import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { computeCompanyStatus, isWithinQuarter, quarterStart } from '@ourcrowd/core';
import type { Mention } from '@ourcrowd/core';
import { config, ROOT } from './config.ts';
import { log } from './lib/logger.ts';
import {
  getClassifiedMentions,
  getCompanies,
  getMentionsForCompany,
  getStats,
  prepareStore,
} from './store/db.ts';

/**
 * Read-only API over the collected data, plus the built dashboard.
 *
 * Everything is computed per request from SQLite. At this size (a few hundred
 * companies, low thousands of mentions) that is well under a millisecond and
 * avoids a cache that could serve stale numbers right after a pipeline run.
 */
export function buildServer() {
  const app = Fastify({ logger: false });

  const prepared = prepareStore();
  if (prepared.hydrated > 0) {
    log.info(`Loaded ${prepared.hydrated} classified mentions from data/mentions.json`);
  }

  app.register(cors, { origin: true });

  app.get('/api/health', async () => ({
    status: 'ok',
    ...getStats(),
  }));

  /** Dashboard rows: one status per company, plus quarter totals. */
  app.get('/api/companies', async (request) => {
    const now = new Date();
    const companies = getCompanies();
    const mentions = getClassifiedMentions();

    const byCompany = new Map<string, Mention[]>();
    for (const mention of mentions) {
      const existing = byCompany.get(mention.companyId);
      if (existing) existing.push(mention);
      else byCompany.set(mention.companyId, [mention]);
    }

    const statuses = companies.map((company) =>
      computeCompanyStatus(company, byCompany.get(company.id) ?? [], now),
    );

    const query = request.query as { status?: string; search?: string };
    let filtered = statuses;
    if (query.status && query.status !== 'all') {
      filtered = filtered.filter((s) => s.status === query.status);
    }
    if (query.search) {
      const needle = query.search.toLowerCase();
      filtered = filtered.filter(
        (s) =>
          s.companyName.toLowerCase().includes(needle) ||
          s.aliases?.some((alias) => alias.toLowerCase().includes(needle)) ||
          s.ticker?.toLowerCase() === needle,
      );
    }

    return {
      quarterStart: quarterStart(now).toISOString(),
      generatedAt: now.toISOString(),
      total: statuses.length,
      companies: filtered,
    };
  });

  /** One company with its full mention list, newest first. */
  app.get('/api/companies/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const company = getCompanies().find((c) => c.id === id);
    if (!company) {
      return reply.code(404).send({ error: 'company not found' });
    }

    const now = new Date();
    const mentions = getMentionsForCompany(id);
    return {
      company,
      status: computeCompanyStatus(company, mentions, now),
      mentions,
      quarterMentions: mentions.filter(
        (m) => m.relevance === 'relevant' && isWithinQuarter(m, now),
      ),
    };
  });

  /** Portfolio-wide rollup for the dashboard header. */
  app.get('/api/summary', async () => {
    const now = new Date();
    const companies = getCompanies();
    const mentions = getClassifiedMentions();
    const relevant = mentions.filter((m) => m.relevance === 'relevant');
    const inQuarter = relevant.filter((m) => isWithinQuarter(m, now));

    const byCompany = new Map<string, Mention[]>();
    for (const mention of mentions) {
      const existing = byCompany.get(mention.companyId);
      if (existing) existing.push(mention);
      else byCompany.set(mention.companyId, [mention]);
    }
    const statuses = companies.map((company) =>
      computeCompanyStatus(company, byCompany.get(company.id) ?? [], now),
    );

    // Weekly buckets across the quarter, oldest first, for the trend chart.
    const weeks: { weekStart: string; positive: number; negative: number; neutral: number }[] = [];
    const start = quarterStart(now).getTime();
    const WEEK = 7 * 24 * 60 * 60 * 1000;
    for (let bucket = 0; bucket < 13; bucket++) {
      const from = start + bucket * WEEK;
      const to = from + WEEK;
      const inBucket = inQuarter.filter((m) => {
        const at = new Date(m.publishedAt).getTime();
        return at >= from && at < to;
      });
      weeks.push({
        weekStart: new Date(from).toISOString().slice(0, 10),
        positive: inBucket.filter((m) => m.sentiment === 'positive').length,
        negative: inBucket.filter((m) => m.sentiment === 'negative').length,
        neutral: inBucket.filter((m) => m.sentiment === 'neutral').length,
      });
    }

    return {
      generatedAt: now.toISOString(),
      quarterStart: quarterStart(now).toISOString(),
      model: config.ollama.model,
      totals: {
        companies: companies.length,
        withCoverage: statuses.filter((s) => s.lastMentionedAt !== null).length,
        quarterMentions: inQuarter.length,
        allMentions: mentions.length,
        filteredIrrelevant: mentions.length - relevant.length,
      },
      sentiment: {
        positive: inQuarter.filter((m) => m.sentiment === 'positive').length,
        negative: inQuarter.filter((m) => m.sentiment === 'negative').length,
        neutral: inQuarter.filter((m) => m.sentiment === 'neutral').length,
      },
      statusBreakdown: {
        active: statuses.filter((s) => s.status === 'active').length,
        recent: statuses.filter((s) => s.status === 'recent').length,
        stale: statuses.filter((s) => s.status === 'stale').length,
        dormant: statuses.filter((s) => s.status === 'dormant').length,
        none: statuses.filter((s) => s.status === 'none').length,
      },
      weeks,
    };
  });

  /** Every relevant mention in the quarter, newest first — the feed view. */
  app.get('/api/mentions', async (request) => {
    const now = new Date();
    const query = request.query as { sentiment?: string; limit?: string };
    const companyNames = new Map(getCompanies().map((c) => [c.id, c.name]));

    let mentions = getClassifiedMentions().filter(
      (m) => m.relevance === 'relevant' && isWithinQuarter(m, now),
    );
    if (query.sentiment && query.sentiment !== 'all') {
      mentions = mentions.filter((m) => m.sentiment === query.sentiment);
    }

    const limit = Number(query.limit) || 200;
    return {
      total: mentions.length,
      mentions: mentions.slice(0, limit).map((m) => ({
        ...m,
        companyName: companyNames.get(m.companyId) ?? m.companyId,
      })),
    };
  });

  // Serve the built dashboard when it exists, so the whole thing runs on one
  // port. In development the Vite dev server proxies to this API instead.
  const dashboardDist = join(ROOT, 'apps/dashboard/dist');
  if (existsSync(dashboardDist)) {
    app.register(fastifyStatic, { root: dashboardDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

if (import.meta.filename === process.argv[1]) {
  const app = buildServer();
  app
    .listen({ port: config.port, host: '0.0.0.0' })
    .then(() => {
      log.info(`API listening on http://localhost:${config.port}`);
      const built = existsSync(join(ROOT, 'apps/dashboard/dist'));
      log.info(
        built
          ? `Dashboard: http://localhost:${config.port}`
          : 'Dashboard not built — run `pnpm --filter @ourcrowd/dashboard dev` for the dev server.',
      );
    })
    .catch((error) => {
      log.error(String(error));
      process.exit(1);
    });
}

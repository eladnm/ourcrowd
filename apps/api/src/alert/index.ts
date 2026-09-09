import type { Company, Mention } from '@ourcrowd/core';
import { config } from '../config.ts';
import { log } from '../lib/logger.ts';

/**
 * Daily alert delivery.
 *
 * Console is the default channel so the alert is visible with no setup, which
 * is what a reviewer needs. A Slack-compatible webhook is the second channel;
 * both can run at once via ALERT_CHANNEL=both. Email was left out deliberately
 * — it needs an API key and a verified sender to demonstrate anything.
 */

const SENTIMENT_ICON = { positive: '📈', negative: '📉', neutral: '➖' } as const;

/**
 * Caps on the console alert. A daily run reports a handful of mentions, but a
 * first run after a backfill can have hundreds — and an alert too long to read
 * is not an alert. Companies are ordered worst-news-first, so the cap keeps
 * what matters and points at the dashboard for the tail.
 */
const MAX_CONSOLE_COMPANIES = 20;
const MAX_CONSOLE_MENTIONS_PER_COMPANY = 5;

export interface AlertPayload {
  generatedAt: string;
  mentions: Mention[];
  companiesById: Map<string, Company>;
}

/** Group mentions by company so one company's news reads as one block. */
function groupByCompany(payload: AlertPayload): Map<string, Mention[]> {
  const grouped = new Map<string, Mention[]>();
  for (const mention of payload.mentions) {
    const existing = grouped.get(mention.companyId);
    if (existing) existing.push(mention);
    else grouped.set(mention.companyId, [mention]);
  }
  return grouped;
}

function companyName(payload: AlertPayload, companyId: string): string {
  return payload.companiesById.get(companyId)?.name ?? companyId;
}

export function formatConsoleAlert(payload: AlertPayload): string {
  const { mentions } = payload;
  if (mentions.length === 0) {
    return 'No new press mentions since the last check.';
  }

  const grouped = groupByCompany(payload);
  const negative = mentions.filter((m) => m.sentiment === 'negative').length;

  const lines: string[] = [
    '',
    '='.repeat(72),
    `  OURCROWD PRESS ALERT — ${mentions.length} new mention${mentions.length === 1 ? '' : 's'} across ${grouped.size} compan${grouped.size === 1 ? 'y' : 'ies'}`,
    `  ${payload.generatedAt}`,
    '='.repeat(72),
  ];

  if (negative > 0) {
    lines.push(`  ⚠  ${negative} negative mention${negative === 1 ? '' : 's'} — review first.`);
    lines.push('-'.repeat(72));
  }

  // Companies with negative coverage first: that is what needs a human today.
  const ordered = [...grouped.entries()].sort(([, a], [, b]) => {
    const negA = a.filter((m) => m.sentiment === 'negative').length;
    const negB = b.filter((m) => m.sentiment === 'negative').length;
    return negB - negA || b.length - a.length;
  });

  // A backfill can leave hundreds of mentions unalerted, and a 1,400-line
  // wall of text in a terminal is an alert nobody reads. Cap the detail and
  // say what was withheld — the dashboard has the rest.
  const shown = ordered.slice(0, MAX_CONSOLE_COMPANIES);

  for (const [companyId, items] of shown) {
    lines.push('', `${companyName(payload, companyId)} (${items.length})`);

    for (const mention of items.slice(0, MAX_CONSOLE_MENTIONS_PER_COMPANY)) {
      const date = mention.publishedAt.slice(0, 10);
      lines.push(
        `  ${SENTIMENT_ICON[mention.sentiment]} [${mention.sentiment}] ${mention.title}`,
        `     ${date}${mention.source ? ` · ${mention.source}` : ''}`,
        `     ${mention.url}`,
      );
      if (mention.reasoning) lines.push(`     ↳ ${mention.reasoning}`);
    }

    const hidden = items.length - MAX_CONSOLE_MENTIONS_PER_COMPANY;
    if (hidden > 0) lines.push(`     …and ${hidden} more for this company`);
  }

  const remainingCompanies = ordered.length - shown.length;
  if (remainingCompanies > 0) {
    const remainingMentions = ordered
      .slice(MAX_CONSOLE_COMPANIES)
      .reduce((total, [, items]) => total + items.length, 0);
    lines.push(
      '',
      '-'.repeat(72),
      `  …and ${remainingMentions} more mention${remainingMentions === 1 ? '' : 's'} ` +
        `across ${remainingCompanies} further compan${remainingCompanies === 1 ? 'y' : 'ies'}.`,
      '  See the dashboard for the full list.',
    );
  }

  lines.push('', '='.repeat(72), '');
  return lines.join('\n');
}

/** Slack-compatible payload; also fine for any generic JSON webhook. */
export function formatWebhookPayload(payload: AlertPayload): Record<string, unknown> {
  const grouped = groupByCompany(payload);
  const negative = payload.mentions.filter((m) => m.sentiment === 'negative').length;

  const summary =
    payload.mentions.length === 0
      ? 'No new press mentions.'
      : `${payload.mentions.length} new mention(s) across ${grouped.size} company(ies)` +
        (negative > 0 ? ` — ${negative} negative` : '');

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📰 OurCrowd Press Alert' },
    },
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
  ];

  // Slack rejects payloads over 50 blocks; cap and link to the dashboard.
  const MAX_COMPANIES = 15;
  for (const [companyId, items] of [...grouped.entries()].slice(0, MAX_COMPANIES)) {
    const lines = items
      .slice(0, 5)
      .map((m) => `${SENTIMENT_ICON[m.sentiment]} <${m.url}|${escapeSlack(m.title)}> _(${m.sentiment})_`);
    if (items.length > 5) lines.push(`_…and ${items.length - 5} more_`);
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${escapeSlack(companyName(payload, companyId))}*\n${lines.join('\n')}` },
    });
  }

  if (grouped.size > MAX_COMPANIES) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `_…and ${grouped.size - MAX_COMPANIES} more companies. See the dashboard._` },
      ],
    });
  }

  return { text: summary, blocks };
}

/** Slack treats these three characters as markup control chars. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function postWebhook(payload: AlertPayload): Promise<void> {
  if (!config.alert.webhookUrl) {
    log.warn('ALERT_CHANNEL includes webhook but ALERT_WEBHOOK_URL is unset — skipping.');
    return;
  }
  try {
    const response = await fetch(config.alert.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formatWebhookPayload(payload)),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log.error(`webhook returned HTTP ${response.status}: ${await response.text()}`);
      return;
    }
    log.info('webhook alert delivered');
  } catch (error) {
    // A delivery failure must not fail the run — the mentions are already
    // stored, and the next run will re-alert anything still unalerted.
    log.error(`webhook delivery failed: ${String(error)}`);
  }
}

/**
 * Send the alert on every configured channel.
 * Returns true if at least one channel accepted it.
 */
export async function sendAlert(payload: AlertPayload): Promise<boolean> {
  const { channel } = config.alert;
  let delivered = false;

  if (channel === 'console' || channel === 'both') {
    console.log(formatConsoleAlert(payload));
    delivered = true;
  }
  if (channel === 'webhook' || channel === 'both') {
    await postWebhook(payload);
    delivered = true;
  }
  return delivered;
}

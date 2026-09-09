/**
 * Classification spot-check.
 *
 * Runs the classifier over a small hand-labelled set and reports agreement,
 * so the README can cite a real number rather than an impression. The set is
 * deliberately small and hand-written — it is a sanity check on prompt
 * behaviour, not a benchmark.
 *
 *   pnpm --filter @ourcrowd/api eval
 */
import type { Company, RawMention, Sentiment } from '@ourcrowd/core';
import { classifyMention, checkOllama } from '../classify/ollama.ts';
import { config } from '../config.ts';
import { log } from '../lib/logger.ts';

interface EvalCase {
  company: Company;
  title: string;
  snippet: string;
  expectedSentiment: Sentiment;
  expectedRelevance: 'relevant' | 'irrelevant';
  /** Why a human labelled it this way. */
  note: string;
}

/**
 * Cases are written to cover the decisions the prompt has to get right:
 * clear good/bad news, the "positive tone, bad for us" trap, routine filler,
 * and name collisions for the common-word company names.
 */
const CASES: EvalCase[] = [
  {
    company: { id: 'lemonade', name: 'Lemonade' },
    title: 'Lemonade reports record quarterly revenue, raises full-year guidance',
    snippet: 'The insurtech beat analyst expectations and lifted its outlook for the year.',
    expectedSentiment: 'positive',
    expectedRelevance: 'relevant',
    note: 'unambiguous good financial news',
  },
  {
    company: { id: 'hailo', name: 'Hailo' },
    title: 'Hailo raises $120M Series C to scale edge AI chip production',
    snippet: 'The round was led by existing investors and values the company at $1.2B.',
    expectedSentiment: 'positive',
    expectedRelevance: 'relevant',
    note: 'funding round — the most common positive case',
  },
  {
    company: { id: 'skillz', name: 'Skillz', sector: 'mobile games platform' },
    title: 'Skillz faces class-action lawsuit over alleged misleading disclosures',
    snippet: 'Shareholders claim the company overstated user engagement metrics.',
    expectedSentiment: 'negative',
    expectedRelevance: 'relevant',
    note: 'litigation — unambiguous negative',
  },
  {
    company: { id: 'beyond-meat', name: 'Beyond Meat' },
    title: 'Beyond Meat cuts 19% of workforce as sales decline',
    snippet: 'The plant-based producer announced layoffs following a fourth straight quarterly drop.',
    expectedSentiment: 'negative',
    expectedRelevance: 'relevant',
    note: 'layoffs plus declining sales',
  },
  {
    company: { id: 'insightec', name: 'Insightec' },
    title: 'Insightec to present at the Annual Neurosurgery Conference in March',
    snippet: 'The company will host a session on focused ultrasound applications.',
    expectedSentiment: 'neutral',
    expectedRelevance: 'relevant',
    note: 'routine announcement, no business signal either way',
  },
  {
    company: { id: 'arbe-robotics', name: 'Arbe Robotics' },
    title: 'Competitor secures major OEM deal, squeezing Arbe Robotics in radar market',
    snippet: 'The rival win narrows the field for remaining imaging-radar suppliers.',
    expectedSentiment: 'negative',
    expectedRelevance: 'relevant',
    note: 'upbeat tone about someone else — bad for THIS company; the trap case',
  },
  {
    company: { id: 'shield', name: 'Shield', sector: 'fintech compliance software' },
    title: 'Marvel announces new S.H.I.E.L.D. series for Disney+',
    snippet: 'The streaming series will explore the agency origins.',
    expectedSentiment: 'neutral',
    expectedRelevance: 'irrelevant',
    note: 'name collision — must be filtered out',
  },
  {
    company: { id: 'silo', name: 'Silo', sector: 'produce supply-chain technology' },
    title: 'Apple TV+ renews Silo for a third season',
    snippet: 'The dystopian drama has been a critical success for the streamer.',
    expectedSentiment: 'neutral',
    expectedRelevance: 'irrelevant',
    note: 'name collision with a TV show',
  },
  {
    company: { id: 'lemonade', name: 'Lemonade' },
    title: 'Ten stocks to watch this week',
    snippet: 'Our roundup includes Lemonade, alongside several other insurers.',
    expectedSentiment: 'neutral',
    expectedRelevance: 'relevant',
    note: 'passing mention in a roundup — relevant but not meaningful news',
  },
  {
    company: { id: 'briefcam', name: 'BriefCam' },
    title: 'BriefCam video analytics deployed across city transit network',
    snippet: 'The municipality will use the platform for incident review.',
    expectedSentiment: 'positive',
    expectedRelevance: 'relevant',
    note: 'customer win / deployment',
  },
];

function toMention(testCase: EvalCase, index: number): RawMention {
  return {
    id: `eval-${index}`,
    companyId: testCase.company.id,
    title: testCase.title,
    snippet: testCase.snippet,
    url: `https://example.com/eval/${index}`,
    source: 'Eval Fixture',
    publishedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
  };
}

async function main() {
  const health = await checkOllama();
  if (!health.ok) {
    log.error(health.message);
    process.exit(1);
  }

  log.step(`Spot-checking ${CASES.length} hand-labelled cases against ${config.ollama.model}`);

  let sentimentHits = 0;
  let relevanceHits = 0;
  const failures: string[] = [];

  for (const [index, testCase] of CASES.entries()) {
    const result = await classifyMention(testCase.company, toMention(testCase, index));

    const sentimentOk = result.sentiment === testCase.expectedSentiment;
    const relevanceOk = result.relevance === testCase.expectedRelevance;
    if (sentimentOk) sentimentHits++;
    if (relevanceOk) relevanceHits++;

    const mark = sentimentOk && relevanceOk ? '✓' : '✗';
    console.log(
      `${mark} ${testCase.company.name}: ${testCase.title.slice(0, 58)}\n` +
        `   expected ${testCase.expectedRelevance}/${testCase.expectedSentiment}, ` +
        `got ${result.relevance}/${result.sentiment} (conf ${result.confidence.toFixed(2)})\n` +
        `   model said: ${result.reasoning}`,
    );

    if (!sentimentOk || !relevanceOk) {
      failures.push(`${testCase.company.name} — ${testCase.note}`);
    }
  }

  const pct = (hits: number) => ((hits / CASES.length) * 100).toFixed(0);
  log.step('Spot-check results');
  log.info(`  relevance: ${relevanceHits}/${CASES.length} (${pct(relevanceHits)}%)`);
  log.info(`  sentiment: ${sentimentHits}/${CASES.length} (${pct(sentimentHits)}%)`);
  if (failures.length) {
    log.warn('  disagreed on:');
    for (const failure of failures) log.warn(`    - ${failure}`);
  }
}

main().catch((error) => {
  log.error(String(error));
  process.exit(1);
});

/**
 * Consistency check over the exported data/ files.
 *
 * The exports are the deliverable a reviewer reads without running anything,
 * so it is worth proving they agree with each other: that every company has a
 * status row, that the summary totals match the rows they summarise, that no
 * status counts a mention the model filtered out, and that every mention
 * carries a working source link.
 *
 *   node scripts/verify-export.mjs
 */
import { readFileSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));

const companies = read('companies.json').companies;
const mentions = read('mentions.json');
const statuses = read('company-status.json');
const summary = read('run-summary.json');

const relevant = mentions.filter((m) => m.relevance === 'relevant');
const failures = [];

function check(label, condition) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label}`);
    failures.push(label);
  }
}

console.log('Verifying data/ exports\n');

check('every company has a status row', statuses.length === companies.length);
check('summary company count matches the seed list', summary.totals.companies === companies.length);
check('summary classified count matches mentions.json', summary.totals.mentionsClassified === mentions.length);
check(
  'relevant + irrelevant accounts for every mention',
  summary.totals.mentionsRelevant + summary.totals.mentionsIrrelevant === mentions.length,
);
check('summary relevant count matches the rows', summary.totals.mentionsRelevant === relevant.length);
check(
  'every mention links to its source',
  mentions.every((m) => typeof m.url === 'string' && m.url.startsWith('http')),
);
check(
  'every mention carries a valid sentiment',
  mentions.every((m) => ['positive', 'negative', 'neutral'].includes(m.sentiment)),
);
check(
  'every mention belongs to a tracked company',
  mentions.every((m) => companies.some((c) => c.id === m.companyId)),
);
check('every mention records the model that labelled it', mentions.every((m) => Boolean(m.model)));
check(
  'summary coverage count matches the status rows',
  summary.totals.companiesWithCoverage === statuses.filter((s) => s.lastMentionedAt !== null).length,
);
check(
  'no status counts a mention the model filtered out',
  statuses.every(
    (s) => s.quarterMentionCount <= relevant.filter((m) => m.companyId === s.companyId).length,
  ),
);
check(
  'status buckets account for every company',
  Object.values(summary.statusBreakdown).reduce((a, b) => a + b, 0) === companies.length,
);
check(
  'sentiment totals sum exactly to the quarter relevant count',
  // Exact, not <=: a loose check here is what let the quarter-scoped sentiment
  // block drift from the all-time relevant total without anything noticing.
  Object.values(summary.sentiment).reduce((a, b) => a + b, 0) ===
    summary.totals.quarterMentionsRelevant,
);
check(
  'the quarter relevant count never exceeds the all-time one',
  summary.totals.quarterMentionsRelevant <= summary.totals.mentionsRelevant,
);
check(
  'a company reporting no coverage really has none',
  statuses
    .filter((s) => s.status === 'none')
    .every((s) => !relevant.some((m) => m.companyId === s.companyId)),
);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${15} checks passed — ${mentions.length} mentions, ${companies.length} companies.`);

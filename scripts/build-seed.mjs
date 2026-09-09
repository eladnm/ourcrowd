/**
 * One-shot converter: the raw company list we were given (one name per line)
 * -> data/companies.json, the seed file the whole pipeline reads.
 *
 * Kept in the repo so the mapping from the source list is reproducible and
 * reviewable rather than hand-typed. Re-run with:
 *   node scripts/build-seed.mjs <path-to-raw-list.txt>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/build-seed.mjs <raw-list.txt>');
  process.exit(1);
}

/** Companies whose plain name is too ambiguous to search for on its own. */
const DISAMBIGUATION = {
  Shield: 'Shield fintech compliance',
  Peak: 'Peak AI decision intelligence',
  Near: 'Near data intelligence company',
  Silo: 'Silo produce technology',
  Wave: 'Wave financial technology',
  Orchard: 'Orchard real estate technology',
  Guild: 'Guild Education',
  Astra: 'Astra space launch company',
  Privateer: 'Privateer Space',
  Kini: 'Kini startup',
  Launchpad: 'Launchpad startup platform',
  Overtime: 'Overtime sports media',
  Greenlight: 'Greenlight family finance app',
  Casper: 'Casper mattress company',
  Bites: 'Bites microlearning app',
  Moodify: 'Moodify scent technology',
  Klook: 'Klook travel booking',
  Tala: 'Tala lending app',
  Ro: 'Ro telehealth company',
  Island: 'Island enterprise browser',
  Harvey: 'Harvey AI legal',
  Glean: 'Glean enterprise search',
  Groq: 'Groq AI chips',
  Anthropic: 'Anthropic AI',
  Stripe: 'Stripe payments',
  SpaceX: 'SpaceX',
  xAI: 'xAI Musk',
  Databricks: 'Databricks',
  Cerebras: 'Cerebras Systems',
  'Scale AI': 'Scale AI data labeling',
  'Together AI': 'Together AI',
  Lano: 'Lano global payroll',
  Sotero: 'Sotero data security',
  Ukko: 'Ukko food allergy protein',
  Carrar: 'Carrar battery thermal',
  Zippin: 'Zippin checkout-free retail',
  Clinch: 'Clinch personalized advertising',
  Neura: 'Neura AI',
  Sweetch: 'Sweetch digital health',
  Powwow: 'Powwow enterprise mobility',
  Mentad: 'Mentad advertising',
  Parko: 'Parko parking app',
  Shopial: 'Shopial social commerce',
  Wayup: 'WayUp early career jobs',
  Nanorep: 'Nanorep customer service AI',
  Celeno: 'Celeno wireless chips',
  Kemtai: 'Kemtai virtual exercise',
  NetOp: 'NetOp network automation',
  Sfara: 'Sfara driver safety',
  Verse: 'Verse.ai messaging',
  Treedom: 'Treedom tree planting',
  Ynsect: 'Ynsect insect protein',
  wefox: 'wefox insurance',
  Skillz: 'Skillz mobile gaming',
};

/** Names carrying a parenthetical note: "X (formerly Y)" / "X (domain)". */
function parseName(line) {
  const match = line.match(/^(.+?)\s*\((.+)\)\s*$/);
  if (!match) return { name: line, note: null };
  return { name: match[1].trim(), note: match[2].trim() };
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const lines = readFileSync(source, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const seen = new Set();
const companies = [];

for (const line of lines) {
  const { name, note } = parseName(line);
  const id = slugify(name);
  if (seen.has(id)) {
    console.warn(`skipping duplicate: ${name}`);
    continue;
  }
  seen.add(id);

  // A note is either an alias ("formerly X"/"known as X") or a domain hint.
  let aliases = [];
  let domain = null;
  if (note) {
    const formerly = note.match(/^(?:formerly(?:\s+known\s+as)?|known\s+as)\s+(.+)$/i);
    if (formerly) aliases = [formerly[1].trim()];
    else if (/\.[a-z]{2,}$/i.test(note)) domain = note;
    else aliases = [note];
  }

  companies.push({
    id,
    name,
    ...(aliases.length ? { aliases } : {}),
    ...(domain ? { domain } : {}),
    // searchQuery overrides the default `"<name>"` query when the bare name
    // is a common English word and would drown the feed in noise.
    ...(DISAMBIGUATION[name] ? { searchQuery: DISAMBIGUATION[name] } : {}),
  });
}

writeFileSync(
  'data/companies.json',
  JSON.stringify({ source: 'OurCrowd portfolio + fund companies', count: companies.length, companies }, null, 2) + '\n',
);
console.log(`wrote data/companies.json with ${companies.length} companies`);
console.log(`  ${companies.filter((c) => c.aliases).length} with aliases`);
console.log(`  ${companies.filter((c) => c.searchQuery).length} with disambiguated search queries`);

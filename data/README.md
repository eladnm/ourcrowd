# Data folder

Deliverable #5: the output of a successful run, committed so results can be
reviewed without re-running the pipeline.

| File | What it is |
| --- | --- |
| `companies.json` | The 258-company seed list the pipeline tracks. Generated from the supplied list by `scripts/build-seed.mjs`. |
| `mentions.json` | Every **classified** mention: title, source, publication date, article URL, sentiment, relevance, model confidence and the model's one-line reasoning. |
| `mentions.csv` | The same rows, flattened for a spreadsheet. |
| `company-status.json` | Per-company "current mention status": last mentioned date, days since, status bucket, quarter mention count and sentiment breakdown. All 258 companies, including those with no coverage. |
| `company-status.csv` | The same, flattened. |
| `run-summary.json` | Totals for the run: how many companies, how many mentions collected vs classified, the sentiment mix, the status breakdown, and which Ollama model produced the labels. |

`press.db` (the SQLite database) is deliberately **not** committed — these
exports are the reviewable artefact. Regenerate them at any time with
`pnpm export`.

## Verifying these files

`pnpm verify:data` cross-checks the exports against each other — that every
company has a status row, that the summary totals match the rows they
summarise, that no status counts a mention the model filtered out, and that
every mention carries a source link and the model that labelled it.

## Reading the numbers

**`mentions.json` contains only classified mentions.** Collection covers the
full 90-day quarter for all 258 companies (4,895 mentions), but classification
on a local 8B model runs at ~12 s per item, so the committed run labels the most
recent window rather than the entire quarter. `run-summary.json` records both
figures — `mentionsCollected` vs `mentionsClassified`. See "Known limitations"
in the root README.

**Most companies show as "active".** Classification runs newest-first, so the
labelled mentions in this snapshot are overwhelmingly from the last week —
which makes almost every company with coverage fall in the `active` (≤7 days)
bucket. That is an artefact of how far classification got, not of the status
logic, which is unit-tested across all five buckets.

**`relevance: "irrelevant"` rows are intentional.** Around 50 of the tracked
companies have names that collide with common words, TV shows or other
businesses (Shield, Silo, Peak, Wave, Orchard…). The model filters those out,
and the filtered rows are kept here — and shown dimmed in the dashboard — so the
filter can be audited rather than trusted blindly. They are excluded from every
status and sentiment count.

**Sentiment is relative to the company, not the article's tone.** "Competitor
wins major deal, squeezing X" is negative *for X* even though the article reads
as upbeat news for somebody.

**One story often appears many times.** The same funding round covered by thirty
outlets counts as thirty mentions; there is no cross-outlet story clustering.
Quarter counts measure press volume, not distinct events.

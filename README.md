# OurCrowd Press Monitor

Monitors press coverage for OurCrowd portfolio and fund companies, classifies
every mention's sentiment with a **locally hosted Ollama model**, and presents
the results in a dashboard — with a daily alert when new coverage appears.

Built for the OurCrowd take-home exercise. It tracks the **258 companies** in
the supplied seed list.

---

## What it does

1. **Quarterly press dashboard** — for each company, its press appearances over
   the trailing 90 days, each labelled positive / negative / neutral and linked
   back to the source article.
2. **Current mention status** — how recently each company was last in the news
   ("last mentioned 3 days ago", "last mentioned 45 days ago", "no coverage
   found"), bucketed into active / recent / stale / dormant / none.
3. **Daily alert** — a scheduled job that collects a narrow window, classifies
   what is new, and sends an alert listing it. Negative coverage sorts first.

---

## Quick start

Prerequisites: **Node.js ≥ 22** (for the built-in `node:sqlite`), **pnpm 10**,
and **Ollama**.

```bash
# 1. Install Ollama and pull the model (~4.9 GB)
#    macOS/Linux: curl -fsSL https://ollama.com/install.sh | sh
#    Windows:     winget install Ollama.Ollama
ollama serve            # leave running in its own terminal
ollama pull llama3.1:8b

# 2. Install dependencies
pnpm install

# 3. Smoke test — 5 companies, end to end, about 2 minutes
pnpm pipeline -- --limit 5 --since 7

# 4. Build and serve the dashboard
pnpm --filter @ourcrowd/dashboard build
pnpm api                # http://localhost:4000
```

No API keys, no database server, no `.env` file required — every setting has a
working default. `apps/api/.env.example` documents the knobs.

### Running it for real

Step 3 above is deliberately small so you can confirm the pipeline works before
committing time to it. The full run is two very differently priced halves:

| Step | Scope | Roughly |
| --- | --- | --- |
| `pnpm collect` | 258 companies, 90 days, ~4,900 mentions | **~7 minutes** |
| `pnpm classify -- --since 7` | last week's coverage | **~1.5 hours** |
| `pnpm classify -- --since 30` | last month's coverage | **~5.5 hours** |
| `pnpm classify` | the whole quarter | **~16 hours** |

Collection is fast; **classification is the bottleneck** — `llama3.1:8b` on CPU
runs at roughly 12 seconds per mention, and the requirement is a *local* model.
Those figures are from an 8-core laptop with no GPU; a GPU or a smaller model
(`OLLAMA_MODEL=qwen2.5:3b`) cuts them substantially.

Classification is **resumable and idempotent**, so the sane way to run it is to
collect once and then let the classifier chip away:

```bash
pnpm collect                    # ~7 min, gets the whole quarter
pnpm classify -- --since 7      # start with the most recent week
pnpm classify                   # later, extend to everything else
pnpm export                     # refresh data/ whenever you like
```

### Just want to look at the results?

The `data/` folder holds the output of a real run, so you can review the
mentions, labels and per-company status without running anything.

---

## Commands

| Command | What it does |
| --- | --- |
| `pnpm pipeline` | Collect → classify → export, end to end |
| `pnpm pipeline -- --since 30` | Same, but only label coverage from the last 30 days |
| `pnpm collect` | Collect only. `--days 90`, `--limit 10` |
| `pnpm classify` | Label pending mentions. `--since 30`, `--limit 20`, `--relabel` |
| `pnpm alert` | The daily job: collect 2 days, classify, alert. `--dry-run` |
| `pnpm export` | Rewrite `data/*.json` and `data/*.csv` from the database |
| `pnpm api` | Serve the API + built dashboard on :4000 |
| `pnpm --filter @ourcrowd/dashboard dev` | Dashboard dev server on :3000 |
| `pnpm --filter @ourcrowd/api eval` | Classification spot-check (see below) |
| `pnpm --filter @ourcrowd/api schedule` | Long-running in-process daily scheduler |
| `pnpm verify:data` | Cross-check the exported `data/` files against each other |
| `pnpm test` | Unit tests |
| `pnpm typecheck` | TypeScript across the workspace |

Both `collect` and `classify` are **resumable**. Results are written as they
land, deduped by mention id, so an interrupted run loses nothing and re-running
picks up where it stopped.

**Re-labelling after a prompt change.** A label reflects the prompt and the
company context that existed when it was produced. When either changes, redo
the affected labels rather than the entire backlog:

```bash
pnpm classify -- --relabel        # companies that have since gained sector/ticker
pnpm classify -- --relabel-all    # every label, when the prompt itself changed
pnpm classify -- --relabel --relabel-before 2026-09-09T06:20:00Z
```

`--relabel` clears the labels and then classifies **exactly** what it cleared —
it will not drag the rest of the pending backlog along with it. The collected
mentions themselves are never touched, so nothing is re-fetched.

---

## Architecture

```
apps/
  api/                    Fastify API + all pipeline CLIs
    src/collect/          Google News RSS collection
    src/classify/         Ollama prompt, client, batch runner
    src/store/            SQLite schema and queries
    src/alert/            Console + webhook alert formatting
    src/cli/              collect / classify / pipeline / alert / export / eval / schedule
  dashboard/              React + Vite SPA
packages/
  core/                   Shared types + mention-status logic (used by both)
data/                     Seed list and the committed output of a real run
scripts/build-seed.mjs    Raw company list -> data/companies.json
docs/AI_PROMPTS.md        The prompts used with AI coding assistants
```

**Flow:** `collect` fetches one RSS feed per company and inserts new mentions →
`classify` sends each unlabelled mention to Ollama and stores the verdict →
`export` writes JSON/CSV → the API computes status per request and the
dashboard renders it.

### Design decisions

**Collection and classification are separate steps.** Collecting 258 companies
takes ~7 minutes; classifying on a local model takes hours. Splitting them means
a slow classifier never blocks collection, and either can be re-run alone.

**Mention identity is a hash of company + normalized URL.** Tracking params are
stripped and the host is lowercased before hashing, so the same article
collected on two different days is one mention. The id is company-scoped on
purpose: an article covering two portfolio companies is a mention for each.

**"New" for alerting means `alerted_at IS NULL`, not "published today."** Feeds
lag. An article published last week but first seen today is genuinely new to us,
and one already alerted on yesterday must not fire twice.

**Status is computed from relevant mentions only.** An irrelevant hit — a
different company sharing the name — must not make a dormant company look
active.

**Shared status logic lives in `packages/core`.** The API and the dashboard
derive "last mentioned N days ago" from the same functions, so they cannot drift.

---

## The local LLM

### Model: `llama3.1:8b`

Chosen because it is a good fit for this specific job:

- **Reliable structured output.** It honours Ollama's `format: json` and the
  requested schema consistently — important when classifying thousands of items
  unattended.
- **Runs on a normal laptop.** 4.9 GB, no GPU required.
- **Strong enough at nuance.** Sentiment here is not tone analysis; the model
  has to tell "rival raises $200M to take on Acme" (bad for Acme, upbeat tone)
  from "Acme raises $200M". Smaller 3B models were noticeably weaker at that.

Override with `OLLAMA_MODEL` — anything Ollama serves works. `qwen2.5:3b` is
roughly 3× faster if you want to trade accuracy for speed.

### How it is invoked

`POST /api/chat` with `stream: false`, `format: 'json'`, `temperature: 0` (so a
re-run reproduces the same labels), and `num_predict: 200`. The system prompt
lives in [apps/api/src/classify/prompt.ts](apps/api/src/classify/prompt.ts).

**One call does two jobs** — relevance *and* sentiment. A separate relevance
pass would double round-trips for no measurable gain; the model needs the same
context for both.

**Relevance filtering matters here.** ~50 of the 258 companies have common-word
names (Shield, Peak, Wave, Silo, Orchard, Guild, Near, Astra…). Two things
handle that: `searchQuery` overrides narrow the feed query at collection time,
and the model filters what still gets through. Filtered mentions stay in the
database and are shown dimmed in the dashboard drawer, so the filter can be
audited rather than trusted blindly.

**Sentiment is scoped to the company, not the article.** The prompt pins this
explicitly, because investors reading the dashboard care about the company's
position, not the writer's mood.

Expected output:

```json
{
  "relevance": "relevant",
  "sentiment": "positive",
  "confidence": 0.9,
  "reasoning": "one short sentence"
}
```

Responses are parsed defensively: the first balanced JSON object is extracted
(models occasionally wrap output in prose), every field is validated against the
allowed values, and confidence is clamped to 0–1. **An invalid label is never
stored** — the mention is left unclassified and retried on the next run. One
malformed response triggers a single retry; a lost connection aborts the whole
run rather than burning through the backlog with the same error.

### How classification quality was validated

`pnpm --filter @ourcrowd/api eval` runs the model over 10 hand-labelled cases
in [apps/api/src/cli/eval.ts](apps/api/src/cli/eval.ts) and reports agreement.
The cases deliberately cover the decisions that are easy to get wrong:

- clear good news (funding round, record revenue, customer win)
- clear bad news (layoffs, class-action lawsuit)
- **the trap case** — positive-sounding coverage that is bad for the company
  ("competitor secures major OEM deal, squeezing Arbe Robotics")
- routine filler that should be neutral (conference appearance, stock roundup)
- **name collisions that must be filtered** (Marvel's S.H.I.E.L.D. for "Shield",
  the Apple TV+ series for "Silo")

**Result: 10/10 relevance, 10/10 sentiment** on the current prompt — but read
that number with the caveat below.

The first run scored **9/10 on both**. The single miss is the interesting part:
the model correctly filtered Marvel's S.H.I.E.L.D. for "Shield" but accepted the
Apple TV+ series for "Silo" as genuine company news. The prompt had no way to
tell them apart, because it was given only a name.

Two changes followed, and both are in the shipped code:

1. The prompt now states that a work of fiction sharing a company's name is not
   coverage of that company, and that a given sector must plausibly fit.
2. `sector` was added for the 49 companies with collision-prone names and is
   passed to the model as its strongest disambiguation signal.

The model's reasoning on the retry shows it working: *"TV show renewal unrelated
to produce supply-chain technology company"* (confidence 1.00).

**Caveat: the prompt was tuned after seeing that failure, so 10/10 on the same
ten cases is not an independent measurement.** It shows the fix works on the
case that motivated it, not that accuracy is 100%. A real evaluation needs a
held-out set of hand-labelled *real* articles, which does not exist here.

Alongside the fixture set, mentions from the live run were spot-checked by hand.
The relevance filter behaved sensibly — for example it correctly marked a general
"When the AI Breaks Its Own Rules" article as *irrelevant* to Morphisec while
keeping two genuine Morphisec security posts as relevant and neutral.

**This is a sanity check, not a benchmark.** Ten fixture cases and an informal
read of real output tell you the prompt is behaving; they do not give you a
defensible accuracy figure.

---

## News source: Google News RSS

One RSS query per company against `news.google.com/rss/search`, with
`when:{n}d` bounding the window server-side. Requests are sequential with a
1.2 s delay and retry with exponential backoff.

**Why:** no API key, no signup, no quota — a reviewer can clone and run it
immediately. Paid APIs give cleaner data but put a signup between the reviewer
and a working pipeline.

**Limitations, honestly:**

- **Headline + short snippet only.** No article body, so the model classifies
  from roughly 200 characters. This is the single biggest constraint on
  accuracy. Fetching and extracting article text would improve it materially.
- **~100 items per query.** Well-covered companies (Anthropic, Databricks,
  Lemonade, Cerebras…) hit that ceiling, so their quarter counts are floors,
  not true totals.
- **Google-wrapped redirect URLs.** Links resolve correctly in a browser but are
  not the publisher's canonical URL, which makes cross-source dedupe weaker than
  it would be with real URLs.
- **No source quality weighting.** A tier-one outlet and a content-farm
  aggregator count the same.
- **Publication dates are the feed's.** Occasionally wrong or missing; items
  with unparseable dates are skipped, and future-dated items never become a
  company's "last mentioned".

The collector is one module behind a plain interface
([apps/api/src/collect/google-news.ts](apps/api/src/collect/google-news.ts)),
so adding NewsAPI or Bing as a second provider is a contained change.

---

## Storage

SQLite via **`node:sqlite`**, Node's built-in driver — no native compilation and
nothing to install. (`better-sqlite3` was the first choice but needs a C++
toolchain on Windows, exactly the setup friction this README is meant to avoid.)

Three tables: `companies`, `mentions` (collection + classification columns, with
`alerted_at` for alert bookkeeping), and `runs` for run history. The database
lives at `data/press.db` and is gitignored; the reviewable snapshot is the
exported JSON/CSV.

---

## The daily alert

```bash
pnpm alert              # collect 2 days, classify, alert on anything new
pnpm alert -- --dry-run # print what would be sent, mark nothing as alerted
```

Console output is the default channel, so the alert is visible with zero setup.
Set `ALERT_CHANNEL=webhook` (or `both`) plus `ALERT_WEBHOOK_URL` for a
Slack-compatible webhook. Alerts group by company and **sort companies with
negative coverage first** — that is what needs a human today.

Scheduling, pick one:

```bash
# cron, 8am daily
0 8 * * * cd /path/to/ourcrowd && pnpm alert >> alert.log 2>&1

# Windows Task Scheduler
schtasks /create /tn "OurCrowd Press Alert" /tr "pnpm alert" /sc daily /st 08:00

# or an in-process scheduler, if you'd rather leave a process running
pnpm --filter @ourcrowd/api schedule
```

Email was deliberately left out: it needs an API key and a verified sender to
demonstrate anything, which works against the zero-setup goal.

---

## Data folder

Output of a real run, committed for review:

| File | Contents |
| --- | --- |
| `companies.json` | The 258-company seed list (generated by `scripts/build-seed.mjs`) |
| `mentions.json` / `.csv` | Every classified mention: sentiment, relevance, confidence, model reasoning, source URL |
| `company-status.json` / `.csv` | Per-company last-mentioned date, days since, status bucket, quarter count, sentiment breakdown |
| `run-summary.json` | Totals, sentiment mix, status breakdown, model used |

---

## Assumptions and trade-offs

**Assumptions**

- "Last quarter" means the **trailing 90 days**, not a calendar quarter — more
  useful for a monitoring dashboard that runs continuously.
- Status thresholds: active ≤ 7d, recent ≤ 30d, stale ≤ 90d, dormant > 90d.
- The seed list is names only. Where a name was ambiguous, a `searchQuery`
  override (53 of 258) and a `sector` (49 of 258) were added by hand;
  parentheticals like "Ludeo (formerly Edge)" became aliases (11) and are both
  searched and shown. Sectors were not researched for the other ~200 companies,
  so those rely on the name alone.
- An article mentioning two portfolio companies counts once for each.

**Trade-offs**

- **SQLite over Postgres** — zero setup beats horizontal scale for a system
  processing a few thousand rows a day.
- **Sequential collection** — ~7 minutes for 258 companies. Parallel would be
  faster but Google News throttles aggressively; a slow run beats a rate-limited
  one with gaps.
- **Classification concurrency defaults to 2** — Ollama serves from one local
  model, so more parallel requests mostly queue while raising timeout risk.
  `CLASSIFY_CONCURRENCY=4` was used for the committed run.
- **Status computed per request, not cached** — sub-millisecond at this size,
  and it can never serve stale numbers right after a run.

**Known limitations**

- **Collection covers the full quarter; classification does not.**
  Collection is complete: **all 4,895 mentions across all 258 companies** for
  the trailing 90 days are stored, with source URLs and publication dates.
  Classification is the bottleneck — `llama3.1:8b` on CPU runs at roughly
  **12 seconds per mention**, so labelling the full quarter is ~16 hours of
  compute. The committed run therefore labels the **most recent window** and
  leaves older mentions collected but unlabelled.

  `data/run-summary.json` records exactly how many were labelled. Nothing is
  lost: unlabelled mentions sit in the database and `pnpm classify` (with no
  `--since`) picks up where it stopped.

  This is a throughput limit, not a correctness one — but it does mean **quarter
  totals for the older weeks understate reality**, because the dashboard counts
  only classified mentions. On a machine with a GPU, or with a smaller model
  (`OLLAMA_MODEL=qwen2.5:3b`), the full quarter is comfortably achievable.
- **Classification quality is spot-checked, not measured.** The fixture set is
  ten hand-written cases, and the prompt was tuned against them — so the 10/10
  is a regression check, not an accuracy figure. No labelled set of real
  articles exists here.
- **Ticker-only coverage was being filtered out — now fixed.** An audit of the
  run found the filter rejecting *"Why Did DRTS Stock Surge 22% Today?"* for
  Alpha Tau, when DRTS is exactly Alpha Tau Medical's NASDAQ ticker. That was
  1 clear false negative in 153 filtered items (~0.7%); the other name-mismatch
  rejections sampled were correct. Companies now carry a `ticker` (19 of the
  258 listed ones), the prompt states that ticker-only coverage counts, and
  both are covered by regression tests. Mentions labelled before this fix were
  re-classified with `pnpm classify -- --relabel`, which redoes exactly the
  affected labels.
- **Roughly 40% of collected mentions are filtered as irrelevant.** That is
  high but expected given ~50 common-word company names; the filtered rows are
  kept and shown dimmed so the decision can be audited.
- **Model confidence is not a useful review signal.** Across the committed run
  `llama3.1:8b` reported ≥0.7 on every single label, so confidence cannot be
  used to route uncertain items to a human. It is stored anyway, but do not
  build a review queue on it.
- **Headline-only input caps accuracy.** See the RSS limitations above.
- **No authentication.** The dashboard is read-only and assumes a trusted
  network. The boilerplate this was derived from had Clerk auth; it was stripped
  to keep setup to one command.
- **No per-source credibility weighting or duplicate-story clustering.** The
  same story from five outlets counts five times.

## Possible next steps

Fetch and extract article body text before classification (the biggest accuracy
win available), cluster near-duplicate stories across outlets, add a second news
provider behind the collector interface, and track sentiment trend per company
over time to alert on *changes* rather than individual articles.

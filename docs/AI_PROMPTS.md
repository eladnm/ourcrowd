# AI coding assistant prompts

Deliverable #6: a copy of the full prompt used with AI coding assistants while
building this solution.

This project was built in a single session with **Claude Code** (Claude Opus).
There was one substantive prompt — the task specification itself — followed by
four clarifying decisions. Everything else was the assistant reading the
codebase, running commands, and iterating on failures.

> Note: this documents prompts given to the *coding assistant*. The prompt the
> running system sends to the *local Ollama model* is a separate thing — it
> lives in [apps/api/src/classify/prompt.ts](../apps/api/src/classify/prompt.ts)
> and is explained in the README.

---

## Initial prompt

> can you take this repository as boilerplate and make new repository called
> ourcrowrd and do this task
>
> **1. Overview**
> OurCrowd tracks press coverage of its portfolio and fund companies. Design and
> build a small system that monitors news coverage for a given list of
> companies, classifies each mention's sentiment, and presents the results
> through a dashboard - with a daily alert when new coverage appears.
> We are less interested in a "perfect" product than in how you approach the
> problem: your architecture choices, code quality, use of the required local
> LLM, and the clarity of your documentation.
>
> **2. Goals**
> 1. Quarterly press dashboard: Build a dashboard showing, for each OurCrowd
>    portfolio/fund company, its press appearances over the last quarter. Each
>    mention should be classified as positive, negative, or neutral, and linked
>    back to its source (a reference / URL to the original article).
> 2. Current mention status: For each company, surface its current "mention
>    status" based on the date it was last mentioned in the news (e.g. last
>    mentioned 3 days ago / 45 days ago / no coverage found).
> 3. Daily alert: Implement a daily job that checks for new press mentions of
>    any tracked company and sends an alert when one is found.
>
> **3. Data Provided**
> You will be given a list of OurCrowd portfolio companies and fund companies
> (name + any identifying detail such as domain or sector) to use as the seed
> list for monitoring. This list will be shared with you separately alongside
> this document.
> - Use this list as the source of truth for which companies to track.
> - You are free to decide how to source news for each company (e.g. news/search
>   APIs, RSS, scraping). Please document your choice and its limitations in the
>   README.
>
> **4. Technical Requirements**
>
> *4.1 Local LLM (required)*
> Sentiment classification (and any other text understanding step, e.g.
> relevance filtering or summarization) must run through a locally hosted Ollama
> model — not a cloud/hosted LLM API. Please state in your README:
> - Which Ollama model you used and why.
> - How the model is invoked (prompt structure, expected output format).
> - How you validated classification quality (even informally, e.g. a small
>   manual spot-check).
>
> *4.2 Architecture*
> The solution must be implemented in JavaScript (Node.js) for both backend and
> any data-collection components. Beyond that, you're free to choose your own
> frameworks/libraries.
> As a guide, a solution typically includes:
> - A data-collection component that fetches recent news items per company.
> - A classification step (Ollama) that labels each item's sentiment.
> - A storage layer (files or a lightweight database) holding results.
> - A dashboard/UI layer to visualize quarterly mentions and current status per
>   company.
> - A scheduled job (cron, script, or workflow tool) that performs the daily
>   check and sends the alert (email, Slack, webhook, console/log output, etc. —
>   your choice, just make it visible and documented).
>
> **5. Deliverables**
> 4. A GitHub repository containing your full solution, with a clear README that
>    explains:
>    - What the project does and how it's structured.
>    - Setup instructions (dependencies, environment variables, how to
>      install/run Ollama and which model to pull).
>    - Exact commands to run the project end-to-end, locally.
>    - Any assumptions, trade-offs, or known limitations.
> 5. A data folder containing the output of a successful run — e.g. the
>    collected mentions, sentiment labels, references/links, and the computed
>    "last mentioned" status per company — so we can review results without
>    re-running everything ourselves.
> 6. A copy of the full prompt used with AI coding assistants while building the
>    solution.
>
> **6. Evaluation Criteria**
> - Correctness — the pipeline runs end-to-end and produces the three required
>   outputs.
> - Code quality — structure, readability, and reasonable error handling.
> - Use of the local LLM — sensible prompting and integration with Ollama.
> - Documentation — a reviewer unfamiliar with the project can set it up and run
>   it from the README alone.
> - Product thinking — sensible choices around sentiment classification,
>   alerting, and how the dashboard presents information.
>
> **7. Notes**
> - Feel free to make reasonable assumptions where this document is ambiguous,
>   just document them.
> - If you run out of time, a partially complete solution with clear notes on
>   what's missing is preferred over an undocumented "complete" one.
> - Please reach out if you have questions about the company list or scope.

## Follow-up: the company list

> `C:\Users\eladn\Downloads\ourcrowd_companies.txt`

(257 lines, one company name per line. Converted to `data/companies.json` by
`scripts/build-seed.mjs`, which is committed so the mapping is reproducible.)

---

## Clarifying decisions

The assistant asked before making choices that would have been expensive to
reverse. The answers given:

**1. How much of the boilerplate to keep?**
→ *Strip to a lean app.* Keep the monorepo shape, Fastify API, React/Vite
dashboard and pnpm/Turbo tooling; drop Clerk auth, Stripe billing, Redis and the
email templates. Storage becomes SQLite so a reviewer needs no external
services.

**2. How should news be sourced?**
→ *Google News RSS* — free, no API key, runs immediately for a reviewer, with
the limitations documented in the README.

**3. Ollama is not installed on this machine — how to proceed?**
→ *Install it via winget and pull `llama3.1:8b`*, so the pipeline could actually
be run end to end and the classification output validated rather than assumed.

**4. Full-quarter classification takes ~15 hours. How far should it go?**
→ *Classify the last 30 days* (~1,780 mentions, ~1.5 h). Older mentions stay
collected but unlabelled, documented as a known limitation.

**5. Several companies hit the RSS 100-item cap with noisy results.**
→ *Leave the seed list as-is and let the LLM relevance filter handle it*, rather
than hand-tuning search queries per company.

---

## How the work actually proceeded

Worth recording, since the brief asks about approach:

1. **Read the boilerplate first** — package layout, Fastify setup, tooling —
   before deciding what to keep.
2. **Converted the seed list with a committed script** rather than by hand, so
   the mapping from the raw list is reviewable and re-runnable.
3. **Built the shared domain package first** (types + status logic), then wrote
   its unit tests, then the layers on top. The status buckets and URL dedupe are
   where correctness actually bites, so they got tests before anything else.
4. **Hit a real problem and changed course:** `better-sqlite3` failed to install
   — a native module with no prebuilt binary for Node 26 and no Visual Studio
   C++ toolchain on the machine. Rather than ask a reviewer to install build
   tools, the storage layer was rewritten against Node's built-in `node:sqlite`.
   That trade-off is recorded in the README and in a comment in `store/db.ts`.
5. **Verified against live data before building the UI** — collected real
   mentions, confirmed the dedupe worked on a second run (27 seen, 0 new), and
   checked the model's actual labels — so the dashboard was built on top of a
   pipeline already known to work.
6. **Split `packages/core` into browser and Node entry points** when the
   dashboard build failed on a `node:crypto` import pulled in transitively.

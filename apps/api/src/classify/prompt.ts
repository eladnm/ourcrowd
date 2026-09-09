import type { Company, RawMention } from '@ourcrowd/core';

/**
 * The classification prompt.
 *
 * Design notes (expanded in the README):
 *
 * - Two jobs in one call — relevance and sentiment. A separate relevance pass
 *   would double the model round-trips for 250+ companies with no accuracy
 *   gain we could measure, and the model needs the same context for both.
 *
 * - Sentiment is scoped to *the company*, not the article. "Rival raises $200M
 *   to take on Acme" is upbeat in tone but not good news for Acme. Investors
 *   reading this dashboard care about the company's position, so the prompt
 *   pins the frame explicitly.
 *
 * - Relevance matters because ~50 of these companies have common-word names
 *   (Shield, Peak, Wave, Silo, Orchard). Search returns unrelated coverage and
 *   the model is the filter that keeps it off the dashboard.
 *
 * - JSON out, enforced with Ollama's `format: json`. The schema is small and
 *   the field order matches the reasoning order we want: decide relevance,
 *   then sentiment, then justify.
 */

export const SYSTEM_PROMPT = `You are a press-monitoring analyst for OurCrowd, a venture investment platform. You classify news coverage of portfolio companies.

You will be given a company and a news headline with a short snippet. Do two things:

1. RELEVANCE — Is this article actually about the specified company?
   Many portfolio companies share names with common words or other businesses.
   Mark "irrelevant" if the article is about a different organisation, a person,
   or a generic use of the word. When the snippet is too thin to tell, prefer
   "relevant" only if the surrounding context (sector, technology, funding)
   plausibly fits the company described.

2. SENTIMENT — Is the coverage good, bad, or neutral FOR THIS COMPANY'S business
   prospects? Judge the company's position, not the article's tone.
   - positive: funding rounds, acquisitions, product launches, partnerships,
     revenue growth, awards, favourable analysis, expansion.
   - negative: layoffs, lawsuits, data breaches, executive departures under
     pressure, missed targets, recalls, down rounds, shutdowns, criticism,
     competitor wins that directly threaten the company.
   - neutral: routine announcements, listings, brief mentions in a roundup,
     factual reporting with no clear upside or downside, market commentary
     where the company is only an example.

Reply with JSON only, matching exactly this schema:
{"relevance":"relevant"|"irrelevant","sentiment":"positive"|"negative"|"neutral","confidence":0.0-1.0,"reasoning":"one short sentence"}

Set confidence to how sure you are overall. Keep reasoning under 20 words.
If relevance is "irrelevant", still provide a sentiment (use "neutral").`;

export function buildUserPrompt(company: Company, mention: RawMention): string {
  const lines = [`Company: ${company.name}`];

  if (company.aliases?.length) {
    lines.push(`Also known as: ${company.aliases.join(', ')}`);
  }
  if (company.sector) lines.push(`Sector: ${company.sector}`);
  if (company.domain) lines.push(`Website: ${company.domain}`);

  lines.push('', `Headline: ${mention.title}`);
  if (mention.source) lines.push(`Publication: ${mention.source}`);
  if (mention.snippet) lines.push(`Snippet: ${mention.snippet}`);

  lines.push('', 'Classify this article. JSON only.');
  return lines.join('\n');
}

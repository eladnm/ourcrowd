import type { CompanyStatus, Mention, MentionStatusLevel, Sentiment } from '@ourcrowd/core';

export interface SummaryResponse {
  generatedAt: string;
  quarterStart: string;
  model: string;
  totals: {
    companies: number;
    withCoverage: number;
    quarterMentions: number;
    allMentions: number;
    filteredIrrelevant: number;
  };
  sentiment: Record<Sentiment, number>;
  statusBreakdown: Record<MentionStatusLevel, number>;
  weeks: { weekStart: string; positive: number; negative: number; neutral: number }[];
}

export interface CompaniesResponse {
  quarterStart: string;
  generatedAt: string;
  total: number;
  companies: CompanyStatus[];
}

export interface CompanyDetailResponse {
  company: { id: string; name: string; aliases?: string[]; sector?: string };
  status: CompanyStatus;
  mentions: Mention[];
  quarterMentions: Mention[];
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Request to ${path} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  summary: () => get<SummaryResponse>('/api/summary'),
  companies: () => get<CompaniesResponse>('/api/companies'),
  company: (id: string) => get<CompanyDetailResponse>(`/api/companies/${id}`),
};

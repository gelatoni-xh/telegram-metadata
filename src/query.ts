import type { QueryFilters } from './provider.js';

export type QueryKind = 'code' | 'keyword';
export type QueryFilterField = keyof QueryFilters;

export const queryFilterFields: QueryFilterField[] = [
  'actress', 'maker', 'label', 'series', 'releaseAfter', 'releaseBefore', 'runtimeMin', 'runtimeMax', 'sort',
];

export function normalizeQuery(input: string): { text: string; kind: QueryKind } | null {
  const text = input.trim();
  if (!text) return null;
  if (text.length > 200) throw new Error('query_too_long');
  const kind: QueryKind = /^[A-Z0-9]{2,8}-\d{2,6}$/i.test(text) ? 'code' : 'keyword';
  return { text, kind };
}

export function normalizeFilterValue(field: QueryFilterField, input: string): string | number {
  const value = input.trim();
  if (!value) throw new Error('filter_value_empty');
  if (field === 'sort') {
    if (value !== 'relevance' && value !== 'release') throw new Error('filter_sort_invalid');
    return value;
  }
  if (field === 'releaseAfter' || field === 'releaseBefore') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('filter_date_invalid');
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('filter_date_invalid');
    return value;
  }
  if (field === 'runtimeMin' || field === 'runtimeMax') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2000) throw new Error('filter_runtime_invalid');
    return parsed;
  }
  if (value.length > 100) throw new Error('filter_value_too_long');
  return value;
}

export function filterStateFromJson(value: unknown): { applied: QueryFilters; draft: QueryFilters } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { applied: {}, draft: {} };
  const raw = value as Record<string, unknown>;
  const clean = (candidate: unknown): QueryFilters => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
    const filters: QueryFilters = {};
    for (const field of queryFilterFields) {
      const fieldValue = (candidate as Record<string, unknown>)[field];
      if (typeof fieldValue === 'string' && fieldValue.trim()) (filters as Record<string, unknown>)[field] = fieldValue;
      if ((field === 'runtimeMin' || field === 'runtimeMax') && typeof fieldValue === 'number' && Number.isFinite(fieldValue)) {
        (filters as Record<string, unknown>)[field] = fieldValue;
      }
    }
    return filters;
  };
  if ('applied' in raw || 'draft' in raw) {
    const applied = clean(raw.applied);
    return { applied, draft: clean(raw.draft ?? raw.applied) };
  }
  const legacy = clean(raw);
  return { applied: legacy, draft: legacy };
}

export function validateQueryFilters(filters: QueryFilters): void {
  if (filters.releaseAfter && filters.releaseBefore && filters.releaseAfter > filters.releaseBefore) {
    throw new Error('filter_date_range_invalid');
  }
  if (filters.runtimeMin !== undefined && filters.runtimeMax !== undefined && filters.runtimeMin > filters.runtimeMax) {
    throw new Error('filter_runtime_range_invalid');
  }
}

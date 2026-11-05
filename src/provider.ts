import { z } from 'zod';
import type { Config } from './config.js';

export interface SearchInput {
  text: string;
  kind: 'code' | 'keyword';
  pageToken?: string;
  pageSize: number;
  filters?: QueryFilters;
}

export interface QueryFilters {
  sort?: 'relevance' | 'release';
  actress?: string;
  maker?: string;
  label?: string;
  series?: string;
  releaseAfter?: string;
  releaseBefore?: string;
  runtimeMin?: number;
  runtimeMax?: number;
}

export interface MetadataSummary {
  providerId: string;
  code?: string;
  title?: string;
  releaseDate?: string;
  durationMinutes?: number;
  actors?: string[];
  maker?: string;
  label?: string;
  series?: string;
  director?: string;
  genres?: string[];
}

export interface SearchPage {
  items: MetadataSummary[];
  nextPageToken?: string;
  previousPageToken?: string;
  total?: number;
}

export interface MetadataProvider {
  search(input: SearchInput): Promise<SearchPage>;
  detail(providerId: string): Promise<Record<string, unknown> | null>;
  accountStatus(): Promise<{ reachable: boolean; balance?: string; rateLimit?: string; hasPaid?: boolean }>;
}

export class ProviderNotVerifiedError extends Error {
  constructor() {
    super('provider_not_verified');
    this.name = 'ProviderNotVerifiedError';
  }
}

export class JavInfoApiError extends Error {
  constructor(readonly status: number, readonly retryAfter?: string) {
    super(`javinfo_http_${status}`);
    this.name = 'JavInfoApiError';
  }
}

export class JavInfoContractError extends Error {
  constructor() {
    super('javinfo_response_contract_mismatch');
    this.name = 'JavInfoContractError';
  }
}

const objectSchema = z.record(z.string(), z.unknown());
const searchResponseSchema = z.object({
  results: z.array(objectSchema),
  count: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().nullable().optional(),
}).passthrough();
const detailResponseSchema = z.object({ result: objectSchema.nullable().optional() }).passthrough();

function record(value: unknown): Record<string, unknown> {
  const parsed = objectSchema.safeParse(value);
  if (!parsed.success) throw new JavInfoContractError();
  return parsed.data;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function textList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.flatMap(item => {
    if (typeof item === 'string') return text(item) ?? [];
    const entry = objectSchema.safeParse(item);
    return entry.success ? text(entry.data.name) ?? [] : [];
  });
  return values.length ? values : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function mapRecord(rawValue: unknown, requireId: boolean): MetadataSummary | Record<string, unknown> {
  const raw = record(rawValue);
  const extra = objectSchema.safeParse(raw.extra);
  const details = extra.success ? extra.data : {};
  const code = text(raw.dvdId) ?? text(raw.code);
  if (requireId && !code) throw new JavInfoContractError();

  const runtimeSeconds = numeric(details.duration);
  const durationMinutes = numeric(details.runtimeMins) ?? numeric(raw.runtimeMins) ?? (runtimeSeconds === undefined ? undefined : Math.round(runtimeSeconds / 60));
  const actors = textList(details.actresses) ?? textList(raw.actresses) ?? textList(raw.actors);
  const genres = textList(details.categories) ?? textList(details.genres) ?? textList(raw.categories) ?? textList(raw.genres);
  const fields: MetadataSummary = {
    providerId: code ?? '',
    code,
    title: text(raw.title) ?? text(raw.titleEn) ?? text(raw.titleJa),
    releaseDate: text(raw.releaseDate),
    durationMinutes,
    actors,
    maker: text(details.maker) ?? text(details.studio) ?? text(raw.maker) ?? textList(raw.makers)?.join('、'),
    label: text(details.label) ?? text(raw.label),
    series: text(details.series) ?? text(raw.series),
    director: text(details.director) ?? text(raw.director) ?? textList(raw.directors)?.join('、'),
    genres,
  };
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) => key === 'providerId' || value !== undefined));
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export class JavInfoProvider implements MetadataProvider {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs = 20_000;

  constructor(
    private readonly config: Pick<Config, 'JAVINFO_API_KEY' | 'JAVINFO_BASE_URL'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = (config.JAVINFO_BASE_URL || 'https://api.javinfo.dev').replace(/\/+$/, '');
  }

  async search(input: SearchInput): Promise<SearchPage> {
    const pageNumber = input.pageToken ? Number(input.pageToken) : 1;
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 200) throw new JavInfoContractError();
    const { sort, ...filter } = input.filters ?? {};
    const payload = await this.request('/query', {
      q: input.text,
      num: input.pageSize,
      page: pageNumber,
      ...(Object.keys(filter).length ? { filter } : {}),
      ...(sort ? { sort } : {}),
    });
    const parsed = searchResponseSchema.safeParse(payload);
    if (!parsed.success) throw new JavInfoContractError();

    const items = parsed.data.results.map(result => mapRecord(result, true) as MetadataSummary);
    const count = parsed.data.count ?? parsed.data.results.length;
    const previousPageToken = pageNumber > 1 ? String(pageNumber - 1) : undefined;
    const nextPageToken = count >= input.pageSize && pageNumber < 200 ? String(pageNumber + 1) : undefined;
    const total = parsed.data.total ?? undefined;
    return {
      items,
      ...(previousPageToken ? { previousPageToken } : {}),
      ...(nextPageToken ? { nextPageToken } : {}),
      ...(total === undefined ? {} : { total }),
    };
  }

  async detail(providerId: string): Promise<Record<string, unknown> | null> {
    let payload: unknown;
    try {
      payload = await this.request('/movie', { q: providerId });
    } catch (error) {
      if (error instanceof JavInfoApiError && error.status === 404) return null;
      throw error;
    }
    const parsed = detailResponseSchema.safeParse(payload);
    if (!parsed.success) throw new JavInfoContractError();
    if (!parsed.data.result) return null;
    return mapRecord(parsed.data.result, true) as Record<string, unknown>;
  }

  async accountStatus(): Promise<{ reachable: boolean; balance?: string; rateLimit?: string; hasPaid?: boolean }> {
    const raw = record(await this.request('/profile'));
    const rateLimitValue = raw.rpm ?? raw.rateLimit ?? raw.requestsPerMinute ?? raw.rate_limit;
    return {
      reachable: true,
      balance: optionalString(raw.balance ?? raw.balanceRemaining ?? raw.credit),
      rateLimit: optionalString(rateLimitValue),
      hasPaid: typeof raw.hasPaid === 'boolean' ? raw.hasPaid : undefined,
    };
  }

  private async request(path: string, body?: Record<string, unknown>): Promise<unknown> {
    if (!this.config.JAVINFO_API_KEY) throw new ProviderNotVerifiedError();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          'x-javinfo-key': this.config.JAVINFO_API_KEY,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new JavInfoApiError(0);
    }
    if (!response.ok) throw new JavInfoApiError(response.status, response.headers.get('retry-after') ?? undefined);
    try {
      return await response.json();
    } catch {
      throw new JavInfoContractError();
    }
  }
}

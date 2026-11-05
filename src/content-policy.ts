export const allowedMetadataFields = [
  'providerId', 'code', 'title', 'releaseDate', 'durationMinutes', 'actors', 'maker', 'label', 'series', 'director', 'genres', 'sourceUrl',
] as const;

const blockedKey = /(sample|gallery|video|movie.?url|stream|m3u8|magnet|torrent|download|media|cover|image)/i;
const blockedValue = /(?:magnet:\?|\.m3u8(?:\?|$)|\b(?:torrent|download)\b)/i;

export function allowMetadata<T extends Record<string, unknown>>(raw: T): Partial<T> {
  const safe: Partial<T> = {};
  for (const key of allowedMetadataFields) {
    const value = raw[key];
    if (blockedKey.test(key) || value === undefined || value === null) continue;
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized && blockedValue.test(serialized)) continue;
    safe[key as keyof T] = value as T[keyof T];
  }
  return safe;
}

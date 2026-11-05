import test from 'node:test';
import assert from 'node:assert/strict';
import { JavInfoApiError, JavInfoContractError, JavInfoProvider } from '../src/provider.js';

const config = { JAVINFO_API_KEY: 'jvi_test_key', JAVINFO_BASE_URL: 'https://api.javinfo.dev' } as const;

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers });
}

test('search maps JavInfo query fields and sends 1-based page/num values', async () => {
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const provider = new JavInfoProvider(config, async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return jsonResponse({
      q: 'SSIS', source: 'fanza', count: 5,
      results: [{
        id: '118abp00999', dvdId: 'ABP-999', title: 'Title', releaseDate: '2019-01-04',
        cover: 'https://media.invalid/cover.jpg',
        extra: {
          runtimeMins: 130, maker: 'Studio', categories: ['Drama'],
          actresses: [{ name: 'Actor A', image: 'https://media.invalid/actor.jpg' }],
          sampleUrl: 'https://media.invalid/sample.mp4',
        },
      }],
    });
  });

  const page = await provider.search({
    text: 'SSIS', kind: 'keyword', pageToken: '2', pageSize: 5,
    filters: { actress: 'Actor A', runtimeMin: 90, releaseAfter: '2024-01-01', sort: 'release' },
  });
  assert.equal(requestedUrl, 'https://api.javinfo.dev/query');
  assert.equal(requestedInit?.method, 'POST');
  assert.equal(new Headers(requestedInit?.headers).get('x-javinfo-key'), config.JAVINFO_API_KEY);
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    q: 'SSIS', num: 5, page: 2, filter: { actress: 'Actor A', runtimeMin: 90, releaseAfter: '2024-01-01' }, sort: 'release',
  });
  assert.deepEqual(page, {
    items: [{
      providerId: 'ABP-999', code: 'ABP-999', title: 'Title', releaseDate: '2019-01-04',
      durationMinutes: 130, actors: ['Actor A'], maker: 'Studio', genres: ['Drama'],
    }],
    previousPageToken: '1', nextPageToken: '3',
  });
  assert.doesNotMatch(JSON.stringify(page), /media\.invalid|sample/);
});

test('detail maps /movie result and discards image, stream, and magnet fields', async () => {
  let requestedUrl = '';
  const provider = new JavInfoProvider(config, async (input) => {
    requestedUrl = String(input);
    return jsonResponse({
      q: 'SSIS-001', source: 'fanza', result: {
        contentId: 'opaque-id', dvdId: 'SSIS-001', titleEn: 'Title', titleJa: 'タイトル', releaseDate: '2021-07-06',
        runtimeMins: 130, makers: ['Studio'], directors: ['Director'], categories: ['Drama'],
        actresses: ['Actor A'], actors: [], label: 'Label',
        jacketFullUrl: 'https://media.invalid/cover.jpg',
        extra: {
          series: 'Series', streamUrl: 'https://media.invalid/play.m3u8', magnets: ['magnet:?x'],
          galleryFull: ['https://media.invalid/gallery.jpg'],
        },
      },
    });
  });

  const detail = await provider.detail('SSIS-001');
  assert.equal(requestedUrl, 'https://api.javinfo.dev/movie');
  assert.deepEqual(detail, {
    providerId: 'SSIS-001', code: 'SSIS-001', title: 'Title', releaseDate: '2021-07-06',
    durationMinutes: 130, actors: ['Actor A'], maker: 'Studio', label: 'Label', series: 'Series',
    director: 'Director', genres: ['Drama'],
  });
  assert.doesNotMatch(JSON.stringify(detail), /media\.invalid|magnet|streamUrl/);
});

test('empty queries are a valid page and /movie 404 maps to a missing detail', async () => {
  let call = 0;
  const provider = new JavInfoProvider(config, async () => {
    call += 1;
    return call === 1 ? jsonResponse({ q: 'missing', source: 'fanza', count: 0, results: [] }) : jsonResponse({}, 404);
  });
  assert.deepEqual(await provider.search({ text: 'missing', kind: 'code', pageSize: 5 }), { items: [] });
  assert.equal(await provider.detail('MISSING-001'), null);
});

test('invalid response shapes and HTTP errors stay typed', async () => {
  const badShape = new JavInfoProvider(config, async () => jsonResponse({ results: ['not-an-object'] }));
  await assert.rejects(badShape.search({ text: 'x', kind: 'keyword', pageSize: 5 }), JavInfoContractError);

  const unauthorized = new JavInfoProvider(config, async () => jsonResponse({ error: 'invalid api key' }, 401));
  await assert.rejects(unauthorized.accountStatus(), error => error instanceof JavInfoApiError && error.status === 401);

  const missingDvdId = new JavInfoProvider(config, async () => jsonResponse({ results: [{ id: 'opaque-internal-id', title: 'Title' }] }));
  await assert.rejects(missingDvdId.search({ text: 'x', kind: 'keyword', pageSize: 5 }), JavInfoContractError);
});

test('profile is read with a free GET and exposes only account summary fields', async () => {
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const provider = new JavInfoProvider(config, async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return jsonResponse({ balance: 0.02, hasPaid: false, rpm: 5, apiKey: 'never-return-this' });
  });
  assert.deepEqual(await provider.accountStatus(), { reachable: true, balance: '0.02', rateLimit: '5', hasPaid: false });
  assert.equal(requestedUrl, 'https://api.javinfo.dev/profile');
  assert.equal(requestedInit?.method, 'GET');
});

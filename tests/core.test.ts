import test from 'node:test';
import assert from 'node:assert/strict';
import { languageFromTelegram, t } from '../src/i18n.js';
import { filterStateFromJson, normalizeFilterValue, normalizeQuery, validateQueryFilters } from '../src/query.js';
import { allowMetadata } from '../src/content-policy.js';
import { ageView, detailView, filterInputView, filterView, homeView, languageView, resultsView } from '../src/ui.js';

test('selects Japanese only for Japanese Telegram locales', () => {
  assert.equal(languageFromTelegram('ja'), 'ja');
  assert.equal(languageFromTelegram('ja-JP'), 'ja');
  assert.equal(languageFromTelegram('en'), 'zh');
  assert.equal(languageFromTelegram(undefined), 'zh');
});

test('normalizes query and routes code-shaped input', () => {
  assert.deepEqual(normalizeQuery('  ABC-123  '), { text: 'ABC-123', kind: 'code' });
  assert.deepEqual(normalizeQuery('東京'), { text: '東京', kind: 'keyword' });
  assert.equal(normalizeQuery('   '), null);
  assert.throws(() => normalizeQuery('x'.repeat(201)), /query_too_long/);
});

test('validates JavInfo filter values and keeps applied filters separate from edits', () => {
  assert.equal(normalizeFilterValue('releaseAfter', '2024-02-29'), '2024-02-29');
  assert.throws(() => normalizeFilterValue('releaseAfter', '2024-02-30'), /filter_date_invalid/);
  assert.equal(normalizeFilterValue('runtimeMin', '95'), 95);
  assert.throws(() => normalizeFilterValue('runtimeMax', '2001'), /filter_runtime_invalid/);
  assert.throws(() => validateQueryFilters({ runtimeMin: 120, runtimeMax: 90 }), /filter_runtime_range_invalid/);
  assert.throws(() => validateQueryFilters({ releaseAfter: '2025-01-01', releaseBefore: '2024-12-31' }), /filter_date_range_invalid/);
  assert.deepEqual(filterStateFromJson({ applied: { maker: 'Studio' }, draft: { maker: 'Studio', series: 'S1' } }), {
    applied: { maker: 'Studio' }, draft: { maker: 'Studio', series: 'S1' },
  });
});

test('metadata mapper only keeps explicitly allowed, non-media values', () => {
  const mapped = allowMetadata({ code: 'ABC-123', title: 'Title', sampleUrl: 'https://example.invalid/sample', sourceUrl: 'https://example.invalid/record', actors: ['A'] });
  assert.deepEqual(mapped, { code: 'ABC-123', title: 'Title', sourceUrl: 'https://example.invalid/record', actors: ['A'] });
});

test('Chinese and Japanese home screens keep the primary action first and separate secondary actions', () => {
  for (const language of ['zh', 'ja'] as const) {
    const view = homeView(language);
    const rows = view.keyboard.inline_keyboard;
    assert.equal(rows[0]?.length, 1);
    assert.equal(rows[1]?.length, 2);
    assert.equal(rows[2]?.length, 1);
    assert.match(view.text, new RegExp(t(language).brand));
  }
});

test('age confirmation presents a clear confirm/exit pair', () => {
  for (const language of ['zh', 'ja'] as const) {
    const view = ageView(language);
    assert.equal(view.keyboard.inline_keyboard.length, 2);
    const confirm = view.keyboard.inline_keyboard[0]?.[0];
    const decline = view.keyboard.inline_keyboard[1]?.[0];
    assert.ok(confirm && 'callback_data' in confirm);
    assert.ok(decline && 'callback_data' in decline);
    assert.equal(confirm.callback_data, 'age:confirm');
    assert.equal(decline.callback_data, 'age:decline');
  }
});

test('language selector is a compact two-choice row', () => {
  const view = languageView('zh');
  assert.deepEqual(view.keyboard.inline_keyboard[0]?.map(button => button.text), ['中文', '日本語']);
});

test('result actions carry compact server-side session references', () => {
  const view = resultsView('zh', 'cm123456789012345678901234', 3, 2, [{ providerId: 'p-1', code: 'ABC-123', title: '<Unsafe>' }], true, true);
  const buttons = view.keyboard.inline_keyboard.flat();
  const detail = buttons.find(button => 'callback_data' in button && button.callback_data.startsWith('detail:'));
  const next = buttons.find(button => 'callback_data' in button && button.callback_data.startsWith('page:next:'));
  assert.ok(detail && 'callback_data' in detail);
  assert.ok(next && 'callback_data' in next);
  assert.ok(detail.callback_data.length <= 64);
  const filter = buttons.find(button => 'callback_data' in button && button.callback_data.startsWith('filter:open:'));
  assert.ok(filter && 'callback_data' in filter);
  assert.ok(filter.callback_data.length <= 64);
  assert.match(detail.callback_data, /:3:0$/);
  assert.match(next.callback_data, /:3$/);
  assert.match(view.text, /&lt;Unsafe&gt;/);
});

test('filter UI exposes editable fields and a short cancel action in both languages', () => {
  for (const language of ['zh', 'ja'] as const) {
    const view = filterView(language, 'cm123456789012345678901234', 4, { actress: 'Actor', runtimeMin: 90 });
    const buttons = view.keyboard.inline_keyboard.flat();
    assert.match(view.text, /Actor/);
    assert.ok(buttons.some(button => 'callback_data' in button && button.callback_data.includes('filter:apply:')));
    assert.ok(buttons.every(button => !('callback_data' in button) || button.callback_data.length <= 64));
    assert.match(filterInputView(language, 'session-1', 5, 'actress').text, /演员|出演者/);
  }
});

test('long metadata stays within Telegram message limits after HTML escaping', () => {
  const detail = detailView('zh', 'session-1', 2, Array.from({ length: 10 }, (_, index) => [`字段 ${index}`, '&'.repeat(500)]));
  assert.ok(detail.text.length < 4096);
  assert.doesNotMatch(detail.text, /&amp…/);
  const results = resultsView('ja', 'session-1', 2, 1, Array.from({ length: 5 }, (_, index) => ({
    providerId: String(index), code: '&'.repeat(100), title: '<'.repeat(500), releaseDate: '&'.repeat(100), maker: '&'.repeat(500),
  })), false, false);
  assert.ok(results.text.length < 4096);
  assert.doesNotMatch(results.text, /&lt…/);
});

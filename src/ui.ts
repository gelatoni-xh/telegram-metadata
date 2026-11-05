import { InlineKeyboard } from 'grammy';
import type { Language } from './i18n.js';
import { t } from './i18n.js';
import type { MetadataSummary } from './provider.js';
import type { QueryFilterField } from './query.js';
import type { QueryFilters } from './provider.js';

export const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const clip = (value: string, max: number) => Array.from(value).length > max ? `${Array.from(value).slice(0, max - 1).join('')}…` : value;
function escapeWithin(value: string, budget: number) {
  let output = '';
  for (const char of value) {
    const escaped = escapeHtml(char);
    if (output.length + escaped.length > budget - 1) return `${output}…`;
    output += escaped;
  }
  return output;
}

export function homeView(language: Language) {
  const copy = t(language);
  const keyboard = new InlineKeyboard()
    .text(copy.search, 'search').row()
    .text(copy.language, 'language').text(copy.helpButton, 'help').row()
    .text(copy.privacyButton, 'privacy');
  return { text: `<b>${copy.brand}</b>\n\n${copy.home}`, keyboard };
}

export function ageView(language: Language) {
  const copy = t(language);
  const keyboard = new InlineKeyboard()
    .text(copy.confirmAge, 'age:confirm').row()
    .text(copy.declineAge, 'age:decline');
  return { text: `<b>${copy.ageTitle}</b>\n\n${copy.ageBody}`, keyboard };
}

export function languageView(language: Language) {
  const copy = t(language);
  return {
    text: copy.chooseLanguage,
    keyboard: new InlineKeyboard().text('中文', 'language:zh').text('日本語', 'language:ja').row().text(copy.homeButton, 'home'),
  };
}

export function simpleView(language: Language, heading: string, body: string) {
  const copy = t(language);
  return {
    text: `<b>${escapeHtml(heading)}</b>\n\n${escapeHtml(body)}`,
    keyboard: new InlineKeyboard().text(copy.homeButton, 'home'),
  };
}

export function queryView(language: Language, body: string, loading = false) {
  const copy = t(language);
  const keyboard = new InlineKeyboard();
  if (loading) keyboard.text(copy.cancelSearch, 'cancel');
  else keyboard.text(copy.homeButton, 'home');
  return { text: escapeHtml(body), keyboard };
}

export function resultsView(language: Language, sessionId: string, stateVersion: number, pageNumber: number, items: MetadataSummary[], hasPrevious: boolean, hasNext: boolean, total?: number, notice?: string) {
  const copy = t(language);
  const keyboard = new InlineKeyboard();
  items.forEach((item, index) => {
    const label = [item.code, item.title].filter(Boolean).join(' · ') || (language === 'zh' ? '查看记录' : '情報を表示');
    keyboard.text(`${index + 1}. ${clip(label, 48)}`, `detail:${sessionId}:${stateVersion}:${index}`).row();
  });
  keyboard.text(language === 'zh' ? '☷ 筛选' : '☷ 絞り込み', `filter:open:${sessionId}:${stateVersion}`).row();
  if (hasPrevious) keyboard.text(language === 'zh' ? '‹ 上一页' : '‹ 前へ', `page:prev:${sessionId}:${stateVersion}`);
  if (hasNext) keyboard.text(language === 'zh' ? '下一页 ›' : '次へ ›', `page:next:${sessionId}:${stateVersion}`);
  if (hasPrevious || hasNext) keyboard.row();
  keyboard.text(language === 'zh' ? '⌕ 新查询' : '⌕ 新しい検索', 'search').row();
  keyboard.text(copy.homeButton, 'home');
  const heading = language === 'zh' ? '查询结果' : '検索結果';
  const pageLabel = language === 'zh' ? `第 ${pageNumber} 页` : `${pageNumber} ページ`;
  const countLabel = total === undefined ? '' : language === 'zh' ? ` · 共 ${total} 条` : ` · ${total} 件`;
  const body = items.map((item, index) => [
    `<b>${index + 1}. ${escapeWithin(item.code ?? '', 90)}</b>`,
    escapeWithin(item.title ?? (language === 'zh' ? '标题暂缺' : 'タイトルなし'), 280),
    item.releaseDate ? escapeWithin(item.releaseDate, 60) : '',
    item.maker ? `${language === 'zh' ? '制作方' : 'メーカー'} · ${escapeWithin(item.maker, 140)}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
  const resultBody = body || (language === 'zh' ? '没有找到匹配记录。' : '一致する情報が見つかりません。');
  return { text: `<b>${heading}</b>\n${pageLabel}${countLabel}\n\n${notice ? `${escapeHtml(notice)}\n\n` : ''}${resultBody}`, keyboard };
}

const filterFields: Record<Language, Array<[QueryFilterField, string]>> = {
  zh: [
    ['actress', '演员'], ['maker', '制作方'], ['label', '厂牌'], ['series', '系列'],
    ['releaseAfter', '发行起始日'], ['releaseBefore', '发行结束日'], ['runtimeMin', '最短时长'], ['runtimeMax', '最长时长'],
  ],
  ja: [
    ['actress', '出演者'], ['maker', 'メーカー'], ['label', 'レーベル'], ['series', 'シリーズ'],
    ['releaseAfter', '発売開始日'], ['releaseBefore', '発売終了日'], ['runtimeMin', '最短時間'], ['runtimeMax', '最長時間'],
  ],
};

export function filterView(language: Language, sessionId: string, stateVersion: number, filters: QueryFilters, notice?: string) {
  const keyboard = new InlineKeyboard();
  const fields = filterFields[language];
  for (let index = 0; index < fields.length; index += 2) {
    const first = fields[index];
    const second = fields[index + 1];
    if (first) keyboard.text(`${first[1]}${filters[first[0]] === undefined ? '' : ' ✓'}`, `filter:field:${first[0]}:${sessionId}:${stateVersion}`);
    if (second) keyboard.text(`${second[1]}${filters[second[0]] === undefined ? '' : ' ✓'}`, `filter:field:${second[0]}:${sessionId}:${stateVersion}`);
    keyboard.row();
  }
  const order = filters.sort === 'release'
    ? (language === 'zh' ? '发行日期 ↓' : '発売日 ↓')
    : (language === 'zh' ? '相关度' : '関連度');
  keyboard.text(`${language === 'zh' ? '排序' : '並び順'}：${order}`, `filter:sort:${sessionId}:${stateVersion}`).row();
  keyboard.text(language === 'zh' ? '应用' : '適用', `filter:apply:${sessionId}:${stateVersion}`)
    .text(language === 'zh' ? '重置' : 'リセット', `filter:reset:${sessionId}:${stateVersion}`).row()
    .text(language === 'zh' ? '取消' : 'キャンセル', `filter:cancel:${sessionId}:${stateVersion}`);
  const summary = fields.flatMap(([field, label]) => filters[field] === undefined ? [] : [`${label}：${filters[field]}`]);
  const empty = language === 'zh' ? '未设置筛选条件' : '絞り込み条件なし';
  const heading = language === 'zh' ? '筛选条件' : '絞り込み';
  const hint = language === 'zh' ? '点选条件后发送内容。日期格式：YYYY-MM-DD；时长单位：分钟。' : '条件を選び、値を送信してください。日付：YYYY-MM-DD、時間：分。';
  return { text: `<b>${heading}</b>\n${escapeHtml(summary.join('\n') || empty)}\n\n${notice ? `${escapeHtml(notice)}\n\n` : ''}${escapeHtml(hint)}`, keyboard };
}

export function filterInputView(language: Language, sessionId: string, stateVersion: number, field: QueryFilterField) {
  const label = filterFields[language].find(([key]) => key === field)?.[1] ?? '';
  const prompt = language === 'zh' ? `发送${label}筛选值。输入 - 可清除此项。` : `${label}の値を送信してください。「-」で解除できます。`;
  const keyboard = new InlineKeyboard().text(language === 'zh' ? '返回筛选' : '絞り込みに戻る', `filter:return:${sessionId}:${stateVersion}`);
  return { text: escapeHtml(prompt), keyboard };
}

export function detailView(language: Language, sessionId: string, stateVersion: number, values: Array<[string, string]>) {
  const labels = language === 'zh'
    ? { back: '‹ 返回列表', home: t(language).homeButton }
    : { back: '‹ 一覧に戻る', home: t(language).homeButton };
  const keyboard = new InlineKeyboard().text(labels.back, `back:${sessionId}:${stateVersion}`).row().text(labels.home, 'home');
  const content = values.slice(0, 10).map(([label, value]) => label
    ? `<b>${escapeHtml(label)}</b>\n${escapeWithin(value, 300)}`
    : escapeWithin(value, 300)).join('\n\n');
  return { text: content || (language === 'zh' ? '暂时没有可展示的文本详情。' : '表示できるテキスト情報がありません。'), keyboard };
}

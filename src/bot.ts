import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy';
import type { Prisma } from '@prisma/client';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { isLanguage, languageFromTelegram, t, type Language } from './i18n.js';
import { filterStateFromJson, normalizeFilterValue, normalizeQuery, queryFilterFields, validateQueryFilters, type QueryFilterField } from './query.js';
import { JavInfoApiError, ProviderNotVerifiedError, type MetadataProvider, type QueryFilters } from './provider.js';
import { ageView, detailView, filterInputView, filterView, homeView, languageView, queryView, resultsView, simpleView } from './ui.js';
import { allowMetadata } from './content-policy.js';
import type { MetadataSummary } from './provider.js';
import { configureAdministratorCommands } from './commands.js';

type Profile = Awaited<ReturnType<Db['user']['upsert']>>;

export function createBot(db: Db, config: Config, provider: MetadataProvider, botInfo?: ConstructorParameters<typeof Bot>[1]) {
  const bot = new Bot(config.BOT_TOKEN, botInfo);

  async function profile(ctx: Context): Promise<Profile | null> {
    if (!ctx.from || !ctx.chat || ctx.chat.type !== 'private' || ctx.from.is_bot) return null;
    return db.user.upsert({
      where: { telegramUserId: BigInt(ctx.from.id) },
      create: {
        telegramUserId: BigInt(ctx.from.id),
        chatId: BigInt(ctx.chat.id),
        language: languageFromTelegram(ctx.from.language_code),
      },
      update: { chatId: BigInt(ctx.chat.id), lastSeenAt: new Date() },
    });
  }

  async function screen(ctx: Context, text: string, keyboard: InlineKeyboard) {
    const options = { reply_markup: keyboard, parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, options);
        return;
      } catch (error) {
        if (error instanceof GrammyError && error.error_code === 400 && error.description.includes('message is not modified')) return;
        if (!(error instanceof GrammyError && error.error_code === 400)) throw error;
      }
    }
    await ctx.reply(text, options);
  }

  async function editMessage(ctx: Context, chatId: bigint, messageId: number, text: string, keyboard: InlineKeyboard) {
    await ctx.api.editMessageText(String(chatId), messageId, text, {
      reply_markup: keyboard,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }

  async function showHome(ctx: Context, user: Profile) {
    const view = homeView(user.language as Language);
    await screen(ctx, view.text, view.keyboard);
  }

  function providerFailure(language: Language, error: unknown): string {
    const copy = t(language);
    if (error instanceof JavInfoApiError) {
      if (error.status === 401) return copy.queryUnauthorized;
      if (error.status === 402) return copy.queryNoCredit;
      if (error.status === 429) return copy.queryRateLimited;
      if (error.status === 503) return copy.querySourceBusy;
    }
    return copy.queryUnavailable;
  }

  async function startSearch(ctx: Context, user: Profile) {
    const copy = t(user.language as Language);
    if (!user.ageConfirmedAt) {
      const view = ageView(user.language as Language);
      await screen(ctx, `<b>${copy.adultRequired}</b>\n\n${view.text}`, view.keyboard);
      return;
    }
    const view = queryView(user.language as Language, copy.queryPrompt);
    await screen(ctx, view.text, view.keyboard);
  }

  async function query(ctx: Context, user: Profile, text: string) {
    const language = user.language as Language;
    const copy = t(language);
    if (!user.ageConfirmedAt) {
      const view = ageView(language);
      await screen(ctx, `<b>${copy.adultRequired}</b>\n\n${view.text}`, view.keyboard);
      return;
    }
    let normalized: ReturnType<typeof normalizeQuery>;
    try {
      normalized = normalizeQuery(text);
    } catch (error) {
      const view = queryView(language, error instanceof Error && error.message === 'query_too_long' ? copy.queryTooLong : copy.emptyQuery);
      await screen(ctx, view.text, view.keyboard);
      return;
    }
    if (!normalized) {
      const view = queryView(language, copy.emptyQuery);
      await screen(ctx, view.text, view.keyboard);
      return;
    }

    const expiresAt = new Date(Date.now() + config.QUERY_SESSION_TTL_SECONDS * 1000);
    const session = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: user.id }, select: { ageConfirmedAt: true } });
      if (!current?.ageConfirmedAt) return null;
      const created = await tx.querySession.create({
        data: {
          userId: user.id,
          queryText: normalized.text,
          queryKind: normalized.kind,
          filtersJson: { applied: {}, draft: {} },
          expiresAt,
        },
      });
      await tx.user.update({ where: { id: user.id }, data: { activeSessionId: created.id } });
      return created;
    });
    if (!session) {
      const view = ageView(language);
      await screen(ctx, `<b>${copy.adultRequired}</b>\n\n${view.text}`, view.keyboard);
      return;
    }
    const loading = queryView(language, `${copy.queryLoading}\n\n${normalized.text}`, true);
    const statusMessage = await ctx.reply(loading.text, {
      reply_markup: loading.keyboard,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });

    try {
      const page = await provider.search({ text: normalized.text, kind: normalized.kind, pageSize: 5, filters: {} });
      const items = page.items.map(item => ({
        ...allowMetadata(item as unknown as Record<string, unknown>),
        providerId: item.providerId,
      }) as unknown as MetadataSummary);
      await db.querySession.update({ where: { id: session.id }, data: {
        itemsJson: items as unknown as Prisma.InputJsonValue,
        pageToken: page.nextPageToken,
        previousPageToken: page.previousPageToken,
        totalCount: page.total,
      } });
      const updatedUser = await db.user.findUnique({ where: { id: user.id } });
      const updatedSession = await db.querySession.findUnique({ where: { id: session.id } });
      if (!updatedUser || updatedUser.activeSessionId !== session.id || !updatedSession || updatedSession.expiresAt <= new Date()) return;
      const view = resultsView(language, session.id, updatedSession.stateVersion, 1, items, false, Boolean(page.nextPageToken), page.total);
      await editMessage(ctx, user.chatId, statusMessage.message_id, view.text, view.keyboard);
    } catch (error) {
      const [latestUser, latestSession] = await Promise.all([
        db.user.findUnique({ where: { id: user.id }, select: { activeSessionId: true } }),
        db.querySession.findUnique({ where: { id: session.id }, select: { stateVersion: true, expiresAt: true } }),
      ]);
      if (latestUser?.activeSessionId !== session.id || latestSession?.stateVersion !== session.stateVersion || !latestSession || latestSession.expiresAt <= new Date()) return;
      const reason = error instanceof ProviderNotVerifiedError ? copy.queryUnavailable : providerFailure(language, error);
      const view = queryView(language, reason);
      await editMessage(ctx, user.chatId, statusMessage.message_id, view.text, view.keyboard);
    }
  }

  async function ownedSession(ctx: Context, user: Profile, id: string, expectedVersion: number) {
    const session = await db.querySession.findFirst({ where: { id, userId: user.id, expiresAt: { gt: new Date() } } });
    if (!session || user.activeSessionId !== session.id || session.stateVersion !== expectedVersion) {
      try { await ctx.answerCallbackQuery({ text: user.language === 'ja' ? 'この操作は期限切れです。' : '此操作已过期。', show_alert: true }); } catch { /* already answered */ }
      return null;
    }
    await ctx.answerCallbackQuery();
    return session;
  }

  function itemsFromSession(value: Prisma.JsonValue): MetadataSummary[] {
    return Array.isArray(value) ? value as unknown as MetadataSummary[] : [];
  }

  async function renderResults(ctx: Context, user: Profile, session: NonNullable<Awaited<ReturnType<typeof db.querySession.findFirst>>>) {
    const items = itemsFromSession(session.itemsJson);
    const view = resultsView(user.language as Language, session.id, session.stateVersion, session.pageNumber + 1, items, Boolean(session.previousPageToken), Boolean(session.pageToken), session.totalCount ?? undefined);
    return screen(ctx, view.text, view.keyboard);
  }

  async function renderFilterMenu(ctx: Context, user: Profile, session: NonNullable<Awaited<ReturnType<typeof db.querySession.findFirst>>>, notice?: string) {
    const filters = filterStateFromJson(session.filtersJson).draft;
    const view = filterView(user.language as Language, session.id, session.stateVersion, filters, notice);
    return screen(ctx, view.text, view.keyboard);
  }

  function detailFields(raw: Record<string, unknown>, language: Language): Array<[string, string]> {
    const item = allowMetadata(raw);
    const names: Record<string, string> = language === 'zh'
      ? { code: '影片编号', title: '标题', releaseDate: '发行日期', durationMinutes: '时长（分钟）', actors: '演员', maker: '制作方', label: '厂牌', series: '系列', director: '导演', genres: '分类' }
      : { code: '作品番号', title: 'タイトル', releaseDate: '発売日', durationMinutes: '長さ（分）', actors: '出演者', maker: 'メーカー', label: 'レーベル', series: 'シリーズ', director: '監督', genres: 'ジャンル' };
    return Object.entries(names).flatMap(([key, label]) => {
      const value = item[key];
      if (value === undefined || value === null || value === '') return [];
    const text = Array.isArray(value) ? value.map(entry => typeof entry === 'string' ? entry : '').filter(Boolean).join('、') : String(value);
      return text ? [[label, text] as [string, string]] : [];
    });
  }

  bot.command('start', async (ctx) => {
    let user = await profile(ctx);
    if (!user) return;
    if (String(user.telegramUserId) === config.ADMIN_TELEGRAM_ID) await configureAdministratorCommands(bot, config);
    await db.querySession.deleteMany({ where: { userId: user.id } });
    user = await db.user.update({ where: { id: user.id }, data: { activeSessionId: null } });
    if (!user.ageConfirmedAt) {
      const view = ageView(user.language as Language);
      return screen(ctx, view.text, view.keyboard);
    }
    return showHome(ctx, user);
  });
  bot.command('help', async (ctx) => {
    const user = await profile(ctx);
    if (!user) return;
    const view = simpleView(user.language as Language, t(user.language as Language).helpButton, t(user.language as Language).help);
    return screen(ctx, view.text, view.keyboard);
  });
  bot.command('language', async (ctx) => {
    const user = await profile(ctx);
    if (!user) return;
    const view = languageView(user.language as Language);
    return screen(ctx, view.text, view.keyboard);
  });
  bot.command('cancel', async (ctx) => {
    const user = await profile(ctx);
    if (!user) return;
    await db.querySession.deleteMany({ where: { userId: user.id } });
    await db.user.update({ where: { id: user.id }, data: { activeSessionId: null } });
    const view = simpleView(user.language as Language, t(user.language as Language).homeButton, t(user.language as Language).cancelDone);
    return screen(ctx, view.text, view.keyboard);
  });
  bot.command('privacy', async (ctx) => {
    const user = await profile(ctx);
    if (!user) return;
    const language = user.language as Language;
    const copy = t(language);
    const keyboard = new InlineKeyboard().text(language === 'zh' ? '清除年龄确认' : '年齢確認を解除', 'privacy:reset').row().text(copy.homeButton, 'home');
    return screen(ctx, `<b>${copy.privacyButton}</b>\n\n${copy.privacy}`, keyboard);
  });
  bot.command('status', async (ctx) => {
    const user = await profile(ctx);
    if (!user) return;
    const language = user.language as Language;
    if (!config.ADMIN_TELEGRAM_ID || !ctx.from || String(ctx.from.id) !== config.ADMIN_TELEGRAM_ID) {
      const view = simpleView(language, language === 'zh' ? '无权限' : '権限がありません', language === 'zh' ? '此命令不可用。' : 'このコマンドは利用できません。');
      return screen(ctx, view.text, view.keyboard);
    }
    try {
      const status = await provider.accountStatus();
      const paid = status.hasPaid === undefined ? (language === 'zh' ? '未提供' : '未提供') : language === 'zh' ? (status.hasPaid ? '已充值' : '未充值') : (status.hasPaid ? 'チャージ済み' : '未チャージ');
      const text = language === 'zh'
        ? `上游连通：${status.reachable ? '正常' : '不可用'}\n余额：${status.balance ?? '未提供'}\n充值状态：${paid}\n每分钟限速：${status.rateLimit ?? '未提供'}`
        : `接続：${status.reachable ? '正常' : '利用不可'}\n残高：${status.balance ?? '未提供'}\nチャージ状態：${paid}\n毎分制限：${status.rateLimit ?? '未提供'}`;
      const view = simpleView(language, '/status', text);
      return screen(ctx, view.text, view.keyboard);
    } catch (error) {
      const view = simpleView(language, '/status', providerFailure(language, error));
      return screen(ctx, view.text, view.keyboard);
    }
  });

  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    const user = await profile(ctx);
    if (!user) return;
    if (user.ageConfirmedAt && user.activeSessionId) {
      const session = await db.querySession.findFirst({
        where: { id: user.activeSessionId, userId: user.id, expiresAt: { gt: new Date() } },
      });
      const field = session?.view.startsWith('filter-input:') ? session.view.slice('filter-input:'.length) as QueryFilterField : undefined;
      if (session && field && queryFilterFields.includes(field)) {
        const state = filterStateFromJson(session.filtersJson);
        const draft: QueryFilters = { ...state.draft };
        let errorText: string | undefined;
        if (ctx.message.text.trim() === '-') delete draft[field];
        else {
          try {
            (draft as Record<string, string | number>)[field] = normalizeFilterValue(field, ctx.message.text);
          } catch (error) {
            const reason = error instanceof Error ? error.message : '';
            errorText = reason === 'filter_date_invalid'
              ? (user.language === 'ja' ? '日付は YYYY-MM-DD 形式で入力してください。' : '日期请使用 YYYY-MM-DD 格式。')
              : reason === 'filter_runtime_invalid'
                ? (user.language === 'ja' ? '時間は 0〜2000 分で入力してください。' : '时长请输入 0 到 2000 分钟。')
                : reason === 'filter_value_too_long'
                  ? (user.language === 'ja' ? '値は 100 文字以内で入力してください。' : '筛选值请控制在 100 个字符以内。')
                  : (user.language === 'ja' ? '値を入力してください。' : '请输入筛选值。');
          }
        }
        if (errorText) {
          const view = filterInputView(user.language as Language, session.id, session.stateVersion, field);
          return ctx.reply(`${errorText}\n${view.text}`, { reply_markup: view.keyboard, parse_mode: 'HTML' });
        }
        const changed = await db.querySession.updateMany({
          where: { id: session.id, stateVersion: session.stateVersion, view: session.view },
          data: {
            stateVersion: { increment: 1 },
            view: 'filterMenu',
            filtersJson: { applied: state.applied, draft } as unknown as Prisma.InputJsonValue,
          },
        });
        if (changed.count) {
          const updated = await db.querySession.findUnique({ where: { id: session.id } });
          if (updated) return renderFilterMenu(ctx, user, updated);
        }
        return;
      }
    }
    await query(ctx, user, ctx.message.text);
  });

  bot.callbackQuery(/.*/, async (ctx) => {
    const user = await profile(ctx);
    if (!user) {
      await ctx.answerCallbackQuery();
      return;
    }
    const data = ctx.callbackQuery.data;
    const language = user.language as Language;
    if (!data.startsWith('page:') && !data.startsWith('detail:') && !data.startsWith('back:') && !data.startsWith('filter:')) await ctx.answerCallbackQuery();
    if (data === 'age:confirm') {
      const updated = await db.user.update({ where: { id: user.id }, data: { ageConfirmedAt: new Date() } });
      return showHome(ctx, updated);
    }
    if (data === 'age:decline') {
      const view = simpleView(language, t(language).ageTitle, t(language).declined);
      return screen(ctx, view.text, view.keyboard);
    }
    if (data === 'language') {
      const view = languageView(language);
      return screen(ctx, view.text, view.keyboard);
    }
    if (data.startsWith('language:')) {
      const selected = data.slice('language:'.length);
      if (!isLanguage(selected)) return;
      const updated = await db.user.update({ where: { id: user.id }, data: { language: selected } });
      return showHome(ctx, updated);
    }
    if (data === 'search') return startSearch(ctx, user);
    if (data.startsWith('filter:')) {
      const parts = data.split(':');
      const action = parts[1];
      const id = parts[action === 'field' ? 3 : 2];
      const versionRaw = parts[action === 'field' ? 4 : 3];
      const expectedVersion = Number(versionRaw);
      if (!id || !Number.isSafeInteger(expectedVersion)) { await ctx.answerCallbackQuery(); return; }
      const session = await ownedSession(ctx, user, id, expectedVersion);
      if (!session) return;
      const state = filterStateFromJson(session.filtersJson);

      if (action === 'open' || action === 'return') {
        const changed = await db.querySession.updateMany({
          where: { id, stateVersion: expectedVersion },
          data: {
            stateVersion: { increment: 1 },
            view: 'filterMenu',
            filtersJson: { applied: state.applied, draft: action === 'return' ? state.draft : state.applied } as unknown as Prisma.InputJsonValue,
          },
        });
        if (!changed.count) return;
        const updated = await db.querySession.findUnique({ where: { id } });
        if (updated) return renderFilterMenu(ctx, user, updated);
      }

      if (action === 'field') {
        const field = parts[2] as QueryFilterField;
        if (!queryFilterFields.includes(field)) return;
        const changed = await db.querySession.updateMany({
          where: { id, stateVersion: expectedVersion },
          data: { stateVersion: { increment: 1 }, view: `filter-input:${field}` },
        });
        if (!changed.count) return;
        const view = filterInputView(language, id, expectedVersion + 1, field);
        return screen(ctx, view.text, view.keyboard);
      }

      if (action === 'sort') {
        const draft = { ...state.draft, sort: state.draft.sort === 'release' ? 'relevance' : 'release' };
        const changed = await db.querySession.updateMany({
          where: { id, stateVersion: expectedVersion },
          data: { stateVersion: { increment: 1 }, view: 'filterMenu', filtersJson: { applied: state.applied, draft } as unknown as Prisma.InputJsonValue },
        });
        if (!changed.count) return;
        const updated = await db.querySession.findUnique({ where: { id } });
        if (updated) return renderFilterMenu(ctx, user, updated);
      }

      if (action === 'reset') {
        const changed = await db.querySession.updateMany({
          where: { id, stateVersion: expectedVersion },
          data: {
            stateVersion: { increment: 1 },
            view: 'filterMenu',
            filtersJson: { applied: state.applied, draft: {} } as unknown as Prisma.InputJsonValue,
          },
        });
        if (!changed.count) return;
        const updated = await db.querySession.findUnique({ where: { id } });
        if (updated) return renderFilterMenu(ctx, user, updated);
      }

      if (action === 'cancel') {
        const changed = await db.querySession.updateMany({
          where: { id, stateVersion: expectedVersion },
          data: {
            stateVersion: { increment: 1 },
            view: 'results',
            filtersJson: { applied: state.applied, draft: state.applied } as unknown as Prisma.InputJsonValue,
          },
        });
        if (!changed.count) return;
        const updated = await db.querySession.findUnique({ where: { id } });
        if (updated) return renderResults(ctx, user, updated);
      }

      if (action === 'apply') {
        try {
          validateQueryFilters(state.draft);
        } catch (error) {
          const message = error instanceof Error && error.message === 'filter_date_range_invalid'
            ? (language === 'zh' ? '发行日期范围无效，请检查起止日期。' : '発売日の範囲を確認してください。')
            : (language === 'zh' ? '时长范围无效，请检查最短和最长时长。' : '時間の範囲を確認してください。');
          const view = filterView(language, id, expectedVersion, state.draft, message);
          return screen(ctx, view.text, view.keyboard);
        }
        const claimed = await db.querySession.updateMany({
          where: { id, stateVersion: expectedVersion },
          data: { stateVersion: { increment: 1 }, view: 'filterLoading' },
        });
        if (!claimed.count) return;
        const loading = queryView(language, t(language).queryLoading, true);
        await screen(ctx, loading.text, loading.keyboard);
        try {
          const page = await provider.search({
            text: session.queryText,
            kind: session.queryKind as 'code' | 'keyword',
            pageSize: 5,
            filters: state.draft,
          });
          const items = page.items.map(item => ({
            ...allowMetadata(item as unknown as Record<string, unknown>),
            providerId: item.providerId,
          })) as unknown as MetadataSummary[];
          const changed = await db.querySession.updateMany({
            where: { id, stateVersion: expectedVersion + 1 },
            data: {
              stateVersion: { increment: 1 },
              filtersJson: { applied: state.draft, draft: state.draft } as unknown as Prisma.InputJsonValue,
              itemsJson: items as unknown as Prisma.InputJsonValue,
              pageNumber: 0,
              previousPageToken: page.previousPageToken ?? null,
              pageToken: page.nextPageToken ?? null,
              totalCount: page.total ?? null,
              view: 'results',
            },
          });
          if (!changed.count) return;
          const [latestUser, updated] = await Promise.all([
            db.user.findUnique({ where: { id: user.id } }),
            db.querySession.findUnique({ where: { id } }),
          ]);
          if (!latestUser || latestUser.activeSessionId !== id || !updated) return;
          const view = resultsView(language, id, updated.stateVersion, 1, items, Boolean(page.previousPageToken), Boolean(page.nextPageToken), page.total);
          return screen(ctx, view.text, view.keyboard);
        } catch (error) {
          const changed = await db.querySession.updateMany({
            where: { id, stateVersion: expectedVersion + 1 },
            data: {
              stateVersion: { increment: 1 },
              view: 'results',
              filtersJson: { applied: state.applied, draft: state.applied } as unknown as Prisma.InputJsonValue,
            },
          });
          if (!changed.count) return;
          const updated = await db.querySession.findUnique({ where: { id } });
          if (!updated) return;
          const items = itemsFromSession(updated.itemsJson);
          const notice = providerFailure(language, error);
          const view = resultsView(language, id, updated.stateVersion, updated.pageNumber + 1, items, Boolean(updated.previousPageToken), Boolean(updated.pageToken), updated.totalCount ?? undefined, notice);
          return screen(ctx, view.text, view.keyboard);
        }
      }
    }
    if (data === 'help') {
      const view = simpleView(language, t(language).helpButton, t(language).help);
      return screen(ctx, view.text, view.keyboard);
    }
    if (data === 'privacy') {
      const view = simpleView(language, t(language).privacyButton, t(language).privacy);
      const keyboard = new InlineKeyboard().text(language === 'zh' ? '清除年龄确认' : '年齢確認を解除', 'privacy:reset').row().text(t(language).homeButton, 'home');
      return screen(ctx, view.text, keyboard);
    }
    if (data === 'privacy:reset') {
      await db.user.update({ where: { id: user.id }, data: { ageConfirmedAt: null, activeSessionId: null } });
      await db.querySession.deleteMany({ where: { userId: user.id } });
      const view = simpleView(language, t(language).privacyButton, t(language).privacyReset);
      return screen(ctx, view.text, view.keyboard);
    }
    if (data === 'home' || data === 'cancel') {
      await db.querySession.deleteMany({ where: { userId: user.id } });
      const updated = await db.user.update({ where: { id: user.id }, data: { activeSessionId: null } });
      return showHome(ctx, updated);
    }
    if (data.startsWith('page:')) {
      const [, direction, id, versionRaw] = data.split(':');
      const expectedVersion = Number(versionRaw);
      if (!id || !Number.isSafeInteger(expectedVersion)) { await ctx.answerCallbackQuery(); return; }
      const session = await ownedSession(ctx, user, id, expectedVersion);
      if (!session) return;
      const token = direction === 'next' ? session.pageToken : session.previousPageToken;
      if (!token) return renderResults(ctx, user, session);
      const claimed = await db.querySession.updateMany({ where: { id, stateVersion: expectedVersion }, data: { stateVersion: { increment: 1 }, view: 'loading' } });
      if (!claimed.count) return;
      const nextVersion = expectedVersion + 1;
      const loading = queryView(language, t(language).queryLoading, true);
      await screen(ctx, loading.text, loading.keyboard);
      try {
        const filters = filterStateFromJson(session.filtersJson).applied;
        const page = await provider.search({ text: session.queryText, kind: session.queryKind as 'code' | 'keyword', pageToken: token, pageSize: 5, filters });
        if (!page.items.length) {
          const finished = await db.querySession.updateMany({
            where: { id, stateVersion: nextVersion },
            data: { stateVersion: { increment: 1 }, pageToken: null, view: 'results' },
          });
          if (!finished.count) return;
          const [latestUser, updated] = await Promise.all([
            db.user.findUnique({ where: { id: user.id } }),
            db.querySession.findUnique({ where: { id } }),
          ]);
          if (!latestUser || latestUser.activeSessionId !== id || !updated) return;
          const notice = language === 'zh' ? '已经没有更多结果。' : 'これ以上の結果はありません。';
          const items = itemsFromSession(updated.itemsJson);
          const view = resultsView(language, id, updated.stateVersion, updated.pageNumber + 1, items, Boolean(updated.previousPageToken), false, updated.totalCount ?? undefined, notice);
          return screen(ctx, view.text, view.keyboard);
        }
        await db.querySession.updateMany({
          where: { id, stateVersion: nextVersion },
          data: {
            stateVersion: { increment: 1 },
            pageNumber: { increment: direction === 'next' ? 1 : -1 },
            previousPageToken: page.previousPageToken ?? null,
            pageToken: page.nextPageToken ?? null,
            itemsJson: page.items.map(item => ({
              ...allowMetadata(item as unknown as Record<string, unknown>),
              providerId: item.providerId,
            })) as unknown as Prisma.InputJsonValue,
            totalCount: page.total ?? null,
            view: 'results',
          },
        });
        const updatedUser = await db.user.findUnique({ where: { id: user.id } });
        const updated = await db.querySession.findUnique({ where: { id } });
        if (!updatedUser || updatedUser.activeSessionId !== id || !updated || updated.stateVersion !== nextVersion + 1) return;
        const view = resultsView(language, id, updated.stateVersion, updated.pageNumber + 1, itemsFromSession(updated.itemsJson), Boolean(page.previousPageToken), Boolean(page.nextPageToken), page.total);
        return screen(ctx, view.text, view.keyboard);
      } catch (error) {
        const [latestUser, latestSession] = await Promise.all([
          db.user.findUnique({ where: { id: user.id }, select: { activeSessionId: true } }),
          db.querySession.findUnique({ where: { id }, select: { stateVersion: true } }),
        ]);
        if (latestUser?.activeSessionId !== id || latestSession?.stateVersion !== nextVersion) return;
        const view = queryView(language, providerFailure(language, error));
        return screen(ctx, view.text, view.keyboard);
      }
    }
    if (data.startsWith('detail:')) {
      const [, id, versionRaw, indexRaw] = data.split(':');
      const expectedVersion = Number(versionRaw), index = Number(indexRaw);
      if (!id || !Number.isSafeInteger(expectedVersion) || !Number.isSafeInteger(index) || index < 0) { await ctx.answerCallbackQuery(); return; }
      const session = await ownedSession(ctx, user, id, expectedVersion);
      if (!session) return;
      const summary = itemsFromSession(session.itemsJson)[index];
      if (!summary) return renderResults(ctx, user, session);
      const claimed = await db.querySession.updateMany({ where: { id, stateVersion: expectedVersion }, data: { stateVersion: { increment: 1 }, view: 'detail' } });
      if (!claimed.count) return;
      const nextVersion = expectedVersion + 1;
      try {
        const raw = await provider.detail(summary.providerId);
        if (!raw) throw new Error('detail_missing');
        const values = detailFields(raw, language);
        const view = detailView(language, id, nextVersion, values);
        const [latestUser, latestSession] = await Promise.all([
          db.user.findUnique({ where: { id: user.id } }),
          db.querySession.findUnique({ where: { id } }),
        ]);
        if (latestUser?.activeSessionId === id && latestSession?.stateVersion === nextVersion) return screen(ctx, view.text, view.keyboard);
      } catch {
        const [latestUser, latestSession] = await Promise.all([
          db.user.findUnique({ where: { id: user.id }, select: { activeSessionId: true } }),
          db.querySession.findUnique({ where: { id }, select: { stateVersion: true } }),
        ]);
        if (latestUser?.activeSessionId !== id || latestSession?.stateVersion !== nextVersion) return;
        const copy = language === 'zh' ? '这条记录暂时无法查看。' : 'この情報は現在表示できません。';
        const view = detailView(language, id, nextVersion, [['', copy]]);
        return screen(ctx, view.text, view.keyboard);
      }
    }
    if (data.startsWith('back:')) {
      const [, id, versionRaw] = data.split(':');
      const expectedVersion = Number(versionRaw);
      if (id && Number.isSafeInteger(expectedVersion)) {
        const session = await ownedSession(ctx, user, id, expectedVersion);
        if (session) return renderResults(ctx, user, session);
      }
    }
  });

  bot.catch((error) => console.error(JSON.stringify({ event: 'bot_error', error: error.error instanceof Error ? error.error.name : 'unknown' })));
  return bot;
}

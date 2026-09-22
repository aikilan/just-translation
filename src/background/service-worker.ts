import { initializeBackgroundLanguage } from './ui-language';
import { message, LocalizedError } from '../shared/i18n';
import { configuredProviderOptions } from '../shared/providers';
import { translateBatch, translateFullDocument } from '../shared/translation-client';
import { AbortableRequestRegistry } from './request-registry';
import { ProviderRequestQueue } from './provider-request-queue';
import { SelectionTranslationService } from './selection-translation';
import {
  ensurePageTranslationMenu,
  handlePageTranslationMenuClick,
  RetryMenuRegistration,
  RETRY_FAILED_MENU_ID,
  retryFailedMenuProperties,
} from './context-menu';
import {
  readPublicSettings,
  saveTranslationProfile,
  deleteTranslationProfile,
  updateReadingPreferences,
  updateUiLanguage,
  updateSiteRule,
  selectActiveProfile,
  setSiteAutoTranslation,
} from './configuration-service';
import { getSettings, initializeSettings } from '../shared/settings-store';
import {
  getErrorMessage,
  type Result,
  type RuntimeRequest,
  type TranslationPriority,
  type TranslationBatchProgress,
} from '../shared/messages';
import { getActiveProfile, validateTranslationProfile } from '../shared/settings';
import { CandidateResolver } from './candidate-resolver';
import { ensureCacheCleanupAlarm, runCacheCleanupForAlarm } from './cache-maintenance';
import {
  TranslationCache,
  createTranslationCacheKey,
  type TranslationCacheContext,
} from './translation-cache';
import {
  TranslationSessionStore,
  type TranslationSessionContext,
  type TranslationSessionIdentity,
} from './translation-session-store';

// 后台唯一入口：负责持久化设置、AI 请求调度和浏览器右键菜单注册。
const activeRequests = new AbortableRequestRegistry(60_000);
const providerRequests = new ProviderRequestQueue();
const selectionTranslations = new SelectionTranslationService(
  getSettings,
  (details) => chrome.webNavigation.getFrame(details),
  providerRequests,
);
const translationCache = new TranslationCache();
const candidateResolver = new CandidateResolver(translationCache);
const translationSessions = new TranslationSessionStore(chrome.storage.session);
const translationBatches = new Map<
  string,
  {
    priority: TranslationPriority;
    priorityRevision: number;
    cancelled: boolean;
    started: boolean;
    deferred: boolean;
  }
>();

const TRANSLATION_REQUEST_POLICIES: Readonly<Record<TranslationPriority, { timeoutMs: number }>> = {
  visible: { timeoutMs: 20_000 },
  readAhead: { timeoutMs: 30_000 },
  background: { timeoutMs: 60_000 },
};

void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void initializeSettings();
void ensureCacheCleanupAlarm(chrome.alarms);
// One registration per worker evaluation also covers install/startup, without concurrent resets.
const menuReady = ensureContextMenu();
initializeBackgroundLanguage(menuReady);
const retryMenu = new RetryMenuRegistration(
  async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) return undefined;
    return chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_STATUS' }, { frameId: 0 });
  },
  async (registered) => {
    await menuReady;
    if (registered) await createContextMenu(retryFailedMenuProperties());
    else await chrome.contextMenus.remove(RETRY_FAILED_MENU_ID);
  },
);
refreshRetryMenu();
chrome.tabs.onActivated.addListener(refreshRetryMenu);
chrome.windows.onFocusChanged.addListener(refreshRetryMenu);
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.status || change.url) refreshRetryMenu();
});

chrome.runtime.onInstalled.addListener(() => {
  void initializeSettings();
  void ensureCacheCleanupAlarm(chrome.alarms);
});

chrome.runtime.onStartup.addListener(() => {
  void ensureCacheCleanupAlarm(chrome.alarms);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void runCacheCleanupForAlarm(alarm, translationCache).catch((error: unknown) => {
    console.error('翻译缓存定时清理失败', error);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handlePageTranslationMenuClick(
    info,
    tab?.id,
    (tabId, command, options) => chrome.tabs.sendMessage(tabId, command, options),
    async (tabId, frameId) => (await chrome.webNavigation.getFrame({ tabId, frameId }))?.documentId,
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  refreshRetryMenu();
  selectionTranslations.removeTab(tabId);
  activeRequests.cancelForTab(tabId);
  void translationSessions.deleteForTab(tabId).catch((error: unknown) => {
    console.error('翻译会话清理失败', error);
  });
});

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, documentId }) => {
  selectionTranslations.navigate(tabId, frameId, documentId);
  if (frameId !== 0) return;
  refreshRetryMenu();
  activeRequests.cancelOtherDocuments(tabId, documentId);
  void translationSessions.deleteOtherDocuments(tabId, documentId).catch((error: unknown) => {
    console.error('旧网页翻译会话清理失败', error);
  });
});

chrome.runtime.onMessage.addListener(
  (request: RuntimeRequest, sender, sendResponse: (response: Result<unknown>) => void) => {
    void handleRuntimeRequest(request, sender).then(sendResponse);
    return true;
  },
);

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'translate-page') return;
  void getActiveTabId().then((tabId) => {
    if (tabId !== undefined) {
      return chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_TRANSLATION' });
    }
    return undefined;
  });
});

async function handleRuntimeRequest(
  request: RuntimeRequest,
  sender: chrome.runtime.MessageSender,
): Promise<Result<unknown>> {
  try {
    // Content scripts can translate, but cannot mutate credentials or global preferences.
    if (
      !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`) &&
      [
        'SAVE_TRANSLATION_PROFILE',
        'DELETE_TRANSLATION_PROFILE',
        'UPDATE_READING_PREFERENCES',
        'UPDATE_UI_LANGUAGE',
        'UPDATE_SITE_RULE',
        'SET_ACTIVE_PROFILE',
        'SET_SITE_AUTO_TRANSLATE',
      ].includes(request.type)
    ) {
      throw new LocalizedError(message('设置只能由扩展页面修改'));
    }
    switch (request.type) {
      case 'PAGE_RETRY_STATE_CHANGED':
        if (sender.frameId === 0 && sender.tab?.id !== undefined) await retryMenu.refresh();
        return { ok: true, data: undefined };
      case 'TRANSLATE_SELECTION':
        return {
          ok: true,
          data: await selectionTranslations.translate(sender, request.requestId, request.text),
        };
      case 'CANCEL_SELECTION_TRANSLATION':
        selectionTranslations.cancel(sender, request.requestId);
        return { ok: true, data: undefined };
      case 'GET_PUBLIC_SETTINGS': {
        return { ok: true, data: await readPublicSettings() };
      }
      case 'BEGIN_TRANSLATION_SESSION': {
        if (request.mode !== 'segmented' && request.mode !== 'full-document')
          throw new LocalizedError(message('翻译模式无效'));
        const identity = getSenderPageIdentity(sender, request.sessionId);
        const settings = await getConfiguredSettings(request.profileId);
        await assertCurrentDocument(identity);
        await translationSessions.create({ ...identity, settings, mode: request.mode });
        try {
          await assertCurrentDocument(identity);
        } catch (error) {
          await translationSessions.delete(identity.tabId, identity.sessionId);
          throw error;
        }
        // Hash the exact trusted snapshot, never send its model, prompt or credentials to the page.
        const configurationId = await createTranslationCacheKey(
          { ...settings, origin: identity.origin },
          '',
        );
        return {
          ok: true,
          data: {
            configurationId,
            context: { profileId: settings.id, targetLanguage: settings.targetLanguage },
          },
        };
      }
      case 'RESOLVE_TRANSLATION_CANDIDATES': {
        const session = await getTranslationSession(sender, request.sessionId);
        assertSessionMode(session, 'segmented');
        const context = getCacheContext(session);
        return {
          ok: true,
          data: await candidateResolver.resolve(context, request.candidates),
        };
      }
      case 'STORE_TRANSLATION_CACHE': {
        const session = await getTranslationSession(sender, request.sessionId);
        assertSessionMode(session, 'segmented');
        const context = getCacheContext(session);
        try {
          await translationCache.putMany(context, request.entries);
        } catch (error) {
          // Cache persistence cannot turn an already successful translation into a page error.
          console.error('翻译缓存写入失败', error);
        }
        return { ok: true, data: undefined };
      }
      case 'TRANSLATE_FULL_DOCUMENT': {
        const identity = getSenderPageIdentity(sender, request.sessionId);
        const requestKey = `${getRequestPrefix(identity)}full-document`;
        // Register before asynchronous preflight: stop/navigation also cancel work awaiting storage.
        const result = await activeRequests.run(
          requestKey,
          async (signal) => {
            const session = await getTranslationSession(sender, request.sessionId);
            signal.throwIfAborted();
            assertSessionMode(session, 'full-document');
            // One admitted attempt owns the entire document; queue time consumes no HTTP timeout.
            const translations = await translateFullDocument(
              session.settings,
              request.units,
              fetch,
              signal,
              {
                scheduleAttempt: (attempt) =>
                  providerRequests.run(
                    session.settings.apiUrl,
                    'visible',
                    signal,
                    120_000,
                    async (attemptSignal) => {
                      await assertCurrentDocument(session);
                      attemptSignal.throwIfAborted();
                      return attempt(attemptSignal);
                    },
                    requestKey,
                  ),
                onRateLimit: (delay) => providerRequests.defer(session.settings.apiUrl, delay),
              },
            );
            await assertCurrentDocument(session);
            signal.throwIfAborted();
            return translations;
          },
          0,
        );
        return { ok: true, data: result };
      }
      case 'TRANSLATE_BATCH': {
        const identity = getSenderPageIdentity(sender, request.sessionId);
        const requestKey = `${getRequestPrefix(identity)}${request.batchId}`;
        const batchState = {
          priority: request.priority,
          priorityRevision: 0,
          cancelled: false,
          started: false,
          deferred: false,
        };
        translationBatches.set(requestKey, batchState);
        try {
          const session = await getTranslationSession(sender, request.sessionId);
          assertSessionMode(session, 'segmented');
          if (batchState.cancelled) throw new LocalizedError(message('API 请求已取消'));
          if (batchState.deferred) return { ok: true, data: { deferred: true } };
          const documentId = session.documentId;
          const publish = (data: Pick<TranslationBatchProgress, 'translations' | 'timing'>) => {
            const event: TranslationBatchProgress = {
              type: 'TRANSLATION_BATCH_PROGRESS',
              sessionId: request.sessionId,
              batchId: request.batchId,
              ...data,
            };
            // Address the original document, never the tab's newly navigated page.
            // The terminal response still accounts for all results if the document has closed.
            void chrome.tabs
              .sendMessage(session.tabId, event, { documentId })
              .catch(() => undefined);
          };
          const translations = await activeRequests.run(
            requestKey,
            (signal) =>
              translateBatch(session.settings, request.segments, fetch, signal, {
                // Keep the retry budget fixed for this session, including later dynamic batches.
                maxRetries: session.settings.translationRetryCount,
                onTranslations: (translations) => publish({ translations }),
                onTiming: (stage, durationMs) =>
                  publish({ translations: {}, timing: { stage, durationMs } }),
                scheduleAttempt: (attempt) =>
                  providerRequests.run(
                    session.settings.apiUrl,
                    batchState.priority,
                    signal,
                    TRANSLATION_REQUEST_POLICIES[batchState.priority].timeoutMs,
                    async (attemptSignal) => {
                      // A suspended worker can wake for an old message: validate again at HTTP admission.
                      await assertCurrentDocument(session);
                      attemptSignal.throwIfAborted();
                      // No await between this boundary and the HTTP attempt: viewport updates
                      // may only return batches that have never submitted a request.
                      batchState.started = true;
                      return attempt(attemptSignal);
                    },
                    requestKey,
                  ),
                onRateLimit: (delayMs) => providerRequests.defer(session.settings.apiUrl, delayMs),
              }),
            0,
          );
          return { ok: true, data: translations };
        } catch (error) {
          if (batchState.deferred && !batchState.cancelled)
            return { ok: true, data: { deferred: true } };
          throw error;
        } finally {
          translationBatches.delete(requestKey);
        }
      }
      case 'CANCEL_TRANSLATION_BATCH': {
        const identity = getSenderPageIdentity(sender, request.sessionId);
        const key = `${getRequestPrefix(identity)}${request.batchId}`;
        const state = translationBatches.get(key);
        if (state) state.cancelled = true;
        activeRequests.cancel(key);
        return { ok: true, data: undefined };
      }
      case 'UPDATE_TRANSLATION_PRIORITIES': {
        const session = await getTranslationSession(sender, request.sessionId);
        for (const { batchId, priority } of request.batches) {
          const key = `${getRequestPrefix(session)}${batchId}`;
          const state = translationBatches.get(key);
          // Storage/document checks may resolve out of order; older snapshots never win.
          if (!state || request.revision <= state.priorityRevision) continue;
          state.priorityRevision = request.revision;
          state.priority = priority;
          if (
            request.requeueUnsent &&
            priority !== 'visible' &&
            !state.started &&
            !state.cancelled
          ) {
            state.deferred = true;
            activeRequests.cancel(key);
          } else {
            providerRequests.updatePriority(session.settings.apiUrl, key, priority);
          }
        }
        return { ok: true, data: undefined };
      }
      case 'CANCEL_TRANSLATION_REQUESTS': {
        const identity = getSenderPageIdentity(sender, request.sessionId);
        activeRequests.cancelPrefix(getRequestPrefix(identity));
        await translationSessions.delete(identity.tabId, request.sessionId);
        return { ok: true, data: undefined };
      }
      case 'END_TRANSLATION_SESSION': {
        const { tabId } = getSenderPageIdentity(sender, request.sessionId);
        await translationSessions.delete(tabId, request.sessionId);
        return { ok: true, data: undefined };
      }
      case 'SAVE_TRANSLATION_PROFILE': {
        return { ok: true, data: await saveTranslationProfile(request.profile) };
      }
      case 'DELETE_TRANSLATION_PROFILE': {
        return { ok: true, data: await deleteTranslationProfile(request.profileId) };
      }
      case 'UPDATE_UI_LANGUAGE':
        return { ok: true, data: await updateUiLanguage(request.uiLanguage) };
      case 'UPDATE_READING_PREFERENCES': {
        return { ok: true, data: await updateReadingPreferences(request.patch) };
      }
      case 'UPDATE_SITE_RULE': {
        return { ok: true, data: await updateSiteRule(request.rule) };
      }
      case 'SET_ACTIVE_PROFILE': {
        return { ok: true, data: await selectActiveProfile(request.profileId) };
      }
      case 'SET_SITE_AUTO_TRANSLATE': {
        return {
          ok: true,
          data: await setSiteAutoTranslation(request.hostname, request.enabled),
        };
      }
    }
    // An extension page may still send a different build's command; never return an empty reply.
    return { ok: false, error: message('扩展页面与后台消息不一致，请重新加载扩展并重新打开页面') };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

async function getConfiguredSettings(profileId: string) {
  const settings = await getSettings();
  const profile = getActiveProfile(settings, profileId);
  if (!profile) throw new LocalizedError(message('翻译配置不存在'));
  if (
    Object.keys(validateTranslationProfile(profile)).length > 0 ||
    !settings.targetLanguage.trim()
  ) {
    throw new LocalizedError(message('请先在设置页完成 API 配置'));
  }
  return {
    ...profile,
    ...configuredProviderOptions(profile),
    targetLanguage: settings.targetLanguage,
    translationRetryCount: settings.translationRetryCount,
  };
}

function assertSessionMode(
  session: TranslationSessionContext,
  mode: TranslationSessionContext['mode'],
): void {
  if (session.mode !== mode) throw new LocalizedError(message('翻译命令与当前会话模式不一致'));
}

function getCacheContext(session: TranslationSessionContext): TranslationCacheContext {
  const { settings } = session;
  return { ...settings, origin: session.origin };
}

async function getTranslationSession(
  sender: chrome.runtime.MessageSender,
  sessionId: string,
): Promise<TranslationSessionContext> {
  const identity = getSenderPageIdentity(sender, sessionId);
  await assertCurrentDocument(identity);
  return translationSessions.read(identity);
}

async function assertCurrentDocument(identity: TranslationSessionIdentity): Promise<void> {
  const current = await chrome.webNavigation.getFrame({ tabId: identity.tabId, frameId: 0 });
  if (current?.documentId !== identity.documentId)
    throw new LocalizedError(message('当前网页已变化，翻译会话失效'));
}

/** Uses browser-owned sender metadata so a webpage cannot choose another cache origin. */
function getSenderPageIdentity(
  sender: chrome.runtime.MessageSender,
  sessionId: string,
): TranslationSessionIdentity {
  const tabId = sender.tab?.id;
  const tabUrl = sender.tab?.url;
  if (tabId === undefined || !tabUrl) throw new LocalizedError(message('无法确定当前网页站点'));
  if (!sender.documentId || sender.frameId !== 0)
    throw new LocalizedError(message('无法确定请求所属网页文档'));
  const url = new URL(tabUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new LocalizedError(message('当前页面不支持翻译缓存'));
  }
  return {
    tabId,
    documentId: sender.documentId,
    sessionId,
    origin: url.origin,
  };
}

function getRequestPrefix(identity: TranslationSessionIdentity): string {
  return `${identity.tabId}:${identity.documentId}:${identity.sessionId}:`;
}

async function getActiveTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function ensureContextMenu(): Promise<void> {
  return ensurePageTranslationMenu({
    removeAll: () => chrome.contextMenus.removeAll(),
    create: createContextMenu,
  }).catch((error: unknown) => {
    console.error('右键翻译菜单注册失败', error);
  });
}

/** Chrome reports create failures through the callback, not the synchronous return ID. */
function createContextMenu(properties: chrome.contextMenus.CreateProperties): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    chrome.contextMenus.create(properties, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new LocalizedError(error.message ?? message('发生未知错误')));
      else resolve();
    });
  });
}

/** Recompute on lifecycle events rather than retaining potentially stale per-tab failure counts. */
function refreshRetryMenu(): void {
  void retryMenu.refresh().catch((error: unknown) => {
    console.error('右键重试菜单更新失败', error);
  });
}

import { translateBatch } from '../shared/openai-client';
import { AbortableRequestRegistry } from './request-registry';
import { ProviderRequestQueue } from './provider-request-queue';
import { ensurePageTranslationMenu, handlePageTranslationMenuClick } from './context-menu';
import {
  readPublicSettings,
  saveAndReadPublicSettings,
  selectActiveProfile,
  setSiteAutoTranslation,
} from './configuration-service';
import { getSettings, initializeSettings, saveSettings } from '../shared/settings-store';
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
const translationCache = new TranslationCache();
const candidateResolver = new CandidateResolver(translationCache);
const translationSessions = new TranslationSessionStore(chrome.storage.session);
const batchPriorities = new Map<string, { priority: TranslationPriority; cancelled: boolean }>();

const TRANSLATION_REQUEST_POLICIES: Readonly<Record<TranslationPriority, { timeoutMs: number }>> = {
  visible: { timeoutMs: 20_000 },
  readAhead: { timeoutMs: 30_000 },
  background: { timeoutMs: 60_000 },
};

void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void initializeSettings();
void ensureCacheCleanupAlarm(chrome.alarms);
ensureContextMenu();

chrome.runtime.onInstalled.addListener(() => {
  void initializeSettings();
  void ensureCacheCleanupAlarm(chrome.alarms);
  ensureContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureCacheCleanupAlarm(chrome.alarms);
  ensureContextMenu();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void runCacheCleanupForAlarm(alarm, translationCache).catch((error: unknown) => {
    console.error('翻译缓存定时清理失败', error);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handlePageTranslationMenuClick(info.menuItemId, tab?.id, (tabId, command) =>
    chrome.tabs.sendMessage(tabId, command),
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeRequests.cancelForTab(tabId);
  void translationSessions.deleteForTab(tabId).catch((error: unknown) => {
    console.error('翻译会话清理失败', error);
  });
});

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, documentId }) => {
  if (frameId !== 0) return;
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
    switch (request.type) {
      case 'GET_PUBLIC_SETTINGS': {
        return { ok: true, data: await readPublicSettings() };
      }
      case 'BEGIN_TRANSLATION_SESSION': {
        const identity = getSenderPageIdentity(sender, request.sessionId);
        const settings = await getConfiguredSettings(request.profileId);
        await assertCurrentDocument(identity);
        await translationSessions.create({ ...identity, settings });
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
        return { ok: true, data: { configurationId } };
      }
      case 'RESOLVE_TRANSLATION_CANDIDATES': {
        const session = await getTranslationSession(sender, request.sessionId);
        const context = getCacheContext(session);
        return {
          ok: true,
          data: await candidateResolver.resolve(context, request.candidates),
        };
      }
      case 'STORE_TRANSLATION_CACHE': {
        const session = await getTranslationSession(sender, request.sessionId);
        const context = getCacheContext(session);
        try {
          await translationCache.putMany(context, request.entries);
        } catch (error) {
          // Cache persistence cannot turn an already successful translation into a page error.
          console.error('翻译缓存写入失败', error);
        }
        return { ok: true, data: undefined };
      }
      case 'TRANSLATE_BATCH': {
        const identity = getSenderPageIdentity(sender, request.sessionId);
        const requestKey = `${getRequestPrefix(identity)}${request.batchId}`;
        const batchState = { priority: request.priority, cancelled: false };
        batchPriorities.set(requestKey, batchState);
        try {
          const session = await getTranslationSession(sender, request.sessionId);
          if (batchState.cancelled) throw new Error('API 请求已取消');
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
                      return attempt(attemptSignal);
                    },
                    requestKey,
                  ),
                onRateLimit: (delayMs) => providerRequests.defer(session.settings.apiUrl, delayMs),
              }),
            0,
          );
          return { ok: true, data: translations };
        } finally {
          batchPriorities.delete(requestKey);
        }
      }
      case 'CANCEL_TRANSLATION_BATCH': {
        const identity = getSenderPageIdentity(sender, request.sessionId);
        const key = `${getRequestPrefix(identity)}${request.batchId}`;
        const state = batchPriorities.get(key);
        if (state) state.cancelled = true;
        activeRequests.cancel(key);
        return { ok: true, data: undefined };
      }
      case 'PROMOTE_TRANSLATION_BATCHES': {
        const session = await getTranslationSession(sender, request.sessionId);
        const ranks = { background: 0, readAhead: 1, visible: 2 };
        for (const batchId of request.batchIds) {
          const key = `${getRequestPrefix(session)}${batchId}`;
          const state = batchPriorities.get(key);
          if (!state || ranks[state.priority] >= ranks[request.priority]) continue;
          state.priority = request.priority;
          providerRequests.promote(session.settings.apiUrl, key, request.priority);
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
      case 'SAVE_SETTINGS': {
        return { ok: true, data: await saveAndReadPublicSettings(request.settings) };
      }
      case 'SAVE_DISPLAY_MODE': {
        const settings = await getSettings();
        await saveSettings({ ...settings, displayMode: request.displayMode });
        return { ok: true, data: undefined };
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
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

async function getConfiguredSettings(profileId: string) {
  const settings = await getSettings();
  const profile = getActiveProfile(settings, profileId);
  if (!profile) throw new Error('翻译配置不存在');
  if (
    Object.keys(validateTranslationProfile(profile)).length > 0 ||
    !settings.targetLanguage.trim()
  ) {
    throw new Error('请先在设置页完成 API 配置');
  }
  return { ...profile, targetLanguage: settings.targetLanguage };
}

function getCacheContext(session: TranslationSessionContext): TranslationCacheContext {
  const { settings } = session;
  return {
    origin: session.origin,
    apiUrl: settings.apiUrl,
    model: settings.model,
    targetLanguage: settings.targetLanguage,
    translationPrompt: settings.translationPrompt,
  };
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
  if (current?.documentId !== identity.documentId) throw new Error('当前网页已变化，翻译会话失效');
}

/** Uses browser-owned sender metadata so a webpage cannot choose another cache origin. */
function getSenderPageIdentity(
  sender: chrome.runtime.MessageSender,
  sessionId: string,
): TranslationSessionIdentity {
  const tabId = sender.tab?.id;
  const tabUrl = sender.tab?.url;
  if (tabId === undefined || !tabUrl) throw new Error('无法确定当前网页站点');
  if (!sender.documentId || sender.frameId !== 0) throw new Error('无法确定请求所属网页文档');
  const url = new URL(tabUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('当前页面不支持翻译缓存');
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

function ensureContextMenu(): void {
  void ensurePageTranslationMenu({
    update: (id, properties) => chrome.contextMenus.update(id, properties),
    create: (properties) => chrome.contextMenus.create(properties),
  }).catch((error: unknown) => {
    console.error('右键翻译菜单注册失败', error);
  });
}

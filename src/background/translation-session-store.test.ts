import { DEFAULT_PROVIDER_OPTIONS } from '../shared/providers';
import { describe, expect, it } from 'vitest';

import type { AiTranslationRuntimeConfig } from './translation-engine';
import { TranslationSessionStore } from './translation-session-store';

const SETTINGS: AiTranslationRuntimeConfig = {
  kind: 'ai',
  profileId: 'profile',
  profileName: 'AI',
  ...DEFAULT_PROVIDER_OPTIONS,
  provider: 'custom',
  protocol: 'openai',
  thinkingEnabled: true,
  translationRetryCount: 3,
  fullDocumentTimeoutMinutes: 10,
  apiUrl: 'https://gateway.example.com/v1',
  apiKey: 'test-secret',
  model: 'translation-model',
  targetLanguage: 'Simplified Chinese',
  translationPrompt: 'Translate into {{targetLanguage}}.',
};

const BUILTIN_SETTINGS = {
  kind: 'builtin' as const,
  engine: 'microsoft-free' as const,
  targetLanguage: 'Simplified Chinese',
  targetLanguageCode: 'zh-Hans',
  translationRetryCount: 1,
};

describe('TranslationSessionStore', () => {
  it('binds a session to its document and cleans old navigations without removing the new document', async () => {
    const store = new TranslationSessionStore(new InMemorySessionStorage());
    const identity = {
      tabId: 18,
      documentId: 'old-document',
      sessionId: 'old-session',
      origin: 'https://news.ycombinator.com',
    };
    await store.create({ mode: 'segmented', ...identity, settings: SETTINGS });
    const current = { ...identity, documentId: 'new-document', sessionId: 'new-session' };
    await store.create({ mode: 'segmented', ...current, settings: SETTINGS });
    await expect(store.read({ ...identity, documentId: 'new-document' })).rejects.toThrow(
      /网页已变化/u,
    );
    await store.deleteOtherDocuments(18, 'new-document');
    await expect(store.read(identity)).rejects.toThrow(/失效/u);
    await expect(store.read(current)).resolves.toMatchObject({ documentId: 'new-document' });
  });
  it('keeps one immutable request configuration for the whole page session', async () => {
    const storage = new InMemorySessionStorage();
    const store = new TranslationSessionStore(storage);
    const mutableSettings = { ...SETTINGS };

    await store.create({
      mode: 'segmented',
      tabId: 18,
      documentId: 'document',
      sessionId: 'page-session',
      origin: 'https://news.ycombinator.com',
      settings: mutableSettings,
    });
    mutableSettings.model = 'changed-after-session-start';
    mutableSettings.translationPrompt = 'A different prompt.';
    mutableSettings.translationRetryCount = 0;
    mutableSettings.fullDocumentTimeoutMinutes = 60;
    mutableSettings.thinkingEnabled = false;
    mutableSettings.provider = 'mimo';
    mutableSettings.protocol = 'anthropic';
    mutableSettings.thinkingControl = 'anthropic-budget';
    mutableSettings.reasoningEffort = 'high';
    mutableSettings.thinkingBudgetTokens = 4096;
    mutableSettings.maxOutputTokens = 32768;

    await expect(
      store.read({
        tabId: 18,
        documentId: 'document',
        sessionId: 'page-session',
        origin: 'https://news.ycombinator.com',
      }),
    ).resolves.toMatchObject({ settings: SETTINGS });
  });

  it('restores a built-in engine snapshot after worker suspension without ephemeral tokens', async () => {
    const storage = new InMemorySessionStorage();
    const identity = {
      tabId: 20,
      documentId: 'document',
      sessionId: 'builtin-session',
      origin: 'https://page.test',
    };
    await new TranslationSessionStore(storage).create({
      ...identity,
      mode: 'segmented',
      settings: BUILTIN_SETTINGS,
    });

    await expect(new TranslationSessionStore(storage).read(identity)).resolves.toMatchObject({
      settings: BUILTIN_SETTINGS,
    });
    expect(JSON.stringify(await storage.get(null))).not.toContain('token');
  });

  it('rejects a restored built-in snapshot whose provider language code was tampered with', async () => {
    const storage = new InMemorySessionStorage();
    const identity = {
      tabId: 20,
      documentId: 'document',
      sessionId: 'tampered-builtin',
      origin: 'https://page.test',
    };
    await storage.set({
      'translation-session:20:tampered-builtin': {
        ...identity,
        mode: 'segmented',
        settings: { ...BUILTIN_SETTINGS, targetLanguageCode: 'ar' },
      },
    });

    await expect(new TranslationSessionStore(storage).read(identity)).rejects.toThrow('已失效');
  });

  it('rejects a built-in full-document session at the persistence boundary', async () => {
    const store = new TranslationSessionStore(new InMemorySessionStorage());
    await expect(
      store.create({
        tabId: 20,
        documentId: 'document',
        sessionId: 'builtin-full',
        origin: 'https://page.test',
        mode: 'full-document',
        settings: BUILTIN_SETTINGS,
      }),
    ).rejects.toThrow('仅支持 AI');
  });

  it('rejects a session from another tab or page origin', async () => {
    const store = new TranslationSessionStore(new InMemorySessionStorage());
    await store.create({
      mode: 'segmented',
      tabId: 18,
      documentId: 'document',
      sessionId: 'page-session',
      origin: 'https://news.ycombinator.com',
      settings: SETTINGS,
    });

    await expect(
      store.read({
        tabId: 19,
        documentId: 'document',
        sessionId: 'page-session',
        origin: 'https://news.ycombinator.com',
      }),
    ).rejects.toThrow(/会话不存在|已失效/u);
    await expect(
      store.read({
        tabId: 18,
        documentId: 'document',
        sessionId: 'page-session',
        origin: 'https://example.com',
      }),
    ).rejects.toThrow(/网页已变化/u);
  });

  it('removes one finished session and all sessions owned by a closed tab', async () => {
    const store = new TranslationSessionStore(new InMemorySessionStorage());
    await store.create({
      mode: 'segmented',
      tabId: 18,
      documentId: 'document',
      sessionId: 'first',
      origin: 'https://a.example',
      settings: SETTINGS,
    });
    await store.create({
      mode: 'segmented',
      tabId: 18,
      documentId: 'document',
      sessionId: 'second',
      origin: 'https://a.example',
      settings: SETTINGS,
    });
    await store.create({
      mode: 'segmented',
      tabId: 19,
      documentId: 'document',
      sessionId: 'third',
      origin: 'https://b.example',
      settings: SETTINGS,
    });

    await store.delete(18, 'first');
    await expect(
      store.read({
        tabId: 18,
        documentId: 'document',
        sessionId: 'first',
        origin: 'https://a.example',
      }),
    ).rejects.toThrow(/会话不存在|已失效/u);

    await store.deleteForTab(18);
    await expect(
      store.read({
        tabId: 18,
        documentId: 'document',
        sessionId: 'second',
        origin: 'https://a.example',
      }),
    ).rejects.toThrow(/会话不存在|已失效/u);
    await expect(
      store.read({
        tabId: 19,
        documentId: 'document',
        sessionId: 'third',
        origin: 'https://b.example',
      }),
    ).resolves.toMatchObject({ sessionId: 'third' });
  });
});

/** Mimics Chrome's structured-clone boundary so callers cannot mutate stored snapshots. */
class InMemorySessionStorage {
  private readonly values = new Map<string, unknown>();

  get(keys: string | null): Promise<Record<string, unknown>> {
    if (keys === null)
      return Promise.resolve(
        Object.fromEntries([...this.values].map(([key, value]) => [key, structuredClone(value)])),
      );
    const value = this.values.get(keys);
    return Promise.resolve(value === undefined ? {} : { [keys]: structuredClone(value) });
  }

  set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }

  remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
    return Promise.resolve();
  }
}

it('explicitly invalidates stored sessions without the new provider contract', async () => {
  const storage = new InMemorySessionStorage();
  const store = new TranslationSessionStore(storage);
  const identity = {
    tabId: 9,
    documentId: 'document',
    sessionId: 'old',
    origin: 'https://page.test',
  };
  const settings: Record<string, unknown> = { ...SETTINGS };
  delete settings.provider;
  delete settings.protocol;
  await storage.set({ 'translation-session:9:old': { ...identity, mode: 'segmented', settings } });
  await expect(store.read(identity)).rejects.toThrow('已失效');
});

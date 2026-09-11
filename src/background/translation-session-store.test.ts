import { describe, expect, it } from 'vitest';

import type { TranslationRequestConfig } from '../shared/openai-client';
import { TranslationSessionStore } from './translation-session-store';

const SETTINGS: TranslationRequestConfig = {
  apiUrl: 'https://gateway.example.com/v1',
  apiKey: 'test-secret',
  model: 'translation-model',
  targetLanguage: 'Simplified Chinese',
  translationPrompt: 'Translate into {{targetLanguage}}.',
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
    await store.create({ ...identity, settings: SETTINGS });
    const current = { ...identity, documentId: 'new-document', sessionId: 'new-session' };
    await store.create({ ...current, settings: SETTINGS });
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
      tabId: 18,
      documentId: 'document',
      sessionId: 'page-session',
      origin: 'https://news.ycombinator.com',
      settings: mutableSettings,
    });
    mutableSettings.model = 'changed-after-session-start';
    mutableSettings.translationPrompt = 'A different prompt.';

    await expect(
      store.read({
        tabId: 18,
        documentId: 'document',
        sessionId: 'page-session',
        origin: 'https://news.ycombinator.com',
      }),
    ).resolves.toMatchObject({ settings: SETTINGS });
  });

  it('rejects a session from another tab or page origin', async () => {
    const store = new TranslationSessionStore(new InMemorySessionStorage());
    await store.create({
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
      tabId: 18,
      documentId: 'document',
      sessionId: 'first',
      origin: 'https://a.example',
      settings: SETTINGS,
    });
    await store.create({
      tabId: 18,
      documentId: 'document',
      sessionId: 'second',
      origin: 'https://a.example',
      settings: SETTINGS,
    });
    await store.create({
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

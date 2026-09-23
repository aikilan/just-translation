/** Chrome's bounded long-operation lifetime pattern; never runs while idle or after cancellation. */
export async function withFullDocumentLifetime<T>(task: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    void chrome.runtime.getPlatformInfo().catch(() => undefined);
  }, 25_000);
  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}

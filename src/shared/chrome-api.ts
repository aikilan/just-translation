import type { PageCommand, Result, RuntimeRequest } from './messages';

/** Checks the wire envelope before callers access it; a stale worker can respond with null. */
export async function sendRuntimeMessage<T>(request: RuntimeRequest): Promise<Result<T>> {
  const response = await chrome.runtime.sendMessage<RuntimeRequest, unknown>(request);
  if (
    response === null ||
    typeof response !== 'object' ||
    !('ok' in response) ||
    typeof response.ok !== 'boolean' ||
    (!response.ok && (!('error' in response) || typeof response.error !== 'string'))
  ) {
    // Never retry a write through another protocol or include its credentials in the error.
    throw new Error(
      '扩展后台未返回有效响应。请先保留未保存的配置，再到扩展管理页重新加载「只是翻译」，并重新打开设置页。',
    );
  }
  return response as Result<T>;
}

export function sendTabMessage<T>(tabId: number, command: PageCommand): Promise<T> {
  return chrome.tabs.sendMessage<PageCommand, T>(tabId, command);
}

import type { PageCommand, Result, RuntimeRequest } from './messages';

export function sendRuntimeMessage<T>(request: RuntimeRequest): Promise<Result<T>> {
  return chrome.runtime.sendMessage<RuntimeRequest, Result<T>>(request);
}

export function sendTabMessage<T>(tabId: number, command: PageCommand): Promise<T> {
  return chrome.tabs.sendMessage<PageCommand, T>(tabId, command);
}

import type { PdfReaderState } from './pdf-reader';
import type { PdfLayout } from './viewer-app';

export interface ViewerSnapshot {
  reader: PdfReaderState;
  fileName: string;
  sourceUrl?: string;
  pageCount: number;
  currentPage: number;
  layout: PdfLayout;
}

/** Immutable snapshots for useSyncExternalStore; the reader updates it outside React. */
export interface ViewerStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ViewerSnapshot;
  update: (patch: Partial<ViewerSnapshot>) => void;
}

export function createViewerStore(initial: ViewerSnapshot): ViewerStore {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    update(patch) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
  };
}

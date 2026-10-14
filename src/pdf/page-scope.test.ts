// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageSection } from './page-view';
import { PdfPageScope } from './page-scope';

const PAGE_HEIGHT = 1000;

class FakeIntersectionObserver {
  static current: FakeIntersectionObserver | undefined;
  readonly targets: Element[] = [];
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.current = this;
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  disconnect() {
    if (FakeIntersectionObserver.current === this) FakeIntersectionObserver.current = undefined;
  }
  enter(...targets: Element[]) {
    this.callback(
      targets.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

describe('PDF page scope', () => {
  let container: HTMLElement;
  let sections: HTMLElement[];
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('innerHeight', 800);
    container = document.createElement('main');
    document.body.append(container);
    sections = Array.from({ length: 5 }, (_, index) => {
      const { section } = createPageSection(document, index + 1, { width: 600, height: 800 });
      container.append(section);
      // Pages are stacked; the viewport shows page 1 and the top of page 2.
      vi.spyOn(section, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, index * PAGE_HEIGHT, 600, PAGE_HEIGHT),
      );
      return section;
    });
  });
  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const unlocked = () =>
    sections.map(
      (section) => !section.querySelector('.pdf-page-reading')!.hasAttribute('translate'),
    );

  it('starts with every page locked and unlocks the pages in range when watching', () => {
    const scope = new PdfPageScope(container, vi.fn());
    expect(unlocked()).toEqual([false, false, false, false, false]);
    expect(scope.watch()).toHaveLength(2);
    // Page 1 is visible and page 2 is within the read-ahead screen.
    expect(unlocked()).toEqual([true, true, false, false, false]);
    expect(scope.progress()).toEqual({ unlocked: 2, total: 5 });
    expect(FakeIntersectionObserver.current?.targets).toEqual(sections);
    expect(FakeIntersectionObserver.current?.options.rootMargin).toBe('50% 0px 100% 0px');
  });

  it('reports only newly reached pages while scrolling', () => {
    const reveal = vi.fn();
    const scope = new PdfPageScope(container, reveal);
    scope.watch();
    FakeIntersectionObserver.current!.enter(sections[1], sections[2]);
    expect(reveal).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledWith([sections[2].querySelector('.pdf-page-reading')]);
    FakeIntersectionObserver.current!.enter(sections[2]);
    expect(reveal).toHaveBeenCalledOnce();
    expect(unlocked()).toEqual([true, true, true, false, false]);
  });

  it('unlocks everything for full-document translation and locks everything on restore', () => {
    const reveal = vi.fn();
    const scope = new PdfPageScope(container, reveal);
    scope.watch();
    expect(scope.unlockAll()).toHaveLength(3);
    expect(FakeIntersectionObserver.current).toBeUndefined();
    expect(unlocked()).toEqual([true, true, true, true, true]);
    scope.lockAll();
    expect(unlocked()).toEqual([false, false, false, false, false]);
    expect(reveal).not.toHaveBeenCalled();
  });
});

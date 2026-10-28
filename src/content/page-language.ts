import { chineseScript, normalizeLanguageCode } from '../shared/translation-languages';

export type PageLanguageResult =
  /**
   * `language` is the rule code (`zh`); `tag` keeps the Chinese script (`zh-Hant`) so a
   * Traditional page is not mistaken for a Simplified target.
   */
  | { status: 'detected'; language: string; tag: string }
  /** Too little readable text yet; a dynamic page may still be rendering. */
  | { status: 'insufficient' }
  | { status: 'unknown' };

export type LanguageDetector = (text: string) => Promise<chrome.i18n.LanguageDetectionResult>;

const SAMPLE_CHARACTERS = 4_000;
const MINIMUM_LETTERS = 120;
const MINIMUM_PERCENTAGE = 70;
const SKIPPED_ELEMENTS = 'script,style,noscript,template,code,pre,textarea,svg,math,[hidden]';

function sampleText(doc: Document, root: Element): string {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(SKIPPED_ELEMENTS) || !node.nodeValue?.trim()
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let text = '';
  while (text.length < SAMPLE_CHARACTERS && walker.nextNode())
    text += `${walker.currentNode.nodeValue!.trim()} `;
  return text.slice(0, SAMPLE_CHARACTERS);
}

function countLetters(text: string): number {
  return text.match(/\p{L}/gu)?.length ?? 0;
}

/**
 * Reads text nodes in document order without layout. The main landmark is preferred; when it is
 * missing or too thin (a teaser or shell), the whole body is sampled instead.
 */
export function samplePageText(doc: Document = document): string {
  const main = doc.querySelector('main,[role="main"]');
  if (main) {
    const text = sampleText(doc, main);
    if (countLetters(text) >= MINIMUM_LETTERS || !doc.body) return text;
  }
  return doc.body ? sampleText(doc, doc.body) : '';
}

/**
 * Identifies the page language locally with the browser's own detector; no text leaves the page.
 * Automatic translation must be conservative, so an unreliable result, a minority language or a
 * conflicting `<html lang>` declaration yields `unknown` rather than a guess.
 */
export async function detectPageLanguage(
  doc: Document = document,
  detector: LanguageDetector = (text) => chrome.i18n.detectLanguage(text),
): Promise<PageLanguageResult> {
  const text = samplePageText(doc);
  if (countLetters(text) < MINIMUM_LETTERS) return { status: 'insufficient' };
  let result: chrome.i18n.LanguageDetectionResult;
  try {
    result = await detector(text);
  } catch {
    return { status: 'unknown' };
  }
  const top = [...(result.languages ?? [])].sort((a, b) => b.percentage - a.percentage)[0];
  if (!result.isReliable || !top || top.percentage < MINIMUM_PERCENTAGE)
    return { status: 'unknown' };
  const language = normalizeLanguageCode(top.language);
  if (!language) return { status: 'unknown' };
  const declaredTag = doc.documentElement.lang;
  const declared = declaredTag ? normalizeLanguageCode(declaredTag) : undefined;
  if (declared && declared !== language) return { status: 'unknown' };
  if (language !== 'zh') return { status: 'detected', language, tag: language };
  // The browser detector reports Traditional as `zh-Hant` and Simplified as bare `zh`.
  const script =
    (declaredTag ? chineseScript(declaredTag) : undefined) ??
    chineseScript(top.language) ??
    (top.language.toLowerCase() === 'zh' ? 'Hans' : undefined);
  return { status: 'detected', language, tag: script ? `zh-${script}` : 'zh' };
}

/**
 * Resolves once the page has stopped mutating for `quietMs`, or after `maxMs`. An SPA commits its
 * new history entry before rendering the route, so text read immediately belongs to the old one.
 */
export function waitForDomQuiet(
  doc: Document = document,
  quietMs = 600,
  maxMs = 3_000,
): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      observer.disconnect();
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
    quietTimer = setTimeout(finish, quietMs);
    const maxTimer = setTimeout(finish, maxMs);
  });
}

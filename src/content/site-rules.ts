export interface TranslationSiteRule {
  hostnames: readonly string[];
  includeSelectors: readonly string[];
}

const SITE_RULES: readonly TranslationSiteRule[] = [
  {
    hostnames: ['news.ycombinator.com'],
    includeSelectors: [
      '.titleline > a',
      '.comment',
      '.toptext',
      'a.hn-item-title',
      '.hn-comment-text',
      '.hn-story-title',
    ],
  },
];

/** Host layout elements that Chrome would otherwise select as a never-moving scroll anchor. */
const SCROLL_ANCHOR_EXCLUSIONS: readonly { hostnames: readonly string[]; selector: string }[] = [
  {
    // X keeps its full-height left navigation in normal flow before <main>. Its only visible
    // content is fixed-positioned, so Chrome anchors on the header itself and never compensates
    // for translations inserted above the reader.
    hostnames: ['x.com', 'twitter.com'],
    selector: 'header[role="banner"]',
  },
];

/** Returns the authoritative rule for a supported host; matching rules do not use generic fallback. */
export function getTranslationSiteRule(url: string | undefined): TranslationSiteRule | undefined {
  const hostname = getHostname(url);
  return hostname ? SITE_RULES.find((rule) => rule.hostnames.includes(hostname)) : undefined;
}

export function getScrollAnchorExclusionSelector(url: string | undefined): string | undefined {
  const hostname = getHostname(url);
  return hostname
    ? SCROLL_ANCHOR_EXCLUSIONS.find((rule) => rule.hostnames.includes(hostname))?.selector
    : undefined;
}

function getHostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

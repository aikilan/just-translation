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

/** Returns the authoritative rule for a supported host; matching rules do not use generic fallback. */
export function getTranslationSiteRule(url: string | undefined): TranslationSiteRule | undefined {
  if (!url) return undefined;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return SITE_RULES.find((rule) => rule.hostnames.includes(hostname));
}

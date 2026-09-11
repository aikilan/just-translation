/** Opaque references to local, non-translatable inline content; never contain its actual value. */
export const PROTECTED_MARKER_PATTERN = /\[\[JT_KEEP_\d+\]\]/gu;

export function preservesProtectedMarkers(source: string, translation: string): boolean {
  const expected = source.match(PROTECTED_MARKER_PATTERN) ?? [];
  const actual = (translation.match(PROTECTED_MARKER_PATTERN) ?? []).sort();
  return (
    expected.length === actual.length &&
    [...expected].sort().every((marker, index) => marker === actual[index])
  );
}

import { describe, expect, it } from 'vitest';

import { assertConnectionTestTranslation, createConnectionTestSegment } from './connection-test';

describe('connection translation probe', () => {
  it('chooses source text that differs from the configured target language', () => {
    expect(createConnectionTestSegment('Simplified Chinese').text).toBe('Good morning.');
    expect(createConnectionTestSegment('English').text).toBe('早上好。');
  });

  it('rejects an API response that merely echoes the source text', () => {
    const segment = createConnectionTestSegment('Simplified Chinese');

    expect(() => assertConnectionTestTranslation(segment.text, '  Good morning!  ')).toThrow(
      /原样返回/u,
    );
  });

  it('accepts a genuine translated result', () => {
    expect(() => assertConnectionTestTranslation('Good morning.', '早上好。')).not.toThrow();
  });
});

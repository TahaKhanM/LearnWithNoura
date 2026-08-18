import { describe, expect, it } from 'vitest';
import { pickMimeType } from './mic';

describe('pickMimeType', () => {
  it('prefers WebM with Opus when the browser offers it', () => {
    expect(pickMimeType(() => true)).toBe('audio/webm;codecs=opus');
  });

  it('falls back to MP4 on browsers that only record AAC', () => {
    expect(pickMimeType((t) => t === 'audio/mp4')).toBe('audio/mp4');
  });

  it('returns undefined when nothing is supported, so the recorder picks its own', () => {
    expect(pickMimeType(() => false)).toBeUndefined();
  });
});

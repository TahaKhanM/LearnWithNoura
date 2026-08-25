import { describe, expect, it, vi } from 'vitest';
import { AudioOut } from './audioOut';

describe('AudioOut scheduling receipts', () => {
  it('reports the existing schedule lead only for a response first chunk', () => {
    const audio = new AudioOut();
    const context = {
      currentTime: 4,
      destination: {},
      createBuffer: (_channels: number, samples: number, sampleRate: number) => ({
        duration: samples / sampleRate,
        getChannelData: () => new Float32Array(samples),
      }),
      createBufferSource: () => ({
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      }),
      createGain: () => ({
        connect: vi.fn(),
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
      }),
    };
    (audio as unknown as { ctx: typeof context }).ctx = context;
    const pcm = btoa('\0\0');

    expect(audio.append('response-1', 'item-1', pcm)).toEqual({
      playbackStartsInMs: 50,
    });
    expect(audio.append('response-1', 'item-1', pcm)).toBeNull();
  });
});

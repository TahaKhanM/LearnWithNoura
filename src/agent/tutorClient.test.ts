import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamLesson } from './tutorClient';
import { snapshotBoard } from '../whiteboard/scene';

afterEach(() => {
  vi.unstubAllGlobals();
});

function successfulStream(_input: RequestInfo | URL, _init?: RequestInit) {
  return Promise.resolve(
    new Response('{"type":"done"}\n', {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    }),
  );
}

describe('streamLesson board context', () => {
  it('omits the visual payload when no learner drawing changed', async () => {
    const fetchMock = vi.fn<typeof fetch>(successfulStream);
    vi.stubGlobal('fetch', fetchMock);

    await streamLesson('hello', [], snapshotBoard([]), undefined, { onStep: vi.fn() });

    const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(request.board).toEqual({ size: [1000, 600], objects: [] });
    expect(request).not.toHaveProperty('boardImage');
  });

  it('sends the generated PNG alongside the same structured scene', async () => {
    const fetchMock = vi.fn<typeof fetch>(successfulStream);
    vi.stubGlobal('fetch', fetchMock);
    const image = 'data:image/png;base64,aGVsbG8=';

    await streamLesson('what is this?', [], snapshotBoard([]), image, { onStep: vi.fn() });

    const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(request.board).toEqual({ size: [1000, 600], objects: [] });
    expect(request.boardImage).toBe(image);
  });
});

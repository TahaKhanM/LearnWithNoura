import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MICROPHONE_PERMISSION_TIMEOUT_MS,
  WebRtcVoiceTransport,
  type PlaybackFailureReason,
  type VoiceTransportState,
} from './voiceTransport';

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.querySelectorAll('audio').forEach((element) => element.remove());
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  else Reflect.deleteProperty(navigator, 'mediaDevices');
});

function transportHarness() {
  const boundaries: Array<{ boundary: string; responseId: string | null; playedMs: number }> = [];
  const states: VoiceTransportState[] = [];
  const failures: Array<{ responseId: string | null; reason: PlaybackFailureReason }> = [];
  const microphone: Array<{ available: boolean; denied: boolean }> = [];
  const transport = new WebRtcVoiceTransport({
    sessionId: 'session',
    lessonCapability: 'capability',
    handlers: {
      onPlaybackBoundary: (boundary, responseId, playedMs) => boundaries.push({ boundary, responseId, playedMs }),
      onStateChange: (state) => states.push(state),
      onPlaybackFailure: (responseId, reason) => failures.push({ responseId, reason }),
      onMicrophoneState: (available, denied) => microphone.push({ available, denied }),
    },
  });
  return { transport, boundaries, states, failures, microphone };
}

describe('WebRTC voice transport media truth', () => {
  it('reports autoplay blocking, retries on demand, and starts the local boundary only after playback succeeds', async () => {
    const { transport, boundaries, states, failures } = transportHarness();
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play');
    play.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    play.mockImplementationOnce(async function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event('playing'));
    });
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockReturnValue(false);
    const internals = transport as unknown as {
      handleDataChannelMessage(raw: string): void;
      attachRemoteTrack(stream: MediaStream): void;
    };

    transport.noteResponse('response-1');
    internals.handleDataChannelMessage(JSON.stringify({ type: 'output_audio_buffer.started', response_id: 'response-1' }));
    internals.attachRemoteTrack({} as MediaStream);
    await vi.waitFor(() => expect(states).toContain('blocked'));
    expect(boundaries).toEqual([]);
    expect(failures).toContainEqual({ responseId: 'response-1', reason: 'autoplay_blocked' });

    await expect(transport.resumePlayback()).resolves.toBe(true);
    expect(states.at(-1)).toBe('connected');
    expect(boundaries).toEqual([{ boundary: 'started', responseId: 'response-1', playedMs: 0 }]);

    internals.handleDataChannelMessage(JSON.stringify({ type: 'output_audio_buffer.stopped', response_id: 'response-1' }));
    expect(boundaries.at(-1)).toMatchObject({ boundary: 'stopped', responseId: 'response-1' });

    transport.suppressResponse('cancelled-late');
    transport.noteResponse('cancelled-late');
    internals.handleDataChannelMessage(JSON.stringify({ type: 'output_audio_buffer.started', response_id: 'cancelled-late' }));
    expect(boundaries).toHaveLength(2);
    expect(document.querySelector('audio')?.muted).toBe(true);
  });

  it('continues as a listen-only call when microphone permission is denied', async () => {
    class FakePeerConnection {
      connectionState = 'new';
      iceGatheringState = 'complete';
      localDescription: { sdp: string } | null = null;
      ontrack: ((event: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      addTrack = vi.fn();
      addTransceiver = vi.fn();
      createDataChannel = vi.fn(() => ({ onmessage: null, readyState: 'open', send: vi.fn() }));
      createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' }));
      setLocalDescription = vi.fn(async (offer: { sdp?: string }) => { this.localDescription = { sdp: offer.sdp ?? '' }; });
      setRemoteDescription = vi.fn(async () => {});
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      close = vi.fn();
    }
    const pc = new FakePeerConnection();
    function PeerConnectionConstructor(): FakePeerConnection { return pc; }
    vi.stubGlobal('RTCPeerConnection', PeerConnectionConstructor);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('answer-sdp', { status: 200 })));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); }) },
    });
    const { transport, microphone, states } = transportHarness();

    await expect(transport.connect()).resolves.toBeUndefined();
    expect(microphone).toEqual([{ available: false, denied: true }]);
    expect(pc.addTrack).not.toHaveBeenCalled();
    expect(pc.addTransceiver).toHaveBeenCalledWith('audio', { direction: 'recvonly' });
    expect(states.at(-1)).toBe('connected');
  });

  it('bounds an unanswered microphone prompt, connects listen-only, and stops a late stream', async () => {
    vi.useFakeTimers();
    class FakePeerConnection {
      connectionState = 'new';
      iceGatheringState = 'complete';
      localDescription: { sdp: string } | null = null;
      ontrack: ((event: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      addTrack = vi.fn();
      addTransceiver = vi.fn();
      createDataChannel = vi.fn(() => ({ onmessage: null, readyState: 'open', send: vi.fn() }));
      createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' }));
      setLocalDescription = vi.fn(async (offer: { sdp?: string }) => { this.localDescription = { sdp: offer.sdp ?? '' }; });
      setRemoteDescription = vi.fn(async () => {});
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      close = vi.fn();
    }
    const pc = new FakePeerConnection();
    function PeerConnectionConstructor(): FakePeerConnection { return pc; }
    vi.stubGlobal('RTCPeerConnection', PeerConnectionConstructor);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('answer-sdp', { status: 200 })));
    let resolveMicrophone!: (stream: MediaStream) => void;
    const pendingMicrophone = new Promise<MediaStream>((resolve) => { resolveMicrophone = resolve; });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(() => pendingMicrophone) },
    });
    const { transport, microphone, states } = transportHarness();

    const connected = transport.connect();
    await vi.advanceTimersByTimeAsync(MICROPHONE_PERMISSION_TIMEOUT_MS);
    await expect(connected).resolves.toBeUndefined();
    expect(microphone).toEqual([{ available: false, denied: false }]);
    expect(pc.addTrack).not.toHaveBeenCalled();
    expect(pc.addTransceiver).toHaveBeenCalledWith('audio', { direction: 'recvonly' });
    expect(states.at(-1)).toBe('connected');

    const stop = vi.fn();
    resolveMicrophone({ getAudioTracks: () => [{ stop }] } as unknown as MediaStream);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

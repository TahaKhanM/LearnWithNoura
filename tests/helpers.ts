import type { APIRequestContext, Page } from '@playwright/test';

export const ORIGIN = 'http://localhost:5180';

/** Exercise preparation against the real fixture compiler without inventing a provider key. */
export async function enableFixturePreparation(page: Page) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({ response, json: { ...config, lessonsAvailable: true } });
  });
}

export async function createSyntheticSession(request: APIRequestContext, suffix = Date.now().toString(36)) {
  const childResponse = await request.post('/api/children', {
    headers: { Origin: ORIGIN },
    data: { name: `Synthetic ${suffix}`, age: 10 },
  });
  if (!childResponse.ok()) throw new Error(`child create failed: ${childResponse.status()}`);
  const child = (await childResponse.json()).child as { id: string; name: string };
  const sessionResponse = await request.post('/api/sessions', {
    headers: { Origin: ORIGIN },
    data: { childId: child.id, goal: 'Compare two fractions on one number line' },
  });
  if (!sessionResponse.ok()) throw new Error(`session create failed: ${sessionResponse.status()}`);
  const body = await sessionResponse.json() as { session: { id: string }; lessonCapability?: string };
  return { child, session: body.session, lessonCapability: body.lessonCapability };
}

export async function setLessonCapability(page: Page, sessionId: string, capability?: string) {
  if (!capability) return;
  await page.addInitScript(([key, value]) => sessionStorage.setItem(key, value), [
    `noura.lessonCapability.${sessionId}`,
    capability,
  ]);
}

export async function installFakeRealtime(page: Page) {
  await page.addInitScript(() => {
    type Identity = { sessionId: string; connectionEpoch: number; turnId: string; generationId: string };
    class FakeRealtimeSocket {
      static OPEN = 1;
      readonly OPEN = 1;
      readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      identity: Identity | null = null;
      sequence = 0;
      sent: Array<Identity & { type: string; payload?: Record<string, unknown>; sentAtMs: number }> = [];
      constructor() {
        (window as typeof window & { __nouraFakeSocket?: FakeRealtimeSocket }).__nouraFakeSocket = this;
        setTimeout(() => { this.readyState = 1; this.onopen?.(new Event('open')); }, 0);
      }
      send(raw: string) {
        const event = JSON.parse(raw) as Identity & { type: string };
        this.sent.push({
          ...event,
          sentAtMs: performance.now(),
        } as Identity & { type: string; payload?: Record<string, unknown>; sentAtMs: number });
        const changed = !this.identity || event.connectionEpoch !== this.identity.connectionEpoch || event.turnId !== this.identity.turnId || event.generationId !== this.identity.generationId;
        this.identity = { sessionId: event.sessionId, connectionEpoch: event.connectionEpoch, turnId: event.turnId, generationId: event.generationId };
        if (changed) this.sequence = 0;
        if (event.type === 'hello') this.emit('ready', {});
        if (event.type === 'user_text') {
          this.emit('user_transcript', { text: (event as unknown as { payload: { text: string } }).payload.text });
          setTimeout(() => this.emit('response_started', { response_id: 'fake-response' }), 20);
        }
      }
      emit(type: string, payload: Record<string, unknown>, optional: Record<string, unknown> = {}) {
        if (!this.identity) throw new Error('fake socket has no runtime identity');
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({
          eventId: crypto.randomUUID(), schemaVersion: '1.0.0', ...this.identity,
          sequence: this.sequence++, type, payload, ...optional,
        }) }));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: FakeRealtimeSocket });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { throw new DOMException('Synthetic microphone denial', 'NotAllowedError'); } } });

    // The voice plane's offline stand-in: no WebRTC, no provider. Tests drive
    // playback boundaries explicitly to gate board reveals and task delivery.
    type PlaybackBoundary = 'started' | 'stopped' | 'cleared';
    interface VoiceHandlers {
      onPlaybackBoundary(boundary: PlaybackBoundary, responseId: string | null, playedMs: number): void;
      onStateChange(state: string): void;
    }
    class FakePageVoice {
      state = 'new';
      micMuted = false;
      clears = 0;
      private active: string | null = null;
      private playedSoFarMs = 0;
      constructor(private handlers: VoiceHandlers) {}
      connect(): Promise<void> {
        this.state = 'connected';
        this.handlers.onStateChange('connected');
        return Promise.resolve();
      }
      noteResponse(_responseId: string): void {}
      suppressResponse(_responseId: string): void {}
      resumePlayback(): Promise<boolean> {
        this.state = 'connected';
        this.handlers.onStateChange('connected');
        return Promise.resolve(true);
      }
      setMicMuted(muted: boolean): void { this.micMuted = muted; }
      playingResponseId(): string | null { return this.active; }
      playedMs(): number { return this.active ? this.playedSoFarMs : 0; }
      stopPlayback(): number {
        const heard = this.playedMs();
        this.active = null;
        this.playedSoFarMs = 0;
        this.clears += 1;
        return heard;
      }
      readMicEnergy(): number { return 0; }
      readVoiceEnergy(): number { return this.active ? 0.4 : 0; }
      close(): void {
        this.state = 'closed';
        this.handlers.onStateChange('closed');
      }
      emitBoundary(boundary: PlaybackBoundary, responseId: string | null, playedMs = 0): void {
        if (boundary === 'started') {
          this.active = responseId;
          this.playedSoFarMs = 0;
        } else {
          this.active = null;
          this.playedSoFarMs = 0;
        }
        this.handlers.onPlaybackBoundary(boundary, responseId, playedMs);
      }
      block(responseId: string): void {
        this.state = 'blocked';
        const extended = this.handlers as VoiceHandlers & {
          onPlaybackFailure?: (responseId: string | null, reason: string) => void;
        };
        extended.onPlaybackFailure?.(responseId, 'autoplay_blocked');
        this.handlers.onStateChange('blocked');
      }
    }
    (window as typeof window & { __nouraVoiceTransport?: (input: { handlers: VoiceHandlers }) => FakePageVoice }).__nouraVoiceTransport = (input) => {
      const voice = new FakePageVoice(input.handlers);
      (window as typeof window & { __nouraFakeVoice?: FakePageVoice }).__nouraFakeVoice = voice;
      return voice;
    };
  });
}

/** The fake socket deliberately does not invent an opening tutor response.
 * Tests that manually drive provider events should synchronize on the real
 * client `start` envelope rather than a UI phase that only a response can
 * change from Thinking to Listening. */
export async function waitForFakeRealtimeStart(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const socket = (window as typeof window & {
      __nouraFakeSocket?: { sent: Array<{ type: string }> };
    }).__nouraFakeSocket;
    return socket?.sent.some((event) => event.type === 'start') === true;
  });
}

/** Marks a response as audibly playing in the page's fake voice transport. */
export async function startFakePlayback(page: Page, responseId: string) {
  await page.evaluate((id) => {
    const voice = (window as typeof window & { __nouraFakeVoice?: { emitBoundary(boundary: string, responseId: string | null, playedMs?: number): void } }).__nouraFakeVoice;
    if (!voice) throw new Error('fake voice transport not installed');
    voice.emitBoundary('started', id);
  }, responseId);
}

/** Finishes fake playback, releasing the cues bound to that response. */
export async function stopFakePlayback(page: Page, responseId: string, playedMs = 1_000) {
  await page.evaluate(([id, played]) => {
    const voice = (window as typeof window & { __nouraFakeVoice?: { emitBoundary(boundary: string, responseId: string | null, playedMs?: number): void } }).__nouraFakeVoice;
    if (!voice) throw new Error('fake voice transport not installed');
    voice.emitBoundary('stopped', id, Number(played));
  }, [responseId, playedMs] as const);
}

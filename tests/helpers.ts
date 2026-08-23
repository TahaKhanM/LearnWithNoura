import type { APIRequestContext, Page } from '@playwright/test';

export const ORIGIN = 'http://localhost:5180';

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
      sent: Array<Identity & { type: string; payload?: Record<string, unknown> }> = [];
      constructor() {
        (window as typeof window & { __nouraFakeSocket?: FakeRealtimeSocket }).__nouraFakeSocket = this;
        setTimeout(() => { this.readyState = 1; this.onopen?.(new Event('open')); }, 0);
      }
      send(raw: string) {
        const event = JSON.parse(raw) as Identity & { type: string };
        this.sent.push(event as Identity & { type: string; payload?: Record<string, unknown> });
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
  });
}

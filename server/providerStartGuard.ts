export interface ProviderStartGuardInput {
  apiKey?: string;
  lessonCompiler?: string;
  argv: readonly string[];
  vercel?: string;
  authorizedLiveRun?: boolean;
  authorizedM2Smoke?: boolean;
}

export function assertProviderStartAllowed(input: ProviderStartGuardInput): void {
  if (!input.apiKey?.trim()) return;
  if (input.vercel) return;
  if (input.lessonCompiler === 'fixture') return;
  if (input.authorizedLiveRun || input.authorizedM2Smoke || input.argv.includes('--authorized-live-run')) return;
  throw new Error(
    'A configured OPENAI_API_KEY cannot start a local server or harness without NOURA_LESSON_COMPILER=fixture or --authorized-live-run.',
  );
}

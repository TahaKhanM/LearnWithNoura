export const MAX_AUTHORIZED_LIVE_LESSON_SESSIONS = 2 as const;

export type LessonEvalAuthorization = {
  authorizedLiveRun: boolean;
  liveSessionBudget: number;
};

export function parseLessonEvalAuthorization(argv: readonly string[]): LessonEvalAuthorization {
  const authorizedLiveRun = argv.includes('--authorized-live-run');
  return {
    authorizedLiveRun,
    liveSessionBudget: authorizedLiveRun ? MAX_AUTHORIZED_LIVE_LESSON_SESSIONS : 0,
  };
}

/** Live lesson evaluation refuses to start without explicit authorization. */
export function assertLiveLessonEvalAuthorized(auth: LessonEvalAuthorization): void {
  if (!auth.authorizedLiveRun) {
    throw new Error(
      'Live lesson evaluation requires --authorized-live-run and remains capped at two short sessions per invocation.',
    );
  }
}

/** Even with authorization, refuse more than the capped session count. */
export function assertLiveSessionBudget(auth: LessonEvalAuthorization, requestedSessions: number): void {
  assertLiveLessonEvalAuthorized(auth);
  if (requestedSessions > auth.liveSessionBudget) {
    throw new Error(
      `Live lesson evaluation refuses ${requestedSessions} sessions; maximum is ${MAX_AUTHORIZED_LIVE_LESSON_SESSIONS} per invocation.`,
    );
  }
}

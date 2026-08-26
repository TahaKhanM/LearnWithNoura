import type { FalseBargeInFixture } from './types.js';

export type FalseBargeInResult = {
  pass: boolean;
  confirmedThenCancelled: number;
  providerCompletedAfterConfirmed: number;
  providerFailed: number;
  unresolvedConfirmed: number;
  unlabelledCancellations: number;
  localOnlyRejected: number;
  providerOnlyRejected: number;
};

/**
 * Counts confirmed-then-cancelled gate outcomes vs provider_completed after
 * confirmed and from unlabelled cancellations. Unlabelled rows are reported
 * separately — never as proven false barge-ins.
 */
export function scoreFalseBargeIns(fixture: FalseBargeInFixture): FalseBargeInResult {
  let confirmedThenCancelled = 0;
  let providerCompletedAfterConfirmed = 0;
  let providerFailed = 0;
  let unresolvedConfirmed = 0;
  let unlabelledCancellations = 0;
  let localOnlyRejected = 0;
  let providerOnlyRejected = 0;

  for (const trace of fixture.traces) {
    if (trace.gateOutcome === 'local_only_rejected') {
      localOnlyRejected += 1;
      continue;
    }
    if (trace.gateOutcome === 'provider_only_rejected') {
      providerOnlyRejected += 1;
      continue;
    }

    if (!trace.providerResponseId) {
      unresolvedConfirmed += 1;
      continue;
    }

    if (!trace.cancelOutcome) {
      unlabelledCancellations += 1;
      continue;
    }

    if (trace.cancelOutcome === 'provider_cancelled') {
      confirmedThenCancelled += 1;
    } else if (trace.cancelOutcome === 'provider_completed') {
      providerCompletedAfterConfirmed += 1;
    } else if (trace.cancelOutcome === 'provider_failed') {
      providerFailed += 1;
    }
  }

  const pass =
    confirmedThenCancelled === fixture.expectedConfirmedThenCancelled &&
    unlabelledCancellations === fixture.expectedUnlabelledCancellations &&
    providerCompletedAfterConfirmed === fixture.expectedProviderCompletedAfterConfirmed &&
    providerFailed === fixture.expectedProviderFailed;

  return {
    pass,
    confirmedThenCancelled,
    providerCompletedAfterConfirmed,
    providerFailed,
    unresolvedConfirmed,
    unlabelledCancellations,
    localOnlyRejected,
    providerOnlyRejected,
  };
}

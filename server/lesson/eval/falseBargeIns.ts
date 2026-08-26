import type { FalseBargeInFixture } from './types.js';

export type FalseBargeInResult = {
  pass: boolean;
  confirmedThenCancelled: number;
  trueInterrupts: number;
  unresolvedConfirmed: number;
  unlabelledCancellations: number;
  localOnlyRejected: number;
  providerOnlyRejected: number;
};

/**
 * Counts confirmed-then-cancelled gate outcomes vs labelled true interrupts.
 * Unlabelled cancellations are reported separately — never as proven false barge-ins.
 */
export function scoreFalseBargeIns(fixture: FalseBargeInFixture): FalseBargeInResult {
  let confirmedThenCancelled = 0;
  let trueInterrupts = 0;
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
      trueInterrupts += 1;
    }
  }

  let pass = fixture.expectPass;
  if (fixture.expectedConfirmedThenCancelled !== undefined) {
    pass = confirmedThenCancelled === fixture.expectedConfirmedThenCancelled;
  }

  return {
    pass,
    confirmedThenCancelled,
    trueInterrupts,
    unresolvedConfirmed,
    unlabelledCancellations,
    localOnlyRejected,
    providerOnlyRejected,
  };
}

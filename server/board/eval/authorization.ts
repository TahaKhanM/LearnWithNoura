const HARD_SPEND_CAP_USD = 30;

export interface DirectorEvalAuthorization {
  authorizedLiveRun: boolean;
  maxSpendUsd: number;
}

export function parseDirectorEvalAuthorization(argv: string[]): DirectorEvalAuthorization {
  let authorizedLiveRun = false;
  let maxSpendUsd = HARD_SPEND_CAP_USD;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--authorized-live-run') {
      authorizedLiveRun = true;
      continue;
    }
    if (argument === '--max-spend-usd') {
      const value = argv[index + 1];
      index += 1;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('The live spend cap must be a positive number.');
      if (parsed > HARD_SPEND_CAP_USD) throw new Error(`The live spend cap cannot exceed $${HARD_SPEND_CAP_USD}.`);
      maxSpendUsd = parsed;
      continue;
    }
    if (argument === '--help') continue;
    if (argument.startsWith('--')) throw new Error(`Unknown Director evaluation option: ${argument}`);
  }
  return { authorizedLiveRun, maxSpendUsd };
}

export { HARD_SPEND_CAP_USD };

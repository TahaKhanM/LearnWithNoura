const MIN_SPEECH_RMS = 0.04;
const REQUIRED_HOT_FRAMES = 7;
const MAX_HOT_GAP_MS = 160;
const SERVER_CONFIRMATION_WINDOW_MS = 1_200;
const LOCAL_CANDIDATE_WINDOW_MS = 500;

/**
 * Fuses sustained local microphone energy with the provider's speech-start
 * event. Neither a short acoustic spike nor server VAD alone may interrupt a
 * tutor response.
 */
export class VoiceInterruptionGate {
  private noiseFloor = 0.006;
  private hotFrames = 0;
  private lastHotAt = Number.NEGATIVE_INFINITY;
  private localCandidateAt = Number.NEGATIVE_INFINITY;
  private serverSpeechAt = Number.NEGATIVE_INFINITY;

  observeEnergy(rms: number, tutorActive: boolean, now: number): boolean {
    const energy = Number.isFinite(rms) ? Math.max(0, rms) : 0;
    if (!tutorActive) {
      this.noiseFloor = this.noiseFloor * 0.94 + Math.min(energy, 0.08) * 0.06;
      this.clearCandidate();
      return false;
    }

    const threshold = Math.min(0.14, Math.max(MIN_SPEECH_RMS, this.noiseFloor * 2.2 + 0.012));
    if (energy >= threshold) {
      if (now - this.lastHotAt > MAX_HOT_GAP_MS) this.hotFrames = 0;
      this.hotFrames += 1;
      this.lastHotAt = now;
      if (this.hotFrames >= REQUIRED_HOT_FRAMES) this.localCandidateAt = now;
    } else if (now - this.lastHotAt > MAX_HOT_GAP_MS) {
      this.hotFrames = 0;
      this.localCandidateAt = Number.NEGATIVE_INFINITY;
    }

    return this.localCandidateAt > Number.NEGATIVE_INFINITY &&
      now - this.serverSpeechAt <= SERVER_CONFIRMATION_WINDOW_MS;
  }

  confirmServerSpeech(tutorActive: boolean, now: number): boolean {
    if (!tutorActive) {
      this.serverSpeechAt = Number.NEGATIVE_INFINITY;
      return false;
    }
    this.serverSpeechAt = now;
    return this.localCandidateAt > Number.NEGATIVE_INFINITY &&
      now - this.localCandidateAt <= LOCAL_CANDIDATE_WINDOW_MS;
  }

  endServerSpeech(): void {
    this.serverSpeechAt = Number.NEGATIVE_INFINITY;
    if (this.localCandidateAt === Number.NEGATIVE_INFINITY) this.hotFrames = 0;
  }

  reset(): void {
    this.clearCandidate();
    this.serverSpeechAt = Number.NEGATIVE_INFINITY;
  }

  private clearCandidate(): void {
    this.hotFrames = 0;
    this.lastHotAt = Number.NEGATIVE_INFINITY;
    this.localCandidateAt = Number.NEGATIVE_INFINITY;
  }
}

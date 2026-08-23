import { describe, expect, it } from 'vitest';
import { VoiceInterruptionGate } from './voiceInterruption';

describe('VoiceInterruptionGate', () => {
  it('rejects short noises even when server VAD reports speech', () => {
    const gate = new VoiceInterruptionGate();
    expect(gate.confirmServerSpeech(true, 0)).toBe(false);
    for (let frame = 1; frame <= 3; frame += 1) {
      expect(gate.observeEnergy(0.12, true, frame * 40)).toBe(false);
    }
    expect(gate.observeEnergy(0.005, true, 320)).toBe(false);
  });

  it('rejects sustained energy without independent server speech confirmation', () => {
    const gate = new VoiceInterruptionGate();
    for (let frame = 1; frame <= 10; frame += 1) {
      expect(gate.observeEnergy(0.09, true, frame * 40)).toBe(false);
    }
  });

  it('accepts sustained speech when local and server detectors agree', () => {
    const gate = new VoiceInterruptionGate();
    expect(gate.confirmServerSpeech(true, 80)).toBe(false);
    for (let frame = 1; frame < 7; frame += 1) {
      expect(gate.observeEnergy(0.09, true, 80 + frame * 40)).toBe(false);
    }
    expect(gate.observeEnergy(0.09, true, 80 + 7 * 40)).toBe(true);
  });

  it('raises the local threshold above a steady room-noise floor', () => {
    const gate = new VoiceInterruptionGate();
    for (let frame = 1; frame <= 60; frame += 1) gate.observeEnergy(0.02, false, frame * 40);
    gate.confirmServerSpeech(true, 2_500);
    for (let frame = 1; frame <= 12; frame += 1) {
      expect(gate.observeEnergy(0.035, true, 2_500 + frame * 40)).toBe(false);
    }
  });
});

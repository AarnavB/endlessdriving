import type { VehicleDefinition } from '../vehicles/VehicleDefinitions';
import type { VehicleShiftEvent } from '../vehicles/VehicleController';

/**
 * Sample-based engine playback.
 *
 * This deliberately contains no oscillator, periodic-wave, or synthesized
 * exhaust path. The audible engine is the recorded car audio assigned to the
 * selected vehicle. Playback rate follows simulated RPM; downshifts create a
 * brief rate flare from the same recording.
 */
export class EngineAudio {
  private sample: HTMLAudioElement | null = null;
  private currentVehicleId: VehicleDefinition['id'] | null = null;
  private currentProfile: VehicleDefinition['audio'] | null = null;
  private started = false;
  private paused = false;

  private engineVolume = 0.42;
  private effectsVolume = 0.45;

  private shiftStartedAt = 0;
  private shiftDuration = 0;
  private shiftRateBoost = 0;

  async unlock(definition: VehicleDefinition): Promise<void> {
    this.started = true;
    this.paused = false;
    await this.selectVehicleSample(definition, true);
  }

  update(
    rpm: number,
    throttle: number,
    _speedMps: number,
    engineLoad: number,
    definition: VehicleDefinition,
  ): void {
    if (!this.started || this.paused) return;

    if (this.currentVehicleId !== definition.id || !this.sample) {
      void this.selectVehicleSample(definition, false).catch((error: unknown) => {
        console.warn('Recorded engine sample could not be loaded:', error);
      });
      return;
    }

    const profile = definition.audio;
    const idleRpm = Math.min(1300, Math.max(750, definition.maxRpm * 0.12));
    const rpmRange = Math.max(1, definition.maxRpm - idleRpm);
    const normalizedRpm = Math.min(1, Math.max(0, (rpm - idleRpm) / rpmRange));
    const rpmCurve = Math.pow(normalizedRpm, 0.78);
    const baseRate = profile.minPlaybackRate
      + (profile.maxPlaybackRate - profile.minPlaybackRate) * rpmCurve;

    // A short pitch rise is applied to the actual recording on downshifts,
    // including zero-throttle downshifts. No oscillator or synthetic blip is used.
    const now = performance.now();
    const elapsed = (now - this.shiftStartedAt) / 1000;
    const shiftEnvelope = this.shiftDuration > 0
      ? Math.max(0, 1 - elapsed / this.shiftDuration)
      : 0;
    if (shiftEnvelope === 0) {
      this.shiftRateBoost = 0;
      this.shiftDuration = 0;
    }

    const playbackRate = Math.min(
      1.65,
      Math.max(0.55, baseRate * (1 + this.shiftRateBoost * shiftEnvelope)),
    );
    this.sample.playbackRate = playbackRate;
    this.sample.volume = this.getSampleVolume(
      Math.max(0.06, Math.min(1, engineLoad * 0.72 + throttle * 0.28)),
    );
  }

  /** Gear changes shape the recorded sample itself rather than adding a synth. */
  playShiftEvent(event: VehicleShiftEvent): void {
    if (!this.started || this.paused || !this.sample) return;

    const currentRpm = Math.max(700, event.currentRpm);
    const targetRpm = Math.max(700, event.targetRpm);
    const rpmRise = Math.max(0, targetRpm - currentRpm);

    if (event.type === 'downshift') {
      const ratioRise = targetRpm / currentRpm;
      this.shiftRateBoost = Math.min(0.32, Math.max(0.08, ratioRise - 1));
      this.shiftDuration = 0.24;
      this.shiftStartedAt = performance.now();
    } else if (event.type === 'upshift') {
      this.shiftRateBoost = -0.1;
      this.shiftDuration = 0.13;
      this.shiftStartedAt = performance.now();
    } else if (event.type === 'neutral' || event.type === 'engage' || event.type === 'reverse') {
      this.shiftRateBoost = Math.min(0.12, rpmRise / 12000);
      this.shiftDuration = 0.12;
      this.shiftStartedAt = performance.now();
    }
  }

  setEngineVolume(volume: number): void {
    this.engineVolume = Math.max(0, Math.min(1, volume));
    if (this.sample) {
      this.sample.volume = this.getSampleVolume(0.7);
    }
  }

  /** Effects volume scales the brief gear-change playback-rate accent. */
  setEffectsVolume(volume: number): void {
    this.effectsVolume = Math.max(0, Math.min(1, volume));
    this.shiftRateBoost *= 0.75 + this.effectsVolume * 0.25;
  }

  pause(): void {
    this.paused = true;
    this.sample?.pause();
  }

  resume(): void {
    if (!this.started || !this.sample) return;
    this.paused = false;
    void this.sample.play().catch((error: unknown) => {
      console.warn('Recorded engine sample could not resume:', error);
    });
  }

  dispose(): void {
    this.started = false;
    this.paused = true;
    this.sample?.pause();
    if (this.sample) {
      this.sample.removeAttribute('src');
      this.sample.load();
    }
    this.sample = null;
    this.currentVehicleId = null;
    this.currentProfile = null;
    this.shiftDuration = 0;
    this.shiftRateBoost = 0;
  }

  private async selectVehicleSample(
    definition: VehicleDefinition,
    playImmediately: boolean,
  ): Promise<void> {
    if (this.currentVehicleId === definition.id && this.sample) {
      if (playImmediately && this.sample.paused) await this.sample.play();
      return;
    }

    this.sample?.pause();
    if (this.sample) {
      this.sample.removeAttribute('src');
      this.sample.load();
    }

    const profile = definition.audio;
    const sample = new Audio(profile.sampleUrl);
    sample.preload = 'auto';
    sample.loop = true;
    sample.volume = this.getSampleVolume(0.7);
    sample.playbackRate = profile.minPlaybackRate;
    // Preserve the recording's spectral character while allowing pitch to follow RPM.
    sample.preservesPitch = false;

    sample.addEventListener('error', () => {
      console.warn(
        'Could not load the recorded engine sample for',
        definition.name,
        profile.sampleUrl,
      );
    });

    this.sample = sample;
    this.currentVehicleId = definition.id;
    this.currentProfile = profile;

    if (playImmediately) {
      await sample.play();
    }
  }

  private getSampleVolume(load: number): number {
    const profileGain = this.currentProfile?.volume ?? 0.9;
    const loadGain = 0.66 + load * 0.34;
    return Math.min(1, Math.max(0, this.engineVolume * profileGain * loadGain));
  }
}

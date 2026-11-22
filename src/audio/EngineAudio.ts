import type { VehicleDefinition } from '../vehicles/VehicleDefinitions';
import type { VehicleShiftEvent } from '../vehicles/VehicleController';

/**
 * Recorded engine playback with a strict engine-focused filter chain.
 *
 * No wind bed, ambience, crowd layer, oscillator, synthesized exhaust, or
 * additional sound effects are mixed into the engine channel. The original
 * video-derived recordings are band-limited to suppress wind rumble and
 * intelligible voice frequencies as much as a real-time browser filter allows.
 */
export class EngineAudio {
  private context: AudioContext | null = null;
  private sample: HTMLAudioElement | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;
  private highPass: BiquadFilterNode | null = null;
  private voiceLowCut: BiquadFilterNode | null = null;
  private voicePresenceCut: BiquadFilterNode | null = null;
  private lowPass: BiquadFilterNode | null = null;
  private outputGain: GainNode | null = null;

  private currentVehicleId: VehicleDefinition['id'] | null = null;
  private currentProfile: VehicleDefinition['audio'] | null = null;
  private started = false;
  private paused = false;

  private engineVolume = 0.42;
  private shiftStartedAt = 0;
  private shiftDuration = 0;
  private shiftRateBoost = 0;

  async unlock(definition: VehicleDefinition): Promise<void> {
    this.started = true;
    this.paused = false;
    this.ensureAudioGraph();
    await this.selectVehicleSample(definition, true);
    await this.context?.resume();
  }

  update(
    rpm: number,
    throttle: number,
    _speedMps: number,
    engineLoad: number,
    definition: VehicleDefinition,
  ): void {
    if (!this.started || this.paused || !this.context) return;

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

    // Downshift flare is applied to the real engine recording, even off throttle.
    const now = performance.now();
    const elapsed = (now - this.shiftStartedAt) / 1000;
    const shiftEnvelope = this.shiftDuration > 0
      ? Math.max(0, 1 - elapsed / this.shiftDuration)
      : 0;
    if (shiftEnvelope === 0) {
      this.shiftRateBoost = 0;
      this.shiftDuration = 0;
    }

    this.sample.playbackRate = Math.min(
      1.65,
      Math.max(0.55, baseRate * (1 + this.shiftRateBoost * shiftEnvelope)),
    );

    const load = Math.max(0.08, Math.min(1, engineLoad * 0.72 + throttle * 0.28));
    if (this.outputGain) {
      const profileGain = this.currentProfile?.volume ?? 0.9;
      const loadGain = 0.68 + load * 0.32;
      this.outputGain.gain.setTargetAtTime(
        Math.min(1, this.engineVolume * profileGain * loadGain),
        this.context.currentTime,
        0.045,
      );
    }
  }

  /** Gear changes accent the recorded sample only; no separate blip/effect is mixed. */
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
    if (this.outputGain && this.context) {
      this.outputGain.gain.setTargetAtTime(
        this.engineVolume * (this.currentProfile?.volume ?? 0.9),
        this.context.currentTime,
        0.04,
      );
    }
  }

  /** Other effects are intentionally disabled: the mix is engine audio only. */
  setEffectsVolume(_volume: number): void {
    // No wind, ambience, tyre, crowd, or other effects are mixed by EngineAudio.
  }

  pause(): void {
    this.paused = true;
    this.sample?.pause();
    void this.context?.suspend();
  }

  resume(): void {
    if (!this.started || !this.sample) return;
    this.paused = false;
    void this.context?.resume();
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

    this.mediaSource?.disconnect();
    this.highPass?.disconnect();
    this.voiceLowCut?.disconnect();
    this.voicePresenceCut?.disconnect();
    this.lowPass?.disconnect();
    this.outputGain?.disconnect();

    void this.context?.close();
    this.context = null;
    this.sample = null;
    this.mediaSource = null;
    this.highPass = null;
    this.voiceLowCut = null;
    this.voicePresenceCut = null;
    this.lowPass = null;
    this.outputGain = null;
    this.currentVehicleId = null;
    this.currentProfile = null;
    this.shiftDuration = 0;
    this.shiftRateBoost = 0;
  }

  private ensureAudioGraph(): void {
    if (this.context) return;

    this.context = new AudioContext();
    const context = this.context;

    this.highPass = context.createBiquadFilter();
    this.highPass.type = 'highpass';
    this.highPass.frequency.value = 78;
    this.highPass.Q.value = 0.707;

    // Speech fundamental/body region: attenuate, rather than boost, this band.
    this.voiceLowCut = context.createBiquadFilter();
    this.voiceLowCut.type = 'peaking';
    this.voiceLowCut.frequency.value = 245;
    this.voiceLowCut.Q.value = 0.9;
    this.voiceLowCut.gain.value = -10;

    // Reduce voice intelligibility and incidental high-frequency activity.
    this.voicePresenceCut = context.createBiquadFilter();
    this.voicePresenceCut.type = 'peaking';
    this.voicePresenceCut.frequency.value = 1180;
    this.voicePresenceCut.Q.value = 0.85;
    this.voicePresenceCut.gain.value = -18;

    this.lowPass = context.createBiquadFilter();
    this.lowPass.type = 'lowpass';
    this.lowPass.frequency.value = 920;
    this.lowPass.Q.value = 0.58;

    this.outputGain = context.createGain();
    this.outputGain.gain.value = 0;

    this.highPass.connect(this.voiceLowCut);
    this.voiceLowCut.connect(this.voicePresenceCut);
    this.voicePresenceCut.connect(this.lowPass);
    this.lowPass.connect(this.outputGain);
    this.outputGain.connect(context.destination);
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
    this.mediaSource?.disconnect();

    if (this.sample) {
      this.sample.removeAttribute('src');
      this.sample.load();
    }

    this.ensureAudioGraph();
    const profile = definition.audio;
    const sample = new Audio();
    sample.crossOrigin = 'anonymous';
    sample.preload = 'auto';
    sample.loop = true;
    sample.playbackRate = profile.minPlaybackRate;
    sample.preservesPitch = false;
    sample.src = profile.sampleUrl;
    sample.volume = 1;

    this.mediaSource = this.context!.createMediaElementSource(sample);
    this.mediaSource.connect(this.highPass!);

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
    if (this.outputGain && this.context) {
      this.outputGain.gain.setTargetAtTime(
        this.engineVolume * profile.volume * 0.72,
        this.context.currentTime,
        0.04,
      );
    }

    // A vehicle changed in the garage while paused must begin playing on resume.
    if (playImmediately || (!this.paused && this.started)) {
      await sample.play();
    }
  }
}

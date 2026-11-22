import type { VehicleDefinition, VehicleAudioProfile } from '../vehicles/VehicleDefinitions';
import type { VehicleShiftEvent } from '../vehicles/VehicleController';

/**
 * Procedural ICE/exhaust synthesizer.
 *
 * The main voice is a repeating combustion-pressure pulse train, not a stack of
 * clean sine tones. Its spectrum is shaped by engine-specific exhaust resonance,
 * mild saturation and a deliberately low exhaust cutoff. There are no noise
 * generators, wind beds, ambience layers, samples or electric-motor tones.
 */
export class EngineAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;

  private combustionOsc: OscillatorNode | null = null;
  private blockOsc: OscillatorNode | null = null;
  private combustionWave: PeriodicWave | null = null;
  private saturation: WaveShaperNode | null = null;

  private bodyFilter: BiquadFilterNode | null = null;
  private exhaustResonance: BiquadFilterNode | null = null;
  private exhaustLowPass: BiquadFilterNode | null = null;
  private blockGain: GainNode | null = null;

  private currentVehicleId: VehicleDefinition['id'] | null = null;
  private currentProfile: VehicleAudioProfile | null = null;
  private started = false;
  private engineVolume = 0.42;
  private shiftCutUntil = 0;

  async unlock(definition?: VehicleDefinition): Promise<void> {
    if (!this.context) this.createAudioGraph();
    if (!this.context) return;

    this.started = true;
    if (definition) this.applyVehicleProfile(definition);
    if (this.context.state === 'suspended') await this.context.resume();
  }

  update(
    rpm: number,
    throttle: number,
    _speedMps: number,
    engineLoad: number,
    definition: VehicleDefinition,
  ): void {
    const ctx = this.context;
    if (!ctx || !this.started || !this.combustionOsc || !this.blockOsc
      || !this.engineGain || !this.blockGain || !this.bodyFilter
      || !this.exhaustResonance || !this.exhaustLowPass) return;

    if (this.currentVehicleId !== definition.id) {
      this.applyVehicleProfile(definition);
    }

    const profile = definition.audio;
    const now = ctx.currentTime;
    const idleRpm = Math.min(1350, Math.max(750, definition.maxRpm * 0.115));
    const normalizedRpm = THREEClamp((rpm - idleRpm) / Math.max(1, definition.maxRpm - idleRpm));
    const crankHz = Math.max(10, rpm / 60);
    const firingFrequency = Math.max(24, crankHz * (profile.cylinders / 2));
    const load = THREEClamp(engineLoad * 0.74 + throttle * 0.26, 0.12, 1);
    const shiftCut = now < this.shiftCutUntil ? 0.38 : 1;

    // The exhaust pulses follow the actual four-stroke firing rate.
    this.combustionOsc.frequency.setTargetAtTime(firingFrequency, now, 0.035);
    // A quiet mechanical-block component adds weight without introducing a
    // separate whine or an unrelated ambience/noise layer.
    this.blockOsc.frequency.setTargetAtTime(crankHz * 2, now, 0.055);

    this.engineGain.gain.setTargetAtTime(
      this.engineVolume * (0.58 + load * 0.42) * shiftCut,
      now,
      0.055,
    );
    this.blockGain.gain.setTargetAtTime(
      this.engineVolume * profile.exhaustBodyGain * (0.075 + load * 0.055),
      now,
      0.07,
    );

    // Keep the exhaust body dominant. Higher RPM opens the exhaust slightly,
    // but the ceiling remains low enough to avoid the previous piercing whine.
    this.bodyFilter.gain.setTargetAtTime(3.2 + load * 2.8, now, 0.09);
    this.exhaustResonance.frequency.setTargetAtTime(
      profile.exhaustResonanceHz * (0.94 + normalizedRpm * 0.16),
      now,
      0.11,
    );
    this.exhaustResonance.gain.setTargetAtTime(
      2.2 + load * 2.1,
      now,
      0.09,
    );
    this.exhaustLowPass.frequency.setTargetAtTime(
      Math.min(
        profile.maxExhaustHz,
        profile.maxExhaustHz * (0.64 + normalizedRpm * 0.36) + load * 85,
      ),
      now,
      0.095,
    );
  }

  /** Gear changes create a short flare using the same exhaust pulse waveform. */
  playShiftEvent(event: VehicleShiftEvent): void {
    const ctx = this.context;
    const profile = this.currentProfile;
    if (!ctx || !this.started || !profile || !this.combustionWave) return;

    if (event.type === 'upshift') {
      this.shiftCutUntil = Math.max(this.shiftCutUntil, ctx.currentTime + 0.105);
      return;
    }

    if (event.type === 'downshift') {
      // This is driven by the gear event, not throttle input.
      this.playCombustionFlare(event.currentRpm, event.targetRpm, 0.2, 0.25);
    } else if (event.type === 'neutral' || event.type === 'engage' || event.type === 'reverse') {
      this.playCombustionFlare(event.currentRpm, event.targetRpm, 0.11, 0.14);
    }
  }

  setEngineVolume(volume: number): void {
    this.engineVolume = THREEClamp(volume);
    if (this.engineGain && this.context) {
      this.engineGain.gain.setTargetAtTime(
        this.engineVolume * 0.85,
        this.context.currentTime,
        0.04,
      );
    }
  }

  /** Suspend the engine tone while the game is paused. */
  pause(): void {
    if (this.context?.state === 'running') {
      void this.context.suspend();
    }
  }

  /** Resume the engine tone when gameplay resumes. */
  resume(): void {
    if (this.started && this.context?.state === 'suspended') {
      void this.context.resume();
    }
  }

  /** The engine channel intentionally contains no separate effects or ambience. */
  setEffectsVolume(_volume: number): void {
    // Kept for settings compatibility; there are no non-engine sounds in this channel.
  }

  dispose(): void {
    try { this.combustionOsc?.stop(); } catch { /* already stopped */ }
    try { this.blockOsc?.stop(); } catch { /* already stopped */ }

    this.combustionOsc?.disconnect();
    this.blockOsc?.disconnect();
    this.saturation?.disconnect();
    this.bodyFilter?.disconnect();
    this.exhaustResonance?.disconnect();
    this.exhaustLowPass?.disconnect();
    this.blockGain?.disconnect();
    this.engineGain?.disconnect();
    this.master?.disconnect();

    void this.context?.close();
    this.context = null;
    this.master = null;
    this.engineGain = null;
    this.combustionOsc = null;
    this.blockOsc = null;
    this.combustionWave = null;
    this.saturation = null;
    this.bodyFilter = null;
    this.exhaustResonance = null;
    this.exhaustLowPass = null;
    this.blockGain = null;
    this.currentVehicleId = null;
    this.currentProfile = null;
    this.started = false;
  }

  private createAudioGraph(): void {
    const ctx = new AudioContext();
    this.context = ctx;

    this.master = ctx.createGain();
    this.engineGain = ctx.createGain();
    this.blockGain = ctx.createGain();

    this.saturation = ctx.createWaveShaper();
    this.saturation.oversample = '4x';

    this.bodyFilter = ctx.createBiquadFilter();
    this.bodyFilter.type = 'lowshelf';
    this.bodyFilter.frequency.value = 145;
    this.bodyFilter.gain.value = 5;

    this.exhaustResonance = ctx.createBiquadFilter();
    this.exhaustResonance.type = 'peaking';
    this.exhaustResonance.frequency.value = 125;
    this.exhaustResonance.Q.value = 0.92;
    this.exhaustResonance.gain.value = 3.5;

    this.exhaustLowPass = ctx.createBiquadFilter();
    this.exhaustLowPass.type = 'lowpass';
    this.exhaustLowPass.frequency.value = 900;
    this.exhaustLowPass.Q.value = 0.58;

    this.combustionOsc = ctx.createOscillator();
    this.combustionOsc.type = 'sawtooth';
    this.combustionOsc.connect(this.saturation);
    this.saturation.connect(this.bodyFilter);

    this.blockOsc = ctx.createOscillator();
    this.blockOsc.type = 'triangle';
    this.blockOsc.connect(this.blockGain);
    this.blockGain.connect(this.bodyFilter);

    this.bodyFilter.connect(this.exhaustResonance);
    this.exhaustResonance.connect(this.exhaustLowPass);
    this.exhaustLowPass.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.master.gain.value = 0.88;
    this.engineGain.gain.value = this.engineVolume * 0.72;

    this.combustionOsc.start();
    this.blockOsc.start();
  }

  private applyVehicleProfile(definition: VehicleDefinition): void {
    const ctx = this.context;
    const profile = definition.audio;
    if (!ctx || !this.combustionOsc || !this.saturation || !this.bodyFilter
      || !this.exhaustResonance || !this.exhaustLowPass) return;

    this.currentVehicleId = definition.id;
    this.currentProfile = profile;
    this.combustionWave = this.createExhaustPulseWave(ctx, profile);
    this.combustionOsc.setPeriodicWave(this.combustionWave);

    // A mild asymmetric soft clip adds exhaust bark without the fizz of hard
    // clipping. The saturation amount is authored per engine.
    const curve = new Float32Array(2048);
    const drive = profile.saturation;
    const normalizer = Math.tanh(drive);
    for (let i = 0; i < curve.length; i++) {
      const input = (i / (curve.length - 1)) * 2 - 1;
      const asymmetric = input >= 0 ? input * drive : input * drive * 0.86;
      curve[i] = Math.tanh(asymmetric) / normalizer;
    }
    this.saturation.curve = curve;

    this.bodyFilter.frequency.setValueAtTime(140, ctx.currentTime);
    this.bodyFilter.gain.setValueAtTime(4.4, ctx.currentTime);
    this.exhaustResonance.frequency.setValueAtTime(
      profile.exhaustResonanceHz,
      ctx.currentTime,
    );
    this.exhaustLowPass.frequency.setValueAtTime(profile.maxExhaustHz * 0.72, ctx.currentTime);
  }

  private createExhaustPulseWave(
    ctx: AudioContext,
    profile: VehicleAudioProfile,
  ): PeriodicWave {
    const sampleCount = 512;
    const harmonicCount = 96;
    const pulse = new Float32Array(sampleCount);
    let mean = 0;

    // A steep combustion-pressure rise followed by an exponential exhaust
    // decay. Repeated at the firing interval this reads as exhaust pulses,
    // rather than a continuous smooth electronic oscillator.
    for (let i = 0; i < sampleCount; i++) {
      const phase = i / sampleCount;
      const value = phase < profile.pulseWidth
        ? Math.exp(-phase / Math.max(0.025, profile.pulseWidth * 0.43))
        : 0;
      pulse[i] = value;
      mean += value / sampleCount;
    }

    for (let i = 0; i < sampleCount; i++) pulse[i] -= mean;

    const real = new Float32Array(harmonicCount + 1);
    const imag = new Float32Array(harmonicCount + 1);
    for (let harmonic = 1; harmonic <= harmonicCount; harmonic++) {
      let cosine = 0;
      let sine = 0;
      for (let sample = 0; sample < sampleCount; sample++) {
        const angle = (2 * Math.PI * harmonic * sample) / sampleCount;
        cosine += pulse[sample] * Math.cos(angle);
        sine += pulse[sample] * Math.sin(angle);
      }
      real[harmonic] = (2 / sampleCount) * cosine;
      imag[harmonic] = (2 / sampleCount) * sine;
    }

    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  private playCombustionFlare(
    currentRpm: number,
    targetRpm: number,
    peakGain: number,
    duration: number,
  ): void {
    const ctx = this.context;
    const profile = this.currentProfile;
    if (!ctx || !profile || !this.combustionWave || !this.saturation) return;

    const firingOrder = profile.cylinders / 2;
    const startHz = Math.max(24, (Math.max(700, currentRpm) / 60) * firingOrder);
    const targetHz = Math.max(24, (Math.max(700, targetRpm) / 60) * firingOrder);
    const now = ctx.currentTime;

    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();
    oscillator.setPeriodicWave(this.combustionWave);
    oscillator.frequency.setValueAtTime(startHz, now);
    oscillator.frequency.exponentialRampToValueAtTime(targetHz, now + 0.075);

    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(0.0002, peakGain * this.engineVolume),
      now + 0.018,
    );
    envelope.gain.setValueAtTime(
      Math.max(0.0002, peakGain * this.engineVolume) * 0.72,
      now + Math.min(0.095, duration * 0.45),
    );
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    // Feed the transient into the same saturator, exhaust-body resonance and
    // low-pass chain as the running engine. It cannot introduce a separate tone.
    oscillator.connect(envelope);
    envelope.connect(this.saturation);

    oscillator.start(now);
    oscillator.stop(now + duration + 0.025);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
    };
  }
}

function THREEClamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

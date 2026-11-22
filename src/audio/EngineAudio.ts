import type { VehicleDefinition } from '../vehicles/VehicleDefinitions';
import type { VehicleShiftEvent } from '../vehicles/VehicleController';

export class EngineAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private shiftGain: GainNode | null = null;
  private ambientGain: GainNode | null = null;
  private effectsGain: GainNode | null = null;

  // The primary voice runs at crankshaft speed. Its custom spectrum emphasizes
  // each engine's firing order instead of stacking bright electronic tones.
  private lowOsc: OscillatorNode | null = null;
  private midOsc: OscillatorNode | null = null;
  private highOsc: OscillatorNode | null = null;
  private subOsc: OscillatorNode | null = null;
  private electricOsc: OscillatorNode | null = null;
  private engineWave: PeriodicWave | null = null;

  private engineFilter: BiquadFilterNode | null = null;
  private lowLayerGain: GainNode | null = null;
  private midLayerGain: GainNode | null = null;
  private highLayerGain: GainNode | null = null;
  private subLayerGain: GainNode | null = null;
  private electricLayerGain: GainNode | null = null;

  // Low-mid exhaust turbulence adds texture so the engine is not a clean,
  // continuous oscillator. Turbo noise is deliberately much quieter.
  private exhaustSource: AudioBufferSourceNode | null = null;
  private exhaustFilter: BiquadFilterNode | null = null;
  private exhaustGain: GainNode | null = null;
  private turboSource: AudioBufferSourceNode | null = null;
  private turboFilter: BiquadFilterNode | null = null;
  private turboGain: GainNode | null = null;
  private windSource: AudioBufferSourceNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;

  private started = false;
  private engineVolume = 0.42;
  private effectsVolume = 0.45;
  private shiftCutUntil = 0;
  private currentProfile: VehicleDefinition['audio'] | null = null;

  async unlock(): Promise<void> {
    if (this.started) {
      if (this.context?.state === 'suspended') await this.context.resume();
      return;
    }

    const AudioContextCtor = window.AudioContext;
    this.context = new AudioContextCtor();
    const ctx = this.context;

    this.master = ctx.createGain();
    this.engineGain = ctx.createGain();
    this.shiftGain = ctx.createGain();
    this.ambientGain = ctx.createGain();
    this.effectsGain = ctx.createGain();
    this.master.gain.value = 0.78;
    this.engineGain.gain.value = this.engineVolume * 0.72;
    this.shiftGain.gain.value = this.engineVolume * 0.42;
    this.ambientGain.gain.value = this.effectsVolume * 0.2;
    this.effectsGain.gain.value = this.effectsVolume;

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 1050;
    this.engineFilter.Q.value = 0.68;

    this.lowLayerGain = ctx.createGain();
    this.midLayerGain = ctx.createGain();
    this.highLayerGain = ctx.createGain();
    this.subLayerGain = ctx.createGain();
    this.electricLayerGain = ctx.createGain();

    this.lowOsc = ctx.createOscillator();
    this.midOsc = ctx.createOscillator();
    this.highOsc = ctx.createOscillator();
    this.subOsc = ctx.createOscillator();
    this.electricOsc = ctx.createOscillator();

    // A custom periodic waveform is assigned once the selected engine profile
    // is known. Supporting voices are intentionally restrained.
    this.lowOsc.type = 'sawtooth';
    this.midOsc.type = 'triangle';
    this.highOsc.type = 'sine';
    this.subOsc.type = 'sine';
    this.electricOsc.type = 'sine';

    this.lowOsc.connect(this.lowLayerGain);
    this.midOsc.connect(this.midLayerGain);
    this.highOsc.connect(this.highLayerGain);
    this.subOsc.connect(this.subLayerGain);
    this.electricOsc.connect(this.electricLayerGain);

    this.lowLayerGain.connect(this.engineFilter);
    this.midLayerGain.connect(this.engineFilter);
    this.highLayerGain.connect(this.engineFilter);
    this.subLayerGain.connect(this.engineFilter);
    this.electricLayerGain.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.shiftGain.connect(this.master);

    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++) {
      noiseData[i] = (Math.random() * 2 - 1) * 0.28;
    }

    this.exhaustSource = ctx.createBufferSource();
    this.exhaustSource.buffer = noiseBuffer;
    this.exhaustSource.loop = true;
    this.exhaustFilter = ctx.createBiquadFilter();
    this.exhaustFilter.type = 'bandpass';
    this.exhaustFilter.frequency.value = 310;
    this.exhaustFilter.Q.value = 0.72;
    this.exhaustGain = ctx.createGain();
    this.exhaustGain.gain.value = 0;
    this.exhaustSource.connect(this.exhaustFilter);
    this.exhaustFilter.connect(this.exhaustGain);
    this.exhaustGain.connect(this.engineFilter);

    this.turboSource = ctx.createBufferSource();
    this.turboSource.buffer = noiseBuffer;
    this.turboSource.loop = true;
    this.turboFilter = ctx.createBiquadFilter();
    this.turboFilter.type = 'bandpass';
    this.turboFilter.frequency.value = 620;
    this.turboFilter.Q.value = 0.72;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turboSource.connect(this.turboFilter);
    this.turboFilter.connect(this.turboGain);
    this.turboGain.connect(this.engineGain);

    this.windSource = ctx.createBufferSource();
    this.windSource.buffer = noiseBuffer;
    this.windSource.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 180;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSource.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.ambientGain);

    this.ambientGain.connect(this.master);
    this.effectsGain.connect(this.master);
    this.master.connect(ctx.destination);

    this.lowOsc.start();
    this.midOsc.start();
    this.highOsc.start();
    this.subOsc.start();
    this.electricOsc.start();
    this.exhaustSource.start();
    this.turboSource.start();
    this.windSource.start();

    this.started = true;
    await ctx.resume();
  }

  update(
    rpm: number,
    throttle: number,
    speedMps: number,
    engineLoad: number,
    definition: VehicleDefinition,
  ): void {
    const ctx = this.context;
    if (!ctx || !this.started || !this.lowOsc || !this.midOsc || !this.highOsc
      || !this.subOsc || !this.electricOsc || !this.engineFilter || !this.engineGain
      || !this.lowLayerGain || !this.midLayerGain || !this.highLayerGain
      || !this.subLayerGain || !this.electricLayerGain
      || !this.exhaustGain || !this.exhaustFilter
      || !this.windGain || !this.windFilter || !this.turboGain || !this.turboFilter) return;

    const now = ctx.currentTime;
    const profile = definition.audio;
    if (this.currentProfile !== profile) {
      this.engineWave = this.createEngineWave(profile);
      if (this.engineWave) this.lowOsc.setPeriodicWave(this.engineWave);
      this.currentProfile = profile;
    }

    const normalizedRpm = Math.min(1, Math.max(0, rpm / definition.maxRpm));
    const crankHz = Math.max(12, rpm / 60);
    const firingOrder = profile.cylinders / 2;
    const firingFrequency = crankHz * firingOrder;

    // Keep a real idle underneath the engine note. Load opens the exhaust and
    // intake character; it does not switch the engine on/off with the throttle.
    const load = Math.max(0.08, Math.min(1, engineLoad * 0.72 + throttle * 0.28));
    const shiftCut = now < this.shiftCutUntil ? 0.3 : 1;

    this.lowOsc.frequency.setTargetAtTime(crankHz, now, 0.045);
    this.midOsc.frequency.setTargetAtTime(firingFrequency, now, 0.05);
    this.highOsc.frequency.setTargetAtTime(firingFrequency * 1.8, now, 0.06);
    this.subOsc.frequency.setTargetAtTime(Math.max(7, crankHz * 0.5), now, 0.07);
    this.electricOsc.frequency.setTargetAtTime(65 + normalizedRpm * 210, now, 0.09);

    this.lowLayerGain.gain.setTargetAtTime(
      profile.lowLayer * (0.34 + load * 0.48), now, 0.07,
    );
    this.midLayerGain.gain.setTargetAtTime(
      profile.midLayer * (0.025 + load * 0.085), now, 0.08,
    );
    this.highLayerGain.gain.setTargetAtTime(
      profile.highLayer * (0.003 + normalizedRpm * 0.018), now, 0.09,
    );
    this.subLayerGain.gain.setTargetAtTime(
      0.035 + profile.lowLayer * 0.065, now, 0.1,
    );
    // The LaFerrari's electric assist is only a faint layer beneath its V12.
    this.electricLayerGain.gain.setTargetAtTime(
      profile.electricLayer * (0.001 + throttle * 0.018), now, 0.1,
    );

    const filterFrequency = profile.filterHz + normalizedRpm * 520 + load * 170;
    this.engineFilter.frequency.setTargetAtTime(
      Math.min(1850, filterFrequency), now, 0.085,
    );
    this.engineGain.gain.setTargetAtTime(
      this.engineVolume * (0.62 + load * 0.38) * shiftCut, now, 0.055,
    );

    this.exhaustFilter.frequency.setTargetAtTime(
      245 + normalizedRpm * 250 + load * 65, now, 0.11,
    );
    this.exhaustGain.gain.setTargetAtTime(
      profile.lowLayer * (0.075 + load * 0.105), now, 0.09,
    );

    // Turbo spool is a restrained broadband hiss, not a continuous whistle.
    const turboResponse = profile.turboLayer * throttle * (0.1 + normalizedRpm * 0.45);
    this.turboGain.gain.setTargetAtTime(
      turboResponse * this.engineVolume * 0.065, now, 0.18,
    );
    this.turboFilter.frequency.setTargetAtTime(
      430 + normalizedRpm * 560, now, 0.14,
    );

    this.windFilter.frequency.setTargetAtTime(
      140 + Math.min(1, speedMps / 50) * 620, now, 0.12,
    );
    this.windGain.gain.setTargetAtTime(
      Math.min(0.16, speedMps / 65) * 0.28, now, 0.15,
    );
  }

  /** Gear transition events are the source of shift sounds; throttle is deliberately not consulted. */
  playShiftEvent(event: VehicleShiftEvent): void {
    const ctx = this.context;
    if (!ctx || !this.started) return;

    if (event.type === 'upshift') {
      this.shiftCutUntil = Math.max(this.shiftCutUntil, ctx.currentTime + 0.105);
      this.playShiftTransient(event.currentRpm, event.targetRpm, 0.11, 0.16);
    } else if (event.type === 'downshift') {
      // The rev flare is a transmission event and remains active at exactly zero throttle.
      this.playShiftTransient(event.currentRpm, event.targetRpm, 0.17, 0.23);
    } else if (event.type === 'neutral' || event.type === 'engage') {
      this.playShiftTransient(
        event.currentRpm,
        Math.max(900, event.targetRpm * 0.9),
        0.065,
        0.1,
      );
    } else if (event.type === 'reverse') {
      this.playShiftTransient(event.currentRpm, Math.max(850, event.targetRpm), 0.085, 0.12);
    }
  }

  setEngineVolume(volume: number): void {
    this.engineVolume = Math.max(0, Math.min(1, volume));
    if (this.engineGain && this.context) {
      this.engineGain.gain.setTargetAtTime(this.engineVolume * 0.72, this.context.currentTime, 0.04);
    }
    if (this.shiftGain && this.context) {
      this.shiftGain.gain.setTargetAtTime(this.engineVolume * 0.42, this.context.currentTime, 0.04);
    }
  }

  setEffectsVolume(volume: number): void {
    this.effectsVolume = Math.max(0, Math.min(1, volume));
    if (this.context) {
      const now = this.context.currentTime;
      this.ambientGain?.gain.setTargetAtTime(this.effectsVolume * 0.2, now, 0.04);
      this.effectsGain?.gain.setTargetAtTime(this.effectsVolume, now, 0.04);
    }
  }

  dispose(): void {
    const oscillators = [
      this.lowOsc, this.midOsc, this.highOsc, this.subOsc, this.electricOsc,
    ];
    for (const oscillator of oscillators) {
      try { oscillator?.stop(); } catch { /* already stopped */ }
    }

    try { this.exhaustSource?.stop(); } catch { /* already stopped */ }
    try { this.turboSource?.stop(); } catch { /* already stopped */ }
    try { this.windSource?.stop(); } catch { /* already stopped */ }

    void this.context?.close();
    this.started = false;
    this.context = null;
    this.currentProfile = null;
    this.engineWave = null;
  }

  private createEngineWave(profile: VehicleDefinition['audio']): PeriodicWave | null {
    const ctx = this.context;
    if (!ctx) return null;

    // At crankshaft frequency, the strongest partials land at the engine's
    // firing order (4th for V8, 5th for V10, 6th for V12). Their overtones decay
    // progressively, giving each layout a combustion pulse rather than an EV-like
    // pair of pure tones.
    const partialCount = 64;
    const real = new Float32Array(partialCount + 1);
    const imag = new Float32Array(partialCount + 1);
    const firingOrder = profile.cylinders / 2;

    const pulseStrength = {
      'classic-v8': 0.9,
      'hybrid-v12': 0.72,
      v10: 0.8,
      'deep-v12': 1.02,
      'sharp-v12': 0.76,
      'track-v8': 0.86,
    }[profile.character];

    const phaseOffset = {
      'classic-v8': 0.035,
      'hybrid-v12': 0.015,
      v10: 0.055,
      'deep-v12': 0.025,
      'sharp-v12': 0.075,
      'track-v8': 0.06,
    }[profile.character];

    for (let harmonic = 1; harmonic <= partialCount; harmonic++) {
      const isFiringPartial = harmonic % firingOrder === 0;
      const firingHarmonic = isFiringPartial ? harmonic / firingOrder : 1;
      const mechanicalBody = 0.105 / Math.pow(harmonic, 0.82);
      const firingPulse = isFiringPartial
        ? (pulseStrength * profile.lowLayer) / Math.pow(firingHarmonic, 1.12)
        : 0;
      const upperTexture = profile.highLayer * 0.035 / Math.pow(harmonic, 1.25);
      const spectralRolloff = Math.exp(-harmonic / 34);
      const magnitude = (mechanicalBody + firingPulse + upperTexture) * spectralRolloff;
      const phase = harmonic * phaseOffset;
      real[harmonic] = magnitude * Math.sin(phase);
      imag[harmonic] = magnitude * Math.cos(phase);
    }

    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  private playShiftTransient(
    currentRpm: number,
    targetRpm: number,
    peakGain: number,
    duration: number,
  ): void {
    const ctx = this.context;
    if (!ctx) return;

    const profile = this.currentProfile;
    const cylinders = profile?.cylinders ?? 8;
    const firingOrder = cylinders / 2;
    const now = ctx.currentTime;
    const startHz = Math.max(12, Math.max(700, currentRpm) / 60);
    const targetHz = Math.max(12, Math.max(700, targetRpm) / 60);

    const oscillator = ctx.createOscillator();
    const harmonic = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    const harmonicGain = ctx.createGain();

    oscillator.type = 'sawtooth';
    if (this.engineWave) oscillator.setPeriodicWave(this.engineWave);
    harmonic.type = 'sine';
    oscillator.frequency.setValueAtTime(startHz, now);
    oscillator.frequency.exponentialRampToValueAtTime(targetHz, now + 0.085);
    harmonic.frequency.setValueAtTime(startHz * firingOrder, now);
    harmonic.frequency.exponentialRampToValueAtTime(targetHz * firingOrder, now + 0.085);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(profile?.filterHz ?? 900, now);
    filter.frequency.exponentialRampToValueAtTime(
      Math.min(1650, (profile?.filterHz ?? 900) + 420), now + 0.08,
    );
    filter.Q.value = 0.62;

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peakGain), now + 0.022);
    gain.gain.setValueAtTime(Math.max(0.0002, peakGain) * 0.72, now + 0.085);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    harmonicGain.gain.value = 0.055;

    oscillator.connect(filter);
    harmonic.connect(harmonicGain);
    harmonicGain.connect(filter);
    filter.connect(gain);
    gain.connect(this.shiftGain ?? this.master ?? ctx.destination);

    oscillator.start(now);
    harmonic.start(now);
    oscillator.stop(now + duration + 0.025);
    harmonic.stop(now + duration + 0.025);

    oscillator.onended = () => {
      oscillator.disconnect();
      harmonic.disconnect();
      filter.disconnect();
      gain.disconnect();
      harmonicGain.disconnect();
    };
  }
}

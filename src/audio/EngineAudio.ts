import type { VehicleDefinition } from '../vehicles/VehicleDefinitions';
import type { VehicleShiftEvent } from '../vehicles/VehicleController';

export class EngineAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private shiftGain: GainNode | null = null;
  private ambientGain: GainNode | null = null;
  private effectsGain: GainNode | null = null;
  private lowOsc: OscillatorNode | null = null;
  private midOsc: OscillatorNode | null = null;
  private highOsc: OscillatorNode | null = null;
  private subOsc: OscillatorNode | null = null;
  private electricOsc: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private lowLayerGain: GainNode | null = null;
  private midLayerGain: GainNode | null = null;
  private highLayerGain: GainNode | null = null;
  private subLayerGain: GainNode | null = null;
  private electricLayerGain: GainNode | null = null;
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
    this.master.gain.value = 0.74;
    this.engineGain.gain.value = this.engineVolume;
    this.shiftGain.gain.value = this.engineVolume * 0.82;
    this.ambientGain.gain.value = this.effectsVolume * 0.24;
    this.effectsGain.gain.value = this.effectsVolume;

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 1100;
    this.engineFilter.Q.value = 0.82;

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
    this.lowOsc.type = 'sawtooth';
    this.midOsc.type = 'square';
    this.highOsc.type = 'triangle';
    this.subOsc.type = 'triangle';
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
    for (let i = 0; i < noiseData.length; i++) noiseData[i] = (Math.random() * 2 - 1) * 0.25;

    this.turboSource = ctx.createBufferSource();
    this.turboSource.buffer = noiseBuffer;
    this.turboSource.loop = true;
    this.turboFilter = ctx.createBiquadFilter();
    this.turboFilter.type = 'bandpass';
    this.turboFilter.frequency.value = 1350;
    this.turboFilter.Q.value = 0.65;
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
      || !this.windGain || !this.windFilter || !this.turboGain || !this.turboFilter) return;

    const now = ctx.currentTime;
    const profile = definition.audio;
    this.currentProfile = profile;
    const normalizedRpm = Math.min(1, Math.max(0, rpm / definition.maxRpm));
    // Four-stroke firing frequency: half the crankshaft revolutions per cylinder.
    const firingFrequency = Math.max(18, (rpm / 60) * (profile.cylinders / 2));
    const load = Math.max(0.12, Math.min(1, engineLoad * 0.72 + throttle * 0.28));
    const pitch = 0.96 + normalizedRpm * 0.09;

    this.lowOsc.frequency.setTargetAtTime(firingFrequency * pitch, now, 0.055);
    this.midOsc.frequency.setTargetAtTime(firingFrequency * 2.03 * pitch, now, 0.06);
    this.highOsc.frequency.setTargetAtTime(firingFrequency * 3.01 * pitch, now, 0.065);
    this.subOsc.frequency.setTargetAtTime(firingFrequency * 0.5, now, 0.07);
    this.electricOsc.frequency.setTargetAtTime(75 + normalizedRpm * 330, now, 0.09);

    this.lowLayerGain.gain.setTargetAtTime(profile.lowLayer * (0.78 + load * 0.34), now, 0.08);
    this.midLayerGain.gain.setTargetAtTime(profile.midLayer * (0.28 + load * 0.72), now, 0.08);
    this.highLayerGain.gain.setTargetAtTime(profile.highLayer * (0.12 + normalizedRpm * 1.1), now, 0.08);
    this.subLayerGain.gain.setTargetAtTime(0.15 + profile.lowLayer * 0.3, now, 0.1);
    this.electricLayerGain.gain.setTargetAtTime(profile.electricLayer * (0.14 + throttle * 0.7), now, 0.09);
    this.engineFilter.frequency.setTargetAtTime(
      profile.filterHz + normalizedRpm * 1750 + load * 350, now, 0.085,
    );
    const shiftCut = now < this.shiftCutUntil ? 0.28 : 1;
    this.engineGain.gain.setTargetAtTime(this.engineVolume * load * shiftCut, now, 0.055);

    const turboResponse = profile.turboLayer * throttle * (0.18 + normalizedRpm * 0.82);
    this.turboGain.gain.setTargetAtTime(turboResponse * this.engineVolume * 0.23, now, 0.16);
    this.turboFilter.frequency.setTargetAtTime(900 + normalizedRpm * 1800, now, 0.12);

    this.windFilter.frequency.setTargetAtTime(
      150 + Math.min(1, speedMps / 50) * 1100, now, 0.12,
    );
    this.windGain.gain.setTargetAtTime(Math.min(0.18, speedMps / 65) * 0.32, now, 0.15);
  }

  /** Gear transition events are the source of shift sounds; throttle is deliberately not consulted. */
  playShiftEvent(event: VehicleShiftEvent): void {
    const ctx = this.context;
    if (!ctx || !this.started) return;
    if (event.type === 'upshift') {
      this.shiftCutUntil = Math.max(this.shiftCutUntil, ctx.currentTime + 0.105);
      this.playShiftTransient(event.targetRpm, 0.12, 0.16);
    } else if (event.type === 'downshift') {
      // The rev flare is a transmission event and remains active at exactly zero throttle.
      this.playShiftTransient(event.targetRpm, 0.2, 0.24);
    } else if (event.type === 'neutral' || event.type === 'engage') {
      this.playShiftTransient(Math.max(900, event.currentRpm * 0.9), 0.07, 0.1);
    } else if (event.type === 'reverse') {
      this.playShiftTransient(Math.max(850, event.targetRpm), 0.1, 0.13);
    }
  }

  setEngineVolume(volume: number): void {
    this.engineVolume = Math.max(0, Math.min(1, volume));
    if (this.engineGain && this.context) {
      this.engineGain.gain.setTargetAtTime(this.engineVolume, this.context.currentTime, 0.04);
    }
    if (this.shiftGain && this.context) {
      this.shiftGain.gain.setTargetAtTime(this.engineVolume * 0.82, this.context.currentTime, 0.04);
    }
  }

  setEffectsVolume(volume: number): void {
    this.effectsVolume = Math.max(0, Math.min(1, volume));
    if (this.context) {
      const now = this.context.currentTime;
      this.ambientGain?.gain.setTargetAtTime(this.effectsVolume * 0.24, now, 0.04);
      this.effectsGain?.gain.setTargetAtTime(this.effectsVolume, now, 0.04);
    }
  }

  dispose(): void {
    const oscillators = [this.lowOsc, this.midOsc, this.highOsc, this.subOsc, this.electricOsc];
    for (const oscillator of oscillators) {
      try { oscillator?.stop(); } catch { /* already stopped */ }
    }
    try { this.turboSource?.stop(); } catch { /* already stopped */ }
    try { this.windSource?.stop(); } catch { /* already stopped */ }
    void this.context?.close();
    this.started = false;
    this.context = null;
    this.currentProfile = null;
  }

  private playShiftTransient(targetRpm: number, peakGain: number, duration: number): void {
    const ctx = this.context;
    if (!ctx) return;
    const profile = this.currentProfile;
    const cylinders = profile?.cylinders ?? 8;
    const now = ctx.currentTime;
    const startHz = Math.max(34, (Math.max(700, targetRpm * 0.72) / 60) * (cylinders / 2));
    const targetHz = Math.max(38, (targetRpm / 60) * (cylinders / 2));
    const oscillator = ctx.createOscillator();
    const harmonic = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    const harmonicGain = ctx.createGain();

    oscillator.type = 'sawtooth';
    harmonic.type = 'triangle';
    oscillator.frequency.setValueAtTime(startHz, now);
    oscillator.frequency.exponentialRampToValueAtTime(targetHz, now + 0.075);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, targetHz * 0.82), now + duration);
    harmonic.frequency.setValueAtTime(startHz * 2.02, now);
    harmonic.frequency.exponentialRampToValueAtTime(targetHz * 2.02, now + 0.075);
    harmonic.frequency.exponentialRampToValueAtTime(Math.max(45, targetHz * 1.55), now + duration);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(profile?.filterHz ?? 1100, now);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(550, (profile?.filterHz ?? 1100) * 1.65), now + 0.07,
    );
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.0002, peakGain), now + 0.018,
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    harmonicGain.gain.value = 0.22;

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

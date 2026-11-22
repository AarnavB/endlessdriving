import type { VehicleDefinition } from '../vehicles/VehicleDefinitions';
import type { VehicleShiftEvent } from '../vehicles/VehicleController';

/**
 * Lightweight layered combustion model from the original NYC prototype.
 * It deliberately favours the low, uneven body of an ICE engine over a clean
 * oscillator whine. A speed-responsive filtered air channel supplies road rush.
 */
export class EngineAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private ambientGain: GainNode | null = null;
  private effectsGain: GainNode | null = null;
  private lowOsc: OscillatorNode | null = null;
  private highOsc: OscillatorNode | null = null;
  private subOsc: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private windSource: AudioBufferSourceNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private started = false;
  private engineVolume = 0.42;
  private effectsVolume = 0.45;
  private shiftCutUntil = 0;

  async unlock(_definition?: VehicleDefinition): Promise<void> {
    if (this.started) {
      if (this.context?.state === 'suspended') await this.context.resume();
      return;
    }
    const AudioContextCtor = window.AudioContext;
    this.context = new AudioContextCtor();
    const ctx = this.context;
    this.master = ctx.createGain();
    this.engineGain = ctx.createGain();
    this.ambientGain = ctx.createGain();
    this.effectsGain = ctx.createGain();
    this.master.gain.value = 0.78;
    this.engineGain.gain.value = this.engineVolume * 0.7;
    this.ambientGain.gain.value = this.effectsVolume * 0.22;
    this.effectsGain.gain.value = this.effectsVolume;

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 920;
    this.engineFilter.Q.value = 0.78;

    this.lowOsc = ctx.createOscillator();
    this.highOsc = ctx.createOscillator();
    this.subOsc = ctx.createOscillator();
    this.lowOsc.type = 'sawtooth';
    this.highOsc.type = 'square';
    this.subOsc.type = 'triangle';
    this.lowOsc.frequency.value = 28;
    this.highOsc.frequency.value = 56;
    this.subOsc.frequency.value = 14;

    const highGain = ctx.createGain();
    highGain.gain.value = 0.13;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.42;
    this.lowOsc.connect(this.engineFilter);
    this.highOsc.connect(highGain);
    highGain.connect(this.engineFilter);
    this.subOsc.connect(subGain);
    subGain.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);

    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x7f4a7c15;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = ((seed / 0x100000000) * 2 - 1) * 0.34;
    }
    this.windSource = ctx.createBufferSource();
    this.windSource.buffer = buffer;
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
    this.highOsc.start();
    this.subOsc.start();
    this.windSource.start();
    this.started = true;
    await ctx.resume();
  }

  update(
    rpm: number,
    throttle: number,
    speedMps: number,
    engineLoad: number,
    _definition: VehicleDefinition,
  ): void {
    const ctx = this.context;
    if (!ctx || !this.started || !this.lowOsc || !this.highOsc || !this.subOsc
      || !this.engineFilter || !this.engineGain || !this.windGain || !this.windFilter) return;
    const now = ctx.currentTime;
    const normalizedRpm = Math.min(1, Math.max(0, (rpm - 700) / 6500));
    const base = 16 + normalizedRpm * 94;
    const load = Math.min(1, Math.max(0.12, 0.16 + throttle * 0.48 + engineLoad * 0.25 + normalizedRpm * 0.16));
    const shiftLevel = now < this.shiftCutUntil ? 0.42 : 1;

    this.lowOsc.frequency.setTargetAtTime(base, now, 0.065);
    this.highOsc.frequency.setTargetAtTime(base * 2.02, now, 0.065);
    this.subOsc.frequency.setTargetAtTime(base * 0.49, now, 0.075);
    this.engineFilter.frequency.setTargetAtTime(500 + normalizedRpm * 2450 + load * 180, now, 0.09);
    this.engineGain.gain.setTargetAtTime(this.engineVolume * load * shiftLevel, now, 0.075);

    // The original prototype's wind bed was low-passed and only opened with road speed.
    this.windFilter.frequency.setTargetAtTime(150 + Math.min(1, speedMps / 48) * 920, now, 0.12);
    this.windGain.gain.setTargetAtTime(Math.min(0.15, speedMps / 70 * 0.15), now, 0.15);
  }

  playShiftEvent(event: VehicleShiftEvent): void {
    const ctx = this.context;
    if (!ctx || !this.started || !this.engineFilter || !this.engineGain) return;
    const now = ctx.currentTime;
    if (event.type === 'upshift') {
      this.shiftCutUntil = Math.max(this.shiftCutUntil, now + 0.105);
      return;
    }
    // Downshift blip is a short, low sawtooth flare and does not depend on throttle.
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();
    const target = Math.max(22, Math.min(170, event.targetRpm / 60 * 0.9));
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(Math.max(20, target * 0.78), now);
    oscillator.frequency.exponentialRampToValueAtTime(target, now + 0.075);
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(this.engineVolume * 0.16, now + 0.018);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.19);
    oscillator.connect(envelope);
    envelope.connect(this.engineFilter);
    oscillator.start(now);
    oscillator.stop(now + 0.21);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
    };
  }

  setEngineVolume(volume: number): void {
    this.engineVolume = Math.max(0, Math.min(1, volume));
    if (this.engineGain && this.context) {
      this.engineGain.gain.setTargetAtTime(this.engineVolume * 0.7, this.context.currentTime, 0.04);
    }
  }

  setEffectsVolume(volume: number): void {
    this.effectsVolume = Math.max(0, Math.min(1, volume));
    if (this.ambientGain && this.context) {
      this.ambientGain.gain.setTargetAtTime(this.effectsVolume * 0.22, this.context.currentTime, 0.04);
    }
    if (this.effectsGain && this.context) {
      this.effectsGain.gain.setTargetAtTime(this.effectsVolume, this.context.currentTime, 0.04);
    }
  }

  pause(): void {
    if (this.context?.state === 'running') void this.context.suspend();
  }

  resume(): void {
    if (this.started && this.context?.state === 'suspended') void this.context.resume();
  }

  dispose(): void {
    try { this.lowOsc?.stop(); } catch { /* already stopped */ }
    try { this.highOsc?.stop(); } catch { /* already stopped */ }
    try { this.subOsc?.stop(); } catch { /* already stopped */ }
    try { this.windSource?.stop(); } catch { /* already stopped */ }
    this.lowOsc?.disconnect();
    this.highOsc?.disconnect();
    this.subOsc?.disconnect();
    this.windSource?.disconnect();
    this.windFilter?.disconnect();
    this.windGain?.disconnect();
    this.engineFilter?.disconnect();
    this.engineGain?.disconnect();
    this.ambientGain?.disconnect();
    this.effectsGain?.disconnect();
    this.master?.disconnect();
    void this.context?.close();
    this.context = null;
    this.started = false;
  }
}

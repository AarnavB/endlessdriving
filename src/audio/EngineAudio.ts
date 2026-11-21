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
    this.ambientGain = ctx.createGain();
    this.effectsGain = ctx.createGain();
    this.master.gain.value = 0.75;
    this.engineGain.gain.value = this.engineVolume;
    this.ambientGain.gain.value = this.effectsVolume * 0.28;
    this.effectsGain.gain.value = this.effectsVolume;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 950;
    this.engineFilter.Q.value = 0.7;
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
    highGain.gain.value = 0.18;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.48;
    this.lowOsc.connect(this.engineFilter);
    this.highOsc.connect(highGain);
    highGain.connect(this.engineFilter);
    this.subOsc.connect(subGain);
    subGain.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);

    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.4;
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

  update(rpm: number, throttle: number, speedMps: number, shiftTime: number): void {
    const ctx = this.context;
    if (!ctx || !this.started || !this.lowOsc || !this.highOsc || !this.subOsc || !this.engineFilter || !this.engineGain || !this.windGain || !this.windFilter) return;
    const now = ctx.currentTime;
    const normalizedRpm = Math.min(1, Math.max(0, (rpm - 700) / 6500));
    const base = 14 + normalizedRpm * 96;
    const load = 0.18 + throttle * 0.52 + normalizedRpm * 0.28;
    this.lowOsc.frequency.setTargetAtTime(base, now, 0.07);
    this.highOsc.frequency.setTargetAtTime(base * 2.04, now, 0.07);
    this.subOsc.frequency.setTargetAtTime(base * 0.5, now, 0.08);
    this.engineFilter.frequency.setTargetAtTime(520 + normalizedRpm * 2600, now, 0.09);
    this.engineGain.gain.setTargetAtTime(this.engineVolume * load, now, 0.08);
    this.windFilter.frequency.setTargetAtTime(150 + Math.min(1, speedMps / 50) * 1100, now, 0.12);
    this.windGain.gain.setTargetAtTime(Math.min(0.18, speedMps / 65) * 0.32, now, 0.15);
    if (performance.now() - shiftTime < 110) {
      this.engineGain.gain.setTargetAtTime(this.engineVolume * 0.22, now, 0.015);
    }
  }

  setEngineVolume(volume: number): void {
    this.engineVolume = Math.max(0, Math.min(1, volume));
    if (this.engineGain && this.context) this.engineGain.gain.setTargetAtTime(this.engineVolume, this.context.currentTime, 0.04);
  }

  setEffectsVolume(volume: number): void {
    this.effectsVolume = Math.max(0, Math.min(1, volume));
    if (this.context) {
      const now = this.context.currentTime;
      this.ambientGain?.gain.setTargetAtTime(this.effectsVolume * 0.28, now, 0.04);
      this.effectsGain?.gain.setTargetAtTime(this.effectsVolume, now, 0.04);
    }
  }

  dispose(): void {
    this.lowOsc?.stop();
    this.highOsc?.stop();
    this.subOsc?.stop();
    this.windSource?.stop();
    void this.context?.close();
    this.started = false;
  }
}

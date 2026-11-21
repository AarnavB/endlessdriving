import type { GameSettings, SpeedUnit, TransmissionMode, VehicleTelemetry } from '../types';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '../types';
import type { CameraMode } from '../game/CameraRig';

const esc = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

export class UIController {
  private settings: GameSettings;
  private onStartCallback: () => void = () => undefined;
  private onResumeCallback: () => void = () => undefined;
  private onPauseCallback: () => void = () => undefined;
  private onResetCallback: () => void = () => undefined;
  private onRestartCallback: () => void = () => undefined;
  private onSettingsCallback: (settings: GameSettings) => void = () => undefined;
  private activeScreen: 'menu' | 'game' | 'pause' | 'settings' | 'controls' | 'about' | 'garage' = 'menu';
  private settingsReturnScreen: 'menu' | 'pause' = 'menu';
  private hudVisible = true;
  private root: HTMLElement;

  constructor(root: HTMLElement, settings: GameSettings) {
    this.root = root;
    this.settings = settings;
    this.render();
    this.bindEvents();
  }

  onStart(callback: () => void): void { this.onStartCallback = callback; }
  onResume(callback: () => void): void { this.onResumeCallback = callback; }
  onPause(callback: () => void): void { this.onPauseCallback = callback; }
  onReset(callback: () => void): void { this.onResetCallback = callback; }
  onRestart(callback: () => void): void { this.onRestartCallback = callback; }
  onSettings(callback: (settings: GameSettings) => void): void { this.onSettingsCallback = callback; }

  showGame(): void {
    this.closeOverlays();
    this.setOverlay('game');
  }

  showPause(): void {
    this.setOverlay('pause');
  }

  setHudVisible(visible: boolean): void {
    this.hudVisible = visible;
    this.root.querySelector<HTMLElement>('#hud')?.classList.toggle('hidden', !visible);
  }

  setMapVisible(visible: boolean): void {
    this.root.querySelector<HTMLElement>('#mini-map')?.classList.toggle('hidden', !visible);
  }

  setTransmissionMode(mode: 'AUTO' | 'MANUAL', persist = false): void {
    this.text('#transmission-value', mode);
    if (persist) {
      this.settings.transmission = mode.toLowerCase() as TransmissionMode;
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* storage may be blocked */ }
    }
  }

  setCameraLabel(mode: CameraMode): void {
    const label = this.root.querySelector<HTMLElement>('#camera-label');
    if (label) label.textContent = mode.toUpperCase();
  }

  setFps(fps: number): void {
    const node = this.root.querySelector<HTMLElement>('#fps-value');
    if (node) node.textContent = `${fps} FPS`;
  }

  setSettings(settings: GameSettings): void {
    this.settings = settings;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage may be blocked */ }
    this.root.querySelector<HTMLElement>('#fps-value')?.classList.toggle('hidden', !settings.showFps);
    this.onSettingsCallback(settings);
  }

  updateTelemetry(data: VehicleTelemetry, fps: number, mode: CameraMode, dayPhase: number): void {
    const unitValue = this.settings.speedUnit === 'kmh' ? data.speedKmh : data.speedKmh * 0.621371;
    const unit = this.settings.speedUnit === 'kmh' ? 'KM/H' : 'MPH';
    this.text('#speed-value', Math.round(unitValue).toString().padStart(3, '0'));
    this.text('#speed-unit', unit);
    this.text('#gear-value', data.gearLabel);
    this.text('#transmission-value', data.transmissionMode);
    this.text('#rpm-value', Math.round(data.rpm).toLocaleString('en-US'));
    this.text('#distance-value', `${data.distanceKm.toFixed(2)} KM`);
    const mapDot = this.root.querySelector<SVGCircleElement>('#map-player-dot');
    if (mapDot) {
      mapDot.setAttribute('cx', String(Math.max(8, Math.min(162, 85 + data.worldX * 0.38))));
      mapDot.setAttribute('cy', String(Math.max(8, Math.min(124, 66 + data.worldZ * 0.38))));
    }
    this.text('#throttle-value', `${Math.round(data.throttle * 100)}%`);
    this.text('#camera-label', mode.toUpperCase());
    this.text('#fps-value', `${fps} FPS`);
    const rpmFill = this.root.querySelector<HTMLElement>('#rpm-fill');
    if (rpmFill) rpmFill.style.width = `${Math.min(100, (data.rpm / 7200) * 100)}%`;
    const speedFill = this.root.querySelector<HTMLElement>('#speed-fill');
    if (speedFill) speedFill.style.width = `${Math.min(100, (unitValue / (this.settings.speedUnit === 'kmh' ? 240 : 150)) * 100)}%`;
    const time = dayPhase * 24;
    this.text('#time-value', `${String(Math.floor(time)).padStart(2, '0')}:${String(Math.floor((time % 1) * 60)).padStart(2, '0')}`);
  }

  private text(selector: string, value: string): void {
    const element = this.root.querySelector<HTMLElement>(selector);
    if (element) element.textContent = value;
  }

  private setOverlay(which: 'menu' | 'game' | 'pause' | 'settings' | 'controls' | 'about' | 'garage'): void {
    if (which === 'settings' && this.activeScreen !== 'settings') {
      this.settingsReturnScreen = this.activeScreen === 'pause' ? 'pause' : 'menu';
    }
    this.activeScreen = which;
    this.root.querySelectorAll<HTMLElement>('[data-screen]').forEach((el) => {
      el.classList.toggle('hidden', el.dataset.screen !== which);
    });
    const hud = this.root.querySelector<HTMLElement>('#hud');
    if (hud) hud.classList.toggle('hidden', which !== 'game' || !this.hudVisible);
  }

  private closeOverlays(): void {
    this.root.querySelectorAll<HTMLElement>('[data-screen]').forEach((el) => el.classList.add('hidden'));
  }

  private render(): void {
    const savedControls = [
      ['W / ↑', 'Accelerate'], ['S / ↓', 'Brake / reverse'], ['A D / ← →', 'Steer'],
      ['SPACE', 'Handbrake'], ['E / Q', 'Shift up / down (manual)'], ['M', 'Toggle auto / manual'], ['C', 'Change camera'],
      ['R', 'Reset vehicle'], ['ESC', 'Pause game'], ['H', 'Toggle HUD'], ['N', 'Toggle mini-map'],
    ];
    this.root.innerHTML = `
      <div id="hud" class="pointer-events-none absolute inset-0 z-10 text-white">
        <header class="hud-top pointer-events-auto flex items-center justify-between">
          <div class="brand-lockup"><span class="brand-mark">ED</span><div><div class="brand-name">ENDLESS <span>DRIVING</span></div><div class="brand-sub">MANHATTAN DISTRICT · FREE DRIVE</div></div></div>
          <div class="top-metrics"><div><span class="metric-kicker">LOCAL TIME</span><strong id="time-value">09:12</strong></div><div><span class="metric-kicker">DISTANCE</span><strong id="distance-value">0.00 KM</strong></div><div><span class="metric-kicker">VEHICLE</span><strong>APEX GT-RS</strong></div></div>
          <button id="pause-btn" class="icon-control" aria-label="Pause game">Ⅱ</button>
        </header>
        <div id="mini-map" class="mini-map pointer-events-auto">
          <div class="map-label">MIDTOWN GRID <span>LIVE</span></div>
          <svg viewBox="0 0 170 132" role="img" aria-label="Stylized street grid mini-map">
            <rect width="170" height="132" rx="8" fill="#111922"/>
            ${Array.from({ length: 7 }, (_, i) => `<path d="M${19 + i * 22} 8V124" stroke="#46515b" stroke-width="7"/>`).join('')}
            ${Array.from({ length: 6 }, (_, i) => `<path d="M8 ${18 + i * 19}H162" stroke="#46515b" stroke-width="6"/>`).join('')}
            <path d="M85 118L85 85L108 85L108 47L130 47" stroke="#e86f36" stroke-width="2.5" stroke-dasharray="4 3" fill="none"/>
            <circle id="map-player-dot" cx="85" cy="85" r="5.5" fill="#ff8a4c" stroke="#fff0e6" stroke-width="2"/>
            <path d="M85 74L80 84H90Z" fill="#fff"/>
          </svg>
          <div class="map-footer"><span>● YOU</span><span>GRID / 01</span></div>
        </div>
        <div class="hud-right pointer-events-auto"><div class="telemetry-card"><div class="telemetry-top"><span>ENGINE</span><span id="gear-value" class="gear-pill">1</span></div><div class="rpm-row"><strong id="rpm-value">0850</strong><span>RPM</span></div><div class="bar-track"><div id="rpm-fill" class="bar-fill"></div></div><div class="rpm-scale"><span>0</span><span>3K</span><span>6K</span><span>7.2K</span></div></div>
          <div class="speed-card"><div class="speed-overline">CURRENT SPEED</div><div class="speed-number"><strong id="speed-value">000</strong><span id="speed-unit">KM/H</span></div><div class="bar-track speed-track"><div id="speed-fill" class="bar-fill"></div></div><div class="speed-footer"><span>APEX GT-RS</span><span id="transmission-value">AUTO</span></div></div>
        </div>
        <footer class="hud-bottom pointer-events-auto"><div class="drive-state"><span class="live-dot"></span><div><strong>FREE DRIVE</strong><small>NO ROUTE · NO DESTINATION</small></div></div><div class="control-strip"><span><kbd>W</kbd> ACCEL</span><span><kbd>A</kbd><kbd>D</kbd> STEER</span><span><kbd>SPACE</kbd> HANDBRAKE</span><span><kbd>C</kbd> CAMERA</span><span id="camera-label">CHASE</span></div><div class="fps-indicator ${this.settings.showFps ? '' : 'hidden'}" id="fps-value">0 FPS</div></footer>
      </div>
      <section data-screen="menu" class="screen-overlay menu-screen">
        <div class="menu-topline"><span class="eyebrow"><i></i> OPEN WORLD DRIVING EXPERIENCE</span><span class="version-tag">EARLY ACCESS · BUILD 0.1</span></div>
        <div class="menu-content"><div class="hero-copy"><div class="hero-kicker">NEW YORK, NEVER STOPS</div><h1>FIND YOUR<br/><em>OWN LINE.</em></h1><p>Leave the route behind. Take the streets at your pace, chase the skyline, and let the city unfold one block at a time.</p>
          <button id="drive-btn" class="primary-action"><span>START DRIVING</span><b>↗</b></button><div class="menu-footnote">PHASE 01 · PLAYABLE CITY BLOCKOUT</div></div>
          <div class="car-preview-card"><div class="preview-index">01 <span>/ 01</span></div><div class="car-silhouette"><div class="car-glow"></div><div class="silhouette-body"><i></i><b></b><span></span></div><div class="wheel wheel-a"></div><div class="wheel wheel-b"></div></div><div class="preview-info"><div><span class="metric-kicker">STARTER VEHICLE</span><h2>APEX GT-RS</h2></div><div class="class-pill">SPORT / RWD</div></div><div class="preview-specs"><div><span>POWERTRAIN</span><strong>V6 · TURBO</strong></div><div><span>DRIVE</span><strong>REAR WHEEL</strong></div><div><span>TRANSMISSION</span><strong>6 SPEED</strong></div></div></div>
        </div>
        <nav class="menu-nav"><button data-open="controls">CONTROLS <span>↗</span></button><button data-open="settings">SETTINGS <span>↗</span></button><button data-open="about">ABOUT <span>↗</span></button><span class="phase-note">GARAGE + VEHICLE ROSTER · PHASE 02</span></nav>
      </section>
      <section data-screen="pause" class="screen-overlay modal-screen hidden"><div class="modal-panel"><div class="modal-overline">SESSION PAUSED <span>Ⅱ</span></div><h2>TAKE A<br/><em>BREATHER.</em></h2><p>The city can wait. Your next block is yours.</p><div class="modal-actions"><button id="resume-btn" class="primary-action"><span>RESUME DRIVE</span><b>↗</b></button><button id="reset-btn" class="secondary-action">RESET VEHICLE POSITION</button><button id="restart-btn" class="secondary-action">RESTART DRIVE</button><button data-open="settings" class="secondary-action">SETTINGS</button><button id="main-menu-btn" class="text-action">RETURN TO MAIN MENU</button></div></div></section>
      <section data-screen="settings" class="screen-overlay modal-screen hidden"><div class="modal-panel settings-panel"><div class="modal-overline">PREFERENCES <span>⚙</span></div><h2>GAME <em>SETTINGS.</em></h2><div class="settings-list"><label>ENGINE VOLUME <input id="engine-volume" type="range" min="0" max="1" step="0.01" value="${this.settings.engineVolume}"/></label><label>WIND / AMBIENCE <input id="effects-volume" type="range" min="0" max="1" step="0.01" value="${this.settings.effectsVolume}"/></label><label>TRANSMISSION <select id="transmission-setting"><option value="auto" ${this.settings.transmission === 'auto' ? 'selected' : ''}>AUTOMATIC</option><option value="manual" ${this.settings.transmission === 'manual' ? 'selected' : ''}>MANUAL</option></select></label><label>SPEED UNITS <select id="speed-unit-setting"><option value="kmh" ${this.settings.speedUnit === 'kmh' ? 'selected' : ''}>KM/H</option><option value="mph" ${this.settings.speedUnit === 'mph' ? 'selected' : ''}>MPH</option></select></label><label>GRAPHICS PRESET <select id="graphics-setting"><option value="low" ${this.settings.graphics === 'low' ? 'selected' : ''}>LOW</option><option value="medium" ${this.settings.graphics === 'medium' ? 'selected' : ''}>MEDIUM</option><option value="high" ${this.settings.graphics === 'high' ? 'selected' : ''}>HIGH</option></select></label><label class="check-setting">SHOW FPS COUNTER <input id="fps-setting" type="checkbox" ${this.settings.showFps ? 'checked' : ''}/></label></div><div class="modal-actions"><button id="settings-back" class="primary-action"><span>APPLY & BACK</span><b>↗</b></button></div></div></section>
      <section data-screen="controls" class="screen-overlay modal-screen hidden"><div class="modal-panel controls-panel"><div class="modal-overline">INPUT REFERENCE <span>⌘</span></div><h2>TAKE THE <em>WHEEL.</em></h2><div class="controls-grid">${savedControls.map(([key, label]) => `<div><span>${esc(label)}</span><kbd>${esc(key)}</kbd></div>`).join('')}</div><div class="modal-actions"><button data-back class="primary-action"><span>BACK</span><b>↗</b></button></div></div></section>
      <section data-screen="about" class="screen-overlay modal-screen hidden"><div class="modal-panel"><div class="modal-overline">PROJECT NOTES <span>✳</span></div><h2>BUILT FOR<br/><em>THE LONG WAY.</em></h2><p>Endless Driving is an original browser-based driving project. This Phase 1 build includes a Rapier-powered starter car, an explorable city grid, a chase camera, and synthesized RPM-responsive engine audio.</p><p class="muted-copy">Engine tones are synthesized with the Web Audio API in this prototype; no real-world engine recordings are included.</p><div class="modal-actions"><button data-back class="primary-action"><span>BACK</span><b>↗</b></button></div></div></section>
      <div id="toast" class="toast hidden"></div>
      <div class="bottom-left-caption">MANHATTAN · NEW YORK CITY INSPIRED <span> / </span> BUILT TO KEEP MOVING</div>
    `;
  }

  private bindEvents(): void {
    this.root.querySelector('#drive-btn')?.addEventListener('click', () => this.onStartCallback());
    this.root.querySelector('#pause-btn')?.addEventListener('click', () => this.onPauseCallback());
    this.root.querySelector('#resume-btn')?.addEventListener('click', () => this.onResumeCallback());
    this.root.querySelector('#reset-btn')?.addEventListener('click', () => this.onResetCallback());
    this.root.querySelector('#restart-btn')?.addEventListener('click', () => this.onRestartCallback());
    this.root.querySelector('#main-menu-btn')?.addEventListener('click', () => this.setOverlay('menu'));
    this.root.querySelector('#settings-back')?.addEventListener('click', () => {
      const settings: GameSettings = {
        engineVolume: this.value('#engine-volume', this.settings.engineVolume),
        effectsVolume: this.value('#effects-volume', this.settings.effectsVolume),
        speedUnit: (this.root.querySelector<HTMLSelectElement>('#speed-unit-setting')?.value as SpeedUnit) ?? 'kmh',
        transmission: (this.root.querySelector<HTMLSelectElement>('#transmission-setting')?.value as TransmissionMode) ?? 'auto',
        graphics: (this.root.querySelector<HTMLSelectElement>('#graphics-setting')?.value as GameSettings['graphics']) ?? 'medium',
        showFps: this.root.querySelector<HTMLInputElement>('#fps-setting')?.checked ?? false,
      };
      this.setSettings(settings);
      this.setOverlay(this.settingsReturnScreen);
    });
    this.root.querySelectorAll<HTMLElement>('[data-open]').forEach((button) => button.addEventListener('click', () => this.setOverlay(button.dataset.open as 'settings' | 'controls' | 'about')));
    this.root.querySelectorAll<HTMLElement>('[data-back]').forEach((button) => button.addEventListener('click', () => this.setOverlay('menu')));
  }

  private value(selector: string, fallback: number): number {
    const input = this.root.querySelector<HTMLInputElement>(selector);
    return input ? Number(input.value) : fallback;
  }
}

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GameSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

import type { GameSettings, SpeedUnit, TransmissionMode, VehicleTelemetry } from '../types';
import { DEFAULT_SETTINGS, SETTINGS_KEY, STATS_KEY } from '../types';
import type { CameraMode } from '../game/CameraRig';
import { IDLE_RPM } from '../vehicles/VehicleController';
import { getVehicleDefinition, loadSelectedVehicleId, VEHICLE_CATALOGUE, type VehicleId } from '../vehicles/VehicleDefinitions';

const esc = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

const polarPoint = (radius: number, angleDegrees: number): [number, number] => {
  const angle = angleDegrees * Math.PI / 180;
  return [120 + Math.cos(angle) * radius, 120 + Math.sin(angle) * radius];
};

const createGaugeMarkup = (
  id: 'speed' | 'rpm',
  title: string,
  maxValue: number,
  minorStep: number,
  majorEvery: number,
  redlineStart: number,
  unit: string,
): string => {
  const minimumValue = id === 'rpm' ? IDLE_RPM : 0;
  const valueRange = maxValue - minimumValue;
  const tickCount = Math.max(1, Math.round(valueRange / minorStep));
  const ticks: string[] = [];
  for (let i = 0; i <= tickCount; i++) {
    const ratio = i / tickCount;
    const tickValue = minimumValue + ratio * valueRange;
    const angle = 90 + ratio * 270;
    const major = i % majorEvery === 0 || i === tickCount;
    const [x1, y1] = polarPoint(major ? 94 : 99, angle);
    const [x2, y2] = polarPoint(106, angle);
    const isRedline = tickValue >= redlineStart;
    ticks.push(
      `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" class="gauge-tick ${major ? 'major' : 'minor'} ${isRedline ? 'redline' : ''}"/>`,
    );
    if (major) {
      const [lx, ly] = polarPoint(79, angle);
      const label = id === 'speed'
        ? Math.round(tickValue)
        : Math.round(ratio * maxValue / 1000);
      ticks.push(`<text x="${lx.toFixed(2)}" y="${(ly + 3).toFixed(2)}" class="gauge-mark ${isRedline ? 'redline' : ''}" text-anchor="middle">${label}</text>`);
    }
  }

  const startRatio = (redlineStart - minimumValue) / valueRange;
  const redlinePoints: string[] = [];
  for (let i = 0; i <= 24; i++) {
    const ratio = startRatio + (1 - startRatio) * (i / 24);
    const [x, y] = polarPoint(100, 90 + ratio * 270);
    redlinePoints.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  const redlinePath = redlinePoints.map((point, index) => `${index === 0 ? 'M' : 'L'}${point}`).join(' ');
  const initialValue = id === 'speed' ? '000' : '0850';

  return `
    <section class="analogue-gauge ${id}-gauge" aria-label="${title} gauge">
      <svg class="gauge-face" viewBox="0 0 240 240" role="img" aria-label="${title} analogue dial">
        <defs>
          <radialGradient id="${id}-face-gradient" cx="50%" cy="38%" r="68%">
            <stop offset="0%" stop-color="#202a32"/>
            <stop offset="100%" stop-color="#080d12"/>
          </radialGradient>
        </defs>
        <circle cx="120" cy="120" r="114" class="gauge-shell"/>
        <circle cx="120" cy="120" r="108" class="gauge-bezel"/>
        <circle cx="120" cy="120" r="101" fill="url(#${id}-face-gradient)" class="gauge-face-disc"/>
        <path d="M120 224 A104 104 0 1 1 224 120" class="gauge-track"/>
        <path d="${redlinePath}" class="gauge-redline-arc"/>
        ${ticks.join('')}
        <text x="120" y="31" class="gauge-title" text-anchor="middle">${title}</text>
        <g id="${id}-needle" class="gauge-needle" style="transform:rotate(180deg)">
          <path d="M116.8 127 L118.4 48 Q120 43 121.6 48 L123.2 127 Z" class="gauge-needle-shaft"/>
          <path d="M120 48 L118.5 60 L121.5 60 Z" class="gauge-needle-tip"/>
        </g>
        <circle cx="120" cy="120" r="9" class="gauge-hub-outer"/>
        <circle cx="120" cy="120" r="4" class="gauge-hub-inner"/>
      </svg>
      <div class="gauge-readout">
        <strong id="${id}-value">${initialValue}</strong>
        <span id="${id}-unit">${unit}</span>
      </div>
      ${id === 'rpm' ? '<div id="gear-value" class="gauge-gear" aria-label="Selected gear">1</div>' : ''}
      <span class="gauge-limit">${id === 'speed' ? maxValue : (maxValue / 1000).toFixed(1) + 'K'} MAX</span>
    </section>`;
};

export interface MiniMapPoint {
  x: number;
  y: number;
}

export interface MiniMapRoadGeometry {
  surface: MiniMapPoint[];
  leftEdge: MiniMapPoint[];
  rightEdge: MiniMapPoint[];
  leftLaneDivider: MiniMapPoint[];
  rightLaneDivider: MiniMapPoint[];
  centreLeft: MiniMapPoint[];
  centreRight: MiniMapPoint[];
}

export class UIController {
  private settings: GameSettings;
  private onStartCallback: () => void = () => undefined;
  private onResumeCallback: () => void = () => undefined;
  private onPauseCallback: () => void = () => undefined;
  private onResetCallback: () => void = () => undefined;
  private onRestartCallback: () => void = () => undefined;
  private onSettingsCallback: (settings: GameSettings) => void = () => undefined;
  private onGearSelectCallback: (selection: number | 'drive') => void = () => undefined;
  private onTransmissionToggleCallback: () => void = () => undefined;
  private bestDistanceKm = 0;
  private lastMilestoneKm = 0;
  private selectedVehicleId: VehicleId;
  private garageVehicleId: VehicleId;
  private garageReturnScreen: 'menu' | 'pause' = 'menu';
  private garageAutoRotate = true;
  private onVehicleSelectCallback: (vehicleId: string) => void = () => undefined;
  private onVehiclePreviewCallback: (vehicleId: string) => void = () => undefined;
  private onTripResetCallback: () => void = () => undefined;
  private onGarageRotateCallback: (enabled: boolean) => void = () => undefined;
  private activeScreen: 'menu' | 'game' | 'pause' | 'settings' | 'controls' | 'about' | 'garage' = 'menu';
  private settingsReturnScreen: 'menu' | 'pause' = 'menu';
  private hudVisible = true;
  private root: HTMLElement;

  constructor(root: HTMLElement, settings: GameSettings) {
    this.root = root;
    this.settings = settings;
    this.selectedVehicleId = loadSelectedVehicleId();
    this.garageVehicleId = this.selectedVehicleId;
    try {
      const stats = JSON.parse(localStorage.getItem(STATS_KEY) ?? '{}') as { bestDistanceKm?: number };
      this.bestDistanceKm = Number.isFinite(stats.bestDistanceKm) ? Math.max(0, stats.bestDistanceKm ?? 0) : 0;
    } catch {
      this.bestDistanceKm = 0;
    }
    this.render();
    this.refreshMenuVehiclePreview();
    this.refreshGarageDetails();
    this.bindEvents();
  }

  onStart(callback: () => void): void { this.onStartCallback = callback; }
  onResume(callback: () => void): void { this.onResumeCallback = callback; }
  onPause(callback: () => void): void { this.onPauseCallback = callback; }
  onReset(callback: () => void): void { this.onResetCallback = callback; }
  onRestart(callback: () => void): void { this.onRestartCallback = callback; }
  onSettings(callback: (settings: GameSettings) => void): void { this.onSettingsCallback = callback; }
  onGearSelect(callback: (selection: number | 'drive') => void): void { this.onGearSelectCallback = callback; }
  onTransmissionToggle(callback: () => void): void { this.onTransmissionToggleCallback = callback; }
  onVehicleSelect(callback: (vehicleId: string) => void): void { this.onVehicleSelectCallback = callback; }
  onVehiclePreview(callback: (vehicleId: string) => void): void { this.onVehiclePreviewCallback = callback; }
  onTripReset(callback: () => void): void { this.onTripResetCallback = callback; }
  onGarageRotate(callback: (enabled: boolean) => void): void { this.onGarageRotateCallback = callback; }

  getGaragePreviewCanvas(): HTMLCanvasElement {
    const canvas = this.root.querySelector<HTMLCanvasElement>('#garage-preview');
    if (!canvas) throw new Error('Garage preview canvas is missing.');
    return canvas;
  }

  isGarageVisible(): boolean { return this.activeScreen === 'garage'; }

  setSelectedVehicle(vehicleId: string): void {
    this.selectedVehicleId = getVehicleDefinition(vehicleId).id;
    this.garageVehicleId = this.selectedVehicleId;
    const definition = getVehicleDefinition(this.selectedVehicleId);
    const speedGauge = this.root.querySelector<HTMLElement>('.speed-gauge');
    if (speedGauge) speedGauge.outerHTML = this.renderSpeedGauge(this.settings.speedUnit, definition);
    const rpmGauge = this.root.querySelector<HTMLElement>('.rpm-gauge');
    if (rpmGauge) rpmGauge.outerHTML = createGaugeMarkup(
      'rpm', 'RPM', definition.maxRpm, 250, 4, definition.maxRpm * 0.9, 'RPM',
    );
    this.setTransmissionMode(this.settings.transmission === 'auto' ? 'AUTO' : 'MANUAL', false);
    this.refreshMenuVehiclePreview();
    this.refreshGarageDetails();
  }

  private openGarage(): void {
    this.garageReturnScreen = this.activeScreen === 'pause' ? 'pause' : 'menu';
    this.garageVehicleId = this.selectedVehicleId;
    this.refreshGarageDetails();
    this.onVehiclePreviewCallback(this.garageVehicleId);
    this.setOverlay('garage');
  }

  private previewGarageVehicle(vehicleId: string): void {
    this.garageVehicleId = getVehicleDefinition(vehicleId).id;
    this.refreshGarageDetails();
    this.onVehiclePreviewCallback(this.garageVehicleId);
  }

  private moveGarageSelection(direction: number): void {
    const current = VEHICLE_CATALOGUE.findIndex((vehicle) => vehicle.id === this.garageVehicleId);
    const next = (current + direction + VEHICLE_CATALOGUE.length) % VEHICLE_CATALOGUE.length;
    this.previewGarageVehicle(VEHICLE_CATALOGUE[next].id);
  }

  private selectGarageVehicle(): void {
    const definition = getVehicleDefinition(this.garageVehicleId);
    this.selectedVehicleId = definition.id;
    this.onVehicleSelectCallback(definition.id);
    this.refreshMenuVehiclePreview();
    this.setOverlay(this.garageReturnScreen);
  }

  private refreshMenuVehiclePreview(): void {
    const definition = getVehicleDefinition(this.selectedVehicleId);
    this.text('#menu-vehicle-index', String(VEHICLE_CATALOGUE.findIndex((vehicle) => vehicle.id === definition.id) + 1).padStart(2, '0'));
    this.text('#menu-vehicle-name', definition.name);
    this.text('#menu-vehicle-variant', definition.variant);
    this.text('#menu-vehicle-engine', `V${definition.audio.cylinders} · ${definition.displacementL.toFixed(1)}L · ${definition.audio.induction === 'twin-turbo' ? 'TWIN TURBO' : definition.audio.induction === 'hybrid' ? 'HYBRID' : 'NA'}`);
    this.text('#menu-vehicle-drive', definition.drivetrain.toUpperCase());
    this.text('#vehicle-hud-name', definition.name.toUpperCase());
    this.text('#menu-vehicle-transmission', definition.transmission.toUpperCase());
  }

  private refreshGarageDetails(): void {
    const definition = getVehicleDefinition(this.garageVehicleId);
    const index = VEHICLE_CATALOGUE.findIndex((vehicle) => vehicle.id === definition.id);
    this.text('#garage-index', `${String(index + 1).padStart(2, '0')} / ${String(VEHICLE_CATALOGUE.length).padStart(2, '0')}`);
    this.text('#garage-manufacturer', definition.manufacturer.toUpperCase());
    this.text('#garage-name', definition.name);
    this.text('#garage-variant', definition.variant);
    this.text('#garage-engine', definition.engine);
    this.text('#garage-displacement', `${definition.displacementL.toFixed(3)} L · ${definition.aspiration}`);
    this.text('#garage-power', `${definition.powerHp.toLocaleString('en-US')} HP`);
    this.text('#garage-torque', `${definition.torqueNm.toLocaleString('en-US')} NM`);
    this.text('#garage-transmission', `${definition.transmission} · ${definition.gears} GEARS`);
    this.text('#garage-redline', `${definition.maxRpm.toLocaleString('en-US')} RPM`);
    this.text('#garage-top-speed', `${definition.topSpeedKmh} KM/H`);
    this.text('#garage-acceleration', `${definition.zeroTo100Kmh.toFixed(1)} S 0–100`);
    this.text('#garage-mass', `${definition.massKg.toLocaleString('en-US')} KG`);
    this.text('#garage-drivetrain', definition.drivetrain.toUpperCase());
    this.text('#garage-select-label', definition.id === this.selectedVehicleId ? 'CURRENT VEHICLE' : 'SELECT THIS VEHICLE');
    this.root.querySelectorAll<HTMLButtonElement>('[data-garage-car]').forEach((button) => {
      const active = button.dataset.garageCar === definition.id;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  resetSessionProgress(): void {
    this.lastMilestoneKm = 0;
    this.text('#score-value', '0');
    this.text('#distance-value', '0.00 KM');
  }

  showGame(): void {
    this.closeOverlays();
    this.setOverlay('game');
  }

  showPause(): void {
    this.setOverlay('pause');
  }

  showRuntimeError(error: unknown): void {
    this.setOverlay('pause');
    const existing = this.root.querySelector<HTMLElement>('#runtime-error');
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const safeDetail = esc(detail.slice(0, 700));
    const panel = existing ?? document.createElement('div');
    panel.id = 'runtime-error';
    panel.className = 'runtime-error';
    panel.innerHTML = `<strong>GAME LOOP PAUSED</strong><span>The simulator caught a runtime error instead of silently freezing.</span><code>${safeDetail}</code><button type="button" id="runtime-reload">RELOAD GAME</button>`;
    if (!existing) this.root.append(panel);
    panel.querySelector<HTMLButtonElement>('#runtime-reload')?.addEventListener('click', () => window.location.reload(), { once: true });
  }

  setHudVisible(visible: boolean): void {
    this.hudVisible = visible;
    this.root.querySelector<HTMLElement>('#hud')?.classList.toggle('hidden', this.activeScreen !== 'game' || !visible);
  }

  setMapVisible(visible: boolean): void {
    this.root.querySelector<HTMLElement>('#mini-map')?.classList.toggle('hidden', !visible);
  }

  setTransmissionMode(mode: 'AUTO' | 'MANUAL', persist = false): void {
    this.text('#transmission-value', mode);
    const automatic = mode === 'AUTO';
    this.root.querySelector<HTMLElement>('[data-gear-option="D"]')?.classList.toggle('hidden', !automatic);
    const gearCount = getVehicleDefinition(this.selectedVehicleId).gears;
    this.root.querySelectorAll<HTMLButtonElement>('[data-forward-gear]').forEach((button) => {
      const gear = Number(button.dataset.gearOption);
      button.classList.toggle('hidden', automatic || gear > gearCount);
    });
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
    const speedUnitChanged = settings.speedUnit !== this.settings.speedUnit;
    this.settings = settings;
    if (speedUnitChanged) {
      const gauge = this.root.querySelector<HTMLElement>('.speed-gauge');
      if (gauge) gauge.outerHTML = this.renderSpeedGauge(settings.speedUnit, getVehicleDefinition(this.selectedVehicleId));
    }
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage may be blocked */ }
    this.root.querySelector<HTMLElement>('#fps-value')?.classList.toggle('hidden', !settings.showFps);
    this.onSettingsCallback(settings);
  }

  /** Render a heading-up view of the actual generated road near the vehicle. */
  updateRoadMap(geometry: MiniMapRoadGeometry): void {
    const toPath = (points: readonly MiniMapPoint[]): string => points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
      .join(' ');

    const paths: Array<[string, readonly MiniMapPoint[]]> = [
      ['#map-road-surface', geometry.surface],
      ['#map-road-left-edge', geometry.leftEdge],
      ['#map-road-right-edge', geometry.rightEdge],
      ['#map-road-lane-left', geometry.leftLaneDivider],
      ['#map-road-lane-right', geometry.rightLaneDivider],
      ['#map-road-centre-left', geometry.centreLeft],
      ['#map-road-centre-right', geometry.centreRight],
    ];

    for (const [selector, points] of paths) {
      const element = this.root.querySelector<SVGPathElement>(selector);
      if (element) element.setAttribute('d', toPath(points));
    }
  }

  updateTelemetry(data: VehicleTelemetry, fps: number, mode: CameraMode, dayPhase: number): void {
    const unitValue = this.settings.speedUnit === 'kmh' ? data.speedKmh : data.speedKmh * 0.621371;
    const unit = this.settings.speedUnit === 'kmh' ? 'KM/H' : 'MPH';
    const speedScaleMaximum = this.getSpeedScaleMaximum(this.settings.speedUnit, data.maxSpeedKmh);
    const speedRatio = Math.min(1, Math.max(0, unitValue / speedScaleMaximum));
    const rpmRatio = Math.min(1, Math.max(0, (data.rpm - IDLE_RPM) / (data.maxRpm - IDLE_RPM)));
    const speedNeedle = this.root.querySelector<HTMLElement>('#speed-needle');
    const rpmNeedle = this.root.querySelector<HTMLElement>('#rpm-needle');
    if (speedNeedle) speedNeedle.style.transform = `rotate(${180 + speedRatio * 270}deg)`;
    if (rpmNeedle) rpmNeedle.style.transform = `rotate(${180 + rpmRatio * 270}deg)`;

    this.text('#speed-value', Math.round(unitValue).toString().padStart(3, '0'));
    this.text('#speed-unit', unit);
    this.text('#rpm-value', Math.round(data.rpm).toString().padStart(4, '0'));
    this.text('#gear-value', data.gearLabel);
    const gearIndicator = this.root.querySelector<HTMLElement>('#gear-value');
    gearIndicator?.classList.toggle('is-neutral', data.gearLabel === 'N');
    gearIndicator?.classList.toggle('is-reverse', data.gearLabel === 'R');

    const activeOption = data.gear === 0 ? 'N' : data.transmissionMode === 'AUTO' ? 'D' : String(data.gear);
    this.root.querySelectorAll<HTMLButtonElement>('[data-gear-option]').forEach((button) => {
      button.classList.toggle('active', button.dataset.gearOption === activeOption);
      button.setAttribute('aria-pressed', String(button.dataset.gearOption === activeOption));
    });
    this.text('#transmission-value', data.transmissionMode);
    this.root.querySelector<HTMLElement>('.rpm-gauge')?.classList.toggle('is-redline', data.rpm >= data.maxRpm * 0.9);
    this.text('#vehicle-hud-name', data.vehicleName.toUpperCase());
    this.text('#trip-distance-value', `${data.tripDistanceKm.toFixed(2)} KM`);
    this.text('#odometer-value', `${data.odometerKm.toFixed(1).padStart(7, '0')} KM`);
    this.text('#distance-value', `${data.distanceKm.toFixed(2)} KM`);
    this.text('#score-value', Math.floor(data.distanceKm * 100).toLocaleString('en-US'));
    if (data.distanceKm > this.bestDistanceKm) {
      this.bestDistanceKm = Math.floor(data.distanceKm * 100) / 100;
      try {
        localStorage.setItem(STATS_KEY, JSON.stringify({ bestDistanceKm: this.bestDistanceKm }));
      } catch { /* storage may be blocked */ }
    }
    this.text('#best-distance-value', `${this.bestDistanceKm.toFixed(2)} KM`);
    const milestones = [1, 5, 10, 25, 50, 100, 200, 500];
    for (const milestone of milestones) {
      if (data.distanceKm >= milestone && this.lastMilestoneKm < milestone) {
        this.lastMilestoneKm = milestone;
        this.showMilestoneToast(milestone);
        break;
      }
    }

    this.text('#throttle-value', `${Math.round(data.throttle * 100)}%`);
    this.text('#camera-label', mode.toUpperCase());
    this.text('#fps-value', `${fps} FPS`);
    const time = dayPhase * 24;
    this.text('#time-value', `${String(Math.floor(time)).padStart(2, '0')}:${String(Math.floor((time % 1) * 60)).padStart(2, '0')}`);
  }

  private getSpeedScaleMaximum(unit: SpeedUnit, topSpeedKmh: number): number {
    const conversion = unit === 'kmh' ? 1 : 0.621371;
    return Math.ceil((topSpeedKmh * conversion) / 10) * 10;
  }

  private renderSpeedGauge(unit: SpeedUnit, definition: ReturnType<typeof getVehicleDefinition>): string {
    const kmh = unit === 'kmh';
    const maximum = this.getSpeedScaleMaximum(unit, definition.topSpeedKmh);
    return createGaugeMarkup(
      'speed', 'SPEED', maximum,
      Math.max(5, Math.round(maximum / 20 / 5) * 5), 2,
      Math.round(maximum * 0.9), kmh ? 'KM/H' : 'MPH',
    );
  }

  private showMilestoneToast(distanceKm: number): void {
    const toast = this.root.querySelector<HTMLElement>('#toast');
    if (!toast) return;
    toast.textContent = `MILESTONE REACHED  ·  ${distanceKm} KM`;
    toast.classList.remove('hidden');
    window.setTimeout(() => toast.classList.add('hidden'), 2600);
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
      ['SPACE', 'Handbrake'], ['E / Q', 'Shift up / down (manual; Q from 1 selects neutral)'],
      ['GEAR SELECTOR', 'Select neutral or Drive / a forward gear'], ['M', 'Toggle auto / manual'],
      ['C', 'Change camera'], ['R', 'Reset vehicle'], ['ESC', 'Pause game'], ['H', 'Toggle HUD'], ['N', 'Toggle mini-map'],
    ];
    this.root.innerHTML = `
      <div id="hud" class="pointer-events-none absolute inset-0 z-10 text-white hidden">
        <header class="hud-top pointer-events-auto flex items-center justify-between">
          <div class="brand-lockup"><span class="brand-mark">ED</span><div><div class="brand-name">ENDLESS <span>DRIVING</span></div><div class="brand-sub">MANHATTAN DISTRICT · FREE DRIVE</div></div></div>
          <div class="top-metrics">
            <div><span class="metric-kicker">LOCAL TIME</span><strong id="time-value">09:12</strong></div>
            <div><span class="metric-kicker">DISTANCE</span><strong id="distance-value">0.00 KM</strong></div>
            <div><span class="metric-kicker">BEST</span><strong id="best-distance-value">${this.bestDistanceKm.toFixed(2)} KM</strong></div>
            <div><span class="metric-kicker">SCORE</span><strong id="score-value">0</strong></div>
            <div><span class="metric-kicker">VEHICLE</span><strong id="vehicle-hud-name">${esc(getVehicleDefinition(this.selectedVehicleId).name.toUpperCase())}</strong></div>
          </div>
          <button id="pause-btn" class="icon-control" aria-label="Pause game">Ⅱ</button>
        </header>
        <div id="mini-map" class="mini-map pointer-events-auto">
          <div class="map-label">HIGHWAY MAP <span>LIVE</span></div>
          <svg viewBox="0 0 170 132" role="img" aria-label="Live heading-up map of the generated highway">
            <rect width="170" height="132" rx="8" fill="#111922"/>
            <path id="map-road-surface" d="" fill="none" stroke="#3d4850" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
            <path id="map-road-left-edge" d="" fill="none" stroke="#aab3b8" stroke-width="1.2"/>
            <path id="map-road-right-edge" d="" fill="none" stroke="#aab3b8" stroke-width="1.2"/>
            <path id="map-road-lane-left" d="" fill="none" stroke="#d9e0e1" stroke-width="1" stroke-dasharray="3 4"/>
            <path id="map-road-lane-right" d="" fill="none" stroke="#d9e0e1" stroke-width="1" stroke-dasharray="3 4"/>
            <path id="map-road-centre-left" d="" fill="none" stroke="#dfb857" stroke-width="1.3"/>
            <path id="map-road-centre-right" d="" fill="none" stroke="#dfb857" stroke-width="1.3"/>
            <circle id="map-player-dot" cx="85" cy="100" r="5.5" fill="#ff8a4c" stroke="#fff0e6" stroke-width="2"/>
            <path d="M85 89L80 99H90Z" fill="#fff"/>
          </svg>
          <div class="map-footer"><span>● YOU</span><span>ROAD / LIVE</span></div>
        </div>
        <div class="hud-right instrument-cluster pointer-events-auto" aria-label="Vehicle instrument cluster">
          <div class="gauge-pair">
            ${this.renderSpeedGauge(this.settings.speedUnit)}
            ${createGaugeMarkup('rpm', 'RPM', getVehicleDefinition(this.selectedVehicleId).maxRpm, 250, 4, getVehicleDefinition(this.selectedVehicleId).maxRpm * 0.9, 'RPM')}
          </div>
          <div class="instrument-controls">
            <div class="odometer-readouts"><span>TRIP <b id="trip-distance-value">0.00 KM</b></span><span>ODO <b id="odometer-value">000000.0 KM</b></span><button type="button" id="reset-trip-btn" aria-label="Reset trip distance">↺</button></div>
            <div class="transmission-mode">
              <span>TRANSMISSION</span><strong id="transmission-value">${this.settings.transmission === 'auto' ? 'AUTO' : 'MANUAL'}</strong>
              <button id="transmission-toggle" type="button" aria-label="Toggle automatic or manual transmission">M</button>
            </div>
            <div id="gear-selector" class="gear-selector" role="group" aria-label="Select transmission gear">
              <button type="button" data-gear-option="N" aria-label="Select neutral" aria-pressed="false">N</button>
              <button type="button" data-gear-option="D" class="${this.settings.transmission === 'manual' ? 'hidden' : ''}" aria-label="Select automatic drive" aria-pressed="false">D</button>
              <button type="button" data-gear-option="1" data-forward-gear class="${this.settings.transmission === 'auto' ? 'hidden' : ''}" aria-label="Select first gear" aria-pressed="false">1</button>
              <button type="button" data-gear-option="2" data-forward-gear class="${this.settings.transmission === 'auto' ? 'hidden' : ''}" aria-label="Select second gear" aria-pressed="false">2</button>
              <button type="button" data-gear-option="3" data-forward-gear class="${this.settings.transmission === 'auto' ? 'hidden' : ''}" aria-label="Select third gear" aria-pressed="false">3</button>
              <button type="button" data-gear-option="4" data-forward-gear class="${this.settings.transmission === 'auto' ? 'hidden' : ''}" aria-label="Select fourth gear" aria-pressed="false">4</button>
              <button type="button" data-gear-option="5" data-forward-gear class="${this.settings.transmission === 'auto' ? 'hidden' : ''}" aria-label="Select fifth gear" aria-pressed="false">5</button>
              <button type="button" data-gear-option="6" data-forward-gear class="${this.settings.transmission === 'auto' ? 'hidden' : ''}" aria-label="Select sixth gear" aria-pressed="false">6</button>
              <button type="button" data-gear-option="7" data-forward-gear class="${this.settings.transmission === 'auto' ? 'hidden' : ''}" aria-label="Select seventh gear" aria-pressed="false">7</button>
            </div>
            <div class="cluster-footnote"><span>THROTTLE <b id="throttle-value">0%</b></span><span>F3 DIAGNOSTICS</span></div>
          </div>
        </div>
        <footer class="hud-bottom pointer-events-auto"><div class="drive-state"><span class="live-dot"></span><div><strong>FREE DRIVE</strong><small>NO ROUTE · NO DESTINATION</small></div></div><div class="control-strip"><span><kbd>W</kbd> ACCEL</span><span><kbd>A</kbd><kbd>D</kbd> STEER</span><span><kbd>SPACE</kbd> HANDBRAKE</span><span><kbd>C</kbd> CAMERA</span><span id="camera-label">CHASE</span></div><div class="fps-indicator ${this.settings.showFps ? '' : 'hidden'}" id="fps-value">0 FPS</div></footer>
      </div>
      <section data-screen="menu" class="screen-overlay menu-screen">
        <div class="menu-topline"><span class="eyebrow"><i></i> OPEN WORLD DRIVING EXPERIENCE</span><span class="version-tag">EARLY ACCESS · BUILD 0.1</span></div>
        <div class="menu-content"><div class="hero-copy"><div class="hero-kicker">NEW YORK, NEVER STOPS</div><h1>FIND YOUR<br/><em>OWN LINE.</em></h1><p>Leave the route behind. Take the streets at your pace, chase the skyline, and let the city unfold one block at a time.</p>
          <button id="drive-btn" class="primary-action"><span>START DRIVING</span><b>↗</b></button><div class="menu-footnote">PHASE 01 · PLAYABLE CITY BLOCKOUT</div></div>
          <div class="car-preview-card"><div class="preview-index"><b id="menu-vehicle-index">01</b> <span>/ 06</span></div><div class="car-silhouette"><div class="car-glow"></div><div class="silhouette-body"><i></i><b></b><span></span></div><div class="wheel wheel-a"></div><div class="wheel wheel-b"></div></div><div class="preview-info"><div><span class="metric-kicker" id="menu-vehicle-variant">1987–1992 · ROAD CAR</span><h2 id="menu-vehicle-name">F40</h2></div><div class="class-pill">SELECTED</div></div><div class="preview-specs"><div><span>POWERTRAIN</span><strong id="menu-vehicle-engine">V8 · 2.9L</strong></div><div><span>DRIVE</span><strong id="menu-vehicle-drive">REAR-WHEEL DRIVE</strong></div><div><span>TRANSMISSION</span><strong id="menu-vehicle-transmission">5-SPEED MANUAL</strong></div></div></div>
        </div>
        <nav class="menu-nav"><button id="open-garage">GARAGE <span>↗</span></button><button data-open="controls">CONTROLS <span>↗</span></button><button data-open="settings">SETTINGS <span>↗</span></button><button data-open="about">ABOUT <span>↗</span></button><span class="phase-note">GARAGE + VEHICLE ROSTER · PHASE 02</span></nav>
      </section>
      <section data-screen="pause" class="screen-overlay modal-screen hidden"><div class="modal-panel"><div class="modal-overline">SESSION PAUSED <span>Ⅱ</span></div><h2>TAKE A<br/><em>BREATHER.</em></h2><p>The city can wait. Your next block is yours.</p><div class="modal-actions"><button id="resume-btn" class="primary-action"><span>RESUME DRIVE</span><b>↗</b></button><button id="reset-btn" class="secondary-action">RESET VEHICLE POSITION</button><button id="pause-garage-btn" class="secondary-action">CHANGE VEHICLE</button><button id="restart-btn" class="secondary-action">RESTART DRIVE</button><button data-open="settings" class="secondary-action">SETTINGS</button><button id="main-menu-btn" class="text-action">RETURN TO MAIN MENU</button></div></div></section>
      <section data-screen="settings" class="screen-overlay modal-screen hidden"><div class="modal-panel settings-panel"><div class="modal-overline">PREFERENCES <span>⚙</span></div><h2>GAME <em>SETTINGS.</em></h2><div class="settings-list"><label>ENGINE VOLUME <input id="engine-volume" type="range" min="0" max="1" step="0.01" value="${this.settings.engineVolume}"/></label><label>WIND / AMBIENCE <input id="effects-volume" type="range" min="0" max="1" step="0.01" value="${this.settings.effectsVolume}"/></label><label>TRANSMISSION <select id="transmission-setting"><option value="auto" ${this.settings.transmission === 'auto' ? 'selected' : ''}>AUTOMATIC</option><option value="manual" ${this.settings.transmission === 'manual' ? 'selected' : ''}>MANUAL</option></select></label><label>SPEED UNITS <select id="speed-unit-setting"><option value="kmh" ${this.settings.speedUnit === 'kmh' ? 'selected' : ''}>KM/H</option><option value="mph" ${this.settings.speedUnit === 'mph' ? 'selected' : ''}>MPH</option></select></label><label>GRAPHICS PRESET <select id="graphics-setting"><option value="low" ${this.settings.graphics === 'low' ? 'selected' : ''}>LOW</option><option value="medium" ${this.settings.graphics === 'medium' ? 'selected' : ''}>MEDIUM</option><option value="high" ${this.settings.graphics === 'high' ? 'selected' : ''}>HIGH</option></select></label><label class="check-setting">SHOW FPS COUNTER <input id="fps-setting" type="checkbox" ${this.settings.showFps ? 'checked' : ''}/></label></div><div class="modal-actions"><button id="settings-back" class="primary-action"><span>APPLY & BACK</span><b>↗</b></button></div></div></section>
      <section data-screen="controls" class="screen-overlay modal-screen hidden"><div class="modal-panel controls-panel"><div class="modal-overline">INPUT REFERENCE <span>⌘</span></div><h2>TAKE THE <em>WHEEL.</em></h2><div class="controls-grid">${savedControls.map(([key, label]) => `<div><span>${esc(label)}</span><kbd>${esc(key)}</kbd></div>`).join('')}</div><div class="modal-actions"><button data-back class="primary-action"><span>BACK</span><b>↗</b></button></div></div></section>
      <section data-screen="about" class="screen-overlay modal-screen hidden"><div class="modal-panel"><div class="modal-overline">PROJECT NOTES <span>✳</span></div><h2>BUILT FOR<br/><em>THE LONG WAY.</em></h2><p>Endless Driving is an original browser-based driving project. This Phase 1 build includes a Rapier-powered starter car, an explorable city grid, a chase camera, and synthesized RPM-responsive engine audio.</p><p class="muted-copy">Engine tones are synthesized with the Web Audio API in this prototype; no real-world engine recordings are included.</p><div class="modal-actions"><button data-back class="primary-action"><span>BACK</span><b>↗</b></button></div></div></section>
      <section data-screen="garage" class="screen-overlay garage-screen hidden">
        <header class="garage-header">
          <div><span class="eyebrow"><i></i> VEHICLE COLLECTION · 06 MACHINES</span><h2>THE <em>GARAGE.</em></h2></div>
          <button id="garage-back-btn" class="secondary-action">BACK TO MENU</button>
        </header>
        <div class="garage-layout">
          <div class="garage-visual-panel">
            <div class="garage-preview-badges"><span id="garage-index">01 / 06</span><span>DRAG TO ROTATE · DOUBLE-CLICK TO PAUSE ROTATION</span></div>
            <canvas id="garage-preview" aria-label="Interactive 3D car preview"></canvas>
            <div class="garage-preview-controls"><button id="garage-prev" type="button" aria-label="Previous car">← PREVIOUS</button><button id="garage-rotate-toggle" type="button">AUTO ROTATE ON</button><button id="garage-next" type="button" aria-label="Next car">NEXT →</button></div>
          </div>
          <article class="garage-spec-panel">
            <span id="garage-manufacturer" class="garage-manufacturer">FERRARI</span>
            <h3 id="garage-name">F40</h3><p id="garage-variant">1987–1992 · ROAD CAR</p>
            <div class="garage-spec-grid">
              <div><span>ENGINE</span><strong id="garage-engine"></strong></div>
              <div><span>DISPLACEMENT / ASPIRATION</span><strong id="garage-displacement"></strong></div>
              <div><span>POWER</span><strong id="garage-power"></strong></div>
              <div><span>TORQUE</span><strong id="garage-torque"></strong></div>
              <div><span>TRANSMISSION</span><strong id="garage-transmission"></strong></div>
              <div><span>REDLINE</span><strong id="garage-redline"></strong></div>
              <div><span>TOP SPEED</span><strong id="garage-top-speed"></strong></div>
              <div><span>ACCELERATION</span><strong id="garage-acceleration"></strong></div>
              <div><span>MASS</span><strong id="garage-mass"></strong></div>
              <div><span>DRIVETRAIN</span><strong id="garage-drivetrain"></strong></div>
            </div>
            <button id="garage-select" class="garage-select"><span id="garage-select-label">SELECT THIS VEHICLE</span><b>↗</b></button>
          </article>
        </div>
        <div class="garage-car-list" aria-label="Available vehicles">${this.renderGarageVehicleList()}</div>
      </section>
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
    this.root.querySelector('#transmission-toggle')?.addEventListener('click', () => this.onTransmissionToggleCallback());
    this.root.querySelectorAll<HTMLButtonElement>('[data-gear-option]').forEach((button) => {
      button.addEventListener('click', () => {
        const selection = button.dataset.gearOption;
        if (selection === 'N') this.onGearSelectCallback(0);
        else if (selection === 'D') this.onGearSelectCallback('drive');
        else if (selection) this.onGearSelectCallback(Number(selection));
      });
    });
    this.root.querySelector('#main-menu-btn')?.addEventListener('click', () => this.setOverlay('menu'));
    this.root.querySelector('#open-garage')?.addEventListener('click', () => this.openGarage());
    this.root.querySelector('#pause-garage-btn')?.addEventListener('click', () => this.openGarage());
    this.root.querySelector('#garage-back-btn')?.addEventListener('click', () => this.setOverlay(this.garageReturnScreen));
    this.root.querySelector('#garage-prev')?.addEventListener('click', () => this.moveGarageSelection(-1));
    this.root.querySelector('#garage-next')?.addEventListener('click', () => this.moveGarageSelection(1));
    this.root.querySelector('#garage-select')?.addEventListener('click', () => this.selectGarageVehicle());
    this.root.querySelector('#garage-rotate-toggle')?.addEventListener('click', () => {
      this.garageAutoRotate = !this.garageAutoRotate;
      this.onGarageRotateCallback(this.garageAutoRotate);
      this.text('#garage-rotate-toggle', `AUTO ROTATE ${this.garageAutoRotate ? 'ON' : 'OFF'}`);
    });
    this.root.querySelector('#reset-trip-btn')?.addEventListener('click', () => this.onTripResetCallback());
    this.root.querySelectorAll<HTMLButtonElement>('[data-garage-car]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.garageCar) this.previewGarageVehicle(button.dataset.garageCar);
      });
    });
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

  private renderGarageVehicleList(): string {
    return VEHICLE_CATALOGUE.map((vehicle, index) =>
      `<button type="button" data-garage-car="${vehicle.id}" aria-pressed="${vehicle.id === this.selectedVehicleId}">
        <span class="garage-car-index">${String(index + 1).padStart(2, '0')}</span>
        <span><strong>${esc(vehicle.manufacturer)} ${esc(vehicle.name)}</strong><small>${esc(vehicle.engine)}</small></span>
        <b>↗</b>
      </button>`,
    ).join('');
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

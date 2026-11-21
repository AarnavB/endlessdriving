export type GraphicsPreset = 'low' | 'medium' | 'high';
export type SpeedUnit = 'kmh' | 'mph';
export type TransmissionMode = 'auto' | 'manual';

export interface GameSettings {
  engineVolume: number;
  effectsVolume: number;
  speedUnit: SpeedUnit;
  transmission: TransmissionMode;
  graphics: GraphicsPreset;
  showFps: boolean;
}

export interface InputState {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  shiftUpPressed: boolean;
  shiftDownPressed: boolean;
}

export interface VehicleTelemetry {
  speedMps: number;
  speedKmh: number;
  rpm: number;
  gear: number;
  gearLabel: string;
  transmissionMode: 'AUTO' | 'MANUAL';
  throttle: number;
  steer: number;
  distanceKm: number;
  engineLoad: number;
  worldX: number;
  worldZ: number;
  grounded: boolean;
}

export const DEFAULT_SETTINGS: GameSettings = {
  engineVolume: 0.42,
  effectsVolume: 0.45,
  speedUnit: 'kmh',
  transmission: 'auto',
  graphics: 'medium',
  showFps: false,
};

export const SETTINGS_KEY = 'endless-driving-settings-v1';
export const STATS_KEY = 'endless-driving-stats-v1';

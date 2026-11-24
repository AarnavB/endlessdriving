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
  /** Edge-triggered N key request to select neutral from any transmission state. */
  neutralPressed?: boolean;
  /** 0 = fully engaged clutch, 1 = pedal fully depressed. */
  clutchPedal?: number;
  shiftUpPressed: boolean;
  shiftDownPressed: boolean;
}

export interface VehicleTelemetry {
  speedMps: number;
  speedKmh: number;
  rpm: number;
  gear: number;
  gearLabel: string;
  handbrakeActive: boolean;
  transmissionMode: 'AUTO' | 'MANUAL';
  throttle: number;
  steer: number;
  distanceKm: number;
  tripDistanceKm: number;
  odometerKm: number;
  vehicleId: string;
  vehicleName: string;
  maxRpm: number;
  maxSpeedKmh: number;
  engineLoad: number;
  worldX: number;
  worldZ: number;
  grounded: boolean;
}

export interface VehicleDebugTelemetry {
  throttle: number;
  brake: number;
  steer: number;
  appliedForwardForce: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  forwardSpeed: number;
  positionX: number;
  positionY: number;
  positionZ: number;
  rpm: number;
  gear: number;
  physicsTimestep: number;
  physicsStepsThisFrame: number;
  sleeping: boolean;
  meshSyncError: number;
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

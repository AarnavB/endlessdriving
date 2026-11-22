export type VehicleId =
  | 'ferrari-f40'
  | 'ferrari-laferrari'
  | 'lamborghini-gallardo'
  | 'lamborghini-murcielago'
  | 'lamborghini-aventador'
  | 'mclaren-senna';

export interface VehiclePhysicsProfile {
  massKg: number;
  maxDriveForce: number;
  maxSpeedKmh: number;
  brakeForce: number;
  lateralGrip: number;
  handbrakeGrip: number;
  steeringResponse: number;
  engineBrakeForce: number;
  wheelRadiusM: number;
  finalDrive: number;
  transferDrive: number;
  /** Additional low-speed motor assist for hybrid powertrains. */
  hybridAssist?: number;
  gearRatios: readonly number[];
  torqueCurve: readonly [number, number][];
}

export interface VehicleAudioProfile {
  cylinders: 8 | 10 | 12;
  induction: 'naturally-aspirated' | 'twin-turbo' | 'hybrid';
  /** Combustion pulse width within one firing interval. */
  pulseWidth: number;
  /** Dominant low exhaust resonance, in Hz. */
  exhaustResonanceHz: number;
  /** Mechanical/exhaust body level for low-frequency weight. */
  exhaustBodyGain: number;
  /** Soft saturation drive for a gruff, compressed exhaust edge. */
  saturation: number;
  /** Low-pass ceiling that preserves body and suppresses piercing harmonics. */
  maxExhaustHz: number;
}

export interface VehicleVisualConfig {
  paint: number;
  bodyWidth: number;
  bodyLength: number;
  bodyHeight: number;
  cabinWidth: number;
  cabinLength: number;
  cabinHeight: number;
  cabinZ: number;
  wheelTrack: number;
  wheelBase: number;
  wingWidth: number;
  wingHeight: number;
  wingDepth: number;
  splitterWidth: number;
  splitterDepth: number;
  intakeScale: number;
  style: 'classic-wedge' | 'sculpted' | 'compact-angular' | 'wide-angular' | 'faceted' | 'track-aero';
  popUpHeadlights?: boolean;
  rearLouvres?: boolean;
  activeAero?: boolean;
}

export interface VehicleDefinition {
  id: VehicleId;
  manufacturer: string;
  name: string;
  variant: string;
  engine: string;
  displacementL: number;
  aspiration: string;
  powerHp: number;
  torqueNm: number;
  transmission: string;
  gears: number;
  maxRpm: number;
  topSpeedKmh: number;
  zeroTo100Kmh: number;
  massKg: number;
  drivetrain: string;
  physics: VehiclePhysicsProfile;
  audio: VehicleAudioProfile;
  visual: VehicleVisualConfig;
}

const f40TorqueCurve: readonly [number, number][] = [
  [0, 0.58], [0.18, 0.76], [0.35, 1], [0.63, 0.98], [0.82, 0.84], [1, 0.7],
];
const laFerrariTorqueCurve: readonly [number, number][] = [
  [0, 0.7], [0.25, 0.86], [0.5, 0.94], [0.78, 1], [0.92, 0.92], [1, 0.8],
];
const gallardoTorqueCurve: readonly [number, number][] = [
  [0, 0.62], [0.25, 0.86], [0.48, 0.97], [0.7, 1], [0.9, 0.9], [1, 0.72],
];
const murcielagoTorqueCurve: readonly [number, number][] = [
  [0, 0.72], [0.22, 0.9], [0.48, 1], [0.7, 0.94], [0.88, 0.83], [1, 0.69],
];
const aventadorTorqueCurve: readonly [number, number][] = [
  [0, 0.66], [0.23, 0.88], [0.48, 1], [0.72, 0.97], [0.9, 0.88], [1, 0.74],
];
const sennaTorqueCurve: readonly [number, number][] = [
  [0, 0.8], [0.18, 1], [0.45, 0.98], [0.7, 0.9], [0.88, 0.78], [1, 0.64],
];

export const VEHICLE_CATALOGUE: readonly VehicleDefinition[] = [
  {
    id: 'ferrari-f40',
    manufacturer: 'Ferrari',
    name: 'F40',
    variant: '1987–1992 · Road car',
    engine: '90° twin-turbocharged V8',
    displacementL: 2.936,
    aspiration: 'Twin IHI turbochargers',
    powerHp: 478,
    torqueNm: 577,
    transmission: '5-speed manual',
    gears: 5,
    maxRpm: 7750,
    topSpeedKmh: 324,
    zeroTo100Kmh: 4.7,
    massKg: 1235,
    drivetrain: 'Rear-wheel drive',
    physics: {
      massKg: 1235, maxDriveForce: 11200, maxSpeedKmh: 324, brakeForce: 18400,
      lateralGrip: 5900, handbrakeGrip: 1480, steeringResponse: 0.94,
      engineBrakeForce: 720, wheelRadiusM: 0.34, finalDrive: 2.9, transferDrive: 1.33,
      gearRatios: [2.77, 1.71, 1.23, 0.96, 0.77], torqueCurve: f40TorqueCurve,
    },
    audio: {
      cylinders: 8, induction: 'twin-turbo', pulseWidth: 0.15,
      exhaustResonanceHz: 112, exhaustBodyGain: 0.98,
      saturation: 2.75, maxExhaustHz: 3300,
    },
    visual: {
      paint: 0xb91f27, bodyWidth: 1.9, bodyLength: 4.42, bodyHeight: 0.56,
      cabinWidth: 1.45, cabinLength: 1.52, cabinHeight: 0.48, cabinZ: -0.22,
      wheelTrack: 1.82, wheelBase: 2.55, wingWidth: 1.55, wingHeight: 0.72,
      wingDepth: 0.28, splitterWidth: 1.7, splitterDepth: 0.28, intakeScale: 0.88,
      style: 'classic-wedge', popUpHeadlights: true, rearLouvres: true,
    },
  },
  {
    id: 'ferrari-laferrari',
    manufacturer: 'Ferrari',
    name: 'LaFerrari',
    variant: '2013–2016 · HY-KERS',
    engine: '65° naturally aspirated V12 + electric motor',
    displacementL: 6.262,
    aspiration: 'Naturally aspirated · hybrid assist',
    powerHp: 950,
    torqueNm: 900,
    transmission: '7-speed dual-clutch',
    gears: 7,
    maxRpm: 9250,
    topSpeedKmh: 352,
    zeroTo100Kmh: 2.9,
    massKg: 1585,
    drivetrain: 'Rear-wheel drive · HY-KERS',
    physics: {
      massKg: 1585, maxDriveForce: 15100, maxSpeedKmh: 352, brakeForce: 21800,
      lateralGrip: 6900, handbrakeGrip: 1650, steeringResponse: 1.08,
      engineBrakeForce: 790, wheelRadiusM: 0.34, finalDrive: 3.1, transferDrive: 1,
      hybridAssist: 1.16,
      gearRatios: [3.10, 2.18, 1.63, 1.29, 1.03, 0.84, 0.69], torqueCurve: laFerrariTorqueCurve,
    },
    audio: {
      cylinders: 12, induction: 'hybrid', pulseWidth: 0.10,
      exhaustResonanceHz: 156, exhaustBodyGain: 0.78,
      saturation: 1.95, maxExhaustHz: 4500,
    },
    visual: {
      paint: 0xc92c23, bodyWidth: 1.98, bodyLength: 4.7, bodyHeight: 0.5,
      cabinWidth: 1.43, cabinLength: 1.6, cabinHeight: 0.52, cabinZ: -0.2,
      wheelTrack: 1.9, wheelBase: 2.65, wingWidth: 1.76, wingHeight: 0.45,
      wingDepth: 0.2, splitterWidth: 1.94, splitterDepth: 0.4, intakeScale: 0.92,
      style: 'sculpted', activeAero: true,
    },
  },
  {
    id: 'lamborghini-gallardo',
    manufacturer: 'Lamborghini',
    name: 'Gallardo',
    variant: 'LP560-4 · 2008–2013',
    engine: 'Naturally aspirated 90° V10',
    displacementL: 5.204,
    aspiration: 'Naturally aspirated',
    powerHp: 552,
    torqueNm: 540,
    transmission: '6-speed E-gear / manual',
    gears: 6,
    maxRpm: 8500,
    topSpeedKmh: 325,
    zeroTo100Kmh: 3.7,
    massKg: 1520,
    drivetrain: 'All-wheel drive',
    physics: {
      massKg: 1520, maxDriveForce: 11900, maxSpeedKmh: 325, brakeForce: 19000,
      lateralGrip: 6400, handbrakeGrip: 1540, steeringResponse: 1.02,
      engineBrakeForce: 760, wheelRadiusM: 0.34, finalDrive: 3.44, transferDrive: 1,
      gearRatios: [3.09, 2.05, 1.52, 1.12, 0.88, 0.71], torqueCurve: gallardoTorqueCurve,
    },
    audio: {
      cylinders: 10, induction: 'naturally-aspirated', pulseWidth: 0.105,
      exhaustResonanceHz: 148, exhaustBodyGain: 0.87,
      saturation: 2.2, maxExhaustHz: 4100,
    },
    visual: {
      paint: 0xd6a91f, bodyWidth: 1.9, bodyLength: 4.3, bodyHeight: 0.58,
      cabinWidth: 1.48, cabinLength: 1.55, cabinHeight: 0.55, cabinZ: -0.24,
      wheelTrack: 1.82, wheelBase: 2.56, wingWidth: 1.42, wingHeight: 0.42,
      wingDepth: 0.18, splitterWidth: 1.72, splitterDepth: 0.28, intakeScale: 0.82,
      style: 'compact-angular',
    },
  },
  {
    id: 'lamborghini-murcielago',
    manufacturer: 'Lamborghini',
    name: 'Murciélago',
    variant: 'LP640 · 2006–2010',
    engine: '60° naturally aspirated V12',
    displacementL: 6.496,
    aspiration: 'Naturally aspirated',
    powerHp: 640,
    torqueNm: 660,
    transmission: '6-speed manual / E-gear',
    gears: 6,
    maxRpm: 8500,
    topSpeedKmh: 340,
    zeroTo100Kmh: 3.4,
    massKg: 1665,
    drivetrain: 'All-wheel drive',
    physics: {
      massKg: 1665, maxDriveForce: 13200, maxSpeedKmh: 340, brakeForce: 20500,
      lateralGrip: 6250, handbrakeGrip: 1500, steeringResponse: 0.9,
      engineBrakeForce: 850, wheelRadiusM: 0.35, finalDrive: 3.44, transferDrive: 1,
      gearRatios: [3.091, 2.105, 1.565, 1.241, 1.065, 0.939], torqueCurve: murcielagoTorqueCurve,
    },
    audio: {
      cylinders: 12, induction: 'naturally-aspirated', pulseWidth: 0.16,
      exhaustResonanceHz: 105, exhaustBodyGain: 1.08,
      saturation: 2.8, maxExhaustHz: 3200,
    },
    visual: {
      paint: 0xb84d24, bodyWidth: 2.02, bodyLength: 4.62, bodyHeight: 0.62,
      cabinWidth: 1.52, cabinLength: 1.62, cabinHeight: 0.58, cabinZ: -0.23,
      wheelTrack: 1.92, wheelBase: 2.66, wingWidth: 1.64, wingHeight: 0.56,
      wingDepth: 0.25, splitterWidth: 1.88, splitterDepth: 0.35, intakeScale: 1.05,
      style: 'wide-angular',
    },
  },
  {
    id: 'lamborghini-aventador',
    manufacturer: 'Lamborghini',
    name: 'Aventador',
    variant: 'LP700-4 · 2011–2016',
    engine: '60° naturally aspirated V12',
    displacementL: 6.498,
    aspiration: 'Naturally aspirated',
    powerHp: 691,
    torqueNm: 690,
    transmission: '7-speed ISR automated manual',
    gears: 7,
    maxRpm: 8500,
    topSpeedKmh: 350,
    zeroTo100Kmh: 2.9,
    massKg: 1575,
    drivetrain: 'All-wheel drive',
    physics: {
      massKg: 1575, maxDriveForce: 14100, maxSpeedKmh: 350, brakeForce: 22000,
      lateralGrip: 6750, handbrakeGrip: 1580, steeringResponse: 1.14,
      engineBrakeForce: 890, wheelRadiusM: 0.35, finalDrive: 3.2, transferDrive: 1,
      gearRatios: [2.92, 1.97, 1.44, 1.10, 0.90, 0.74, 0.62], torqueCurve: aventadorTorqueCurve,
    },
    audio: {
      cylinders: 12, induction: 'naturally-aspirated', pulseWidth: 0.095,
      exhaustResonanceHz: 160, exhaustBodyGain: 0.84,
      saturation: 2.25, maxExhaustHz: 4600,
    },
    visual: {
      paint: 0xe36c24, bodyWidth: 2.03, bodyLength: 4.78, bodyHeight: 0.54,
      cabinWidth: 1.46, cabinLength: 1.66, cabinHeight: 0.6, cabinZ: -0.22,
      wheelTrack: 1.94, wheelBase: 2.7, wingWidth: 1.76, wingHeight: 0.58,
      wingDepth: 0.24, splitterWidth: 1.98, splitterDepth: 0.42, intakeScale: 1.02,
      style: 'faceted', activeAero: true,
    },
  },
  {
    id: 'mclaren-senna',
    manufacturer: 'McLaren',
    name: 'Senna',
    variant: '2018–2019 · Track-focused road car',
    engine: 'Twin-turbocharged 90° V8',
    displacementL: 3.994,
    aspiration: 'Twin-scroll turbochargers',
    powerHp: 789,
    torqueNm: 800,
    transmission: '7-speed dual-clutch',
    gears: 7,
    maxRpm: 8500,
    topSpeedKmh: 335,
    zeroTo100Kmh: 2.8,
    massKg: 1309,
    drivetrain: 'Rear-wheel drive',
    physics: {
      massKg: 1309, maxDriveForce: 14600, maxSpeedKmh: 335, brakeForce: 23800,
      lateralGrip: 7900, handbrakeGrip: 1760, steeringResponse: 1.22,
      engineBrakeForce: 820, wheelRadiusM: 0.34, finalDrive: 3.31, transferDrive: 1,
      gearRatios: [3.98, 2.61, 1.91, 1.48, 1.16, 0.91, 0.69], torqueCurve: sennaTorqueCurve,
    },
    audio: {
      cylinders: 8, induction: 'twin-turbo', pulseWidth: 0.125,
      exhaustResonanceHz: 132, exhaustBodyGain: 0.99,
      saturation: 2.55, maxExhaustHz: 4200,
    },
    visual: {
      paint: 0x254e43, bodyWidth: 1.96, bodyLength: 4.74, bodyHeight: 0.51,
      cabinWidth: 1.42, cabinLength: 1.58, cabinHeight: 0.54, cabinZ: -0.22,
      wheelTrack: 1.88, wheelBase: 2.67, wingWidth: 1.96, wingHeight: 0.88,
      wingDepth: 0.34, splitterWidth: 1.98, splitterDepth: 0.52, intakeScale: 1.12,
      style: 'track-aero', activeAero: true,
    },
  },
];

export const DEFAULT_VEHICLE_ID: VehicleId = 'ferrari-f40';
export const VEHICLE_SELECTION_KEY = 'endless-driving-selected-vehicle-v1';

export function getVehicleDefinition(id: string | null | undefined): VehicleDefinition {
  return VEHICLE_CATALOGUE.find((vehicle) => vehicle.id === id)
    ?? VEHICLE_CATALOGUE.find((vehicle) => vehicle.id === DEFAULT_VEHICLE_ID)
    ?? VEHICLE_CATALOGUE[0];
}

export function loadSelectedVehicleId(): VehicleId {
  try {
    const value = window.localStorage.getItem(VEHICLE_SELECTION_KEY);
    return getVehicleDefinition(value).id;
  } catch {
    return DEFAULT_VEHICLE_ID;
  }
}

export function saveSelectedVehicleId(id: string): VehicleId {
  const safeId = getVehicleDefinition(id).id;
  try { window.localStorage.setItem(VEHICLE_SELECTION_KEY, safeId); } catch { /* storage may be unavailable */ }
  return safeId;
}

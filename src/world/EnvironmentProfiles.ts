import { SeededRandom, hashSeed } from './SeededRandom';

export type EnvironmentKind =
  | 'countryside'
  | 'forest'
  | 'suburban'
  | 'industrial'
  | 'mountain';

export interface EnvironmentProfile {
  kind: EnvironmentKind;
  terrainColor: number;
  treeColor: number;
  bushColor: number;
  rockColor: number;
  buildingColor: number;
  treeChance: number;
  bushChance: number;
  rockChance: number;
  buildingChance: number;
  streetlightChance: number;
  terrainRelief: number;
}

export interface EnvironmentTransition {
  primary: EnvironmentProfile;
  secondary: EnvironmentProfile;
  blend: number;
}

export const ENVIRONMENT_PROFILES: Record<EnvironmentKind, EnvironmentProfile> = {
  countryside: {
    kind: 'countryside',
    terrainColor: 0x66764b,
    treeColor: 0x416b3e,
    bushColor: 0x536f3d,
    rockColor: 0x77766b,
    buildingColor: 0x8a806c,
    treeChance: 0.62,
    bushChance: 0.7,
    rockChance: 0.24,
    buildingChance: 0.025,
    streetlightChance: 0.2,
    terrainRelief: 0.8,
  },
  forest: {
    kind: 'forest',
    terrainColor: 0x3e5942,
    treeColor: 0x244b35,
    bushColor: 0x315d3c,
    rockColor: 0x62685f,
    buildingColor: 0x666c63,
    treeChance: 0.96,
    bushChance: 0.8,
    rockChance: 0.28,
    buildingChance: 0.01,
    streetlightChance: 0.08,
    terrainRelief: 1.1,
  },
  suburban: {
    kind: 'suburban',
    terrainColor: 0x788067,
    treeColor: 0x547447,
    bushColor: 0x66804c,
    rockColor: 0x858477,
    buildingColor: 0x8a8580,
    treeChance: 0.38,
    bushChance: 0.4,
    rockChance: 0.12,
    buildingChance: 0.56,
    streetlightChance: 0.82,
    terrainRelief: 0.5,
  },
  industrial: {
    kind: 'industrial',
    terrainColor: 0x62665c,
    treeColor: 0x50664a,
    bushColor: 0x59664b,
    rockColor: 0x74756f,
    buildingColor: 0x646e75,
    treeChance: 0.18,
    bushChance: 0.22,
    rockChance: 0.3,
    buildingChance: 0.82,
    streetlightChance: 0.94,
    terrainRelief: 0.55,
  },
  mountain: {
    kind: 'mountain',
    terrainColor: 0x77796e,
    treeColor: 0x4b6446,
    bushColor: 0x5c6c4e,
    rockColor: 0x89877f,
    buildingColor: 0x77736b,
    treeChance: 0.28,
    bushChance: 0.16,
    rockChance: 0.9,
    buildingChance: 0.01,
    streetlightChance: 0.04,
    terrainRelief: 2.2,
  },
};

const ENVIRONMENT_ORDER: EnvironmentKind[] = [
  'countryside',
  'forest',
  'suburban',
  'industrial',
  'mountain',
];
const REGION_CHUNKS = 12;

function profileForRegion(seed: number, region: number): EnvironmentProfile {
  const rng = new SeededRandom(hashSeed(seed, region + 0x51ed270b));
  return ENVIRONMENT_PROFILES[ENVIRONMENT_ORDER[rng.integer(0, ENVIRONMENT_ORDER.length - 1)]];
}

/**
 * Changes scenery mix over the final third of each 12-chunk region. The same
 * region/profile choice is returned regardless of generation order.
 */
export function getEnvironmentTransition(seed: number, chunkIndex: number): EnvironmentTransition {
  const region = Math.floor(chunkIndex / REGION_CHUNKS);
  const localChunk = chunkIndex - region * REGION_CHUNKS;
  const primary = profileForRegion(seed, region);
  const secondary = profileForRegion(seed, region + 1);
  const transitionStart = REGION_CHUNKS * 0.62;
  const raw = Math.max(0, Math.min(1, (localChunk - transitionStart) / (REGION_CHUNKS - 1 - transitionStart)));
  const blend = raw * raw * (3 - 2 * raw);
  return { primary, secondary, blend };
}

export function selectEnvironmentForFeature(
  transition: EnvironmentTransition,
  rng: SeededRandom,
): EnvironmentProfile {
  return rng.chance(transition.blend) ? transition.secondary : transition.primary;
}

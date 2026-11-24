/**
 * Deterministic Hudson River layout in the game's local ENU frame.
 * +X is east, so the Manhattan shoreline is the river's eastern bank.
 *
 * The curved banks are deliberately broad planning geometry, not a claim
 * that this hand-authored coastline is a surveyed hydrographic dataset.
 */
export const HUDSON_RIVER_MIN_Z = -3100;
export const HUDSON_RIVER_MAX_Z = 3100;
export const HUDSON_RIVER_SURFACE_Y = 0.04;

export interface HudsonPoint2D { x: number; z: number; }

export function getHudsonEastBankX(z: number): number {
  return -1850
    + 34 * Math.sin(z * 0.00072)
    + 17 * Math.sin(z * 0.00191 + 0.8)
    + 6 * Math.sin(z * 0.0041);
}

export function getHudsonWestBankX(z: number): number {
  return -3820
    + 74 * Math.sin(z * 0.00061 + 1.25)
    + 29 * Math.sin(z * 0.00173)
    + 9 * Math.sin(z * 0.0033 + 0.4);
}

export function getHudsonRiverWidthM(z: number): number {
  return getHudsonEastBankX(z) - getHudsonWestBankX(z);
}

export function getHudsonRiverCenterX(z: number): number {
  return (getHudsonEastBankX(z) + getHudsonWestBankX(z)) * 0.5;
}

export function isHudsonWater(x: number, z: number, bankClearanceM = 0): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  if (z < HUDSON_RIVER_MIN_Z || z > HUDSON_RIVER_MAX_Z) return false;
  const eastBank = getHudsonEastBankX(z) - bankClearanceM;
  const westBank = getHudsonWestBankX(z) + bankClearanceM;
  return x > westBank && x < eastBank;
}

export function getHudsonRiverDepthM(x: number, z: number): number {
  const width = Math.max(1, getHudsonRiverWidthM(z));
  const lateral = Math.abs((x - getHudsonRiverCenterX(z)) / (width * 0.5));
  const basin = Math.sqrt(Math.max(0, 1 - Math.min(1, lateral) ** 2));
  const longitudinal = 1.1 * Math.sin(z * 0.0011) + 0.65 * Math.cos(z * 0.0022);
  return Math.max(4.5, 11.5 + 5.5 * basin + longitudinal);
}

/** A scenic north/south road offset inland from the shoreline. */
export function getHudsonShorelineRoadX(z: number): number {
  return getHudsonEastBankX(z) + 104;
}

/** True when a 2D rectangular footprint reaches the open river basin. */
export function footprintTouchesHudson(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): boolean {
  const centreX = (minX + maxX) * 0.5;
  const centreZ = (minZ + maxZ) * 0.5;
  const samples: HudsonPoint2D[] = [
    { x: minX, z: minZ }, { x: maxX, z: minZ },
    { x: minX, z: maxZ }, { x: maxX, z: maxZ },
    { x: centreX, z: centreZ },
    { x: centreX, z: minZ }, { x: centreX, z: maxZ },
  ];
  return samples.some((point) => isHudsonWater(point.x, point.z, -1.5));
}

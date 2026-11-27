/**
 * Place an at-grade road-ribbon vertex on the same DEM surface used by the
 * terrain mesh and static collision, then apply the requested small render lift.
 */
export function drapeAtGradeRoadVertex(point, verticalOffsetM, elevationAt) {
  if (!point || ![point.x, point.z, verticalOffsetM].every(Number.isFinite)
    || typeof elevationAt !== 'function') {
    throw new RangeError('Invalid input for NYC at-grade road surface draping.');
  }
  const elevation = elevationAt(point.x, point.z);
  if (elevation === null || elevation === undefined || !Number.isFinite(elevation)) {
    throw new Error(
      'No validated NYC DEM elevation for at-grade road vertex at '
        + point.x.toFixed(1) + ' m, ' + point.z.toFixed(1) + ' m.',
    );
  }
  return { x: point.x, y: elevation + verticalOffsetM, z: point.z };
}

/**
 * Sample the exact piecewise-planar surface emitted by the NYC terrain mesh.
 * Grid indices are global, integer coordinates; each cell uses triangles
 * (A,C,B) when u >= v and (A,D,C) otherwise, matching buildChunk indices.
 * Only corners with non-zero barycentric weight are sampled, so a point at a
 * shared grid edge does not require unrelated NoData corners.
 */
export function sampleTriangulatedTerrainSurface(worldX, worldZ, gridSpacingM, sampleGridHeight) {
  if (![worldX, worldZ, gridSpacingM].every(Number.isFinite) || gridSpacingM <= 0
    || typeof sampleGridHeight !== 'function') {
    throw new RangeError('Invalid input for NYC triangulated terrain sampling.');
  }

  const gridX = Math.floor(worldX / gridSpacingM);
  const gridZ = Math.floor(worldZ / gridSpacingM);
  const u = Math.max(0, Math.min(1, (worldX - gridX * gridSpacingM) / gridSpacingM));
  const v = Math.max(0, Math.min(1, (worldZ - gridZ * gridSpacingM) / gridSpacingM));
  const weightedCorners = u >= v
    ? [
      [gridX, gridZ, 1 - u],
      [gridX + 1, gridZ, u - v],
      [gridX + 1, gridZ + 1, v],
    ]
    : [
      [gridX, gridZ, 1 - v],
      [gridX, gridZ + 1, v - u],
      [gridX + 1, gridZ + 1, u],
    ];

  let elevation = 0;
  for (const [cornerX, cornerZ, weight] of weightedCorners) {
    if (weight <= 0) continue;
    const sample = sampleGridHeight(cornerX, cornerZ);
    if (sample === null || sample === undefined || !Number.isFinite(sample)) {
      throw new Error(
        'No validated NYC DEM elevation for terrain grid vertex '
          + cornerX + ':' + cornerZ + '.',
      );
    }
    elevation += sample * weight;
  }
  return elevation;
}

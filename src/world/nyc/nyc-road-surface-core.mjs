/**
 * Place an at-grade road-ribbon vertex on the same DEM surface used by the
 * terrain mesh and static collision, then apply the requested small render lift.
 */
export function drapeAtGradeRoadVertex(point, verticalOffsetM, elevationAt) {
  if (!point || ![point.x, point.y, point.z, verticalOffsetM].every(Number.isFinite)
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

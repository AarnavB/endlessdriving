import * as THREE from 'three';
import type { VehicleDefinition, VehicleVisualConfig } from './VehicleDefinitions';

type VehicleVisualParts = { root: THREE.Group; wheels: THREE.Object3D[] };

function addPolygon(
  parent: THREE.Group,
  points: readonly [number, number, number][],
  mat: THREE.Material,
): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
  const indices: number[] = [];
  for (let i = 1; i < points.length - 1; i++) indices.push(0, i, i + 1);
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function addBox(parent: THREE.Group, size: [number, number, number], position: [number, number, number], mat: THREE.Material, rotationY = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
  mesh.position.set(...position);
  mesh.rotation.y = rotationY;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function addBeam(parent: THREE.Group, from: THREE.Vector3, to: THREE.Vector3, radius: number, mat: THREE.Material): THREE.Mesh {
  const delta = to.clone().sub(from);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, delta.length(), 8), mat);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function createBodyGeometry(config: VehicleVisualConfig): THREE.BufferGeometry {
  const halfWidth = config.bodyWidth * 0.5;
  const length = config.bodyLength;
  const h = config.bodyHeight;
  const wide = config.style === 'wide-angular' || config.style === 'faceted' || config.style === 'track-aero';
  const stations = [
    { z: length * 0.50, w: 0.73, side: -0.045, top: h * 0.48 },
    { z: length * 0.43, w: 0.86, side: 0.015, top: h * 0.76 },
    { z: length * 0.27, w: 0.96, side: 0.065, top: h * 0.94 },
    { z: length * 0.04, w: 1.00, side: 0.075, top: h },
    { z: -length * 0.20, w: wide ? 1.025 : 0.99, side: 0.055, top: h * 0.97 },
    { z: -length * 0.38, w: wide ? 0.97 : 0.91, side: 0.015, top: h * 0.83 },
    { z: -length * 0.50, w: 0.78, side: -0.055, top: h * 0.5 },
  ];
  const section = [
    [-1.00, -0.22], [-1.025, 0.035], [-0.91, 0.78], [-0.67, 1.00],
    [0, 1.055], [0.67, 1.00], [0.91, 0.78], [1.025, 0.035],
    [1.00, -0.22], [0, -0.265],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const station of stations) {
    for (const [xFactor, yFactor] of section) {
      const y = yFactor < 0
        ? (yFactor === -0.22 ? -0.22 : -0.265)
        : station.side + (station.top - station.side) * yFactor;
      positions.push(xFactor * halfWidth * station.w, y, station.z);
    }
  }
  const ringSize = section.length;
  for (let row = 0; row < stations.length - 1; row++) {
    for (let edge = 0; edge < ringSize; edge++) {
      const next = (edge + 1) % ringSize;
      const a = row * ringSize + edge;
      const b = (row + 1) * ringSize + edge;
      const c = row * ringSize + next;
      const d = (row + 1) * ringSize + next;
      // Winding is deliberately outward-facing for the left/right body panels.
      indices.push(a, c, b, c, d, b);
    }
  }
  for (let i = 1; i < ringSize - 1; i++) {
    indices.push(0, i + 1, i);
    const last = (stations.length - 1) * ringSize;
    indices.push(last, last + i, last + i + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function addCurve(parent: THREE.Group, points: THREE.Vector3[], radius: number, mat: THREE.Material): void {
  const curve = new THREE.CatmullRomCurve3(points);
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(16, points.length * 4), radius, 5, false), mat);
  mesh.castShadow = true;
  parent.add(mesh);
}

function createCabin(root: THREE.Group, config: VehicleVisualConfig, paint: THREE.Material, glass: THREE.Material, trim: THREE.Material): void {
  const baseHalf = config.cabinWidth * 0.5;
  const roofHalf = config.cabinWidth * (config.style === 'classic-wedge' ? 0.34 : 0.36);
  const baseY = config.bodyHeight * 0.48;
  const roofY = baseY + config.cabinHeight * (config.style === 'track-aero' ? 0.70 : 0.76);
  const frontBase = config.cabinZ + config.cabinLength * 0.47;
  const rearBase = config.cabinZ - config.cabinLength * 0.48;
  const frontRoof = frontBase - config.cabinLength * (config.style === 'classic-wedge' ? 0.31 : 0.22);
  const rearRoof = rearBase + config.cabinLength * 0.22;
  const bl: [number, number, number] = [-baseHalf, baseY, frontBase];
  const br: [number, number, number] = [baseHalf, baseY, frontBase];
  const fl: [number, number, number] = [-roofHalf, roofY, frontRoof];
  const fr: [number, number, number] = [roofHalf, roofY, frontRoof];
  const rl: [number, number, number] = [-baseHalf, baseY, rearBase];
  const rr: [number, number, number] = [baseHalf, baseY, rearBase];
  const rfl: [number, number, number] = [-roofHalf, roofY, rearRoof];
  const rfr: [number, number, number] = [roofHalf, roofY, rearRoof];

  addPolygon(root, [bl, br, fr, fl], glass);
  addPolygon(root, [rr, rl, rfl, rfr], glass);
  addPolygon(root, [bl, fl, rfl, rl], glass);
  addPolygon(root, [br, rr, rfr, fr], glass);
  addPolygon(root, [fl, fr, rfr, rfl], paint);

  const p = (v: [number, number, number]): THREE.Vector3 => new THREE.Vector3(...v);
  for (const side of [-1, 1]) {
    const baseFront = p(side < 0 ? bl : br);
    const roofFront = p(side < 0 ? fl : fr);
    const baseRear = p(side < 0 ? rl : rr);
    const roofRear = p(side < 0 ? rfl : rfr);
    addBeam(root, baseFront, roofFront, 0.038, trim);
    addBeam(root, roofFront, roofRear, 0.032, trim);
    addBeam(root, roofRear, baseRear, 0.038, trim);
    addBeam(root, baseFront.clone().lerp(baseRear, 0.48), roofFront.clone().lerp(roofRear, 0.48), 0.024, trim);
    addBox(root, [0.17, 0.09, 0.22], [side * (config.bodyWidth * 0.49), baseY + 0.08, config.cabinZ + 0.06], paint, side * -0.1);
    const mirror = addBox(root, [0.19, 0.075, 0.13], [side * (baseHalf + 0.12), baseY + 0.16, frontBase - 0.13], trim, side * 0.18);
    mirror.scale.y = 0.86;
  }
}

function addWheelAssembly(
  root: THREE.Group,
  config: VehicleVisualConfig,
  definition: VehicleDefinition,
  rubber: THREE.Material,
  alloy: THREE.Material,
  brake: THREE.Material,
  caliperMaterial: THREE.Material,
): THREE.Object3D[] {
  const wheels: THREE.Object3D[] = [];
  const radius = definition.physics.wheelRadiusM;
  for (const side of [-1, 1]) {
    for (const z of [-config.wheelBase * 0.5, config.wheelBase * 0.5]) {
      const x = side * config.wheelTrack * 0.5;
      const assembly = new THREE.Group();
      assembly.position.set(x, 0.02, z);
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.27, 40, 1), rubber);
      tyre.rotation.z = Math.PI / 2;
      tyre.castShadow = true;
      assembly.add(tyre);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.67, radius * 0.67, 0.045, 32), brake);
      disc.rotation.z = Math.PI / 2;
      disc.position.x = side * 0.075;
      assembly.add(disc);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.23, radius * 0.23, 0.282, 24), alloy);
      hub.rotation.z = Math.PI / 2;
      assembly.add(hub);
      for (let spoke = 0; spoke < 10; spoke++) {
        const spokeMesh = new THREE.Mesh(new THREE.BoxGeometry(0.04, radius * 1.08, 0.045), alloy);
        spokeMesh.position.x = -side * 0.143;
        spokeMesh.rotation.x = spoke * Math.PI / 5;
        assembly.add(spokeMesh);
      }
      const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.23, 0.13), caliperMaterial);
      caliper.position.set(-side * 0.105, 0.08, radius * 0.42);
      assembly.add(caliper);
      root.add(assembly);
      wheels.push(assembly);

      const archPoints: THREE.Vector3[] = [];
      for (let i = 0; i <= 24; i++) {
        const angle = Math.PI * i / 24;
        archPoints.push(new THREE.Vector3(x, 0.02 + Math.sin(angle) * (radius + 0.09), z + Math.cos(angle) * (radius + 0.09)));
      }
      addCurve(root, archPoints, 0.035, material(config.paint, 0.58, 0.28));
    }
  }
  return wheels;
}

function addFrontAndRearDetails(
  root: THREE.Group,
  config: VehicleVisualConfig,
  carbon: THREE.Material,
  glass: THREE.Material,
  lamp: THREE.Material,
  tail: THREE.Material,
  metal: THREE.Material,
): void {
  const length = config.bodyLength;
  const width = config.bodyWidth;
  addPolygon(root, [
    [-width * 0.31, -0.08, length * 0.489], [width * 0.31, -0.08, length * 0.489],
    [width * 0.23, -0.205, length * 0.478], [-width * 0.23, -0.205, length * 0.478],
  ], carbon);
  addBox(root, [config.splitterWidth, 0.045, config.splitterDepth], [0, -0.235, length * 0.48], carbon);

  for (const side of [-1, 1]) {
    addPolygon(root, [
      [side * width * 0.17, 0.12, length * 0.444], [side * width * 0.43, 0.095, length * 0.442],
      [side * width * 0.40, 0.16, length * 0.40], [side * width * 0.20, 0.18, length * 0.402],
    ], glass);
    addPolygon(root, [
      [side * width * 0.20, 0.125, length * 0.448], [side * width * 0.40, 0.11, length * 0.445],
      [side * width * 0.36, 0.15, length * 0.414], [side * width * 0.22, 0.16, length * 0.416],
    ], lamp);
    addPolygon(root, [
      [side * width * 0.24, 0.075, -length * 0.475], [side * width * 0.44, 0.07, -length * 0.462],
      [side * width * 0.43, 0.16, -length * 0.46], [side * width * 0.23, 0.17, -length * 0.475],
    ], tail);

    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.14, 18), metal);
    exhaust.rotation.x = Math.PI / 2;
    exhaust.position.set(side * width * 0.25, -0.12, -length * 0.49);
    root.add(exhaust);

    const intakeZ = -length * (config.style === 'classic-wedge' ? 0.23 : 0.18);
    addPolygon(root, [
      [side * width * 0.48, 0.105, intakeZ + 0.31], [side * width * 0.50, 0.105, intakeZ - 0.25],
      [side * width * 0.44, -0.04, intakeZ - 0.32], [side * width * 0.41, -0.02, intakeZ + 0.23],
    ], carbon);
    addPolygon(root, [
      [side * width * 0.42, 0.115, length * 0.37], [side * width * 0.49, 0.09, length * 0.31],
      [side * width * 0.47, -0.015, length * 0.24], [side * width * 0.41, 0.005, length * 0.30],
    ], carbon);
  }

  addBox(root, [width * 0.76, 0.10, 0.30], [0, -0.20, -length * 0.475], carbon);
  addBox(root, [width * 0.58, 0.035, 0.045], [0, 0.145, -length * 0.486], tail);
  for (let fin = -2; fin <= 2; fin++) addBox(root, [0.035, 0.12, 0.28], [fin * width * 0.13, -0.24, -length * 0.46], carbon);

  if (config.popUpHeadlights) {
    for (const side of [-1, 1]) {
      addBox(root, [0.27, 0.10, 0.25], [side * width * 0.30, 0.205, length * 0.35], carbon);
      addBox(root, [0.18, 0.025, 0.08], [side * width * 0.30, 0.26, length * 0.36], lamp);
    }
  }
  if (config.rearLouvres) {
    for (let i = 0; i < 7; i++) addBox(root, [width * 0.56, 0.018, 0.055], [0, 0.16, -length * 0.13 - i * 0.095], carbon);
  }
}

function addAero(root: THREE.Group, config: VehicleVisualConfig, carbon: THREE.Material): void {
  if (config.style === 'sculpted') {
    for (const side of [-1, 1]) {
      const channel = addBox(root, [0.15, 0.17, 1.22], [side * config.bodyWidth * 0.39, -0.005, -0.12], carbon, side * -0.13);
      channel.scale.y = 0.78;
    }
    addBox(root, [0.12, 0.10, 0.92], [0, 0.15, -0.08], carbon);
  } else if (config.style === 'compact-angular') {
    for (const side of [-1, 1]) addBox(root, [0.085, 0.19, 0.54], [side * config.bodyWidth * 0.47, -0.02, -0.39], carbon, side * -0.18);
  } else if (config.style === 'wide-angular') {
    for (const side of [-1, 1]) addBox(root, [0.18, 0.23, 0.78], [side * config.bodyWidth * 0.46, -0.015, -0.35], carbon, side * -0.2);
  } else if (config.style === 'faceted') {
    for (const side of [-1, 1]) addBox(root, [0.22, 0.18, 0.76], [side * config.bodyWidth * 0.43, -0.025, -0.48], carbon, side * -0.28);
    addBox(root, [config.bodyWidth * 0.72, 0.08, 0.38], [0, -0.22, config.bodyLength * 0.49], carbon);
  } else if (config.style === 'track-aero') {
    addBox(root, [config.bodyWidth * 0.96, 0.10, 0.54], [0, -0.23, config.bodyLength * 0.49], carbon);
    for (const side of [-1, 1]) addBox(root, [0.15, 0.22, 0.72], [side * config.bodyWidth * 0.43, -0.025, -0.18], carbon, side * 0.18);
  }

  if (config.wingWidth > 0) {
    const rearZ = -config.bodyLength * 0.43;
    const wingY = 0.18 + config.wingHeight * 0.72;
    for (const side of [-1, 1]) {
      addBeam(root,
        new THREE.Vector3(side * config.wingWidth * 0.31, 0.31, rearZ + 0.05),
        new THREE.Vector3(side * config.wingWidth * 0.31, wingY - 0.025, rearZ),
        0.035, carbon);
    }
    const wing = addBox(root, [config.wingWidth, 0.075, config.wingDepth], [0, wingY, rearZ], carbon);
    if (config.activeAero) wing.rotation.x = -0.055;
    addBox(root, [config.wingWidth * 0.94, 0.025, config.wingDepth * 0.44], [0, wingY + 0.052, rearZ], material(0x252b30, 0.65, 0.35));
  }
}

function material(color: number, metalness = 0.35, roughness = 0.32): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}

export function createSportsCarVisual(definition: VehicleDefinition): VehicleVisualParts {
  const config = definition.visual;
  const root = new THREE.Group();
  const paint = new THREE.MeshPhysicalMaterial({
    color: config.paint, metalness: 0.72, roughness: 0.23, clearcoat: 0.95, clearcoatRoughness: 0.16,
  });
  const carbon = material(0x10151a, 0.58, 0.3);
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x142b37, metalness: 0.32, roughness: 0.12, clearcoat: 1,
    transparent: true, opacity: 0.82, side: THREE.DoubleSide,
  });
  const trim = material(0x242b31, 0.72, 0.27);
  const rubber = material(0x080a0d, 0.02, 0.9);
  const alloy = material(0xb5c0c5, 0.9, 0.19);
  const brake = material(0x666d73, 0.8, 0.35);
  const caliper = material(0xc62e25, 0.48, 0.3);
  const headlamp = new THREE.MeshStandardMaterial({
    color: 0xf4f0d8, emissive: 0xd8e3ed, emissiveIntensity: 0.55,
    metalness: 0.22, roughness: 0.18, side: THREE.DoubleSide,
  });
  const tailLamp = new THREE.MeshStandardMaterial({
    color: 0xb9121d, emissive: 0xe01825, emissiveIntensity: 1.2, metalness: 0.15, roughness: 0.25,
  });

  const hull = new THREE.Mesh(createBodyGeometry(config), paint);
  hull.castShadow = true;
  hull.receiveShadow = true;
  root.add(hull);
  createCabin(root, config, paint, glass, trim);
  const wheels = addWheelAssembly(root, config, definition, rubber, alloy, brake, caliper);
  addFrontAndRearDetails(root, config, carbon, glass, headlamp, tailLamp, alloy);
  addAero(root, config, carbon);

  const bodyLine = new THREE.LineBasicMaterial({ color: 0x171c21, transparent: true, opacity: 0.68 });
  for (const side of [-1, 1]) {
    const x = side * config.bodyWidth * 0.455;
    const z0 = config.bodyLength * 0.20;
    const z1 = -config.bodyLength * 0.28;
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x, 0.06, z0),
      new THREE.Vector3(x * 1.025, 0.045, z0 * 0.25),
      new THREE.Vector3(x * 1.015, 0.02, z1),
    ]);
    root.add(new THREE.Line(lineGeometry, bodyLine));
  }
  return { root, wheels };
}

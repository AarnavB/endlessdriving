import * as THREE from 'three';
import type { VehicleDefinition, VehicleVisualConfig } from './VehicleDefinitions';

type VehicleVisualParts = { root: THREE.Group; wheels: THREE.Object3D[] };

function material(color: number, metalness = 0.35, roughness = 0.32): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}

function addBox(
  parent: THREE.Group,
  size: [number, number, number],
  position: [number, number, number],
  mat: THREE.Material,
  rotationY = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
  mesh.position.set(...position);
  mesh.rotation.y = rotationY;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function createHull(config: VehicleVisualConfig, paint: THREE.Material): THREE.Mesh {
  const w = config.bodyWidth * 0.5;
  const l = config.bodyLength;
  const h = config.bodyHeight;
  const sections = [
    { z: l * 0.5, width: w * 0.65, upper: w * 0.56, top: h * 0.46 },
    { z: l * 0.4, width: w * 0.84, upper: w * 0.77, top: h * 0.72 },
    { z: l * 0.24, width: w * 0.98, upper: w * 0.96, top: h * 0.92 },
    { z: l * 0.04, width: w, upper: w * 0.92, top: h },
    { z: -l * 0.18, width: w * 1.02, upper: w * 0.97, top: h * 0.96 },
    { z: -l * 0.36, width: w * 0.96, upper: w * 0.9, top: h * 0.82 },
    { z: -l * 0.5, width: w * 0.8, upper: w * 0.66, top: h * 0.48 },
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const section of sections) {
    const bottom = -0.14;
    positions.push(
      -section.width, bottom, section.z,
      section.width, bottom, section.z,
      section.upper, section.top, section.z,
      -section.upper, section.top, section.z,
    );
  }
  for (let i = 0; i < sections.length - 1; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    for (let edge = 0; edge < 4; edge++) {
      const next = (edge + 1) % 4;
      indices.push(a + edge, b + edge, a + next, a + next, b + edge, b + next);
    }
  }
  indices.push(0, 1, 2, 0, 2, 3);
  const end = (sections.length - 1) * 4;
  indices.push(end, end + 2, end + 1, end, end + 3, end + 2);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, paint);
}

function createCabinGeometry(
  width: number,
  height: number,
  length: number,
  style: VehicleVisualConfig['style'],
): THREE.BufferGeometry {
  const frontRoofZ = style === 'classic-wedge' ? length * 0.13 : length * 0.2;
  const rearRoofZ = style === 'track-aero' ? -length * 0.38 : -length * 0.3;
  const roofHeight = height * (style === 'track-aero' ? 0.93 : 1);
  const baseHalf = width * 0.5;
  const roofHalf = width * (style === 'sculpted' ? 0.35 : 0.37);
  const frontTopY = height * (style === 'classic-wedge' ? 0.78 : 0.84);
  const p = [
    -baseHalf, 0, length * 0.5, baseHalf, 0, length * 0.5,
    baseHalf, 0, -length * 0.5, -baseHalf, 0, -length * 0.5,
    -roofHalf, frontTopY, frontRoofZ, roofHalf, frontTopY, frontRoofZ,
    roofHalf, roofHeight, rearRoofZ, -roofHalf, roofHeight, rearRoofZ,
  ];
  const i = [
    0,1,5, 0,5,4, 1,2,6, 1,6,5,
    2,3,7, 2,7,6, 3,0,4, 3,4,7,
    4,5,6, 4,6,7, 0,3,2, 0,2,1,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geometry.setIndex(i);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function createSportsCarVisual(definition: VehicleDefinition): VehicleVisualParts {
  const config = definition.visual;
  const root = new THREE.Group();
  const paint = material(config.paint, 0.72, 0.24);
  const carbon = material(0x10151a, 0.48, 0.38);
  const glass = new THREE.MeshStandardMaterial({ color: 0x10222c, metalness: 0.58, roughness: 0.16 });
  const rubber = material(0x080a0d, 0.05, 0.9);
  const rim = material(0xaeb9c0, 0.86, 0.2);
  const light = new THREE.MeshStandardMaterial({ color: 0xe9f1e9, emissive: 0xa8c8d8, emissiveIntensity: 1.1 });
  const tail = new THREE.MeshStandardMaterial({ color: 0xe1242d, emissive: 0xb20d19, emissiveIntensity: 1.4 });

  const hull = createHull(config, paint);
  hull.position.y = 0.08;
  hull.castShadow = true;
  hull.receiveShadow = true;
  root.add(hull);

  const hoodWidth = config.bodyWidth * (config.style === 'classic-wedge' ? 0.72 : 0.78);
  addBox(root, [hoodWidth, 0.13, config.bodyLength * 0.24], [0, 0.26, config.bodyLength * 0.31], paint);
  addBox(root, [config.bodyWidth * 0.86, 0.12, config.bodyLength * 0.12], [0, 0.08, -config.bodyLength * 0.4], carbon);

  const cabin = new THREE.Mesh(
    createCabinGeometry(config.cabinWidth, config.cabinHeight, config.cabinLength, config.style),
    glass,
  );
  cabin.position.set(0, 0.36, config.cabinZ);
  cabin.castShadow = true;
  cabin.receiveShadow = true;
  root.add(cabin);

  const roof = addBox(
    root,
    [config.cabinWidth * 0.84, 0.12, config.cabinLength * 0.55],
    [0, cabin.position.y + config.cabinHeight * 0.94, config.cabinZ - config.cabinLength * 0.04],
    paint,
  );
  roof.scale.y = config.style === 'track-aero' ? 0.72 : 1;

  for (const side of [-1, 1]) {
    addBox(root, [0.035, config.cabinHeight * 0.8, config.cabinLength * 0.9],
      [side * (config.cabinWidth * 0.49), cabin.position.y + config.cabinHeight * 0.5, config.cabinZ], carbon);
    addBox(root, [0.08, 0.22, config.bodyLength * 0.38],
      [side * (config.bodyWidth * 0.48), 0.02, -config.bodyLength * 0.08], carbon);

    const intake = addBox(
      root,
      [0.045, 0.26 * config.intakeScale, 0.62 * config.intakeScale],
      [side * (config.bodyWidth * 0.49), 0.12, -config.bodyLength * 0.22],
      carbon,
    );
    if (config.style === 'faceted' || config.style === 'track-aero') intake.rotation.y = side * -0.12;

    addBox(root, [0.05, 0.13, config.bodyLength * 0.12],
      [side * (config.bodyWidth * 0.43), 0.12, config.bodyLength * 0.34], carbon);
    addBox(root, [0.18, 0.09, 0.16],
      [side * (config.bodyWidth * 0.52), cabin.position.y + config.cabinHeight * 0.58,
        config.cabinZ + config.cabinLength * 0.31], carbon, side * 0.12);
    addBox(root, [0.14, 0.032, 0.04],
      [side * (config.bodyWidth * 0.49), 0.28, -config.bodyLength * 0.04], rim);
  }

  const frontBumper = addBox(root,
    [config.bodyWidth * 0.96, 0.12, 0.18],
    [0, -0.13, config.bodyLength * 0.48], carbon);
  frontBumper.position.y -= 0.04;
  addBox(root, [config.splitterWidth, 0.055, config.splitterDepth],
    [0, -0.22, config.bodyLength * 0.49], carbon);

  for (const side of [-1, 1]) {
    const headlight = addBox(root,
      [config.style === 'classic-wedge' ? 0.3 : 0.38, 0.085, 0.08],
      [side * config.bodyWidth * 0.31, 0.12, config.bodyLength * 0.47],
      config.popUpHeadlights ? carbon : light);
    if (config.style === 'faceted') headlight.rotation.y = side * 0.18;
    addBox(root, [0.38, 0.085, 0.07],
      [side * config.bodyWidth * 0.31, 0.1, -config.bodyLength * 0.49], tail);
  }

  const wheels: THREE.Object3D[] = [];
  const archMaterial = material(config.paint, 0.64, 0.3);
  for (const side of [-1, 1]) {
    for (const z of [-config.wheelBase * 0.5, config.wheelBase * 0.5]) {
      const x = side * config.wheelTrack * 0.5;
      const assembly = new THREE.Group();
      assembly.position.set(x, 0.02, z);
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 28), rubber);
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      assembly.add(tire);

      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.27, 20), rim);
      hub.rotation.z = Math.PI / 2;
      hub.position.x = side * 0.13;
      assembly.add(hub);
      for (let spoke = 0; spoke < 10; spoke++) {
        const spokeMesh = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.028, 0.27), rim);
        spokeMesh.position.x = side * 0.142;
        spokeMesh.rotation.x = spoke * Math.PI / 5;
        assembly.add(spokeMesh);
      }
      const brakeDisc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.22, 0.035, 24),
        material(0x555c62, 0.72, 0.48),
      );
      brakeDisc.rotation.z = Math.PI / 2;
      brakeDisc.position.x = -side * 0.075;
      assembly.add(brakeDisc);
      const caliper = addBox(assembly, [0.095, 0.2, 0.14],
        [-side * 0.11, 0.12, 0.16], material(0xb52c24, 0.3, 0.45));
      caliper.castShadow = false;
      root.add(assembly);
      wheels.push(assembly);

      const arch = new THREE.Mesh(
        new THREE.TorusGeometry(0.39, 0.035, 7, 24, Math.PI),
        archMaterial,
      );
      arch.rotation.y = Math.PI / 2;
      arch.position.set(x, 0.02, z);
      arch.castShadow = true;
      root.add(arch);
    }
  }

  // Model-specific cues: these are original procedural details, not copied assets.
  if (config.popUpHeadlights) {
    for (const side of [-1, 1]) {
      addBox(root, [0.32, 0.11, 0.24],
        [side * config.bodyWidth * 0.31, 0.25, config.bodyLength * 0.39], carbon);
      addBox(root, [0.2, 0.035, 0.1],
        [side * config.bodyWidth * 0.31, 0.31, config.bodyLength * 0.39], light);
    }
  }

  if (config.rearLouvres) {
    for (let i = 0; i < 7; i++) {
      addBox(root, [config.bodyWidth * 0.53, 0.025, 0.055],
        [0, 0.2, -config.bodyLength * 0.22 - i * 0.105], carbon);
    }
  }

  if (config.style === 'sculpted') {
    for (const side of [-1, 1]) {
      const channel = addBox(root, [0.2, 0.22, 1.1],
        [side * config.bodyWidth * 0.38, 0.18, -0.1], carbon);
      channel.rotation.y = side * -0.12;
    }
    addBox(root, [0.2, 0.25, 0.78], [0, 0.16, -config.bodyLength * 0.48], carbon);
  } else if (config.style === 'compact-angular') {
    for (const side of [-1, 1]) {
      addBox(root, [0.08, 0.36, 0.58],
        [side * config.bodyWidth * 0.49, 0.17, -0.42], carbon, side * -0.18);
      addBox(root, [0.1, 0.16, 0.34],
        [side * config.bodyWidth * 0.44, 0.11, 0.65], light);
    }
  } else if (config.style === 'wide-angular') {
    for (const side of [-1, 1]) {
      addBox(root, [0.2, 0.32, 0.8],
        [side * config.bodyWidth * 0.47, 0.14, -0.35], carbon, side * -0.2);
    }
    addBox(root, [config.bodyWidth * 0.78, 0.12, 0.3],
      [0, -0.14, -config.bodyLength * 0.5], carbon);
  } else if (config.style === 'faceted') {
    addBox(root, [config.bodyWidth * 0.94, 0.1, 0.48],
      [0, -0.2, config.bodyLength * 0.5], carbon);
    for (const side of [-1, 1]) {
      addBox(root, [0.24, 0.2, 0.62],
        [side * config.bodyWidth * 0.39, 0.16, 0.78], carbon, side * -0.3);
      addBox(root, [0.06, 0.28, 0.45],
        [side * config.bodyWidth * 0.48, 0.08, -0.72], carbon, side * -0.25);
    }
  } else if (config.style === 'track-aero') {
    addBox(root, [config.bodyWidth * 1.04, 0.09, 0.52],
      [0, -0.2, config.bodyLength * 0.5], carbon);
    addBox(root, [0.19, 0.3, 0.82],
      [-config.bodyWidth * 0.4, 0.12, -0.16], carbon, -0.2);
    addBox(root, [0.19, 0.3, 0.82],
      [config.bodyWidth * 0.4, 0.12, -0.16], carbon, 0.2);
    addBox(root, [config.bodyWidth * 0.85, 0.13, 0.52],
      [0, -0.16, -config.bodyLength * 0.5], carbon);
  }

  if (config.wingWidth > 0) {
    for (const side of [-1, 1]) {
      addBox(root, [0.07, config.wingHeight * 0.64, 0.08],
        [side * config.wingWidth * 0.34, 0.28 + config.wingHeight * 0.34, -config.bodyLength * 0.43], carbon);
    }
    const wing = addBox(root, [config.wingWidth, 0.075, config.wingDepth],
      [0, 0.28 + config.wingHeight, -config.bodyLength * 0.43], carbon);
    if (config.activeAero) wing.rotation.x = -0.06;
  }

  // Shared rear diffuser fins and a restrained exhaust pair.
  for (let i = -2; i <= 2; i++) {
    addBox(root, [0.035, 0.12, 0.38],
      [i * config.bodyWidth * 0.16, -0.18, -config.bodyLength * 0.49], carbon);
  }
  for (const side of [-1, 1]) {
    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.12, 12), rim);
    exhaust.rotation.x = Math.PI / 2;
    exhaust.position.set(side * config.bodyWidth * 0.23, -0.02, -config.bodyLength * 0.5);
    root.add(exhaust);
  }

  return { root, wheels };
}

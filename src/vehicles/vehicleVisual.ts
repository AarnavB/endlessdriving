import * as THREE from 'three';

export function createSportsCarVisual(): { root: THREE.Group; wheels: THREE.Mesh[] } {
  const root = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xd34b25, metalness: 0.68, roughness: 0.28 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x111821, metalness: 0.36, roughness: 0.42 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x182c3b, metalness: 0.5, roughness: 0.18 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x080a0e, roughness: 0.86 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xaab6c0, metalness: 0.82, roughness: 0.24 });
  const headlight = new THREE.MeshStandardMaterial({ color: 0xf2f4e9, emissive: 0xcad9e6, emissiveIntensity: 1.6 });
  const taillight = new THREE.MeshStandardMaterial({ color: 0xc51b27, emissive: 0xb40712, emissiveIntensity: 1.2 });

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.48, 3.9), paint);
  chassis.position.y = 0.02;
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  root.add(chassis);
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.76, 0.18, 1.05), paint);
  hood.position.set(0, 0.27, 1.34);
  hood.castShadow = true;
  root.add(hood);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.46, 0.62, 1.75), glass);
  cabin.position.set(0, 0.54, -0.18);
  cabin.castShadow = true;
  root.add(cabin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.12, 1.3), paint);
  roof.position.set(0, 0.9, -0.18);
  root.add(roof);
  const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.18, 0.18), dark);
  frontBumper.position.set(0, -0.17, 1.98);
  root.add(frontBumper);
  const rearBumper = frontBumper.clone();
  rearBumper.position.z = -1.98;
  root.add(rearBumper);
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.34), dark);
  splitter.position.set(0, -0.22, 1.9);
  root.add(splitter);

  for (const x of [-0.65, 0.65]) {
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.11, 0.06), headlight);
    light.position.set(x, 0.15, 1.99);
    root.add(light);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.06), taillight);
    tail.position.set(x, 0.12, -1.99);
    root.add(tail);
  }

  const wheels: THREE.Mesh[] = [];
  for (const x of [-0.94, 0.94]) {
    for (const z of [-1.28, 1.28]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 24), rubber);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.05, z);
      wheel.castShadow = true;
      root.add(wheel);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.25, 16), rim);
      hub.rotation.z = Math.PI / 2;
      hub.position.copy(wheel.position);
      root.add(hub);
      wheels.push(wheel);
    }
  }

  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.08, 0.25), dark);
  spoiler.position.set(0, 0.55, -1.7);
  root.add(spoiler);
  return { root, wheels };
}

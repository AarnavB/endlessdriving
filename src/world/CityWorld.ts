import * as THREE from 'three';

export interface BuildingCollider {
  x: number;
  y: number;
  z: number;
  halfWidth: number;
  halfHeight: number;
  halfDepth: number;
  rotation: number;
}

export class CityWorld {
  readonly scene: THREE.Scene;
  private readonly streetLights: THREE.PointLight[] = [];
  private readonly buildingColliders: BuildingCollider[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.buildEnvironment();
  }

  getBuildingColliders(): readonly BuildingCollider[] {
    return this.buildingColliders;
  }

  setNightBlend(amount: number): void {
    const blend = THREE.MathUtils.clamp(amount, 0, 1);
    this.scene.background = new THREE.Color(0x9cb5c5).lerp(new THREE.Color(0x080d18), blend);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(this.scene.background as THREE.Color);
      this.scene.fog.density = THREE.MathUtils.lerp(0.0013, 0.0022, blend);
    }
    for (const light of this.streetLights) light.intensity = THREE.MathUtils.lerp(0.0, 2.7, blend);
  }

  private buildEnvironment(): void {
    this.scene.background = new THREE.Color(0x9cb5c5);
    this.scene.fog = new THREE.FogExp2(0x9cb5c5, 0.0013);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(520, 520),
      new THREE.MeshStandardMaterial({ color: 0x3a4148, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.09;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.addRoadNetwork();
    this.addSidewalks();
    this.addBuildings();
    this.addStreetFurniture();
    this.addTimesSquareCorner();
  }

  private addRoadNetwork(): void {
    const asphalt = new THREE.MeshStandardMaterial({ color: 0x20262c, roughness: 0.96 });
    const roadGroup = new THREE.Group();
    const road = (width: number, length: number, x: number, z: number): void => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, length), asphalt);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, 0.005, z);
      mesh.receiveShadow = true;
      roadGroup.add(mesh);
    };

    road(20, 500, 0, 0);
    for (const x of [-156, -104, -52, 52, 104, 156]) road(15, 500, x, 0);
    for (const z of [-156, -104, -52, 52, 104, 156]) road(500, 15, 0, z);
    this.scene.add(roadGroup);

    // Use instancing for hundreds of small lane dashes. Individual Mesh objects
    // caused excessive draw calls and stutter on integrated GPUs.
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xe9e2c5 });
    const yellowMat = new THREE.MeshBasicMaterial({ color: 0xe3b34b });
    const whiteTransforms: THREE.Matrix4[] = [];
    const yellowTransforms: THREE.Matrix4[] = [];
    const addDash = (target: THREE.Matrix4[], x: number, z: number, width: number, length: number): void => {
      target.push(new THREE.Matrix4().compose(
        new THREE.Vector3(x, 0.035, z),
        new THREE.Quaternion(),
        new THREE.Vector3(width, 0.025, length),
      ));
    };

    for (const x of [0, -156, -104, -52, 52, 104, 156]) {
      for (let z = -245; z <= 245; z += 13) {
        if (x === 0) {
          addDash(yellowTransforms, -0.64, z, 0.11, 5.3);
          addDash(yellowTransforms, 0.64, z, 0.11, 5.3);
        } else {
          addDash(whiteTransforms, x + 4.2, z, 0.08, 4.2);
        }
      }
    }
    for (const z of [0, -156, -104, -52, 52, 104, 156]) {
      for (let x = -245; x <= 245; x += 13) {
        addDash(whiteTransforms, x, z + 4.2, 4.2, 0.08);
      }
    }

    const markings = new THREE.Group();
    const whiteMesh = new THREE.InstancedMesh(unitBox, lineMat, whiteTransforms.length);
    whiteTransforms.forEach((transform, index) => whiteMesh.setMatrixAt(index, transform));
    whiteMesh.instanceMatrix.needsUpdate = true;
    whiteMesh.computeBoundingSphere();
    markings.add(whiteMesh);

    const yellowMesh = new THREE.InstancedMesh(unitBox, yellowMat, yellowTransforms.length);
    yellowTransforms.forEach((transform, index) => yellowMesh.setMatrixAt(index, transform));
    yellowMesh.instanceMatrix.needsUpdate = true;
    yellowMesh.computeBoundingSphere();
    markings.add(yellowMesh);
    this.scene.add(markings);
  }

  private addSidewalks(): void {
    const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0x777b7c, roughness: 0.92 });
    const curbMat = new THREE.MeshStandardMaterial({ color: 0xb5b4aa, roughness: 0.8 });
    const group = new THREE.Group();
    const positions = [-164, -112, -60, 60, 112, 164];
    for (const x of positions) {
      for (const side of [-1, 1]) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.24, 500), sidewalkMat);
        mesh.position.set(x + side * 9.2, 0.03, 0);
        mesh.receiveShadow = true;
        group.add(mesh);
        const curb = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.27, 500), curbMat);
        curb.position.set(x + side * 7.35, 0.06, 0);
        group.add(curb);
      }
    }
    for (const z of positions) {
      for (const side of [-1, 1]) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(500, 0.24, 3.4), sidewalkMat);
        mesh.position.set(0, 0.03, z + side * 9.2);
        mesh.receiveShadow = true;
        group.add(mesh);
      }
    }
    this.scene.add(group);
  }

  private addBuildings(): void {
    const facade = this.createFacadeTexture();
    const materials = [
      new THREE.MeshStandardMaterial({ color: 0x777e85, map: facade, roughness: 0.78, metalness: 0.12 }),
      new THREE.MeshStandardMaterial({ color: 0x9a8c7e, map: facade, roughness: 0.82 }),
      new THREE.MeshStandardMaterial({ color: 0x555f68, map: facade, roughness: 0.64, metalness: 0.2 }),
      new THREE.MeshStandardMaterial({ color: 0xaaa69a, map: facade, roughness: 0.82 }),
    ];
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    let seed = 741903;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const instances: THREE.Matrix4[][] = materials.map(() => []);
    for (let bx = -3; bx <= 2; bx++) {
      for (let bz = -3; bz <= 2; bz++) {
        const x = bx * 52 + 26 + (rand() - 0.5) * 5;
        const z = bz * 52 + 26 + (rand() - 0.5) * 5;
        const width = 15 + rand() * 9;
        const depth = 15 + rand() * 9;
        const height = 25 + Math.pow(rand(), 0.58) * 100;
        const rotation = Math.round(rand() * 3) * Math.PI / 2;
        this.buildingColliders.push({ x, y: height / 2, z, halfWidth: width / 2, halfHeight: height / 2, halfDepth: depth / 2, rotation });
        const matrix = new THREE.Matrix4().compose(
          new THREE.Vector3(x, height / 2, z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotation, 0)),
          new THREE.Vector3(width, height, depth),
        );
        instances[Math.floor(rand() * materials.length)].push(matrix);
      }
    }
    const buildingGroup = new THREE.Group();
    materials.forEach((material, materialIndex) => {
      const matrices = instances[materialIndex];
      if (matrices.length === 0) return;
      const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      buildingGroup.add(mesh);
    });
    this.scene.add(buildingGroup);
  }

  private createFacadeTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable for building texture.');
    ctx.fillStyle = '#3a434a';
    ctx.fillRect(0, 0, 256, 256);
    for (let y = 10; y < 252; y += 24) {
      for (let x = 10; x < 252; x += 21) {
        const lit = Math.random() > 0.42;
        ctx.fillStyle = lit ? (Math.random() > 0.6 ? '#b9a77a' : '#8ea2ad') : '#1a252f';
        ctx.fillRect(x, y, 11, 13);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x, y, 11, 1);
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1.4, 2.2);
    return texture;
  }

  private addStreetFurniture(): void {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x30383d, metalness: 0.75, roughness: 0.35 });
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffd69b, emissive: 0xffbd71, emissiveIntensity: 0.35 });
    const treeMat = new THREE.MeshStandardMaterial({ color: 0x315644, roughness: 1 });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x574438, roughness: 1 });
    const group = new THREE.Group();
    for (let z = -220; z <= 220; z += 44) {
      for (const x of [-13.2, 13.2]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 6.5, 8), poleMat);
        pole.position.set(x, 3.2, z);
        group.add(pole);
        const arm = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.09, 0.1), poleMat);
        arm.position.set(x + (x < 0 ? 0.65 : -0.65), 6.35, z);
        group.add(arm);
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.35), lampMat);
        lamp.position.copy(arm.position).add(new THREE.Vector3(x < 0 ? 0.6 : -0.6, -0.08, 0));
        group.add(lamp);
        // A small number of real point lights provide nighttime pools of light;
        // the emissive lamp mesh carries the remaining street-light detail cheaply.
        if (x < 0 && z % 88 === 0) {
          const point = new THREE.PointLight(0xffc98b, 0, 28, 2);
          point.position.copy(lamp.position).add(new THREE.Vector3(0, -0.25, 0));
          this.streetLights.push(point);
          group.add(point);
        }
      }
    }
    for (let z = -190; z <= 190; z += 52) {
      for (const x of [-25, 25]) {
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.25, 2.8, 7), trunkMat);
        trunk.position.set(x, 1.4, z);
        group.add(trunk);
        const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.45, 1), treeMat);
        crown.position.set(x, 3.6, z);
        crown.scale.set(1, 1.15, 1);
        group.add(crown);
      }
    }
    this.scene.add(group);
  }

  private addTimesSquareCorner(): void {
    const tower = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(20, 34, 13),
      new THREE.MeshStandardMaterial({ color: 0x282f39, roughness: 0.62, metalness: 0.26 }),
    );
    base.position.set(30, 17, -30);
    tower.add(base);
    const signMaterials = [0x143c67, 0x8a2c27, 0xc18b32, 0x2a6b68].map((color) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7 }));
    const signs = [
      { x: 19.8, y: 15, z: -25.5, w: 2.2, h: 11 },
      { x: 30, y: 23, z: -23.2, w: 13, h: 5.5 },
      { x: 40.2, y: 11, z: -25.5, w: 2.1, h: 7 },
    ];
    signs.forEach((s, i) => {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), signMaterials[i]);
      panel.position.set(s.x, s.y, s.z);
      tower.add(panel);
    });
    const label = this.createBillboard('TIMES SQUARE  /  MIDTOWN');
    label.position.set(30, 31, -23.1);
    tower.add(label);
    this.scene.add(tower);
  }

  private createBillboard(text: string): THREE.Mesh {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable for billboard.');
    ctx.fillStyle = '#08121c';
    ctx.fillRect(0, 0, 512, 96);
    ctx.fillStyle = '#f5eee0';
    ctx.font = '700 34px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 48);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
    return new THREE.Mesh(new THREE.PlaneGeometry(12, 2.25), material);
  }
}

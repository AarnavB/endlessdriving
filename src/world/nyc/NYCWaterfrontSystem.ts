import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  HUDSON_RIVER_MAX_Z,
  HUDSON_RIVER_MIN_Z,
  HUDSON_RIVER_SURFACE_Y,
  getHudsonEastBankX,
  getHudsonRiverCenterX,
  getHudsonWestBankX,
} from './NYCWaterfrontLayout';

type GraphicsQuality = 'low' | 'medium' | 'high';

interface BoxSpec {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
  rotationY?: number;
  colour?: number;
}

/**
 * A streamed-world companion for the Hudson waterfront.
 *
 * Water reflections use an application-owned cube render target so the
 * allocation is explicitly disposed. Reflection captures are throttled and
 * disabled unless the player is close to the waterfront.
 */
export class NYCWaterfrontSystem {
  private readonly root = new THREE.Group();
  private readonly boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly promenadeMaterial = new THREE.MeshStandardMaterial({
    color: 0x777b79, roughness: 0.88, metalness: 0.04,
  });
  private readonly seawallMaterial = new THREE.MeshStandardMaterial({
    color: 0x777d80, roughness: 0.82, metalness: 0.08,
  });
  private readonly pierMaterial = new THREE.MeshStandardMaterial({
    color: 0x655f55, roughness: 0.86, metalness: 0.05,
  });
  private readonly skylineMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.54, metalness: 0.26,
  });
  private readonly windowMaterial = new THREE.MeshStandardMaterial({
    color: 0xffd59b, roughness: 0.32, metalness: 0.08,
    emissive: 0xff9b43, emissiveIntensity: 0.0,
  });
  private readonly lampMaterial = new THREE.MeshStandardMaterial({
    color: 0xe6d6b6, roughness: 0.42, metalness: 0.28,
    emissive: 0xffc478, emissiveIntensity: 0.0,
  });
  private readonly waterGeometry: THREE.BufferGeometry;
  private readonly promenadeGeometry: THREE.BufferGeometry;
  private readonly waterMaterial: THREE.ShaderMaterial;
  private readonly waterMesh: THREE.Mesh;
  private readonly reflectionTarget: THREE.WebGLCubeRenderTarget;
  private readonly reflectionCamera: THREE.CubeCamera;
  private readonly body: RAPIER.RigidBody;
  private readonly worldOffset = new THREE.Vector3();
  private elapsed = 0;
  private reflectionElapsed = 0;
  private lastNightBlend = 0;
  private disposed = false;
  private reflectionWarningShown = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: RAPIER.World,
    quality: GraphicsQuality,
  ) {
    this.root.name = 'hudson-river-waterfront';
    this.scene.add(this.root);
    this.body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    this.waterGeometry = this.createWaterGeometry();
    const reflectionResolution = quality === 'high' ? 256 : quality === 'medium' ? 128 : 64;
    this.reflectionTarget = new THREE.WebGLCubeRenderTarget(reflectionResolution, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      type: THREE.HalfFloatType,
    });
    this.reflectionCamera = new THREE.CubeCamera(0.2, 6500, this.reflectionTarget);
    this.reflectionCamera.position.set(getHudsonRiverCenterX(0), 18, 0);

    this.waterMaterial = new THREE.ShaderMaterial({
      name: 'HudsonReflectiveWater',
      uniforms: {
        uTime: { value: 0 },
        uNight: { value: 0 },
        uReflection: { value: this.reflectionTarget.texture },
        uSunDirection: { value: new THREE.Vector3(-0.25, 0.91, 0.32).normalize() },
        uDeepColour: { value: new THREE.Color(0x173e50) },
        uShallowColour: { value: new THREE.Color(0x426c78) },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uNight;
        uniform samplerCube uReflection;
        uniform vec3 uSunDirection;
        uniform vec3 uDeepColour;
        uniform vec3 uShallowColour;
        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;

        void main() {
          vec2 p = vWorldPosition.xz;
          float waveA = sin(p.x * 0.014 + p.y * 0.002 + uTime * 0.34);
          float waveB = cos(p.y * 0.019 - p.x * 0.003 - uTime * 0.25);
          float waveC = sin((p.x + p.y) * 0.008 + uTime * 0.17);
          vec3 normal = normalize(vWorldNormal + vec3(
            (waveA + waveC * 0.45) * 0.055,
            0.0,
            (waveB - waveC * 0.35) * 0.055
          ));
          vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
          vec3 reflectedDirection = reflect(-viewDirection, normal);
          vec3 reflected = textureCube(uReflection, reflectedDirection).rgb;
          float fresnel = pow(1.0 - max(dot(normal, viewDirection), 0.0), 5.0);
          float crest = 0.5 + 0.5 * (waveA * 0.58 + waveB * 0.42);
          vec3 base = mix(uDeepColour, uShallowColour, 0.12 + crest * 0.20);
          vec3 colour = mix(base, reflected, 0.20 + fresnel * 0.70);
          vec3 halfVector = normalize(normal + viewDirection);
          float sunGlint = pow(max(dot(halfVector, normalize(uSunDirection)), 0.0), 90.0);
          colour += vec3(1.0, 0.83, 0.61) * sunGlint * (0.2 + (1.0 - uNight) * 0.72);
          colour = mix(colour, colour * vec3(0.48, 0.61, 0.78), uNight * 0.36);
          gl_FragColor = vec4(colour, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.FrontSide,
      depthWrite: true,
      depthTest: true,
    });
    this.waterMesh = new THREE.Mesh(this.waterGeometry, this.waterMaterial);
    this.waterMesh.name = 'hudson-river-surface';
    this.waterMesh.frustumCulled = false;
    this.waterMesh.renderOrder = 1;
    this.root.add(this.waterMesh);

    this.promenadeGeometry = this.createPromenadeGeometry();
    const promenade = new THREE.Mesh(this.promenadeGeometry, this.promenadeMaterial);
    promenade.name = 'hudson-east-bank-promenade';
    promenade.receiveShadow = true;
    this.root.add(promenade);

    this.buildShoreInfrastructure();
    this.buildNewJerseySkyline();
  }

  update(
    deltaSeconds: number,
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    playerPosition: THREE.Vector3,
    sunDirection: THREE.Vector3,
    nightBlend: number,
  ): void {
    if (this.disposed) return;
    const dt = Math.max(0, Math.min(0.1, deltaSeconds));
    this.elapsed += dt;
    this.reflectionElapsed += dt;
    this.lastNightBlend = THREE.MathUtils.clamp(nightBlend, 0, 1);
    this.waterMaterial.uniforms.uTime.value = this.elapsed;
    this.waterMaterial.uniforms.uNight.value = this.lastNightBlend;
    this.waterMaterial.uniforms.uSunDirection.value.copy(sunDirection).normalize();
    this.windowMaterial.emissiveIntensity = 0.9 * this.lastNightBlend;
    this.lampMaterial.emissiveIntensity = 1.8 * this.lastNightBlend;

    const globalX = playerPosition.x + this.worldOffset.x;
    const globalZ = playerPosition.z + this.worldOffset.z;
    const nearRiver = Math.abs(globalX - getHudsonRiverCenterX(globalZ)) < 1600
      && globalZ >= HUDSON_RIVER_MIN_Z - 200
      && globalZ <= HUDSON_RIVER_MAX_Z + 200;
    if (!nearRiver || this.reflectionElapsed < 1.1) return;

    const targetX = getHudsonRiverCenterX(0) - this.worldOffset.x;
    const targetZ = -this.worldOffset.z;
    if (this.reflectionCamera.position.distanceToSquared(new THREE.Vector3(targetX, 18, targetZ)) > 1) {
      this.reflectionCamera.position.set(targetX, 18, targetZ);
    }
    const visible = this.waterMesh.visible;
    try {
      this.waterMesh.visible = false;
      this.reflectionCamera.updateMatrixWorld(true);
      this.reflectionCamera.update(renderer, this.scene);
      this.reflectionElapsed = 0;
    } catch (error) {
      if (!this.reflectionWarningShown) {
        console.warn('Hudson water reflection capture failed; retaining the last environment capture.', error);
        this.reflectionWarningShown = true;
      }
      this.reflectionElapsed = 0.35;
    } finally {
      this.waterMesh.visible = visible;
    }
  }

  setNightBlend(value: number): void {
    this.lastNightBlend = THREE.MathUtils.clamp(value, 0, 1);
    this.waterMaterial.uniforms.uNight.value = this.lastNightBlend;
    this.windowMaterial.emissiveIntensity = 0.9 * this.lastNightBlend;
    this.lampMaterial.emissiveIntensity = 1.8 * this.lastNightBlend;
  }

  rebase(delta: THREE.Vector3): void {
    if (this.disposed || delta.lengthSq() === 0) return;
    this.worldOffset.add(delta);
    this.root.position.sub(delta);
    const translation = this.body.translation();
    this.body.setTranslation({
      x: translation.x - delta.x,
      y: translation.y - delta.y,
      z: translation.z - delta.z,
    }, true);
    this.reflectionCamera.position.sub(delta);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.root);
    this.physics.removeRigidBody(this.body);
    this.reflectionTarget.dispose();
    this.waterGeometry.dispose();
    this.promenadeGeometry.dispose();
    this.waterMaterial.dispose();
    this.boxGeometry.dispose();
    this.promenadeMaterial.dispose();
    this.seawallMaterial.dispose();
    this.pierMaterial.dispose();
    this.skylineMaterial.dispose();
    this.windowMaterial.dispose();
    this.lampMaterial.dispose();
    this.root.clear();
  }

  private createWaterGeometry(): THREE.BufferGeometry {
    const columns = 42;
    const rows = 136;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let row = 0; row <= rows; row++) {
      const z = THREE.MathUtils.lerp(HUDSON_RIVER_MIN_Z, HUDSON_RIVER_MAX_Z, row / rows);
      const west = getHudsonWestBankX(z) - 5;
      const east = getHudsonEastBankX(z) + 5;
      for (let column = 0; column <= columns; column++) {
        const x = THREE.MathUtils.lerp(west, east, column / columns);
        const shallow = Math.min(column, columns - column) / (columns * 0.5);
        const y = HUDSON_RIVER_SURFACE_Y - 0.025 * shallow;
        positions.push(x, y, z);
        if (row < rows && column < columns) {
          const a = row * (columns + 1) + column;
          const b = a + 1;
          const d = (row + 1) * (columns + 1) + column;
          const c = d + 1;
          indices.push(a, d, b, b, d, c);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createPromenadeGeometry(): THREE.BufferGeometry {
    const rows = 156;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let row = 0; row <= rows; row++) {
      const z = THREE.MathUtils.lerp(HUDSON_RIVER_MIN_Z, HUDSON_RIVER_MAX_Z, row / rows);
      const bank = getHudsonEastBankX(z);
      positions.push(bank + 1.8, 0.53, z, bank + 21.5, 0.53, z);
      if (row < rows) {
        const a = row * 2;
        const b = a + 1;
        const d = a + 2;
        const c = a + 3;
        indices.push(a, d, b, b, d, c);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private buildShoreInfrastructure(): void {
    const walls: BoxSpec[] = [];
    const lamps: BoxSpec[] = [];
    const lampHeads: BoxSpec[] = [];
    const piers: BoxSpec[] = [];
    const pilings: BoxSpec[] = [];

    for (let z = HUDSON_RIVER_MIN_Z; z < HUDSON_RIVER_MAX_Z; z += 48) {
      const bank = getHudsonEastBankX(z + 24);
      walls.push({
        x: bank - 0.4, y: 0.72, z: z + 24,
        width: 1.6, height: 1.45, depth: 48,
      });
      const promenadeDeckCentre = bank + 11.5;
      if (Math.round(z / 192) % 2 === 0) {
        lamps.push({
          x: promenadeDeckCentre + 6.5, y: 3.35, z: z + 24,
          width: 0.16, height: 6.2, depth: 0.16,
        });
        lampHeads.push({
          x: promenadeDeckCentre + 6.5, y: 6.5, z: z + 24,
          width: 0.8, height: 0.18, depth: 0.3,
        });
      }
    }

    // Public piers project west into the river, with solid decks and support piles.
    for (const z of [-2100, -1050, 0, 1050, 2100]) {
      const bank = getHudsonEastBankX(z);
      piers.push({
        x: bank - 86, y: 1.05, z,
        width: 174, height: 0.8, depth: 18,
      });
      for (const along of [bank - 18, bank - 154]) {
        for (const side of [-1, 1]) {
          pilings.push({
            x: along, y: -4.4, z: z + side * 6.3,
            width: 2.1, height: 9.0, depth: 2.1,
          });
        }
      }
    }

    this.addInstancedBoxes('hudson-seawall-segments', walls, this.seawallMaterial, true);
    this.addInstancedBoxes('hudson-waterfront-lamps', lamps, this.lampMaterial, true);
    this.addInstancedBoxes('hudson-waterfront-lamp-heads', lampHeads, this.lampMaterial, false);
    this.addInstancedBoxes('hudson-public-pier-decks', piers, this.pierMaterial, true);
    this.addInstancedBoxes('hudson-public-pier-pilings', pilings, this.pierMaterial, true);

    // Low parapets and benches furnish the route without blocking the skyline.
    const benches: BoxSpec[] = [];
    for (const z of [-2400, -1600, -800, 0, 800, 1600, 2400]) {
      const bank = getHudsonEastBankX(z);
      benches.push({
        x: bank + 15.5, y: 0.92, z,
        width: 3.0, height: 0.5, depth: 1.1,
      });
    }
    this.addInstancedBoxes('hudson-promenade-benches', benches, this.pierMaterial, true);
  }

  private buildNewJerseySkyline(): void {
    const buildings: BoxSpec[] = [];
    const windows: BoxSpec[] = [];
    const colours = [0x4b5960, 0x64737a, 0x777a78, 0x566a75, 0x83796d, 0x6c7478];
    const colourByBuilding: number[] = [];
    const randomUnit = (index: number, salt: number): number => {
      let value = Math.imul(index + 17, 0x45d9f3b) ^ Math.imul(salt + 71, 0x27d4eb2d);
      value ^= value >>> 16;
      return (value >>> 0) / 0x100000000;
    };

    let id = 0;
    for (let row = 0; row < 2; row++) {
      for (let index = 0; index < 42; index++) {
        const z = -2750 + index * 132 + (randomUnit(index, row + 4) - 0.5) * 45;
        const bank = getHudsonWestBankX(z);
        const width = 28 + randomUnit(index, 11 + row) * 48;
        const depth = 32 + randomUnit(index, 23 + row) * 54;
        const height = row === 0
          ? 46 + randomUnit(index, 31) * 176
          : 24 + randomUnit(index, 39) * 112;
        const x = bank - (70 + row * 165 + randomUnit(index, 47 + row) * 160);
        buildings.push({
          x, y: height * 0.5, z, width, height, depth,
          colour: colours[Math.floor(randomUnit(index, 59 + row) * colours.length)],
        } as BoxSpec);
        colourByBuilding.push((buildings[id].colour ?? colours[0]) as number);

        const floors = Math.max(3, Math.floor(height / 4.1));
        const windowColumns = Math.max(3, Math.floor(depth / 8));
        for (let floor = 1; floor < floors; floor += 2) {
          for (let col = 0; col < windowColumns; col++) {
            if (randomUnit(id * 97 + floor * 13 + col, 73) < 0.32) continue;
            const windowZ = z - depth * 0.5 + 4 + col * 7.5;
            windows.push({
              x: x + width * 0.5 + 0.06,
              y: floor * 3.8 + 1.2,
              z: windowZ,
              width: 0.12, height: 1.25, depth: 2.0,
            });
          }
        }
        id++;
      }
    }

    if (buildings.length > 0) {
      const mesh = new THREE.InstancedMesh(this.boxGeometry, this.skylineMaterial, buildings.length);
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      for (let i = 0; i < buildings.length; i++) {
        const item = buildings[i];
        position.set(item.x, item.y, item.z);
        scale.set(item.width, item.height, item.depth);
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(i, matrix);
        mesh.setColorAt(i, new THREE.Color(colourByBuilding[i]));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.name = 'distant-new-jersey-skyline-massing';
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.root.add(mesh);
    }

    if (windows.length > 0) {
      const mesh = new THREE.InstancedMesh(this.boxGeometry, this.windowMaterial, windows.length);
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      for (let i = 0; i < windows.length; i++) {
        const item = windows[i];
        position.set(item.x, item.y, item.z);
        scale.set(item.width, item.height, item.depth);
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(i, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.name = 'distant-new-jersey-skyline-windows';
      mesh.frustumCulled = false;
      this.root.add(mesh);
    }
  }

  private addInstancedBoxes(
    name: string,
    specs: BoxSpec[],
    material: THREE.Material,
    collidable: boolean,
  ): void {
    if (specs.length === 0) return;
    const mesh = new THREE.InstancedMesh(this.boxGeometry, material, specs.length);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      position.set(spec.x, spec.y, spec.z);
      rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spec.rotationY ?? 0);
      scale.set(spec.width, spec.height, spec.depth);
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(i, matrix);
      if (spec.colour !== undefined && mesh.setColorAt) mesh.setColorAt(i, new THREE.Color(spec.colour));
      if (collidable) {
        this.physics.createCollider(
          RAPIER.ColliderDesc.cuboid(spec.width * 0.5, spec.height * 0.5, spec.depth * 0.5)
            .setTranslation(spec.x, spec.y, spec.z)
            .setFriction(0.82)
            .setRestitution(0),
          this.body,
        );
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.root.add(mesh);
  }
}

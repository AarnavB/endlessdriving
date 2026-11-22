import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

interface TrafficVehicle {
  body: RAPIER.RigidBody;
  visual: THREE.Group;
  laneX: number;
  direction: 1 | -1;
  speed: number;
  z: number;
  sequence: number;
}

/**
 * A small fixed pool of kinematic traffic vehicles.
 *
 * Traffic uses the main north/south avenue lanes. Vehicles are recycled ahead
 * of the player instead of allocating meshes and colliders indefinitely, so
 * the scene remains bounded during long drives.
 */
export class TrafficSystem {
  private readonly vehicles: TrafficVehicle[] = [];
  private readonly nextPosition = { x: 0, y: 0.49, z: 0 };
  private readonly chassisGeometry = new THREE.BoxGeometry(1.72, 0.52, 3.55);
  private readonly roofGeometry = new THREE.BoxGeometry(1.38, 0.52, 1.82);
  private readonly wheelGeometry = new THREE.CylinderGeometry(0.31, 0.31, 0.22, 10);
  private readonly glassGeometry = new THREE.BoxGeometry(1.31, 0.37, 1.68);
  private readonly wheelMaterial = new THREE.MeshStandardMaterial({
    color: 0x11161b,
    roughness: 0.88,
    metalness: 0.12,
  });
  private readonly glassMaterial = new THREE.MeshStandardMaterial({
    color: 0x263c4a,
    roughness: 0.28,
    metalness: 0.42,
  });
  private readonly roofMaterial = new THREE.MeshStandardMaterial({
    color: 0x17212a,
    roughness: 0.58,
    metalness: 0.18,
  });
  private readonly bodyMaterials = [
    0x42616b, 0x9a4d37, 0x6c7480, 0xc0b59e, 0x315b4d, 0x8b3940,
  ].map((color) => new THREE.MeshStandardMaterial({
    color,
    roughness: 0.62,
    metalness: 0.2,
  }));

  constructor(
    private readonly world: RAPIER.World,
    private readonly scene: THREE.Scene,
    private readonly startZ: number,
  ) {
    this.createPool();
  }

  update(dt: number, playerPosition: THREE.Vector3): void {
    const safeDt = Math.max(0, Math.min(dt, 1 / 30));
    for (const vehicle of this.vehicles) {
      vehicle.z += vehicle.direction * vehicle.speed * safeDt;

      const relativeAhead = vehicle.z - playerPosition.z;
      if (relativeAhead < -52 || relativeAhead > 245) {
        // A fixed slot is reintroduced at a safe distance rather than popping
        // into the immediate braking/collision zone in front of the player.
        vehicle.z = playerPosition.z + 82 + vehicle.sequence * 48;
      }

      this.nextPosition.x = vehicle.laneX;
      this.nextPosition.z = vehicle.z;
      vehicle.body.setNextKinematicTranslation(this.nextPosition);
    }
  }

  syncVisuals(): void {
    for (const vehicle of this.vehicles) {
      const position = vehicle.body.translation();
      const rotation = vehicle.body.rotation();
      vehicle.visual.position.set(position.x, position.y, position.z);
      vehicle.visual.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    }
  }

  dispose(): void {
    for (const vehicle of this.vehicles) {
      this.scene.remove(vehicle.visual);
      this.world.removeRigidBody(vehicle.body);
    }
    this.vehicles.length = 0;
    this.chassisGeometry.dispose();
    this.roofGeometry.dispose();
    this.wheelGeometry.dispose();
    this.glassGeometry.dispose();
    this.wheelMaterial.dispose();
    this.glassMaterial.dispose();
    this.roofMaterial.dispose();
    for (const material of this.bodyMaterials) material.dispose();
  }

  private createPool(): void {
    // Three vehicles in each direction, distributed along the player's route.
    for (let index = 0; index < 6; index++) {
      const sequence = Math.floor(index / 2);
      const direction: 1 | -1 = index % 2 === 0 ? 1 : -1;
      const laneX = direction === 1 ? -4.2 : 4.2;
      const z = this.startZ + 78 + sequence * 52;
      const yaw = direction === 1 ? 0 : Math.PI;
      const halfYaw = yaw / 2;

      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(laneX, 0.49, z)
          .setRotation({ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) })
          .setCanSleep(false),
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.82, 0.38, 1.78)
          .setFriction(0.16)
          .setRestitution(0.06),
        body,
      );

      const visual = this.createVehicleVisual(this.bodyMaterials[index]);
      visual.position.set(laneX, 0.49, z);
      visual.rotation.y = yaw;
      this.scene.add(visual);

      this.vehicles.push({
        body,
        visual,
        laneX,
        direction,
        speed: direction === 1 ? 12 + sequence * 1.2 : 15 + sequence * 1.4,
        z,
        sequence,
      });
    }
  }

  private createVehicleVisual(bodyMaterial: THREE.Material): THREE.Group {
    const root = new THREE.Group();
    const chassis = new THREE.Mesh(this.chassisGeometry, bodyMaterial);
    chassis.position.y = -0.02;
    const roof = new THREE.Mesh(this.roofGeometry, this.roofMaterial);
    roof.position.set(0, 0.43, -0.05);
    const glass = new THREE.Mesh(this.glassGeometry, this.glassMaterial);
    glass.position.set(0, 0.45, -0.05);

    root.add(chassis, roof, glass);
    for (const x of [-0.83, 0.83]) {
      for (const z of [-1.13, 1.13]) {
        const wheel = new THREE.Mesh(this.wheelGeometry, this.wheelMaterial);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(x, -0.19, z);
        root.add(wheel);
      }
    }
    root.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = false;
        object.receiveShadow = false;
      }
    });
    return root;
  }
}

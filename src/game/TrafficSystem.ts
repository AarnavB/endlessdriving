import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoadPath, ROAD_LANE_OFFSETS } from '../world/RoadPath';

interface TrafficVehicle {
  body: RAPIER.RigidBody;
  visual: THREE.Group;
  laneOffset: number;
  direction: 1 | -1;
  speed: number;
  distance: number;
  sequence: number;
}

/**
 * Fixed-size traffic pool. Vehicles store a scalar road distance and lateral
 * lane offset, then sample the shared RoadPath every physics tick. No traffic
 * object owns a private straight-road coordinate system or grows with play time.
 */
export class TrafficSystem {
  private readonly vehicles: TrafficVehicle[] = [];
  private readonly originOffset = new THREE.Vector3();
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
    private readonly path: RoadPath,
    startDistance: number,
  ) {
    this.createPool(startDistance);
  }

  update(dt: number, playerPosition: THREE.Vector3): void {
    const safeDt = Math.max(0, Math.min(dt, 1 / 30));
    const playerDistance = this.path.getDistanceAtWorldZ(playerPosition.z + this.originOffset.z);

    for (const vehicle of this.vehicles) {
      vehicle.distance += vehicle.direction * vehicle.speed * safeDt;

      const distanceAhead = vehicle.distance - playerDistance;
      if (distanceAhead < -58 || distanceAhead > 285) {
        // Recycle outside the immediate collision/braking zone.
        vehicle.distance = playerDistance + 105 + vehicle.sequence * 48;
      }

      const sample = this.path.sample(vehicle.distance);
      const position = sample.position.clone().addScaledVector(sample.right, vehicle.laneOffset).sub(this.originOffset);
      this.nextPosition.x = position.x;
      this.nextPosition.y = position.y + 0.49;
      this.nextPosition.z = position.z;
      vehicle.body.setNextKinematicTranslation(this.nextPosition);

      const yaw = Math.atan2(sample.tangent.x, sample.tangent.z)
        + (vehicle.direction < 0 ? Math.PI : 0);
      const halfYaw = yaw / 2;
      vehicle.body.setNextKinematicRotation({
        x: 0,
        y: Math.sin(halfYaw),
        z: 0,
        w: Math.cos(halfYaw),
      });
    }
  }

  /** Reposition the fixed pool after a full session restart. */
  reset(playerDistance: number): void {
    for (const vehicle of this.vehicles) {
      vehicle.distance = playerDistance + 105 + vehicle.sequence * 48;
      const sample = this.path.sample(vehicle.distance);
      const position = sample.position.clone().addScaledVector(sample.right, vehicle.laneOffset).sub(this.originOffset);
      const yaw = Math.atan2(sample.tangent.x, sample.tangent.z)
        + (vehicle.direction < 0 ? Math.PI : 0);
      const halfYaw = yaw / 2;
      const rotation = { x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) };
      vehicle.body.setTranslation({
        x: position.x,
        y: position.y + 0.49,
        z: position.z,
      }, true);
      vehicle.body.setRotation(rotation, true);
      vehicle.visual.position.set(position.x, position.y + 0.49, position.z);
      vehicle.visual.rotation.y = yaw;
    }
  }

  /** Keep the pooled traffic bodies near the physics origin on long drives. */
  rebase(delta: THREE.Vector3): void {
    if (delta.lengthSq() === 0) return;
    this.originOffset.add(delta);
    for (const vehicle of this.vehicles) {
      const position = vehicle.body.translation();
      vehicle.body.setTranslation({
        x: position.x - delta.x,
        y: position.y - delta.y,
        z: position.z - delta.z,
      }, true);
      vehicle.visual.position.sub(delta);
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

  private createPool(startDistance: number): void {
    // Three vehicles per direction across the two lanes of each carriageway.
    for (let index = 0; index < 6; index++) {
      const sequence = Math.floor(index / 2);
      const direction: 1 | -1 = index % 2 === 0 ? 1 : -1;
      const laneOffset = direction === 1
        ? (sequence % 2 === 0 ? ROAD_LANE_OFFSETS[0] : ROAD_LANE_OFFSETS[1])
        : (sequence % 2 === 0 ? ROAD_LANE_OFFSETS[2] : ROAD_LANE_OFFSETS[3]);
      const distance = startDistance + 105 + sequence * 48;
      const sample = this.path.sample(distance);
      const position = sample.position.clone().addScaledVector(sample.right, laneOffset).sub(this.originOffset);
      const yaw = Math.atan2(sample.tangent.x, sample.tangent.z)
        + (direction < 0 ? Math.PI : 0);
      const halfYaw = yaw / 2;

      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(position.x, position.y + 0.49, position.z)
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
      visual.position.set(position.x, position.y + 0.49, position.z);
      visual.rotation.y = yaw;
      this.scene.add(visual);

      this.vehicles.push({
        body,
        visual,
        laneOffset,
        direction,
        speed: direction === 1 ? 12 + sequence * 1.2 : 15 + sequence * 1.4,
        distance,
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

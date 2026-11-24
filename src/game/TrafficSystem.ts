import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  CITY_BLOCK_SPACING_M,
  CityRoadGraph,
  CityTrafficController,
} from '../world/nyc/CityRoadGraph';
import type { CityLanePose, CityRoadAxis, CityRoadEdge } from '../world/nyc/CityRoadGraph';

interface TrafficVehicle {
  id: string;
  body: RAPIER.RigidBody;
  visual: THREE.Group;
  edge: CityRoadEdge;
  nextEdge: CityRoadEdge | null;
  laneIndex: number;
  progress: number;
  speed: number;
  seed: number;
  waitingAt: string | null;
  stoppedSeconds: number;
  turnCount: number;
  transitionFrom: { x: number; y: number; z: number } | null;
  transitionYaw: number;
}

interface TrafficSignalLamps {
  red: THREE.MeshStandardMaterial;
  amber: THREE.MeshStandardMaterial;
  green: THREE.MeshStandardMaterial;
}

interface TrafficSignalApproach {
  axis: CityRoadAxis;
  direction: 1 | -1;
  lamps: TrafficSignalLamps;
  arrowMaterial: THREE.MeshStandardMaterial;
}

interface TrafficSignalAssembly {
  intersectionId: string;
  root: THREE.Group;
  approaches: TrafficSignalApproach[];
}

const POOL_SIZE = 10;
const VEHICLE_LENGTH_M = 3.55;
const STOP_LINE_M = 8.5;
const TURN_BLEND_M = 17;

function moveTowards(value: number, target: number, delta: number): number {
  if (Math.abs(target - value) <= delta) return target;
  return value + Math.sign(target - value) * delta;
}
function smoothstep(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}
function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/** Fixed-size AI pool following graph edges, lanes and protected signal phases. */
export class TrafficSystem {
  private readonly vehicles: TrafficVehicle[] = [];
  private readonly controller: CityTrafficController;
  private readonly originOffset = new THREE.Vector3();
  private readonly signalAssemblies: TrafficSignalAssembly[] = [];
  private signalCentreKey: string | null = null;
  private readonly signalPoleGeometry = new THREE.CylinderGeometry(0.075, 0.11, 5.1, 8);
  private readonly signalHeadGeometry = new THREE.BoxGeometry(0.56, 1.9, 0.46);
  private readonly signalLensGeometry = new THREE.SphereGeometry(0.145, 12, 8);
  private readonly signalArrowGeometry = this.createSignalArrowGeometry();
  private readonly signalPoleMaterial = new THREE.MeshStandardMaterial({
    color: 0x38434a, metalness: 0.78, roughness: 0.42,
  });
  private readonly signalHousingMaterial = new THREE.MeshStandardMaterial({
    color: 0x10161c, metalness: 0.12, roughness: 0.72,
  });
  private readonly nextTranslation = { x: 0, y: 0.49, z: 0 };
  private readonly chassisGeometry = new THREE.BoxGeometry(1.72, 0.52, VEHICLE_LENGTH_M);
  private readonly roofGeometry = new THREE.BoxGeometry(1.38, 0.52, 1.82);
  private readonly wheelGeometry = new THREE.CylinderGeometry(0.31, 0.31, 0.22, 10);
  private readonly glassGeometry = new THREE.BoxGeometry(1.31, 0.37, 1.68);
  private readonly wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x11161b, roughness: 0.88 });
  private readonly glassMaterial = new THREE.MeshStandardMaterial({ color: 0x263c4a, roughness: 0.28, metalness: 0.4 });
  private readonly roofMaterial = new THREE.MeshStandardMaterial({ color: 0x17212a, roughness: 0.58, metalness: 0.18 });
  private readonly bodyMaterials = [
    0x42616b, 0x9a4d37, 0x6c7480, 0xc0b59e, 0x315b4d,
    0x8b3940, 0x7b6c50, 0x40566e, 0x9b9b91, 0x6b554e,
  ].map((colour) => new THREE.MeshStandardMaterial({ color: colour, roughness: 0.62, metalness: 0.2 }));

  constructor(
    private readonly world: RAPIER.World,
    private readonly scene: THREE.Scene,
    private readonly graph: CityRoadGraph,
    playerSpawn: THREE.Vector3,
  ) {
    this.controller = new CityTrafficController(graph);
    this.createPool(playerSpawn);
    this.updateSignalInfrastructure(playerSpawn);
  }

  update(dt: number, playerPosition: THREE.Vector3): void {
    const safeDt = Math.max(0, Math.min(dt, 1 / 30));
    this.controller.advance(safeDt);
    this.updateSignalInfrastructure(playerPosition);
    for (const vehicle of this.vehicles) this.updateVehicle(vehicle, safeDt);
  }

  reset(playerPosition: THREE.Vector3): void {
    this.controller.reset();
    const baseX = Math.round((playerPosition.x + this.originOffset.x) / CITY_BLOCK_SPACING_M);
    const baseZ = Math.round((playerPosition.z + this.originOffset.z) / CITY_BLOCK_SPACING_M);
    const offsets = [
      [-1, -1], [1, -1], [-1, 1], [1, 1], [0, -2],
      [0, 2], [-2, 0], [2, 0], [-2, -2], [2, 2],
    ];
    for (let i = 0; i < this.vehicles.length; i++) {
      const vehicle = this.vehicles[i];
      const [dx, dz] = offsets[i % offsets.length];
      const nodeId = this.graph.getIntersectionId(baseX + dx, baseZ + dz);
      const edges = this.graph.getOutgoingEdges(nodeId);
      if (edges.length === 0) continue;
      vehicle.edge = edges[(i * 3 + vehicle.seed) % edges.length];
      vehicle.nextEdge = null;
      vehicle.laneIndex = i % this.graph.getSegment(vehicle.edge.segmentId).profile.lanesPerDirection;
      vehicle.progress = 30 + (i % 3) * 9;
      vehicle.speed = 0;
      vehicle.waitingAt = null;
      vehicle.stoppedSeconds = 0;
      vehicle.turnCount = 0;
      vehicle.transitionFrom = null;
      this.placeVehicle(vehicle);
    }
    this.updateSignalInfrastructure(playerPosition);
  }

  rebase(delta: THREE.Vector3): void {
    if (delta.lengthSq() === 0) return;
    this.originOffset.add(delta);
    for (const vehicle of this.vehicles) {
      const p = vehicle.body.translation();
      vehicle.body.setTranslation({ x: p.x - delta.x, y: p.y - delta.y, z: p.z - delta.z }, true);
      vehicle.visual.position.sub(delta);
    }
    for (const signal of this.signalAssemblies) signal.root.position.sub(delta);
  }

  syncVisuals(): void {
    for (const vehicle of this.vehicles) {
      const p = vehicle.body.translation();
      const q = vehicle.body.rotation();
      vehicle.visual.position.set(p.x, p.y, p.z);
      vehicle.visual.quaternion.set(q.x, q.y, q.z, q.w);
    }
  }

  getDiagnostics(): { activeVehicles: number; queuedVehicles: number; signalClockSeconds: number } {
    return {
      activeVehicles: this.vehicles.length,
      queuedVehicles: this.vehicles.filter((vehicle) => vehicle.waitingAt !== null).length,
      signalClockSeconds: this.controller.getElapsedSeconds(),
    };
  }

  dispose(): void {
    for (const vehicle of this.vehicles) {
      this.scene.remove(vehicle.visual);
      this.world.removeRigidBody(vehicle.body);
    }
    this.vehicles.length = 0;
    this.clearSignalInfrastructure();
    this.signalPoleGeometry.dispose();
    this.signalHeadGeometry.dispose();
    this.signalLensGeometry.dispose();
    this.signalArrowGeometry.dispose();
    this.signalPoleMaterial.dispose();
    this.signalHousingMaterial.dispose();
    this.chassisGeometry.dispose();
    this.roofGeometry.dispose();
    this.wheelGeometry.dispose();
    this.glassGeometry.dispose();
    this.wheelMaterial.dispose();
    this.glassMaterial.dispose();
    this.roofMaterial.dispose();
    for (const material of this.bodyMaterials) material.dispose();
  }

  private createSignalArrowGeometry(): THREE.BufferGeometry {
    const shape = new THREE.Shape();
    shape.moveTo(-0.23, 0);
    shape.lineTo(-0.035, 0.19);
    shape.lineTo(-0.035, 0.075);
    shape.lineTo(0.23, 0.075);
    shape.lineTo(0.23, -0.075);
    shape.lineTo(-0.035, -0.075);
    shape.lineTo(-0.035, -0.19);
    shape.closePath();
    return new THREE.ShapeGeometry(shape);
  }

  private createSignalLamps(): TrafficSignalLamps {
    const create = (colour: number): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({
      color: colour,
      emissive: colour,
      emissiveIntensity: 0.025,
      roughness: 0.32,
      metalness: 0.02,
    });
    return {
      red: create(0xff3028),
      amber: create(0xffa521),
      green: create(0x35ef74),
    };
  }

  private createSignalArrowMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color: 0x35ef74,
      emissive: 0x35ef74,
      emissiveIntensity: 0.025,
      roughness: 0.32,
      metalness: 0.02,
    });
  }

  private setSignalLamps(lamps: TrafficSignalLamps, state: 'red' | 'yellow' | 'green'): void {
    lamps.red.emissiveIntensity = state === 'red' ? 2.2 : 0.025;
    lamps.amber.emissiveIntensity = state === 'yellow' ? 2.0 : 0.025;
    lamps.green.emissiveIntensity = state === 'green' ? 2.2 : 0.025;
  }

  private createSignalHead(
    root: THREE.Group,
    x: number,
    z: number,
    yaw: number,
    approach: TrafficSignalApproach,
  ): void {
    const pole = new THREE.Mesh(this.signalPoleGeometry, this.signalPoleMaterial);
    pole.position.set(x, 2.55, z);
    pole.castShadow = false;
    pole.receiveShadow = false;

    const head = new THREE.Group();
    head.position.set(x, 4.88, z);
    head.rotation.y = yaw;
    const housing = new THREE.Mesh(this.signalHeadGeometry, this.signalHousingMaterial);
    const red = new THREE.Mesh(this.signalLensGeometry, approach.lamps.red);
    const amber = new THREE.Mesh(this.signalLensGeometry, approach.lamps.amber);
    const green = new THREE.Mesh(this.signalLensGeometry, approach.lamps.green);
    red.position.set(0, 0.58, 0.245);
    amber.position.set(0, 0.02, 0.245);
    green.position.set(0, -0.54, 0.245);
    const arrow = new THREE.Mesh(this.signalArrowGeometry, approach.arrowMaterial);
    arrow.position.set(0, -0.79, 0.245);
    head.add(housing, red, amber, green, arrow);
    root.add(pole, head);
  }

  private createSignalAssembly(gridX: number, gridZ: number): TrafficSignalAssembly {
    const intersectionId = this.graph.getIntersectionId(gridX, gridZ);
    const root = new THREE.Group();
    root.name = 'traffic-signals-' + intersectionId;
    root.position.set(
      gridX * CITY_BLOCK_SPACING_M - this.originOffset.x,
      -this.originOffset.y,
      gridZ * CITY_BLOCK_SPACING_M - this.originOffset.z,
    );

    const verticalHalf = this.graph.getRoadProfile('z', gridX).widthM * 0.5;
    const horizontalHalf = this.graph.getRoadProfile('x', gridZ).widthM * 0.5;
    const northSouthLamps = this.createSignalLamps();
    const eastWestLamps = this.createSignalLamps();
    const approaches: TrafficSignalApproach[] = [
      { axis: 'z', direction: 1, lamps: northSouthLamps, arrowMaterial: this.createSignalArrowMaterial() },
      { axis: 'z', direction: -1, lamps: northSouthLamps, arrowMaterial: this.createSignalArrowMaterial() },
      { axis: 'x', direction: 1, lamps: eastWestLamps, arrowMaterial: this.createSignalArrowMaterial() },
      { axis: 'x', direction: -1, lamps: eastWestLamps, arrowMaterial: this.createSignalArrowMaterial() },
    ];

    this.createSignalHead(root, verticalHalf + 1.35, -horizontalHalf - 4.2, Math.PI, approaches[0]);
    this.createSignalHead(root, -verticalHalf - 1.35, horizontalHalf + 4.2, 0, approaches[1]);
    this.createSignalHead(root, -verticalHalf - 4.2, -horizontalHalf - 1.35, -Math.PI * 0.5, approaches[2]);
    this.createSignalHead(root, verticalHalf + 4.2, horizontalHalf + 1.35, Math.PI * 0.5, approaches[3]);
    this.scene.add(root);
    return { intersectionId, root, approaches };
  }

  private updateSignalInfrastructure(playerPosition: THREE.Vector3): void {
    const gridX = Math.round((playerPosition.x + this.originOffset.x) / CITY_BLOCK_SPACING_M);
    const gridZ = Math.round((playerPosition.z + this.originOffset.z) / CITY_BLOCK_SPACING_M);
    const centreKey = gridX + ':' + gridZ;
    if (this.signalCentreKey !== centreKey) {
      this.clearSignalInfrastructure();
      this.signalCentreKey = centreKey;
      for (let x = gridX - 1; x <= gridX + 1; x++) {
        for (let z = gridZ - 1; z <= gridZ + 1; z++) {
          this.signalAssemblies.push(this.createSignalAssembly(x, z));
        }
      }
    }

    for (const assembly of this.signalAssemblies) {
      for (const approach of assembly.approaches) {
        const axisState = this.controller.getSignalState(assembly.intersectionId, approach.axis);
        this.setSignalLamps(approach.lamps, axisState);
        const leftTurnState = this.controller.getProtectedLeftTurnState(
          assembly.intersectionId, approach.axis, approach.direction,
        );
        approach.arrowMaterial.emissiveIntensity = leftTurnState === 'green' ? 2.15 : 0.025;
      }
    }
  }

  private clearSignalInfrastructure(): void {
    for (const assembly of this.signalAssemblies) {
      this.scene.remove(assembly.root);
      assembly.root.clear();
      const uniqueLamps = new Set<THREE.Material>();
      for (const approach of assembly.approaches) {
        uniqueLamps.add(approach.arrowMaterial);
        uniqueLamps.add(approach.lamps.red);
        uniqueLamps.add(approach.lamps.amber);
        uniqueLamps.add(approach.lamps.green);
      }
      for (const material of uniqueLamps) material.dispose();
    }
    this.signalAssemblies.length = 0;
  }

  private createPool(playerSpawn: THREE.Vector3): void {
    const baseX = Math.round((playerSpawn.x + this.originOffset.x) / CITY_BLOCK_SPACING_M);
    const baseZ = Math.round((playerSpawn.z + this.originOffset.z) / CITY_BLOCK_SPACING_M);
    const offsets = [
      [-1, -1], [1, -1], [-1, 1], [1, 1], [0, -2],
      [0, 2], [-2, 0], [2, 0], [-2, -2], [2, 2],
    ];
    for (let index = 0; index < POOL_SIZE; index++) {
      const [dx, dz] = offsets[index];
      const nodeId = this.graph.getIntersectionId(baseX + dx, baseZ + dz);
      const outgoing = this.graph.getOutgoingEdges(nodeId);
      if (outgoing.length === 0) continue;
      const edge = outgoing[(index * 3 + 1) % outgoing.length];
      const laneIndex = index % this.graph.getSegment(edge.segmentId).profile.lanesPerDirection;
      const progress = 34 + (index % 3) * 8;
      this.vehicles.push(this.createVehicle(index, edge, laneIndex, progress));
    }
  }

  private createVehicle(
    index: number, edge: CityRoadEdge, laneIndex: number, progress: number,
  ): TrafficVehicle {
    const pose = this.graph.getLanePose(edge, laneIndex, progress);
    const x = pose.position.x - this.originOffset.x;
    const y = pose.position.y + 0.49 - this.originOffset.y;
    const z = pose.position.z - this.originOffset.z;
    const halfYaw = pose.yaw * 0.5;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(x, y, z)
      .setRotation({ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) })
      .setCanSleep(false));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.82, 0.38, 1.78)
      .setFriction(0.16).setRestitution(0.04), body);
    const visual = this.createVehicleVisual(this.bodyMaterials[index % this.bodyMaterials.length]);
    visual.position.set(x, y, z);
    visual.rotation.y = pose.yaw;
    this.scene.add(visual);
    return {
      id: 'city-traffic-' + index,
      body, visual, edge, nextEdge: null, laneIndex, progress,
      speed: 0, seed: index * 7919 + 17,
      waitingAt: null, stoppedSeconds: 0, turnCount: 0,
      transitionFrom: null, transitionYaw: pose.yaw,
    };
  }

  private updateVehicle(vehicle: TrafficVehicle, dt: number): void {
    const segment = this.graph.getSegment(vehicle.edge.segmentId);
    const remaining = segment.lengthM - vehicle.progress;
    const nextEdge = this.getNextEdge(vehicle);
    if (!nextEdge) {
      this.recoverVehicle(vehicle);
      return;
    }
    const signalAllowsEntry = this.controller.canEnterMovement(
      vehicle.edge.toNodeId, vehicle.edge, nextEdge,
    );
    let targetSpeed = segment.profile.speedLimitKmh / 3.6;

    if (!signalAllowsEntry && remaining < 30) {
      const distanceToStop = Math.max(0, remaining - STOP_LINE_M);
      targetSpeed = Math.min(targetSpeed, Math.sqrt(2 * 4.5 * distanceToStop));
      if (remaining <= STOP_LINE_M + 0.25) {
        targetSpeed = 0;
        this.controller.enqueue(vehicle.edge.toNodeId, vehicle.id);
        vehicle.waitingAt = vehicle.edge.toNodeId;
      }
    } else if (vehicle.waitingAt) {
      this.controller.dequeue(vehicle.waitingAt, vehicle.id);
      vehicle.waitingAt = null;
    }

    const leadGap = this.getLeadGap(vehicle);
    if (leadGap < 34) {
      const followSpeed = Math.sqrt(Math.max(0, 2 * 3.2 * (leadGap - VEHICLE_LENGTH_M - 1.8)));
      targetSpeed = Math.min(targetSpeed, followSpeed);
    }

    vehicle.speed = moveTowards(vehicle.speed, targetSpeed,
      (targetSpeed < vehicle.speed ? 5.8 : 2.0) * dt);
    vehicle.progress += vehicle.speed * dt;

    if (vehicle.speed < 0.18) vehicle.stoppedSeconds += dt;
    else vehicle.stoppedSeconds = 0;

    if (vehicle.progress >= segment.lengthM && signalAllowsEntry) {
      const overflow = vehicle.progress - segment.lengthM;
      if (vehicle.waitingAt) this.controller.dequeue(vehicle.waitingAt, vehicle.id);
      const endPose = this.graph.getLanePose(vehicle.edge, vehicle.laneIndex, segment.lengthM);
      vehicle.transitionFrom = { ...endPose.position };
      vehicle.transitionYaw = endPose.yaw;
      vehicle.edge = nextEdge;
      vehicle.progress = Math.min(overflow, this.graph.getSegment(nextEdge.segmentId).lengthM - 0.01);
      vehicle.laneIndex = Math.min(
        vehicle.laneIndex,
        this.graph.getSegment(nextEdge.segmentId).profile.lanesPerDirection - 1,
      );
      vehicle.nextEdge = null;
      vehicle.waitingAt = null;
      vehicle.turnCount++;
    } else if (!signalAllowsEntry && vehicle.progress > segment.lengthM - STOP_LINE_M) {
      vehicle.progress = segment.lengthM - STOP_LINE_M;
      vehicle.speed = Math.min(vehicle.speed, 0.25);
    }

    if (vehicle.stoppedSeconds > 65) this.recoverVehicle(vehicle);
    const pose = this.getVehiclePose(vehicle);
    this.nextTranslation.x = pose.position.x - this.originOffset.x;
    this.nextTranslation.y = pose.position.y + 0.49 - this.originOffset.y;
    this.nextTranslation.z = pose.position.z - this.originOffset.z;
    vehicle.body.setNextKinematicTranslation(this.nextTranslation);
    const halfYaw = pose.yaw * 0.5;
    vehicle.body.setNextKinematicRotation({
      x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw),
    });
  }

  private getVehiclePose(vehicle: TrafficVehicle): CityLanePose {
    const pose = this.graph.getLanePose(vehicle.edge, vehicle.laneIndex, vehicle.progress);
    if (!vehicle.transitionFrom || vehicle.progress >= TURN_BLEND_M) {
      vehicle.transitionFrom = null;
      return pose;
    }
    const t = smoothstep(vehicle.progress / TURN_BLEND_M);
    const from = vehicle.transitionFrom;
    return {
      ...pose,
      position: {
        x: THREE.MathUtils.lerp(from.x, pose.position.x, t),
        y: THREE.MathUtils.lerp(from.y, pose.position.y, t),
        z: THREE.MathUtils.lerp(from.z, pose.position.z, t),
      },
      yaw: vehicle.transitionYaw + angleDelta(vehicle.transitionYaw, pose.yaw) * t,
    };
  }

  private getNextEdge(vehicle: TrafficVehicle): CityRoadEdge | null {
    if (vehicle.nextEdge) return vehicle.nextEdge;
    vehicle.nextEdge = this.graph.chooseNextEdge(
      vehicle.edge.toNodeId, vehicle.edge.fromNodeId,
      vehicle.seed + vehicle.turnCount * 31,
    );
    return vehicle.nextEdge;
  }

  private getLeadGap(vehicle: TrafficVehicle): number {
    let nearest = Infinity;
    for (const other of this.vehicles) {
      if (other === vehicle
        || other.edge.segmentId !== vehicle.edge.segmentId
        || other.edge.direction !== vehicle.edge.direction
        || other.laneIndex !== vehicle.laneIndex) continue;
      const gap = other.progress - vehicle.progress;
      if (gap > 0 && gap < nearest) nearest = gap;
    }
    return nearest;
  }

  private recoverVehicle(vehicle: TrafficVehicle): void {
    if (vehicle.waitingAt) this.controller.dequeue(vehicle.waitingAt, vehicle.id);
    vehicle.waitingAt = null;
    vehicle.stoppedSeconds = 0;
    vehicle.speed = 0;
    const alternatives = this.graph.getOutgoingEdges(vehicle.edge.toNodeId)
      .filter((edge) => edge.toNodeId !== vehicle.edge.fromNodeId);
    if (alternatives.length > 0) {
      vehicle.nextEdge = alternatives[vehicle.seed % alternatives.length];
      vehicle.progress = Math.min(
        vehicle.progress,
        this.graph.getSegment(vehicle.edge.segmentId).lengthM - STOP_LINE_M,
      );
    } else {
      vehicle.progress = 12;
      vehicle.edge = this.graph.getOutgoingEdges(vehicle.edge.fromNodeId)[0] ?? vehicle.edge;
      vehicle.nextEdge = null;
    }
    vehicle.transitionFrom = null;
  }

  private placeVehicle(vehicle: TrafficVehicle): void {
    const pose = this.graph.getLanePose(vehicle.edge, vehicle.laneIndex, vehicle.progress);
    const x = pose.position.x - this.originOffset.x;
    const y = pose.position.y + 0.49 - this.originOffset.y;
    const z = pose.position.z - this.originOffset.z;
    const halfYaw = pose.yaw * 0.5;
    vehicle.body.setTranslation({ x, y, z }, true);
    vehicle.body.setRotation({ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) }, true);
    vehicle.visual.position.set(x, y, z);
    vehicle.visual.rotation.y = pose.yaw;
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
        wheel.rotation.z = Math.PI * 0.5;
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

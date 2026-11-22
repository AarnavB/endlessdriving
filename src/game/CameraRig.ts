import * as THREE from 'three';

export type CameraMode = 'chase' | 'close' | 'hood';

export class CameraRig {
  mode: CameraMode = 'chase';
  private readonly desiredPosition = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly forward = new THREE.Vector3(0, 0, 1);

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    camera.position.set(0, 4.8, -11);
  }

  cycle(): CameraMode {
    const modes: CameraMode[] = ['chase', 'close', 'hood'];
    this.mode = modes[(modes.indexOf(this.mode) + 1) % modes.length];
    return this.mode;
  }

  /** Snap on spawn/reset so the first gameplay frame never points away from the car. */
  snap(carPosition: THREE.Vector3, carForward: THREE.Vector3): void {
    this.calculatePose(carPosition, carForward);
    this.camera.position.copy(this.desiredPosition);
    this.camera.lookAt(this.lookTarget);
  }

  update(dt: number, carPosition: THREE.Vector3, carForward: THREE.Vector3): void {
    this.calculatePose(carPosition, carForward);
    const alpha = 1 - Math.exp(-5.5 * Math.max(0, Math.min(dt, 0.05)));
    this.camera.position.lerp(this.desiredPosition, alpha);
    this.camera.lookAt(this.lookTarget);
  }

  private calculatePose(carPosition: THREE.Vector3, carForward: THREE.Vector3): void {
    this.forward.copy(carForward).normalize();
    let distance = 9.2;
    let height = 3.7;
    let lookAhead = 5.5;

    if (this.mode === 'close') {
      distance = 5.6;
      height = 2.35;
      lookAhead = 6;
    } else if (this.mode === 'hood') {
      distance = -1.35;
      height = 1.3;
      lookAhead = 13;
    }

    this.desiredPosition.copy(carPosition).addScaledVector(this.forward, -distance);
    this.desiredPosition.y = carPosition.y + height;
    this.lookTarget.copy(carPosition).addScaledVector(this.forward, lookAhead);
    this.lookTarget.y = carPosition.y + (this.mode === 'hood' ? 1.15 : 0.8);
  }
}

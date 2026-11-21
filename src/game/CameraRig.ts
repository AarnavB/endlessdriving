import * as THREE from 'three';

export type CameraMode = 'chase' | 'close' | 'hood';

export class CameraRig {
  mode: CameraMode = 'chase';
  private readonly desiredPosition = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    camera.position.set(0, 5.4, -10.5);
  }

  cycle(): CameraMode {
    const modes: CameraMode[] = ['chase', 'close', 'hood'];
    this.mode = modes[(modes.indexOf(this.mode) + 1) % modes.length];
    return this.mode;
  }

  update(dt: number, carPosition: THREE.Vector3, carForward: THREE.Vector3): void {
    this.forward.copy(carForward).normalize();
    let distance = 10.5;
    let height = 4.4;
    let lookAhead = 4;
    if (this.mode === 'close') { distance = 6.5; height = 2.8; lookAhead = 4.5; }
    if (this.mode === 'hood') { distance = -1.25; height = 1.45; lookAhead = 12; }
    this.desiredPosition.copy(carPosition).addScaledVector(this.forward, -distance);
    this.desiredPosition.y = carPosition.y + height;
    this.lookTarget.copy(carPosition).addScaledVector(this.forward, lookAhead);
    this.lookTarget.y = carPosition.y + (this.mode === 'hood' ? 1.3 : 0.9);
    this.camera.position.lerp(this.desiredPosition, 1 - Math.exp(-4.2 * Math.min(dt, 0.05)));
    this.camera.lookAt(this.lookTarget);
  }
}

import * as THREE from 'three';
import { createSportsCarVisual } from './vehicleVisual';
import type { VehicleDefinition } from './VehicleDefinitions';

export class GaragePreview {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  private readonly vehicleRoot = new THREE.Group();
  private activeDefinition: VehicleDefinition | null = null;
  private dragging = false;
  private lastPointerX = 0;
  private autoRotate = true;
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'low-power',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.scene.add(this.vehicleRoot);
    this.scene.add(new THREE.HemisphereLight(0xe6f0ff, 0x29313a, 1.75));
    const key = new THREE.DirectionalLight(0xffe5d3, 2.3);
    key.position.set(5, 8, 6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xf08b55, 1.25);
    rim.position.set(-5, 3, -5);
    this.scene.add(rim);
    this.camera.position.set(5.8, 2.35, 7.2);
    this.camera.lookAt(0, 0.38, 0);
    this.scene.background = new THREE.Color(0x111820);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('dblclick', this.toggleRotation);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  setVehicle(definition: VehicleDefinition): void {
    if (this.activeDefinition?.id === definition.id) return;
    this.disposeVehicle();
    this.activeDefinition = definition;
    const parts = createSportsCarVisual(definition);
    this.vehicleRoot.add(parts.root);
    this.vehicleRoot.rotation.set(0, -0.38, 0);
  }

  setAutoRotate(enabled: boolean): void { this.autoRotate = enabled; }

  update(deltaSeconds: number, visible: boolean): void {
    if (!visible) return;
    if (this.autoRotate && !this.dragging) this.vehicleRoot.rotation.y += deltaSeconds * 0.16;
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('dblclick', this.toggleRotation);
    this.resizeObserver.disconnect();
    this.disposeVehicle();
    this.renderer.dispose();
  }

  private disposeVehicle(): void {
    for (const child of [...this.vehicleRoot.children]) {
      this.vehicleRoot.remove(child);
      child.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const mat of materials) mat.dispose();
        }
      });
    }
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.dragging = true;
    this.lastPointerX = event.clientX;
    this.canvas.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    const delta = event.clientX - this.lastPointerX;
    this.lastPointerX = event.clientX;
    this.vehicleRoot.rotation.y += delta * 0.009;
  };

  private onPointerUp = (): void => { this.dragging = false; };
  private toggleRotation = (): void => { this.autoRotate = !this.autoRotate; };
}

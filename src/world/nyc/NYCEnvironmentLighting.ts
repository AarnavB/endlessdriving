import * as THREE from 'three';

/**
 * Creates a compact procedural sky environment and prefilters it for PBR image-
 * based lighting. It is intentionally an IBL fill, not a substitute for direct sun.
 */
export class NYCEnvironmentLighting {
  private readonly renderTarget: THREE.WebGLRenderTarget;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable for the city environment map.');

    const sky = context.createLinearGradient(0, 0, 0, canvas.height);
    sky.addColorStop(0, '#263d54');
    sky.addColorStop(0.38, '#647f91');
    sky.addColorStop(0.67, '#acb8bd');
    sky.addColorStop(1, '#747e83');
    context.fillStyle = sky;
    context.fillRect(0, 0, canvas.width, canvas.height);

    // A broad, restrained sun-side glow creates directional colour in reflections
    // without relying on a hard painted sun disc or exaggerated bloom.
    const glowX = canvas.width * 0.72;
    const glowY = canvas.height * 0.31;
    const glow = context.createRadialGradient(glowX, glowY, 8, glowX, glowY, 190);
    glow.addColorStop(0, 'rgba(255, 235, 205, 0.48)');
    glow.addColorStop(0.22, 'rgba(255, 220, 184, 0.2)');
    glow.addColorStop(1, 'rgba(255, 220, 184, 0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const haze = context.createLinearGradient(0, 250, 0, 420);
    haze.addColorStop(0, 'rgba(210, 216, 214, 0)');
    haze.addColorStop(0.55, 'rgba(210, 216, 214, 0.18)');
    haze.addColorStop(1, 'rgba(137, 147, 148, 0.04)');
    context.fillStyle = haze;
    context.fillRect(0, 250, canvas.width, 170);

    const equirectangular = new THREE.CanvasTexture(canvas);
    equirectangular.mapping = THREE.EquirectangularReflectionMapping;
    equirectangular.colorSpace = THREE.SRGBColorSpace;
    equirectangular.wrapS = THREE.RepeatWrapping;
    equirectangular.needsUpdate = true;

    const generator = new THREE.PMREMGenerator(renderer);
    generator.compileEquirectangularShader();
    try {
      this.renderTarget = generator.fromEquirectangular(equirectangular);
    } finally {
      equirectangular.dispose();
      generator.dispose();
    }

    scene.environment = this.renderTarget.texture;
    scene.environmentIntensity = 0.58;
  }

  dispose(scene: THREE.Scene): void {
    if (scene.environment === this.renderTarget.texture) {
      scene.environment = null;
    }
    this.renderTarget.dispose();
  }
}

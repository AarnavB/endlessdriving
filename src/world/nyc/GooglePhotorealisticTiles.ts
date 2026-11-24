import * as THREE from 'three';
import type { WebGLRenderer } from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { NYC_ORIGIN, WGS84 } from './NYCGeo';

/**
 * Live Google Photorealistic 3D Tiles visualization only.
 * Google geometry is never used for collision, analysis, extraction, or persistence.
 */
export class GooglePhotorealisticTiles {
  private readonly tiles: TilesRenderer;
  private readonly attribution: HTMLDivElement;
  private lastAttribution = '';
  private disposed = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly renderer: WebGLRenderer,
    apiKey: string,
  ) {
    if (!apiKey.trim()) throw new Error('Google Maps Platform API key is empty.');

    this.tiles = new TilesRenderer();
    this.tiles.registerPlugin(new GoogleCloudAuthPlugin({
      apiToken: apiKey,
      autoRefreshToken: true,
      useRecommendedSettings: true,
    }));
    this.tiles.errorTarget = 18;
    this.tiles.loadAncestors = true;
    this.tiles.loadSiblings = true;
    this.tiles.group.applyMatrix4(this.createEcefToLocalMatrix());
    this.scene.add(this.tiles.group);
    this.tiles.setCamera(this.camera);
    this.tiles.setResolutionFromRenderer(this.camera, this.renderer);

    this.attribution = document.createElement('div');
    this.attribution.setAttribute('aria-label', 'Google Maps and 3D tile data attribution');
    this.attribution.setAttribute('translate', 'no');
    this.attribution.style.position = 'fixed';
    this.attribution.style.right = '12px';
    this.attribution.style.bottom = '9px';
    this.attribution.style.zIndex = '10000';
    this.attribution.style.maxWidth = '58vw';
    this.attribution.style.maxHeight = '24vh';
    this.attribution.style.overflowY = 'auto';
    this.attribution.style.whiteSpace = 'normal';
    this.attribution.style.padding = '7px 10px';
    this.attribution.style.borderRadius = '3px';
    this.attribution.style.background = 'rgba(0, 0, 0, 0.76)';
    this.attribution.style.color = '#fff';
    this.attribution.style.font = '11px/1.4 Arial, sans-serif';
    this.attribution.style.textAlign = 'right';
    this.attribution.style.pointerEvents = 'none';
    this.attribution.style.textShadow = '0 1px 1px #000';
    this.attribution.textContent = 'Google Maps';
    document.body.appendChild(this.attribution);
  }

  update(): void {
    if (this.disposed) return;
    try {
      this.camera.updateMatrixWorld();
      this.tiles.setCamera(this.camera);
      this.tiles.setResolutionFromRenderer(this.camera, this.renderer);
      this.tiles.update();
      this.updateAttribution();
    } catch (error) {
      console.error('Google Photorealistic 3D Tiles update failed:', error);
      this.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.tiles.group);
    this.tiles.dispose();
    this.attribution.remove();
  }

  private updateAttribution(): void {
    const attributions = this.tiles.getAttributions() as Array<{
      type?: string;
      value?: string;
    }>;
    // The renderer aggregates credits for tiles currently in view. Count each
    // provider occurrence and sort highest-frequency providers first, matching
    // the Map Tiles API attribution guidance.
    const occurrenceCounts = new Map<string, number>();
    for (const item of attributions) {
      if (typeof item.value !== 'string') continue;
      for (const value of item.value.split(';')) {
        const credit = value.trim();
        if (!credit) continue;
        occurrenceCounts.set(credit, (occurrenceCounts.get(credit) ?? 0) + 1);
      }
    }
    const sortedCredits = [...occurrenceCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([credit]) => credit);
    const nextText = sortedCredits.length > 0
      ? 'Google Maps  ·  Map data: ' + sortedCredits.join('; ')
      : 'Google Maps';
    if (nextText !== this.lastAttribution) {
      this.attribution.textContent = nextText;
      this.lastAttribution = nextText;
    }
  }

  /** Transform ECEF tile positions into the same local ENU frame as NYC data. */
  private createEcefToLocalMatrix(): THREE.Matrix4 {
    const latitude = NYC_ORIGIN.latitude * Math.PI / 180;
    const longitude = NYC_ORIGIN.longitude * Math.PI / 180;
    const altitude = NYC_ORIGIN.altitudeM ?? 0;
    const flattening = 1 / WGS84.inverseFlattening;
    const eccentricitySquared = flattening * (2 - flattening);
    const sinLatitude = Math.sin(latitude);
    const cosLatitude = Math.cos(latitude);
    const sinLongitude = Math.sin(longitude);
    const cosLongitude = Math.cos(longitude);
    const primeVerticalRadius = WGS84.semiMajorAxisM
      / Math.sqrt(1 - eccentricitySquared * sinLatitude * sinLatitude);

    const originX = (primeVerticalRadius + altitude) * cosLatitude * cosLongitude;
    const originY = (primeVerticalRadius + altitude) * cosLatitude * sinLongitude;
    const originZ = (primeVerticalRadius * (1 - eccentricitySquared) + altitude) * sinLatitude;

    const eastX = -sinLongitude;
    const eastY = cosLongitude;
    const eastZ = 0;
    const upX = cosLatitude * cosLongitude;
    const upY = cosLatitude * sinLongitude;
    const upZ = sinLatitude;
    const northX = -sinLatitude * cosLongitude;
    const northY = -sinLatitude * sinLongitude;
    const northZ = cosLatitude;

    return new THREE.Matrix4().set(
      eastX, eastY, eastZ, -(eastX * originX + eastY * originY + eastZ * originZ),
      upX, upY, upZ, -(upX * originX + upY * originY + upZ * originZ),
      northX, northY, northZ, -(northX * originX + northY * originY + northZ * originZ),
      0, 0, 0, 1,
    );
  }
}

import type { VehicleDebugTelemetry } from '../types';

export class PhysicsDebugOverlay {
  private readonly panel: HTMLElement;
  private readonly output: HTMLElement;

  constructor(root: HTMLElement) {
    this.panel = document.createElement('aside');
    this.panel.id = 'physics-debug-overlay';
    this.panel.style.cssText = [
      'position:absolute',
      'z-index:35',
      'top:285px',
      'left:42px',
      'width:min(390px,calc(100vw - 32px))',
      'max-height:38vh',
      'overflow:auto',
      'padding:14px 16px',
      'border:1px solid rgba(255,138,76,.45)',
      'background:rgba(7,12,18,.92)',
      'box-shadow:0 12px 36px rgba(0,0,0,.35)',
      'backdrop-filter:blur(14px)',
      'color:#e9eef2',
      'font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace',
      'pointer-events:none',
      'display:none',
    ].join(';');
    this.panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:9px;color:#ff9a64;font-size:10px;font-weight:800;letter-spacing:1.5px">
        <span>PHYSICS TELEMETRY</span><span style="color:#a8b2bb">F3 TO TOGGLE</span>
      </div>
      <pre data-debug-output style="margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:#d7e0e6"></pre>
    `;
    root.append(this.panel);
    const output = this.panel.querySelector<HTMLElement>('[data-debug-output]');
    if (!output) throw new Error('Physics debug overlay failed to initialise.');
    this.output = output;
  }

  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
  }

  update(data: VehicleDebugTelemetry, cameraMode: string, cameraDistance: number): void {
    const number = (value: number): string => Number.isFinite(value) ? value.toFixed(2) : 'n/a';
    this.output.textContent = [
      `INPUT     throttle ${number(data.throttle)}  brake ${number(data.brake)}  steer ${number(data.steer)}`,
      `FORCE     forward ${number(data.appliedForwardForce)} N`,
      `VELOCITY  x ${number(data.velocityX)}  y ${number(data.velocityY)}  z ${number(data.velocityZ)} m/s`,
      `FORWARD   ${number(data.forwardSpeed)} m/s`,
      `POSITION  x ${number(data.positionX)}  y ${number(data.positionY)}  z ${number(data.positionZ)} m`,
      `ENGINE    ${Math.round(data.rpm)} RPM  |  gear ${data.gear === 0 ? 'N' : data.gear}`,
      `PHYSICS   dt ${number(data.physicsTimestep)} s  |  steps/frame ${data.physicsStepsThisFrame}`,
      `BODY      sleeping: ${data.sleeping ? 'YES' : 'NO'}`,
      `RENDER    mesh sync error: ${number(data.meshSyncError)} m`,
      `CAMERA    ${cameraMode}  |  distance: ${number(cameraDistance)} m`,
    ].join(String.fromCharCode(10));
  }

  dispose(): void {
    this.panel.remove();
  }
}

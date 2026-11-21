import type { InputState } from '../types';

type GameAction = 'pause' | 'camera' | 'reset' | 'hud' | 'map' | 'interact' | 'transmission';

export class InputManager {
  private readonly keys = new Set<string>();
  private readonly justPressed = new Set<string>();
  private readonly actionHandlers = new Map<GameAction, () => void>();
  private focused = true;

  constructor(private readonly target: Window = window) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
    target.addEventListener('focus', this.onFocus);
  }

  on(action: GameAction, handler: () => void): void {
    this.actionHandlers.set(action, handler);
  }

  getState(): InputState {
    if (!this.focused) {
      return { throttle: 0, brake: 0, steer: 0, handbrake: false, shiftUpPressed: false, shiftDownPressed: false };
    }
    const throttle = this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0;
    const brake = this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0;
    const left = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const right = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    const steer = Number(right) - Number(left);
    return {
      throttle,
      brake,
      steer,
      handbrake: this.keys.has('Space'),
      shiftUpPressed: this.consume('KeyE'),
      shiftDownPressed: this.consume('KeyQ'),
    };
  }

  isDown(code: string): boolean { return this.keys.has(code); }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('focus', this.onFocus);
  }

  private consume(code: string): boolean {
    const pressed = this.justPressed.has(code);
    this.justPressed.delete(code);
    return pressed;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const blocked = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];
    if (blocked.includes(event.code)) event.preventDefault();
    if (!this.keys.has(event.code)) this.justPressed.add(event.code);
    this.keys.add(event.code);
    if (event.repeat) return;
    const actions: Record<string, GameAction> = {
      Escape: 'pause', KeyC: 'camera', KeyR: 'reset', KeyH: 'hud', KeyN: 'map', KeyM: 'transmission', Enter: 'interact',
    };
    const action = actions[event.code];
    if (action) this.actionHandlers.get(action)?.();
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private onBlur = (): void => { this.focused = false; this.keys.clear(); this.justPressed.clear(); };
  private onFocus = (): void => { this.focused = true; };
}

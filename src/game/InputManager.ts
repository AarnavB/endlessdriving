import type { InputState } from '../types';

type GameAction = 'pause' | 'camera' | 'reset' | 'hud' | 'interact' | 'transmission' | 'debug';

/**
 * Reverse the steering direction at the input boundary.
 * This applies equally to keyboard and gamepad input while leaving the
 * vehicle's steering geometry and physics conventions unchanged.
 */
export function invertSteeringDirection(steer: number): number {
  return -steer;
}

/**
 * Keyboard input is captured at document level (capture phase) so focus on a
 * menu button cannot prevent the game from receiving driving keys.
 * Edge-triggered keys are retained until a physics tick consumes them.
 */
export class InputManager {
  private readonly keys = new Set<string>();
  private readonly justPressed = new Set<string>();
  private readonly actionHandlers = new Map<GameAction, () => void>();

  constructor(private readonly target: Document = document) {
    target.addEventListener('keydown', this.onKeyDown, true);
    target.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);
  }

  on(action: GameAction, handler: () => void): void {
    this.actionHandlers.set(action, handler);
  }

  getState(): InputState {
    const keyboardSteer = Number(this.keys.has('KeyD') || this.keys.has('ArrowRight'))
      - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft'));
    let gamepadSteer = 0;
    if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
      const gamepad = Array.from(navigator.getGamepads()).find((candidate) => candidate?.connected);
      const axis = gamepad?.axes[0] ?? 0;
      const deadzone = 0.12;
      if (axis > deadzone) gamepadSteer = (axis - deadzone) / (1 - deadzone);
      else if (axis < -deadzone) gamepadSteer = (axis + deadzone) / (1 - deadzone);
    }
    return {
      throttle: this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0,
      brake: this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0,
      // Reverse the selected source once here so keyboard and gamepad agree.
      steer: invertSteeringDirection(Math.abs(gamepadSteer) > 0 ? gamepadSteer : keyboardSteer),
      handbrake: this.keys.has('Space'),
      neutralPressed: this.justPressed.has('KeyN'),
      clutchPedal: Number(this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')),
      shiftUpPressed: this.justPressed.has('KeyE'),
      shiftDownPressed: this.justPressed.has('KeyQ'),
    };
  }

  /** Clear one-shot gear input after a physics step has consumed it. */
  consumeEdges(): void {
    this.justPressed.delete('KeyE');
    this.justPressed.delete('KeyQ');
    this.justPressed.delete('KeyN');
  }

  /** Prevent a gear key pressed while paused from being applied after resume. */
  drainEdges(): void {
    this.consumeEdges();
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown, true);
    this.target.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    this.keys.clear();
    this.justPressed.clear();
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.isEditableTarget(event.target)) return;

    const handled = [
      'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Space', 'KeyE', 'KeyQ', 'KeyN', 'KeyC', 'KeyR', 'KeyH', 'KeyM', 'Escape', 'Enter', 'F3',
    ];
    if (handled.includes(event.code)) event.preventDefault();

    if (!this.keys.has(event.code) && (event.code === 'KeyE' || event.code === 'KeyQ' || event.code === 'KeyN')) {
      this.justPressed.add(event.code);
    }
    this.keys.add(event.code);
    if (event.repeat) return;

    const actions: Partial<Record<string, GameAction>> = {
      Escape: 'pause',
      KeyC: 'camera',
      KeyR: 'reset',
      KeyH: 'hud',
      KeyM: 'transmission',
      Enter: 'interact',
      F3: 'debug',
    };
    const action = actions[event.code];
    if (action) this.actionHandlers.get(action)?.();
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.justPressed.clear();
  };
}

import type { InputState } from '../types';

type GameAction = 'pause' | 'camera' | 'reset' | 'hud' | 'map' | 'interact' | 'transmission' | 'debug';

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
    return {
      throttle: this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0,
      brake: this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0,
      steer: Number(this.keys.has('KeyD') || this.keys.has('ArrowRight'))
        - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft')),
      handbrake: this.keys.has('Space'),
      shiftUpPressed: this.justPressed.has('KeyE'),
      shiftDownPressed: this.justPressed.has('KeyQ'),
    };
  }

  /** Clear one-shot gear input after a physics step has consumed it. */
  consumeEdges(): void {
    this.justPressed.delete('KeyE');
    this.justPressed.delete('KeyQ');
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
      'Space', 'KeyE', 'KeyQ', 'KeyC', 'KeyR', 'KeyH', 'KeyN', 'KeyM', 'Escape', 'Enter', 'F3',
    ];
    if (handled.includes(event.code)) event.preventDefault();

    if (!this.keys.has(event.code) && (event.code === 'KeyE' || event.code === 'KeyQ')) {
      this.justPressed.add(event.code);
    }
    this.keys.add(event.code);
    if (event.repeat) return;

    const actions: Partial<Record<string, GameAction>> = {
      Escape: 'pause',
      KeyC: 'camera',
      KeyR: 'reset',
      KeyH: 'hud',
      KeyN: 'map',
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

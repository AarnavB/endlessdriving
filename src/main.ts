import './styles.css';
import { Game } from './game/Game';
import { loadSettings } from './ui/UIController';

const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
const uiRoot = document.querySelector<HTMLElement>('#ui-root');

if (!canvas || !uiRoot) throw new Error('Game canvas or UI root is missing from index.html.');

const settings = loadSettings();

try {
  await Game.create(canvas, uiRoot, settings);
} catch (error) {
  console.error('Unable to initialize Endless Driving:', error);
  uiRoot.innerHTML = `
    <div class="absolute inset-0 grid place-items-center bg-[#080b10] p-8 text-center text-white">
      <div class="max-w-xl">
        <p class="mb-3 text-xs font-bold tracking-[.25em] text-orange-400">INITIALIZATION ERROR</p>
        <h1 class="mb-4 text-3xl font-black">THE ENGINE DIDN'T START.</h1>
        <p class="text-sm leading-7 text-slate-400">The browser could not initialize the 3D or physics runtime. Check that WebGL is enabled and reload the page.</p>
        <pre class="mt-5 overflow-auto rounded bg-slate-900 p-4 text-left text-xs text-orange-200">${String(error).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)}</pre>
      </div>
    </div>`;
}

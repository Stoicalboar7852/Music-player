import { AudioEngine } from './audio/engine';
import { createHarness } from './debug/harness';
import { Renderer } from './viz/renderer';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block;background:#000';
document.body.style.margin = '0';
const engine = new AudioEngine();
const renderer = new Renderer(canvas, engine);
renderer.setVisualizer(renderer.defs[0].id, { immediate: true });
renderer.start();

const input = document.createElement('input');
input.type = 'file';
input.id = 'file-input';
input.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2';
document.body.append(input);
input.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;
  engine.element.src = URL.createObjectURL(file);
  engine.element.loop = true;
  await engine.resume();
  await engine.element.play();
});

Object.assign(window, { __phosphor: { engine, renderer, harness: createHarness(renderer) } });

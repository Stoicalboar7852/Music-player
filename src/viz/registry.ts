// Every file in ./visualizers that default-exports a VisualizerDef is
// registered automatically. Adding a visualizer means adding one file.

import type { VisualizerDef } from './types';

const modules = import.meta.glob<{ default: VisualizerDef }>('./visualizers/*.ts', { eager: true });

export const visualizers: VisualizerDef[] = Object.values(modules)
  .map((m) => m.default)
  .filter((def): def is VisualizerDef => Boolean(def && def.id && def.create))
  .sort((a, b) => a.order - b.order);

export function findVisualizer(id: string): VisualizerDef | undefined {
  return visualizers.find((v) => v.id === id);
}

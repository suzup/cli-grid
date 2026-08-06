import { LAYOUT_PRESETS, type LayoutPreset } from './types.js';

/** Sentinel id for "pick a split that fits the number of agents". */
export const AUTO_LAYOUT = 'auto';

export function paneCount(preset: LayoutPreset): number {
  return preset.rows.reduce((a, b) => a + b, 0);
}

export function presetById(id: string): LayoutPreset | undefined {
  return LAYOUT_PRESETS.find((p) => p.id === id);
}

/** Smallest split that gives every agent its own pane. */
export function autoPreset(agents: number): LayoutPreset {
  const wanted = Math.max(1, agents);
  const fits = LAYOUT_PRESETS.find((preset) => paneCount(preset) >= wanted);
  return fits ?? LAYOUT_PRESETS[LAYOUT_PRESETS.length - 1] ?? LAYOUT_PRESETS[0]!;
}

export function resolveLayout(id: string | undefined, agents: number): LayoutPreset | undefined {
  if (!id) return undefined;
  return id === AUTO_LAYOUT ? autoPreset(agents) : presetById(id);
}

/** Pane a newly launched agent should open in, 1-based. */
export function columnFor(index: number, preset: LayoutPreset | undefined): number {
  if (!preset) return 1;
  return (index % paneCount(preset)) + 1;
}

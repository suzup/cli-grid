import type { LayoutPreset } from './types.js';

/** Sentinel id for "pick a split that fits the number of agents". */
export const AUTO_LAYOUT = 'auto';

/** Share of the editor area the file pane takes when it is up. */
export const FILE_PANE_SIZE = 0.35;

/** Ordered smallest first: `autoPreset` takes the first that fits. */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  { id: 'single', label: '1', detail: 'Single pane', rows: [1] },
  { id: 'grid-2x1', label: '2 × 1', detail: 'Two columns', rows: [2] },
  { id: 'grid-1x2', label: '1 × 2', detail: 'Two rows', rows: [1, 1] },
  { id: 'grid-3x1', label: '3 × 1', detail: 'Three columns', rows: [3] },
  { id: 'grid-2x2', label: '2 × 2', detail: 'Four panes', rows: [2, 2] },
  { id: 'grid-3x2', label: '3 × 2', detail: 'Six panes', rows: [3, 3] },
  { id: 'grid-4x2', label: '4 × 2', detail: 'Eight panes', rows: [4, 4] },
];

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

/* ------------------------------ group specs ------------------------------ */

export interface GroupSpec {
  groups?: GroupSpec[];
  size?: number;
}

export interface LayoutSpec {
  orientation: number;
  groups: GroupSpec[];
}

/**
 * `vscode.setEditorLayout` takes nested groups, and each level splits the
 * opposite way to the one above it. Orientation 0 splits with a horizontal
 * divider, so at the top level it means rows.
 */
export function toSpec(preset: LayoutPreset, filePane: boolean): LayoutSpec {
  if (!filePane) return { orientation: 0, groups: rowsOf(preset) };

  // One level up: columns, the grid in the first and the files in the second.
  // The grid's own rows and columns then fall out the same way as above.
  return {
    orientation: 1,
    groups: [
      { size: 1 - FILE_PANE_SIZE, groups: rowsOf(preset) },
      { size: FILE_PANE_SIZE },
    ],
  };
}

export function rowsOf(preset: LayoutPreset): GroupSpec[] {
  const rowSize = 1 / preset.rows.length;
  return preset.rows.map((columns) => ({
    size: rowSize,
    groups: Array.from({ length: columns }, () => ({ size: 1 / columns })),
  }));
}

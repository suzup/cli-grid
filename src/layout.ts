import * as vscode from 'vscode';
import { LAYOUT_PRESETS, type LayoutPreset } from './types.js';

/** Sentinel id for "pick a split that fits the number of agents". */
export const AUTO_LAYOUT = 'auto';

interface EditorGroupSpec {
  groups?: EditorGroupSpec[];
  size?: number;
}

/**
 * `vscode.setEditorLayout` takes nested groups. Orientation 0 splits with a
 * horizontal divider, so the top level is rows and each nested level is the
 * columns inside that row.
 */
function toSpec(preset: LayoutPreset): { orientation: number; groups: EditorGroupSpec[] } {
  const rowSize = 1 / preset.rows.length;
  return {
    orientation: 0,
    groups: preset.rows.map((columns) => ({
      size: rowSize,
      groups: Array.from({ length: columns }, () => ({ size: 1 / columns })),
    })),
  };
}

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

export async function applyLayout(preset: LayoutPreset): Promise<void> {
  await vscode.commands.executeCommand('vscode.setEditorLayout', toSpec(preset));
}

/**
 * Spreads terminals across the panes, wrapping into tabs once there are more
 * agents than panes — six agents in a 2 x 2 leaves two panes holding two tabs.
 *
 * VS Code removed the `moveEditorToNthGroup` commands in 1.25.1, so the target
 * group is reached by returning to the first group and stepping forward. That
 * walks the groups in order whatever the grid's geometry, which
 * `moveEditorToRightGroup` would not do across rows.
 *
 * Terminals are placed back to front so group one always still holds the first
 * terminal; an emptied group would collapse and take the layout with it.
 */
export async function arrange(
  terminals: readonly vscode.Terminal[],
  preset: LayoutPreset,
): Promise<void> {
  const panes = paneCount(preset);
  if (panes < 2 || terminals.length < 2) return;

  for (let index = terminals.length - 1; index >= 1; index--) {
    const terminal = terminals[index];
    if (!terminal) continue;

    const target = (index % panes) + 1;
    terminal.show(false);
    await vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup');
    for (let step = 1; step < target; step++) {
      await vscode.commands.executeCommand('workbench.action.moveEditorToNextGroup');
    }
  }

  terminals[0]?.show(false);
}

/** Pane a newly launched agent should open in, 1-based. */
export function columnFor(index: number, preset: LayoutPreset | undefined): number {
  if (!preset) return 1;
  return (index % paneCount(preset)) + 1;
}

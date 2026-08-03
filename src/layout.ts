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
 * Makes a terminal the active editor and waits until the workbench agrees.
 *
 * `show()` is fire-and-forget, so issuing a move command straight afterwards
 * races it and moves whatever was previously active — which is how a 2 x 2 ends
 * up as one column of stacked tabs.
 */
async function focusTerminal(terminal: vscode.Terminal): Promise<void> {
  if (vscode.window.activeTerminal === terminal) return;

  const activated = new Promise<void>((resolve) => {
    const timer = setTimeout(finish, 500);
    const sub = vscode.window.onDidChangeActiveTerminal((active) => {
      if (active === terminal) finish();
    });
    function finish() {
      clearTimeout(timer);
      sub.dispose();
      resolve();
    }
  });

  terminal.show(false);
  await activated;
}

/**
 * Moves the terminal into a given editor group, 1-based.
 *
 * The command is `moveActiveEditor` with no prefix — the `workbench.action.`
 * ones move the whole group instead. `moveEditorToNthGroup` was removed in
 * 1.25.1, so the fallback walks forward from the first group; that can invent a
 * group when there is no next one, which is why it is only a fallback.
 */
async function moveToGroup(terminal: vscode.Terminal, group: number): Promise<void> {
  await focusTerminal(terminal);

  try {
    await vscode.commands.executeCommand('moveActiveEditor', {
      to: 'position',
      by: 'group',
      value: group,
    });
    return;
  } catch {
    // Fall through to the older commands.
  }

  await vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup');
  for (let step = 1; step < group; step++) {
    await vscode.commands.executeCommand('workbench.action.moveEditorToNextGroup');
  }
}

/**
 * Puts one agent in each pane, wrapping into tabs once there are more agents
 * than panes — six agents in a 2 x 2 leaves two panes holding two tabs.
 *
 * Everything is gathered into the first group before the split is applied. A
 * group that loses its last editor closes, which would renumber the groups
 * underneath a half-finished arrangement.
 */
export async function arrangeInto(
  terminals: readonly vscode.Terminal[],
  preset: LayoutPreset,
): Promise<void> {
  const panes = paneCount(preset);

  for (const terminal of terminals) await moveToGroup(terminal, 1);
  await applyLayout(preset);
  if (panes < 2 || terminals.length < 2) return;

  // Back to front, so the first group is never emptied mid-way.
  for (let index = terminals.length - 1; index >= 1; index--) {
    const terminal = terminals[index];
    if (terminal) await moveToGroup(terminal, (index % panes) + 1);
  }

  await focusTerminal(terminals[0] as vscode.Terminal);
}

/** Pane a newly launched agent should open in, 1-based. */
export function columnFor(index: number, preset: LayoutPreset | undefined): number {
  if (!preset) return 1;
  return (index % paneCount(preset)) + 1;
}

import * as vscode from 'vscode';
import { paneCount } from './layout.js';
import type { LayoutPreset } from './types.js';

/** Share of the editor area the file pane takes when it is up. */
const FILE_PANE_SIZE = 0.35;

/** `workbench.action.focus*EditorGroup` only goes this far. */
const ORDINALS = [
  'First',
  'Second',
  'Third',
  'Fourth',
  'Fifth',
  'Sixth',
  'Seventh',
  'Eighth',
];

interface GroupSpec {
  groups?: GroupSpec[];
  size?: number;
}

/**
 * The editor area as this extension arranges it: a grid of agent panes, and —
 * once a file is opened — one pane beside it that every file goes to.
 *
 * The workbench has no nested tabs, so "the grid" cannot literally be one tab
 * holding four. What it can be is a block that files never land inside: the
 * grid keeps its shape, the file pane sits next to it, and the editors in it
 * are ordinary editors with ordinary tabs.
 */
export class EditorGrid implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  /** The split the agents are arranged in, once one has been applied. */
  private preset: LayoutPreset | undefined;

  /** Lock state we have already asked for, keyed by group. Avoids re-focusing. */
  private readonly locks = new Map<number, boolean>();

  /** Lock passes are serialised; they move focus, so they must not interleave. */
  private pending: Promise<void> = Promise.resolve();

  /** True while this class is moving editors about, which fires tab events. */
  private arranging = false;

  constructor() {
    this.disposables.push(
      // A pane earns its lock by holding an agent, so the locks follow agents
      // appearing and disappearing rather than being re-applied by every caller.
      // Not while we are mid-arrangement: focus is being moved deliberately
      // there, and a lock pass would take it away between two of the steps.
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        if (this.arranging) return;
        const agents = [...event.opened, ...event.closed].some(isAgentTab);
        if (agents) void this.syncLocks();
      }),
    );
  }

  /**
   * Applies a split without moving anything into it.
   *
   * `adoptFiles` is for the first split of the window: the workbench restores
   * the editors that were open last time, and those belong beside the grid
   * rather than under the agents that are about to launch. Later on, a file
   * inside the grid is there because someone dragged it there.
   */
  async applyPreset(preset: LayoutPreset, adoptFiles = false): Promise<void> {
    const filePane = Boolean(filePaneGroup()) || (adoptFiles && hasFileTabs());
    this.arranging = true;
    try {
      await this.setLayout(preset, filePane);
      if (filePane) await this.gatherFiles(paneCount(preset) + 1);
    } finally {
      this.arranging = false;
    }
    await this.syncLocks();
  }

  /**
   * Puts one agent in each pane, wrapping into tabs once there are more agents
   * than panes — six agents in a 2 x 2 leaves two panes holding two tabs.
   *
   * Everything is gathered into the first group before the split is applied. A
   * group that loses its last editor closes, which would renumber the groups
   * underneath a half-finished arrangement.
   */
  async arrange(terminals: readonly vscode.Terminal[], preset: LayoutPreset): Promise<void> {
    const filePane = Boolean(filePaneGroup());
    const panes = paneCount(preset);

    this.arranging = true;
    try {
      for (const terminal of terminals) await moveToGroup(terminal, 1);
      await this.setLayout(preset, filePane);

      if (panes > 1 && terminals.length > 1) {
        // Back to front, so the first group is never emptied mid-way.
        for (let index = terminals.length - 1; index >= 1; index--) {
          const terminal = terminals[index];
          if (terminal) await moveToGroup(terminal, (index % panes) + 1);
        }
      }

      // Gathering terminals can collapse the group the files were in, so they
      // are put back only once the grid is settled.
      if (filePane) await this.gatherFiles(panes + 1);
    } finally {
      this.arranging = false;
    }
    await this.syncLocks();

    const first = terminals[0];
    if (first) await focusTerminal(first);
  }

  /**
   * Opens a file in the pane beside the grid, splitting one off if this is the
   * first one. Anything the workbench can open goes through `vscode.open`, so
   * images and notebooks behave the same as text.
   */
  async openFile(uri: vscode.Uri, preview = true): Promise<void> {
    const preset = this.preset;
    if (!preset) {
      await vscode.commands.executeCommand('vscode.open', uri, { preview });
      return;
    }

    let column = filePaneGroup()?.viewColumn;
    if (!column) {
      await this.setLayout(preset, true);
      column = paneCount(preset) + 1;
      // Before the file opens, so the pass cannot pull focus off it afterwards.
      await this.syncLocks();
    }

    await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: column, preview });
  }

  private async setLayout(preset: LayoutPreset, filePane: boolean): Promise<void> {
    this.preset = preset;
    // Groups are re-numbered by the new split, so what we locked no longer holds.
    this.locks.clear();
    await vscode.commands.executeCommand('vscode.setEditorLayout', toSpec(preset, filePane));
  }

  /**
   * Moves stray file editors into the file pane.
   *
   * Re-splitting maps the old groups onto the new ones by position, so a file
   * that was beside a 2 x 2 lands inside a 3 x 2. Terminals are left alone —
   * they are placed by `arrange`.
   */
  private async gatherFiles(column: number): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      if (group.viewColumn >= column) continue;

      for (const tab of [...group.tabs]) {
        const uri = fileOf(tab);
        if (!uri) continue;
        // Opening it where it already is just makes it the active editor, which
        // is what `moveActiveEditor` needs.
        await vscode.commands.executeCommand('vscode.open', uri, {
          viewColumn: group.viewColumn,
          preview: false,
        });
        await vscode.commands.executeCommand('moveActiveEditor', {
          to: 'position',
          by: 'group',
          value: column,
        });
      }
    }
  }

  /**
   * Locks the panes that hold an agent, so a file opened from anywhere — quick
   * open, go to definition, a link in the terminal — cannot land on top of one.
   * Explicitly targeting a locked group still works, which is what keeps
   * dragging a tab into the grid available.
   */
  private syncLocks(): Promise<void> {
    const enabled = vscode.workspace
      .getConfiguration('cliGrid')
      .get<boolean>('lockAgentPanes', true);

    return this.setLocks((group) => enabled && group.tabs.some(isAgentTab));
  }

  /**
   * Drops every lock, for the moment a terminal is about to be placed in a
   * pane by the workbench. They come back by themselves once its tab appears.
   */
  unlockAll(): Promise<void> {
    return this.setLocks(() => false);
  }

  private setLocks(wanted: (group: vscode.TabGroup) => boolean): Promise<void> {
    this.pending = this.pending.then(() => this.doSetLocks(wanted));
    return this.pending;
  }

  private async doSetLocks(wanted: (group: vscode.TabGroup) => boolean): Promise<void> {
    const active = vscode.window.activeTerminal;
    let moved = false;

    for (const group of vscode.window.tabGroups.all) {
      const locked = wanted(group);
      if (this.locks.get(group.viewColumn) === locked) continue;
      this.locks.set(group.viewColumn, locked);
      if (await setLock(group.viewColumn, locked)) moved = true;
    }

    // Locking has to focus each group in turn; put the user back where they were.
    if (moved && active) active.show(false);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/**
 * `vscode.setEditorLayout` takes nested groups, and each level splits the
 * opposite way to the one above it. Orientation 0 splits with a horizontal
 * divider, so at the top level it means rows.
 */
function toSpec(preset: LayoutPreset, filePane: boolean): { orientation: number; groups: GroupSpec[] } {
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

function rowsOf(preset: LayoutPreset): GroupSpec[] {
  const rowSize = 1 / preset.rows.length;
  return preset.rows.map((columns) => ({
    size: rowSize,
    groups: Array.from({ length: columns }, () => ({ size: 1 / columns })),
  }));
}

function isAgentTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputTerminal;
}

function hasFileTabs(): boolean {
  return vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => !isAgentTab(tab)));
}

/**
 * The pane beside the grid, if it is up.
 *
 * Found rather than remembered: the workbench closes a group when its last
 * editor closes and renumbers the rest, so a column recorded earlier can quietly
 * come to mean a different pane. It is always the last group, it never holds an
 * agent, and an empty last group is a grid pane waiting for one.
 */
function filePaneGroup(): vscode.TabGroup | undefined {
  const all = vscode.window.tabGroups.all;
  if (all.length < 2) return undefined;

  const last = all[all.length - 1];
  if (!last || last.tabs.length === 0 || last.tabs.some(isAgentTab)) return undefined;
  return last;
}

/** The resource behind a tab, for the editor kinds that have exactly one. */
function fileOf(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) return input.uri;
  if (input instanceof vscode.TabInputCustom) return input.uri;
  if (input instanceof vscode.TabInputNotebook) return input.uri;
  return undefined;
}

/** Returns whether focus had to be moved to do it. */
async function setLock(column: number, locked: boolean): Promise<boolean> {
  const ordinal = ORDINALS[column - 1];
  if (!ordinal) return false;

  try {
    await vscode.commands.executeCommand(`workbench.action.focus${ordinal}EditorGroup`);
    await vscode.commands.executeCommand(
      locked ? 'workbench.action.lockEditorGroup' : 'workbench.action.unlockEditorGroup',
    );
    return true;
  } catch {
    // Older workbenches do not have group locking; the file pane still works.
    return false;
  }
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

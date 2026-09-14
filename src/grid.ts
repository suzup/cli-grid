import * as vscode from 'vscode';
import { setting } from './config.js';
import { paneCount, toSpec } from './layout.js';
import type { LayoutPreset } from './types.js';

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

  /**
   * Whether a pane has ever been locked. Until one has, the workbench is in the
   * state an unlock pass would put it in, so there is nothing to do.
   */
  private everLocked = false;

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
    const column = paneCount(preset) + 1;

    this.arranging = true;
    try {
      const files = filePane ? await this.takeFiles(column) : [];
      await this.setLayout(preset, filePane);
      await this.putFiles(files, column);
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
    this.arranging = true;
    try {
      await this.place(terminals, preset);
    } finally {
      this.arranging = false;
    }
    await this.syncLocks();

    const first = terminals[0];
    if (first) await focusTerminal(first);
  }

  /** The arrangement itself, with the caller holding `arranging`. */
  private async place(
    terminals: readonly vscode.Terminal[],
    preset: LayoutPreset,
  ): Promise<void> {
    const filePane = Boolean(filePaneGroup());
    const panes = paneCount(preset);

    if (await this.alreadyPlaced(terminals, preset, filePane)) return;

    // Files first and out of the way: which group they are in must not have a
    // say in where the panes end up.
    const files = filePane ? await this.takeFiles(panes + 1) : [];

    for (const terminal of terminals) await moveToGroup(terminal, 1);
    await this.setLayout(preset, filePane);

    if (panes > 1 && terminals.length > 1) {
      // Back to front, so the first group is never emptied mid-way.
      for (let index = terminals.length - 1; index >= 1; index--) {
        const terminal = terminals[index];
        if (terminal) await moveToGroup(terminal, (index % panes) + 1);
      }
    }

    await this.putFiles(files, panes + 1);
  }

  /**
   * Brings each agent to the front of its pane, and says whether that was the
   * whole arrangement.
   *
   * Re-applying a split that is already in force asks for panes that are
   * already there holding agents that are already in them, so all it takes is
   * one tab coming forward in each pane — no split to re-apply, no pane
   * renumbered, and so no lock to put back either. Finding that out costs what
   * doing it costs, because a terminal has to be focused before the workbench
   * will say which group it is in, so the agents are brought forward first and
   * the answer falls out of where they turn out to be.
   *
   * Anything out of place hands the job back rather than moving it: a group
   * closes the moment its last editor leaves, taking the numbering of every
   * pane after it with it, and the full arrangement below is the one written to
   * survive that.
   */
  private async alreadyPlaced(
    terminals: readonly vscode.Terminal[],
    preset: LayoutPreset,
    filePane: boolean,
  ): Promise<boolean> {
    const panes = paneCount(preset);
    if (this.preset?.id !== preset.id) return false;
    if (vscode.window.tabGroups.all.length !== panes + (filePane ? 1 : 0)) return false;

    for (const [index, terminal] of terminals.entries()) {
      await focusTerminal(terminal);
      if (vscode.window.tabGroups.activeTabGroup.viewColumn !== (index % panes) + 1) return false;
    }
    return true;
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
   * Closes the file editors, so the split can be applied without them, and
   * hands back what to re-open once it has been.
   *
   * Re-splitting maps the old groups onto the new ones by position, so a file
   * that was beside a 2 x 2 lands inside a 3 x 2 and has to be fetched back
   * out. Moving it looked like the way to do that, and was — but the workbench
   * closes a group the moment its last editor leaves it, and every pane after
   * that one shifts up by one. Re-opening a folder is where that showed:
   * the files the workbench had restored were sitting in what were about to be
   * agent panes, gathering them cost the grid a pane for each group they came
   * from, and the agents launched straight afterwards each landed a pane over
   * from the one their position in the list had asked for.
   *
   * Closing first leaves the shape of the editor area to `setEditorLayout`
   * alone, which is the one thing that gets it right. Nothing is done at all
   * when the files are already where they belong, and a dirty editor is left
   * where it is — no arrangement is worth a save prompt.
   */
  private async takeFiles(column: number): Promise<vscode.Uri[]> {
    const open = vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.filter((tab) => fileOf(tab)).map((tab) => ({ group, tab })),
    );
    if (!open.length) return [];

    // Already one file pane, at the column it is about to be at: re-splitting
    // will leave them alone, so there is nothing to take.
    if (
      vscode.window.tabGroups.all.length === column &&
      open.every(({ group }) => group.viewColumn === column)
    ) {
      return [];
    }

    const movable = open.filter(({ tab }) => !tab.isDirty);
    if (!movable.length) return [];

    const uris = movable.flatMap(({ tab }) => fileOf(tab) ?? []);
    await vscode.window.tabGroups.close(movable.map(({ tab }) => tab), true);
    return uris;
  }

  /** The other half: back into the file pane, in the order they were in. */
  private async putFiles(uris: readonly vscode.Uri[], column: number): Promise<void> {
    for (const uri of uris) {
      await vscode.commands.executeCommand('vscode.open', uri, {
        viewColumn: column,
        preview: false,
        preserveFocus: true,
      });
    }
  }

  /**
   * Locks the panes that hold an agent, so a file opened from anywhere — quick
   * open, go to definition, a link in the terminal — cannot land on top of one.
   * Explicitly targeting a locked group still works, which is what keeps
   * dragging a tab into the grid available.
   */
  private syncLocks(): Promise<void> {
    const enabled = setting('lockAgentPanes');
    return this.setLocks((group) => enabled && group.tabs.some(isAgentTab));
  }

  /**
   * Drops every lock, for the moment a terminal is about to be placed in a
   * pane by the workbench. They come back by themselves once its tab appears.
   */
  unlockAll(): Promise<void> {
    return this.setLocks(() => false);
  }

  /**
   * Locking is best-effort, and a failed pass must not poison the queue: the
   * chain is what every later pass builds on, and `unlockAll` runs immediately
   * before each launch, so a rejection left in it would stop agents starting for
   * the rest of the session.
   */
  private setLocks(wanted: (group: vscode.TabGroup) => boolean): Promise<void> {
    this.pending = this.pending
      .then(() => this.doSetLocks(wanted))
      .catch((err) => console.error('CLI Grid: could not lock the agent panes', err));
    return this.pending;
  }

  private async doSetLocks(wanted: (group: vscode.TabGroup) => boolean): Promise<void> {
    const targets = vscode.window.tabGroups.all.map(
      (group) => [group, wanted(group)] as const,
    );

    // A group starts out unlocked, so while nothing has ever been locked there
    // is nothing to undo. Without this, every pass that wants everything
    // unlocked — which is every pass at all when `lockAgentPanes` is off —
    // still walks the groups focusing each one to unlock what is already
    // unlocked, and takes the cursor away from whatever you were typing in.
    if (!this.everLocked && targets.every(([, locked]) => !locked)) return;

    const active = vscode.window.activeTerminal;
    let moved = false;

    for (const [group, locked] of targets) {
      if (this.locks.get(group.viewColumn) === locked) continue;
      this.locks.set(group.viewColumn, locked);
      if (locked) this.everLocked = true;
      if (await setLock(group.viewColumn, locked)) moved = true;
    }

    // Locking has to focus each group in turn; put the user back where they
    // were. Not if that terminal has gone in the meantime — closing an agent is
    // exactly what sets a lock pass off, so it races with this.
    if (moved && active && vscode.window.terminals.includes(active)) active.show(false);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
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

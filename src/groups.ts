import * as vscode from 'vscode';
import type { EditorGrid } from './grid.js';
import { autoPreset, resolveLayout } from './layout.js';
import { basename, dirnameOf, relativeTo, resolveFolder } from './paths.js';
import {
  addGroupToConfig,
  hasConfig,
  inProjectOrder,
  promptOpenFolder,
  readConfig,
  removeGroupFromConfig,
  writeConfig,
  type ProjectConfig,
  type ProjectWatcher,
} from './project.js';
import type { AgentRegistry } from './registry.js';
import type { WorkspaceRoots } from './roots.js';

/** Which group the window was last showing. Per folder, like the split. */
const ACTIVE_KEY = 'cliGrid.activeGroup';

export interface Group {
  uri: vscode.Uri;
  name: string;
  config: ProjectConfig;
}

/**
 * The window's groups, in the order the folder you opened asks for.
 *
 * That folder comes first because it is the way in, and the rest follow the
 * order its config lists them in — the same rule as agents, where the order in
 * the file is the order of the view. A project the window has picked up any
 * other way goes on the end rather than being dropped: it is still a folder
 * with agents in it, and hiding it would leave its rows nowhere to appear.
 */
export function orderGroups(
  entry: vscode.Uri | undefined,
  refs: readonly string[],
  projects: readonly Group[],
): Group[] {
  const remaining = new Map(projects.map((project) => [project.uri.toString(), project]));
  const ordered: Group[] = [];

  const take = (uri: vscode.Uri | undefined): void => {
    if (!uri) return;
    const group = remaining.get(uri.toString());
    if (!group) return;
    remaining.delete(uri.toString());
    ordered.push(group);
  };

  take(entry);
  if (entry) for (const ref of refs) take(resolveFolder(entry, ref));
  ordered.push(...remaining.values());
  return ordered;
}

/** The group `delta` steps along from the active one, wrapping at both ends. */
export function stepGroup(
  groups: readonly Group[],
  active: vscode.Uri | undefined,
  delta: number,
): Group | undefined {
  if (groups.length < 2) return undefined;

  const at = groups.findIndex((group) => group.uri.toString() === active?.toString());
  const from = at === -1 ? 0 : at;
  return groups[(((from + delta) % groups.length) + groups.length) % groups.length];
}

/**
 * Which set of agents the grid is showing.
 *
 * Four panes is about as far as a grid stays readable, and the way past that
 * used to be a second folder in a second window — which costs a whole window to
 * look at four more terminals. A group is that second folder brought inside:
 * every project folder in the window is a group, one of them is on screen, and
 * the others sit in the terminal panel still running.
 *
 * Nothing here decides what a group is. A group is a project, and a project is
 * a folder that carries `.vscode/cli-grid.json` — so a window with one folder
 * has one group and behaves exactly as it did before any of this existed.
 */
export class GroupController implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];

  /**
   * The group the user last chose, which is remembered across sessions.
   *
   * Not the same thing as the group on screen: on the way up the folder it
   * names is not in the window yet, and while it is missing the first group
   * stands in. Overwriting this with that stand-in would lose the choice the
   * moment the window opened, so the two are kept apart.
   */
  private chosen: string | undefined;

  /** The group actually on screen last time anything asked. */
  private shown: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly projects: ProjectWatcher,
    private readonly registry: AgentRegistry,
    private readonly grid: EditorGrid,
    private readonly roots: WorkspaceRoots,
  ) {
    this.chosen = context.workspaceState.get<string>(ACTIVE_KEY);
    this.disposables.push(projects.onDidChange(() => this.settle()));
  }

  /**
   * The folder the window was opened on, which is the only one read for a group
   * list. Every other folder in the window was put there by this extension, so
   * asking them too would be asking a list about itself.
   */
  private get entry(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private refs(): string[] {
    const entry = this.entry;
    return (entry && this.projects.configFor(entry)?.groups) || [];
  }

  list(): Group[] {
    return orderGroups(this.entry, this.refs(), this.projects.projects());
  }

  /** The group on screen. Always one, as long as the window has any project. */
  active(): Group | undefined {
    const groups = this.list();
    return groups.find((group) => group.uri.toString() === this.chosen) ?? groups[0];
  }

  isActive(root: vscode.Uri): boolean {
    return this.active()?.uri.toString() === root.toString();
  }

  /** Whether the window has more than one, which is what turns the UI on. */
  get many(): boolean {
    return this.list().length > 1;
  }

  /**
   * Puts the group folders in the window, before anything reads the folder list.
   *
   * Read from disk rather than from the watcher: this is the first thing that
   * happens, and the folders it finds are what the watcher then sees as
   * projects. Nothing is saved outside the config — reopening the folder is
   * what brings the whole window back.
   */
  async sync(): Promise<void> {
    const entry = this.entry;
    if (!entry) return;

    const config = await readConfig(entry);
    for (const ref of config?.groups ?? []) {
      await this.roots.ensureRoot(resolveFolder(entry, ref));
    }
  }

  /** Settles the active group on the way up, without touching the editor area. */
  restore(): void {
    this.updateContext();
    this.shown = this.active()?.uri.toString();
  }

  async switchTo(root: vscode.Uri): Promise<void> {
    const target = this.list().find((group) => group.uri.toString() === root.toString());
    if (!target || target.uri.toString() === this.shown) return;

    this.chosen = target.uri.toString();
    this.shown = this.chosen;
    await this.context.workspaceState.update(ACTIVE_KEY, this.chosen);
    await this.show(target);
    this.changeEmitter.fire();
  }

  /**
   * Makes the group a command is about the one on screen.
   *
   * Starting an agent that belongs to a group you are not looking at would put
   * its pane in another group's grid, so the switch happens first and the agent
   * comes up where it belongs.
   */
  async ensureActive(root: vscode.Uri): Promise<void> {
    if (this.many) await this.switchTo(root);
  }

  async step(delta: number): Promise<void> {
    const next = stepGroup(this.list(), this.active()?.uri, delta);
    if (next) await this.switchTo(next.uri);
  }

  async pick(): Promise<void> {
    const groups = this.list();
    if (groups.length < 2) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('This window has one group. Add another folder as a group to switch between them.'),
      );
      return;
    }

    const active = this.active()?.uri.toString();
    const picked = await vscode.window.showQuickPick(
      groups.map((group) => ({
        label: `${group.uri.toString() === active ? '$(circle-filled)' : '$(circle-outline)'} ${group.name}`,
        description: vscode.l10n.t(
          '{0} configured, {1} running',
          group.config.agents.length,
          this.registry.inProject(group.uri).length,
        ),
        detail: group.uri.fsPath,
        uri: group.uri,
      })),
      { title: vscode.l10n.t('Which group should the grid show?'), matchOnDetail: true },
    );
    if (picked) await this.switchTo(picked.uri);
  }

  /**
   * Adds a folder to the window as a group of its own.
   *
   * A folder that is not a project yet becomes one, empty, so that picking a
   * fresh folder here and adding agents to it afterwards is the same two steps
   * as setting up the first group was.
   */
  async add(): Promise<void> {
    const entry = this.entry;
    if (!entry) {
      await promptOpenFolder();
      return;
    }

    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: dirnameOf(entry),
      openLabel: vscode.l10n.t('Add as Group'),
      title: vscode.l10n.t('Which folder should become a group?'),
    });

    const folder = picked?.[0];
    if (!folder) return;

    if (this.list().some((group) => group.uri.toString() === folder.toString())) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('That folder is already a group in this window.'),
      );
      return;
    }

    try {
      if (!(await hasConfig(folder))) await writeConfig(folder, { agents: [] });
      await addGroupToConfig(entry, relativeTo(entry, folder));
    } catch (err) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Could not add {0} as a group: {1}', basename(folder.path), String(err)),
      );
      return;
    }

    await this.roots.ensureRoot(folder);
    await this.projects.refresh();
    await this.switchTo(folder);
  }

  /**
   * Takes a group back out of the window.
   *
   * The folder and its config are left exactly as they are — this is a list the
   * window keeps, not the group itself — so adding it again brings back the
   * same agents. Its running CLIs do stop: they would otherwise be left in the
   * panel belonging to nothing, with no row anywhere to stop them from.
   */
  async remove(root: vscode.Uri): Promise<void> {
    const entry = this.entry;
    if (!entry) return;

    if (root.toString() === entry.toString()) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('This is the folder the window was opened on, so it stays.'),
      );
      return;
    }

    const group = this.list().find((candidate) => candidate.uri.toString() === root.toString());
    const running = this.registry.inProject(root);
    const remove = vscode.l10n.t('Remove');

    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Take the group {0} out of this window?', group?.name ?? basename(root.path)),
      {
        modal: true,
        detail: running.length
          ? vscode.l10n.t('Its agents stop. The folder and its settings are untouched, and adding it again brings them back.')
          : vscode.l10n.t('The folder and its settings are untouched, and adding it again brings them back.'),
      },
      remove,
    );
    if (answer !== remove) return;

    for (const agent of running) this.registry.stop(agent.id);

    // Whichever way it is written down — the config is hand-editable, so the
    // reference that resolves to this folder is not necessarily the one this
    // extension would have written.
    const ref = this.refs().find(
      (candidate) => resolveFolder(entry, candidate).toString() === root.toString(),
    );
    if (ref) await removeGroupFromConfig(entry, ref);

    const folders = (group?.config.agents ?? []).map((spec) => resolveFolder(root, spec.folder));

    await this.roots.removeRoot(root);
    await this.projects.refresh();

    // The folders its agents worked in are nobody's now, unless another group
    // works in them too — which `remove` is the one that knows.
    for (const folder of folders) await this.roots.remove(folder);
    await this.projects.refresh();

    if (this.shown === root.toString()) {
      const first = this.list()[0];
      this.chosen = undefined;
      this.shown = undefined;
      if (first) await this.switchTo(first.uri);
    }
    this.changeEmitter.fire();
  }

  /** The active group in the grid, everything else down in the panel. */
  private async show(target: Group): Promise<void> {
    const running = inProjectOrder(this.projects.projects(), this.registry.list());
    const key = target.uri.toString();
    const show = running.filter((agent) => agent.root.toString() === key);
    const hide = running.filter((agent) => agent.root.toString() !== key);

    const preset = resolveLayout(target.config.layout, show.length) ?? autoPreset(show.length);
    await this.grid.showOnly(
      show.map((agent) => agent.terminal),
      hide.map((agent) => agent.terminal),
      preset,
    );
  }

  /**
   * The group on screen can change without anyone switching: its folder is
   * removed, or the one that was remembered finally arrives. Nothing is written
   * down here — what the user chose stands, and this only reports that what
   * stands in for it has moved.
   */
  private settle(): void {
    this.updateContext();

    const key = this.active()?.uri.toString();
    if (key === this.shown) return;
    this.shown = key;
    this.changeEmitter.fire();
  }

  private updateContext(): void {
    void vscode.commands.executeCommand('setContext', 'cliGrid.hasGroups', this.many);
  }

  dispose(): void {
    this.changeEmitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

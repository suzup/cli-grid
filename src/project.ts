import * as vscode from 'vscode';
import { exists, join } from './paths.js';
import type { LaunchMode, RunningAgent } from './types.js';

/**
 * Config lives inside the folder it describes, the same way `.vscode/settings.json`
 * or `package.json` do.
 *
 * That is the whole model: open a folder, and if it carries this file the grid
 * comes up. A different set of agents is a different folder. There is nothing
 * to name, nothing stored elsewhere, and nothing to find again later.
 */
export const CONFIG_DIR = '.vscode';
export const CONFIG_FILE = 'cli-grid.json';
export const CONFIG_RELATIVE = `${CONFIG_DIR}/${CONFIG_FILE}`;

/**
 * Names this file carried before the extension settled on one, newest first.
 *
 * Read-only: a project written under an old name keeps working, and the first
 * write moves it to the current one. All of this can go once 0.1.0 has shipped
 * and nobody is carrying a config from before it.
 */
const LEGACY_FILES = ['agent-grid.json', 'agentry.json'];
const LEGACY_RELATIVE = LEGACY_FILES.map((file) => `${CONFIG_DIR}/${file}`);

export interface AgentSpec {
  /** Folder reference relative to the project root; "." is the root itself. */
  folder: string;
  cli: string;
  mode?: LaunchMode;
  /** Shown instead of the folder name, for when that is not distinct enough. */
  name?: string;
  /**
   * Whether starting the whole project starts this one. Absent means yes.
   *
   * Written down only when it is `false`, so a project file says which agents
   * were deliberately left out rather than restating the ordinary case for
   * every entry — and a file written before this existed still starts
   * everything, which is what it used to do.
   */
  pinned?: boolean;
}

export interface ProjectConfig {
  layout?: string;
  /**
   * Other project folders that belong beside this one, each one a group.
   *
   * Four panes is about where a grid stops being readable, and the answer used
   * to be a second folder in a second window. This is that second folder, in
   * this window: the folders named here are put in the window on the way up,
   * every one of them is a project in its own right with its own agents and its
   * own split, and one of them is on screen at a time.
   *
   * Only the folder you opened is read for this. A group is a folder like any
   * other, so opening one directly gives you that group on its own — the entry
   * point is still "open a folder", and nothing has to be saved anywhere else.
   */
  groups?: string[];
  agents: AgentSpec[];
}

const EMPTY: ProjectConfig = { agents: [] };

export function configUri(root: vscode.Uri): vscode.Uri {
  return join(root, CONFIG_DIR, CONFIG_FILE);
}

export async function hasConfig(root: vscode.Uri): Promise<boolean> {
  return (await presentConfigUri(root)) !== undefined;
}

/** The config that is actually on disk: the current name, or an old one. */
async function presentConfigUri(root: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (await exists(configUri(root))) return configUri(root);

  for (const file of LEGACY_FILES) {
    const legacy = join(root, CONFIG_DIR, file);
    if (await exists(legacy)) return legacy;
  }
  return undefined;
}

/** The file to show the user: whichever is there, or where a new one would go. */
export async function openableConfigUri(root: vscode.Uri): Promise<vscode.Uri> {
  return (await presentConfigUri(root)) ?? configUri(root);
}

export async function readConfig(root: vscode.Uri): Promise<ProjectConfig | undefined> {
  const present = await presentConfigUri(root);
  if (!present) return undefined;

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(present);
  } catch {
    return undefined;
  }

  try {
    // Hand-edited config is normal here, so tolerate comments and trailing commas.
    const text = Buffer.from(bytes)
      .toString('utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1');

    const parsed = JSON.parse(text) as Partial<ProjectConfig>;
    const groups = (parsed.groups ?? [])
      .filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0)
      .map((ref) => ref.trim());

    return {
      ...(parsed.layout ? { layout: parsed.layout } : {}),
      ...(groups.length ? { groups } : {}),
      agents: (parsed.agents ?? [])
        .filter((a): a is AgentSpec => Boolean(a?.cli))
        .map((a) => ({
          folder: a.folder?.trim() || '.',
          cli: a.cli,
          ...(a.mode ? { mode: a.mode } : {}),
          ...(a.name?.trim() ? { name: a.name.trim() } : {}),
          ...(a.pinned === false ? { pinned: false } : {}),
        })),
    };
  } catch (err) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('{0} could not be read: {1}', CONFIG_RELATIVE, String(err)),
    );
    return EMPTY;
  }
}

export async function writeConfig(root: vscode.Uri, config: ProjectConfig): Promise<void> {
  // No `$schema` key: `contributes.jsonValidation` already binds the schema to
  // this filename, so editors offer completion without it being written in.
  const body = {
    ...(config.layout ? { layout: config.layout } : {}),
    ...(config.groups?.length ? { groups: config.groups } : {}),
    agents: config.agents,
  };

  await vscode.workspace.fs.createDirectory(join(root, CONFIG_DIR));
  await vscode.workspace.fs.writeFile(
    configUri(root),
    Buffer.from(JSON.stringify(body, null, 2) + '\n', 'utf8'),
  );
}

/** Creates the file if it is missing, then applies `mutate` and saves. */
export async function updateConfig(
  root: vscode.Uri,
  mutate: (config: ProjectConfig) => void,
): Promise<void> {
  const config = (await readConfig(root)) ?? { agents: [] };
  mutate(config);
  await writeConfig(root, config);
}

/**
 * What makes two entries the same agent: one CLI per folder.
 *
 * The launcher, the tree and the registry all lean on this, so a second Claude
 * in the same folder is the same row rather than a duplicate nobody can tell
 * apart.
 */
export function sameAgent(a: AgentSpec, b: AgentSpec): boolean {
  return a.folder === b.folder && a.cli === b.cli;
}

/**
 * Whether starting the project starts this agent.
 *
 * Four agents in a project does not mean four you want up every time — one is
 * often a repository you only look at now and then, and having it launch with
 * the rest costs a pane and a CLI session. Un-pinning leaves it in the list,
 * in its place in the order, startable on its own.
 *
 * Pinned unless it says otherwise, so nothing has to be pinned before the
 * button works and a project file that predates this behaves as it did.
 */
export function isPinned(spec: AgentSpec): boolean {
  return spec.pinned !== false;
}

/** The agents `startAll` would launch, in the order they are written down. */
export function pinnedAgents(config: ProjectConfig | undefined): AgentSpec[] {
  return (config?.agents ?? []).filter(isPinned);
}

/**
 * Running agents in the order their project file lists them, with anything not
 * written down after them.
 *
 * That order is the one the Agents view shows and the one `startAll` hands out
 * panes in, so dragging a row is how a user says which pane an agent belongs
 * in. Anything that arranges the panes has to ask the same question — the order
 * agents happen to have been launched in is not an answer to it.
 */
export function inProjectOrder(
  projects: readonly { uri: vscode.Uri; config: ProjectConfig }[],
  running: readonly RunningAgent[],
): RunningAgent[] {
  const ordered: RunningAgent[] = [];
  const placed = new Set<string>();

  for (const project of projects) {
    for (const spec of project.config.agents) {
      const agent = running.find(
        (candidate) =>
          !placed.has(candidate.id) &&
          candidate.root.toString() === project.uri.toString() &&
          candidate.folderRef === spec.folder &&
          candidate.profileId === spec.cli,
      );
      if (!agent) continue;
      placed.add(agent.id);
      ordered.push(agent);
    }
  }

  // Ad-hoc agents, and any project that has gone away since one was launched.
  for (const agent of running) if (!placed.has(agent.id)) ordered.push(agent);

  return ordered;
}

export async function addAgentToConfig(
  root: vscode.Uri,
  spec: AgentSpec,
): Promise<void> {
  await updateConfig(root, (config) => {
    if (!config.agents.some((a) => sameAgent(a, spec))) config.agents.push(spec);
  });
}

/**
 * Replaces one agent's entry, keeping its place in the order.
 *
 * Returns false when the change would collide with an agent already there —
 * pointing two entries at the same CLI in the same folder would make them the
 * same agent, and one of them would quietly win.
 */
export async function updateAgentInConfig(
  root: vscode.Uri,
  current: AgentSpec,
  next: AgentSpec,
): Promise<boolean> {
  let ok = false;
  await updateConfig(root, (config) => {
    const at = config.agents.findIndex((a) => sameAgent(a, current));
    if (at === -1) return;
    if (config.agents.some((a, index) => index !== at && sameAgent(a, next))) return;

    config.agents[at] = next;
    ok = true;
  });
  return ok;
}

/**
 * Moves agents so they sit just before `before`, or last when it is absent.
 *
 * The order in this file is the order of the view, and it is also the order
 * `startAll` hands out panes in — so dragging a row is how you decide which
 * pane an agent comes up in.
 */
export async function reorderAgents(
  root: vscode.Uri,
  moved: readonly AgentSpec[],
  before: AgentSpec | undefined,
): Promise<void> {
  await updateConfig(root, (config) => {
    const taken = config.agents.filter((a) => moved.some((m) => sameAgent(a, m)));
    if (!taken.length) return;

    const rest = config.agents.filter((a) => !moved.some((m) => sameAgent(a, m)));
    // Located after the removal, so the index still means what it looks like.
    const at = before ? rest.findIndex((a) => sameAgent(a, before)) : -1;

    rest.splice(at === -1 ? rest.length : at, 0, ...taken);
    config.agents = rest;
  });
}

export async function removeAgentFromConfig(
  root: vscode.Uri,
  spec: AgentSpec,
): Promise<void> {
  await updateConfig(root, (config) => {
    config.agents = config.agents.filter(
      (a) => !(a.folder === spec.folder && a.cli === spec.cli),
    );
  });
}

/* --------------------------------- groups -------------------------------- */

/**
 * Adds a folder to the entry folder's group list, at the end.
 *
 * Only the folder the window was opened on carries this list. It is the one
 * folder that is certainly there on the way up, so it is the only one whose
 * config can be read before the others have been put in the window.
 */
export async function addGroupToConfig(entry: vscode.Uri, reference: string): Promise<void> {
  await updateConfig(entry, (config) => {
    const groups = config.groups ?? [];
    if (groups.includes(reference)) return;
    config.groups = [...groups, reference];
  });
}

export async function removeGroupFromConfig(entry: vscode.Uri, reference: string): Promise<void> {
  await updateConfig(entry, (config) => {
    config.groups = (config.groups ?? []).filter((ref) => ref !== reference);
  });
}

/* --------------------------- choosing a folder --------------------------- */

/**
 * Nothing to work in, so offer the one thing that helps.
 *
 * Every entry point that needs a folder hits this, and every one of them then
 * has nothing left to do: opening a folder reloads the window.
 */
export async function promptOpenFolder(): Promise<void> {
  const open = vscode.l10n.t('Open Folder...');
  const answer = await vscode.window.showInformationMessage(
    vscode.l10n.t('Open the folder you want to work in first.'),
    open,
  );
  if (answer === open) {
    await vscode.commands.executeCommand('workbench.action.files.openFolder');
  }
}

/**
 * Which open folder a command should act on.
 *
 * One folder is the common case and is never worth a prompt. `only` narrows the
 * list — setting up a project asks about folders that are not one yet — and if
 * nothing is left the full list is offered, so the caller gets a folder to
 * report about rather than silence.
 */
export async function pickProjectFolder(options: {
  title: string;
  placeHolder?: string;
  only?: (folder: vscode.WorkspaceFolder) => Promise<boolean>;
}): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    await promptOpenFolder();
    return undefined;
  }

  let candidates = folders;
  if (options.only) {
    const kept: vscode.WorkspaceFolder[] = [];
    for (const folder of folders) {
      if (await options.only(folder)) kept.push(folder);
    }
    if (kept.length) candidates = kept;
  }

  const only = candidates[0];
  if (candidates.length === 1 && only) return only.uri;

  const picked = await vscode.window.showQuickPick(
    candidates.map((f) => ({
      label: `$(root-folder) ${f.name}`,
      description: f.uri.fsPath,
      uri: f.uri,
    })),
    {
      title: options.title,
      ...(options.placeHolder ? { placeHolder: options.placeHolder } : {}),
      matchOnDescription: true,
    },
  );
  return picked?.uri;
}

/**
 * Tracks which open folders are CLI Grid projects.
 *
 * The config file can appear, change or vanish while the window is open — from
 * a git pull as easily as from our own writes — so this watches rather than
 * reading once at startup.
 */
export class ProjectWatcher implements vscode.Disposable {
  private readonly roots = new Map<string, ProjectConfig>();
  private readonly disposables: vscode.Disposable[] = [];

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor() {
    for (const relative of [CONFIG_RELATIVE, ...LEGACY_RELATIVE]) {
      const watcher = vscode.workspace.createFileSystemWatcher(`**/${relative}`);
      this.disposables.push(
        watcher,
        watcher.onDidCreate(() => void this.refresh()),
        watcher.onDidChange(() => void this.refresh()),
        watcher.onDidDelete(() => void this.refresh()),
      );
    }

    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
    );
    void this.refresh();
  }

  /**
   * Turns an open folder into a project.
   *
   * Adding the first agent does this on its own, so this is for someone who
   * wants the file in place before deciding what goes in it.
   */
  async init(): Promise<void> {
    const root = await pickProjectFolder({
      title: vscode.l10n.t('Which folder should become a CLI Grid project?'),
      only: async (folder) => !(await hasConfig(folder.uri)),
    });
    if (!root) return;

    // Every open folder was already one, so `pickProjectFolder` fell back to the
    // full list rather than leaving the user with no answer.
    if (await hasConfig(root)) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('This folder is already a CLI Grid project.'),
      );
      await this.refresh();
      return;
    }

    try {
      await writeConfig(root, { agents: [] });
    } catch (err) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Could not write {0}: {1}', CONFIG_RELATIVE, String(err)),
      );
      return;
    }

    await this.refresh();
    await vscode.commands.executeCommand('cliGrid.showAgents');
  }

  async refresh(): Promise<void> {
    this.roots.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const config = await readConfig(folder.uri);
      if (config) this.roots.set(folder.uri.toString(), config);
    }
    void vscode.commands.executeCommand('setContext', 'cliGrid.isProject', this.roots.size > 0);
    this.changeEmitter.fire();
  }

  /** Workspace folders that carry a config, in workspace order. */
  projects(): { uri: vscode.Uri; name: string; config: ProjectConfig }[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => this.roots.has(f.uri.toString()))
      .map((f) => ({
        uri: f.uri,
        name: f.name,
        config: this.roots.get(f.uri.toString()) ?? EMPTY,
      }));
  }

  configFor(root: vscode.Uri): ProjectConfig | undefined {
    return this.roots.get(root.toString());
  }

  get any(): boolean {
    return this.roots.size > 0;
  }

  dispose(): void {
    this.changeEmitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

import * as vscode from 'vscode';
import { exists, join } from './paths.js';
import type { LaunchMode } from './types.js';

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
}

export interface ProjectConfig {
  layout?: string;
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
    return {
      ...(parsed.layout ? { layout: parsed.layout } : {}),
      agents: (parsed.agents ?? [])
        .filter((a): a is AgentSpec => Boolean(a?.cli))
        .map((a) => ({
          folder: a.folder?.trim() || '.',
          cli: a.cli,
          ...(a.mode ? { mode: a.mode } : {}),
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

export async function addAgentToConfig(
  root: vscode.Uri,
  spec: AgentSpec,
): Promise<void> {
  await updateConfig(root, (config) => {
    const already = config.agents.some((a) => a.folder === spec.folder && a.cli === spec.cli);
    if (!already) config.agents.push(spec);
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

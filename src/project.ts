import * as vscode from 'vscode';
import { basename, exists, join } from './paths.js';
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
  const body = {
    // Points editors at the settings this file understands.
    $schema: undefined,
    ...(config.layout ? { layout: config.layout } : {}),
    agents: config.agents,
  };
  delete (body as Record<string, unknown>).$schema;

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

/**
 * Immediate subdirectories worth offering as agent targets.
 *
 * Opening a parent directory full of repositories is the common shape, so the
 * launcher should not make the user browse for them one at a time.
 */
export async function candidateFolders(root: vscode.Uri): Promise<vscode.Uri[]> {
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '__pycache__']);

  try {
    const entries = await vscode.workspace.fs.readDirectory(root);
    return entries
      .filter(([name, type]) => type === vscode.FileType.Directory && !skip.has(name) && !name.startsWith('.'))
      .map(([name]) => join(root, name))
      .sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
  } catch {
    return [];
  }
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

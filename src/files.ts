import * as vscode from 'vscode';
import type { GitStatus } from './git.js';
import { basename, join } from './paths.js';
import type { AgentRegistry } from './registry.js';

/** Never worth expanding by default, and slow when they are huge. */
const DEMOTED = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '__pycache__']);

export class FileNode {
  constructor(
    readonly uri: vscode.Uri,
    readonly name: string,
    readonly isDir: boolean,
  ) {}
}

/**
 * A file tree scoped to whichever agent is selected.
 *
 * The Explorer shows the folder you opened; this shows the folder the focused
 * CLI is actually working in, which is the question you have while reading its
 * output. Items carry a `resourceUri`, so file icons come from the user's icon
 * theme and the colouring comes from the built-in git decorations — the same
 * ones the Explorer uses.
 */
export class FilesTreeProvider implements vscode.TreeDataProvider<FileNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<FileNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private readonly scopeEmitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChangeScope = this.scopeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private scope: vscode.Uri | undefined;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly git: GitStatus,
  ) {
    this.disposables.push(
      git.onDidChange(() => this.changeEmitter.fire(undefined)),
      registry.onDidChange(() => this.pruneScope()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.reset()),
      // Following the active terminal means the tree tracks whichever pane you
      // are actually looking at, whether you got there from the Agents list or
      // by clicking the terminal tab itself.
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        const agent = terminal ? registry.byTerminal(terminal) : undefined;
        if (agent) this.setScope(agent.folder);
      }),
    );
    this.reset();
  }

  /** Points the tree at a folder — normally the focused agent's cwd. */
  setScope(uri: vscode.Uri | undefined): void {
    if (this.scope?.toString() === uri?.toString()) return;
    this.scope = uri;
    // Git only knows about repositories in the workspace until it is told.
    if (uri) void this.git.track(uri);
    this.scopeEmitter.fire(uri);
    this.changeEmitter.fire(undefined);
  }

  currentScope(): vscode.Uri | undefined {
    return this.scope;
  }

  /** Falls back to the opened folder when nothing is focused. */
  private reset(): void {
    this.setScope(this.scope ?? vscode.workspace.workspaceFolders?.[0]?.uri);
  }

  /** When the agent whose folder we were showing goes away, fall back. */
  private pruneScope(): void {
    const stillRunning = this.registry
      .list()
      .some((a) => a.folder.toString() === this.scope?.toString());
    if (!stillRunning && this.registry.list().length === 0) {
      this.setScope(vscode.workspace.workspaceFolders?.[0]?.uri);
    }
    this.changeEmitter.fire(undefined);
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  async getChildren(element?: FileNode): Promise<FileNode[]> {
    const dir = element?.uri ?? this.scope;
    if (!dir) return [];

    const showHidden = vscode.workspace
      .getConfiguration('agentry')
      .get<boolean>('showHiddenFiles', false);

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return [];
    }

    return entries
      .filter(([name]) => showHidden || !name.startsWith('.') || name === '.vscode')
      .map(([name, type]) => new FileNode(join(dir, name), name, type === vscode.FileType.Directory))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        const ad = DEMOTED.has(a.name) ? 1 : 0;
        const bd = DEMOTED.has(b.name) ? 1 : 0;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
  }

  getTreeItem(node: FileNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.uri,
      node.isDir
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    // resourceUri is what makes the icon theme and the built-in git
    // decorations apply. The Uri constructor sets it too; being explicit keeps
    // that from looking accidental.
    item.resourceUri = node.uri;
    item.contextValue = node.isDir ? 'agentry.dir' : 'agentry.file';

    if (!node.isDir) {
      item.command = {
        command: 'vscode.open',
        title: vscode.l10n.t('Open File'),
        arguments: [node.uri],
      };
    }

    return item;
  }

  /** Short label for the view header, e.g. "api — main ↑2". */
  headerFor(): string | undefined {
    if (!this.scope) return undefined;
    const git = this.git.describe(this.scope);
    const name = basename(this.scope.path);
    return git ? `${name} — ${git}` : name;
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.scopeEmitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

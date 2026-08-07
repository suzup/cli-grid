import * as vscode from 'vscode';
import { setting } from './config.js';
import type { GitStatus } from './git.js';
import { basename, dirnameOf, exists, join } from './paths.js';
import type { AgentRegistry } from './registry.js';

/** Never worth expanding by default, and slow when they are huge. */
const DEMOTED = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '__pycache__']);

export class FileNode {
  constructor(
    readonly uri: vscode.Uri,
    readonly name: string,
    readonly isDir: boolean,
  ) {}

  /**
   * The folder this row stands for: itself, or the one holding it.
   *
   * Every operation that puts something somewhere — new file, paste, drop —
   * asks the same question of whatever row it was invoked on.
   */
  get folder(): vscode.Uri {
    return this.isDir ? this.uri : dirnameOf(this.uri);
  }
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
export class FilesTreeProvider
  implements vscode.TreeDataProvider<FileNode>, vscode.TreeDragAndDropController<FileNode>, vscode.Disposable
{
  /** Dragging out to an editor group, a terminal or another window. */
  readonly dragMimeTypes = ['text/uri-list'];

  /** `files` is what a drop from outside the window arrives as. */
  readonly dropMimeTypes = ['text/uri-list', 'files'];

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
        if (agent) this.follow(agent.folder);
      }),
    );
    this.reset();
  }

  /**
   * Follows an agent that has just been selected, started or focused.
   *
   * Every path that reacts to "the user is now looking at this agent" comes
   * through here, so `cliGrid.revealOnFocus` is honoured in one place rather
   * than at each of the call sites — one of which would always get forgotten.
   */
  follow(uri: vscode.Uri): void {
    if (setting('revealOnFocus')) this.setScope(uri);
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

    const showHidden = setting('showHiddenFiles');

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
    item.contextValue = node.isDir ? 'cliGrid.dir' : 'cliGrid.file';

    if (!node.isDir) {
      // Not `vscode.open`: that lands in whichever pane was last active, which
      // is normally an agent. This one goes beside the grid.
      item.command = {
        command: 'cliGrid.openFile',
        title: vscode.l10n.t('Open File'),
        arguments: [node.uri],
      };
    }

    return item;
  }

  /**
   * The workbench moves a `text/uri-list` anywhere a file can go: another
   * editor group, a terminal — which pastes the path — or another window.
   */
  handleDrag(source: readonly FileNode[], transfer: vscode.DataTransfer): void {
    transfer.set(
      'text/uri-list',
      new vscode.DataTransferItem(source.map((node) => node.uri.toString()).join('\r\n')),
    );
  }

  /**
   * Dropping onto the tree copies into the folder you dropped on — a file drops
   * into its parent folder, and dropping past the last row means the folder the
   * tree is showing.
   *
   * Always a copy, never a move: the source can be another repository, another
   * window or the desktop, and a move across those is not something to do to
   * someone by accident. A name that is taken gets " copy" added rather than
   * asking, so a drop never overwrites work either.
   */
  async handleDrop(
    target: FileNode | undefined,
    transfer: vscode.DataTransfer,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const into = target ? target.folder : this.scope;
    if (!into) return;

    const failures: string[] = [];
    let copied = 0;

    for (const source of await droppedUris(transfer)) {
      if (token.isCancellationRequested) break;
      if (contains(source, into)) {
        // Copying a folder into itself never terminates.
        failures.push(vscode.l10n.t('{0} contains the folder you dropped it on', basename(source.path)));
        continue;
      }
      try {
        await vscode.workspace.fs.copy(source, await freeName(into, basename(source.path)), {
          overwrite: false,
        });
        copied++;
      } catch (err) {
        failures.push(`${basename(source.path)}: ${String(err)}`);
      }
    }

    for (const file of await droppedFiles(transfer)) {
      if (token.isCancellationRequested) break;
      try {
        await vscode.workspace.fs.writeFile(await freeName(into, file.name), await file.data());
        copied++;
      } catch (err) {
        failures.push(`${file.name}: ${String(err)}`);
      }
    }

    if (copied) this.refresh();
    if (failures.length) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Could not copy {0}', failures.join(', ')),
      );
    }
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

/** How many files the name search collects before it gives up looking. */
const SEARCH_LIMIT = 10000;

export interface FileSearch {
  /** Shallowest first, so the top of the list is the top of the folder. */
  files: vscode.Uri[];
  /** True when the walk stopped at the limit rather than running out. */
  truncated: boolean;
}

/**
 * Every file under a folder, for searching one out by name.
 *
 * Its own walk rather than `workspace.findFiles`, which only ever searches the
 * folders the window was opened on. An agent regularly works somewhere outside
 * them — a worktree, a sibling checkout — and that gap is the reason this view
 * exists at all, so the search has to answer the same question the tree does.
 *
 * The folders the tree pushes to the bottom are skipped outright here: nobody
 * is looking for a file in `node_modules` by name, and walking it is most of
 * what a search like this would ever cost.
 */
export async function searchFiles(
  root: vscode.Uri,
  showHidden = setting('showHiddenFiles'),
): Promise<FileSearch> {
  const files: vscode.Uri[] = [];
  let level = [root];

  // Breadth-first, so hitting the limit costs the deepest files rather than
  // whichever branch happens to sort first — and a level is read in parallel,
  // which is what keeps a large tree from being read one directory at a time.
  while (level.length && files.length < SEARCH_LIMIT) {
    const read = await Promise.all(level.map((dir) => readDirectory(dir)));
    const next: vscode.Uri[] = [];

    for (const [dir, entries] of read) {
      for (const [name, type] of entries) {
        if (DEMOTED.has(name)) continue;
        if (!showHidden && name.startsWith('.')) continue;

        const uri = join(dir, name);

        // Only a real directory is descended into. A symlinked one is left out
        // of both the walk and the results: following it can loop back on
        // itself, and there is no name in there this search would miss.
        if (type & vscode.FileType.Directory) {
          if (type === vscode.FileType.Directory) next.push(uri);
          continue;
        }

        if (files.push(uri) >= SEARCH_LIMIT) return { files, truncated: true };
      }
    }

    level = next;
  }

  return { files, truncated: false };
}

/** The entries of a directory, paired with it; unreadable ones come back empty. */
async function readDirectory(
  dir: vscode.Uri,
): Promise<[vscode.Uri, [string, vscode.FileType][]]> {
  try {
    return [dir, await vscode.workspace.fs.readDirectory(dir)];
  } catch {
    return [dir, []];
  }
}

/** Resources in the drop that the file system can read directly. */
async function droppedUris(transfer: vscode.DataTransfer): Promise<vscode.Uri[]> {
  const list = await transfer.get('text/uri-list')?.asString();
  if (!list) return [];

  return list
    .split(/\r?\n/)
    .map((line) => line.trim())
    // A uri-list may carry comment lines, and empty ones at the end.
    .filter((line) => line && !line.startsWith('#'))
    .flatMap((line) => {
      try {
        return [vscode.Uri.parse(line, true)];
      } catch {
        return [];
      }
    });
}

/**
 * Files dropped from outside the window, which arrive as bytes.
 *
 * The workbench usually lists them under `text/uri-list` as well; those are
 * skipped here so a drop is not copied twice.
 */
async function droppedFiles(transfer: vscode.DataTransfer): Promise<vscode.DataTransferFile[]> {
  const known = new Set((await droppedUris(transfer)).map((uri) => uri.toString()));
  const files: vscode.DataTransferFile[] = [];

  transfer.forEach((item) => {
    const file = item.asFile();
    if (file && !(file.uri && known.has(file.uri.toString()))) files.push(file);
  });

  return files;
}

/** True when `inner` is `outer` itself or sits inside it. */
export function contains(outer: vscode.Uri, inner: vscode.Uri): boolean {
  const parent = outer.toString().replace(/\/+$/, '');
  const child = inner.toString().replace(/\/+$/, '');
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * `name` in `dir`, or the first "name copy" style variant that is free.
 *
 * `fs.copy` with `overwrite: false` would throw instead, and a drop is too easy
 * to do by accident for the answer to be an error dialog.
 */
export async function freeName(dir: vscode.Uri, name: string): Promise<vscode.Uri> {
  if (!(await exists(join(dir, name)))) return join(dir, name);

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';

  for (let n = 1; n < 100; n++) {
    const suffix = n === 1 ? ' copy' : ` copy ${n}`;
    const candidate = join(dir, `${stem}${suffix}${extension}`);
    if (!(await exists(candidate))) return candidate;
  }

  return join(dir, `${stem} copy ${Date.now()}${extension}`);
}

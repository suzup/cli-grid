import { promises as fs } from 'node:fs';
import Module from 'node:module';
import { URI } from 'vscode-uri';

/**
 * Makes `import * as vscode from 'vscode'` resolve to a stand-in, so the parts
 * of the extension that are not workbench UI can be tested in plain node.
 *
 * `vscode` is injected by the extension host and does not exist on disk, which
 * is normally why an extension can only be tested inside a real workbench.
 * Anything not provided here throws rather than quietly returning undefined, so
 * a test can never pass by exercising a stub that does nothing — and reaching
 * for a missing member is the signal that the code under test wants the real
 * workbench, and belongs in the manual pass instead.
 *
 * Two things are deliberately real rather than faked:
 *
 * - `Uri` is `vscode-uri`, the implementation VS Code itself exports, so
 *   `fsPath`, `with` and the parsing rules behave identically.
 * - `workspace.fs` goes to the actual file system. Tests work in a temp
 *   directory, which is cheap, and it means copy, delete and directory reads
 *   are tested rather than imitated.
 *
 * Import this module before the module under test — the compiler keeps
 * `require` calls in source order, so it patches before anything asks for it.
 */

/** What a test can set up and inspect. `reset()` clears it between tests. */
export const state = {
  /** Settings by full id, e.g. `cliGrid.defaultMode`. */
  settings: new Map<string, unknown>(),
  /** Messages the code tried to show the user, newest last. */
  messages: [] as string[],
  /** Commands the extension has registered, by id. */
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  /** Commands it has asked the workbench to run, in order. */
  executed: [] as string[],
  /** The folders this window has open, which `updateWorkspaceFolders` edits. */
  folders: [] as { uri: URI; name: string; index: number }[],
  /** What the code offered the user, and which button a test wants pressed. */
  prompts: [] as string[],
  answer: undefined as string | undefined,
  /** The last list the code put in front of the user, newest last. */
  picks: [] as { label: string }[][],
};

export function reset(): void {
  state.settings.clear();
  state.messages.length = 0;
  state.commands.clear();
  state.executed.length = 0;
  state.folders.length = 0;
  state.prompts.length = 0;
  state.answer = undefined;
  state.picks.length = 0;
  folderChanges.dispose();
}

const noop = { dispose() {} };

/** Enough of `Event`/`EventEmitter` for the providers to be constructed. */
class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** An `Event` nothing ever fires. */
const never = () => noop;

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

const workspaceFs = {
  async stat(uri: URI) {
    const stat = await fs.stat(uri.fsPath);
    return {
      type: stat.isDirectory() ? FileType.Directory : FileType.File,
      ctime: stat.ctimeMs,
      mtime: stat.mtimeMs,
      size: stat.size,
    };
  },
  async readFile(uri: URI): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(uri.fsPath));
  },
  async writeFile(uri: URI, data: Uint8Array): Promise<void> {
    await fs.writeFile(uri.fsPath, data);
  },
  async readDirectory(uri: URI): Promise<[string, number][]> {
    const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((e) => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]);
  },
  async createDirectory(uri: URI): Promise<void> {
    await fs.mkdir(uri.fsPath, { recursive: true });
  },
  async copy(from: URI, to: URI, options?: { overwrite?: boolean }): Promise<void> {
    await fs.cp(from.fsPath, to.fsPath, {
      recursive: true,
      force: options?.overwrite ?? false,
      errorOnExist: !options?.overwrite,
    });
  },
  async delete(uri: URI, options?: { recursive?: boolean }): Promise<void> {
    await fs.rm(uri.fsPath, { recursive: options?.recursive ?? false });
  },
};

const configuration = (section: string) => ({
  get<T>(key: string, fallback: T): T {
    const value = state.settings.get(`${section}.${key}`);
    return value === undefined ? fallback : (value as T);
  },
  update(key: string, value: unknown): Promise<void> {
    state.settings.set(`${section}.${key}`, value);
    return Promise.resolve();
  },
});

const record = (message: string) => {
  state.messages.push(message);
  return Promise.resolve(undefined);
};

/**
 * The real `showWarningMessage` hands back the button that was pressed, and the
 * code under test does different things depending on which. A test says in
 * advance which one the user picks.
 */
const ask = (message: string, ...rest: unknown[]) => {
  state.prompts.push(message);
  const buttons = rest.filter((item): item is string => typeof item === 'string');
  return Promise.resolve(buttons.find((button) => button === state.answer));
};

/**
 * Records the list and picks the item a test named through `state.answer`.
 * Nothing picked is a user pressing escape, which callers have to handle.
 */
const pick = <T extends { label: string }>(items: T[] | Promise<T[]>) =>
  Promise.resolve(items).then((list) => {
    state.picks.push(list);
    return list.find((item) => item.label === state.answer);
  });

const folderChanges = new EventEmitter<{
  added: readonly unknown[];
  removed: readonly unknown[];
}>();

/** The splice the real one does, plus the event the workbench would fire. */
function updateWorkspaceFolders(
  start: number,
  deleteCount: number | null,
  ...added: { uri: URI }[]
): boolean {
  const removed = state.folders.splice(
    start,
    deleteCount ?? 0,
    ...added.map((folder, offset) => ({
      uri: folder.uri,
      name: folder.uri.path.split('/').filter(Boolean).pop() ?? '',
      index: start + offset,
    })),
  );
  state.folders.forEach((folder, index) => (folder.index = index));
  // The workbench applies it and then says so, which is what the code waits on.
  queueMicrotask(() => folderChanges.fire({ added, removed }));
  return true;
}

const members: Record<string, unknown> = {
  Uri: URI,
  FileType,
  EventEmitter,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
  ThemeColor: class { constructor(public id: string) {} },
  MarkdownString: class { constructor(public value?: string) {} },
  TreeItem: class { constructor(public label: unknown, public collapsibleState?: number) {} },
  workspace: {
    fs: workspaceFs,
    getConfiguration: configuration,
    get workspaceFolders() {
      return state.folders.length ? state.folders : undefined;
    },
    getWorkspaceFolder(uri: URI) {
      const path = uri.path.replace(/\/+$/, '');
      return state.folders.find(
        (folder) => path === folder.uri.path || path.startsWith(`${folder.uri.path}/`),
      );
    },
    updateWorkspaceFolders,
    onDidChangeWorkspaceFolders: folderChanges.event,
    onDidChangeConfiguration: never,
    createFileSystemWatcher: () => ({
      onDidCreate: never,
      onDidChange: never,
      onDidDelete: never,
      dispose() {},
    }),
  },
  window: {
    showInformationMessage: record,
    showQuickPick: pick,
    showWarningMessage: ask,
    showErrorMessage: record,
    activeTerminal: undefined,
    terminals: [],
    onDidChangeActiveTerminal: never,
    onDidCloseTerminal: never,
    tabGroups: { all: [], onDidChangeTabs: never },
    createTreeView: () => ({ selection: [], description: undefined, dispose() {} }),
    registerTerminalLinkProvider: () => noop,
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
  },
  commands: {
    registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
      state.commands.set(id, handler);
      return noop;
    },
    executeCommand(id: string) {
      state.executed.push(id);
      return Promise.resolve(undefined);
    },
  },
  extensions: {
    // No Git extension in a bare node process, which `GitStatus` handles.
    getExtension: () => undefined,
  },
  l10n: {
    /** The real one substitutes `{0}`; nothing here needs the bundle. */
    t: (message: string, ...args: unknown[]) =>
      message.replace(/\{(\d+)\}/g, (whole, index: string) => {
        const arg = args[Number(index)];
        return arg === undefined ? whole : String(arg);
      }),
  },
};

const api = new Proxy(members, {
  get(target, name) {
    if (typeof name !== 'string') return undefined;
    if (name in target) return target[name];
    // The compiler's interop helpers probe for these before anything real is
    // read; they are not part of the API surface and must not be a failure.
    if (name.startsWith('__') || name === 'default' || name === 'then') return undefined;
    throw new Error(
      `The vscode stub has no "${name}". Add it in src/test/vscode.ts, or test ` +
        'something that does not reach the workbench.',
    );
  },
});

interface Loader {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}

const loader = Module as unknown as Loader;
const original = loader._load;
loader._load = function (request, parent, isMain) {
  if (request === 'vscode') return api;
  return original.call(this, request, parent, isMain);
};

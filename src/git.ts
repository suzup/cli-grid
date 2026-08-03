import * as vscode from 'vscode';

/**
 * Minimal shape of the built-in Git extension's exported API.
 *
 * Only the members Agentry reads are declared, so a change elsewhere in
 * `git.d.ts` cannot break the build.
 */
interface GitExtensionExports {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitApi;
}

interface GitApi {
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
  getRepositoryRoot(uri: vscode.Uri): Promise<vscode.Uri | null>;
  openRepository(root: vscode.Uri): Promise<GitRepository | null>;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: { name?: string; ahead?: number; behind?: number };
    readonly workingTreeChanges: readonly unknown[];
    readonly indexChanges: readonly unknown[];
    readonly mergeChanges: readonly unknown[];
    readonly untrackedChanges?: readonly unknown[];
    readonly onDidChange: vscode.Event<void>;
  };
}

export interface RepoSummary {
  branch?: string;
  ahead: number;
  behind: number;
  changes: number;
}

/**
 * Reads branch and change counts from the built-in Git extension rather than
 * shelling out, so Agentry stays consistent with what the SCM view shows.
 */
export class GitStatus implements vscode.Disposable {
  private api: GitApi | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repoWatchers = new Map<string, vscode.Disposable>();
  /** Folders already handed to `openRepository`, so it is attempted once each. */
  private readonly tracked = new Set<string>();

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor() {
    void this.connect();
  }

  private async connect(): Promise<void> {
    const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!extension) return;

    const exports = extension.isActive ? extension.exports : await extension.activate();
    if (!exports.enabled) {
      this.disposables.push(
        exports.onDidChangeEnablement((enabled) => {
          if (enabled) void this.connect();
        }),
      );
      return;
    }

    this.api = exports.getAPI(1);
    for (const repo of this.api.repositories) this.watch(repo);
    this.disposables.push(
      this.api.onDidOpenRepository((repo) => {
        this.watch(repo);
        this.changeEmitter.fire();
      }),
      this.api.onDidCloseRepository((repo) => {
        const key = repo.rootUri.toString();
        this.repoWatchers.get(key)?.dispose();
        this.repoWatchers.delete(key);
        this.changeEmitter.fire();
      }),
    );
    this.changeEmitter.fire();
  }

  private watch(repo: GitRepository): void {
    const key = repo.rootUri.toString();
    if (this.repoWatchers.has(key)) return;
    this.repoWatchers.set(
      key,
      repo.state.onDidChange(() => this.changeEmitter.fire()),
    );
  }

  /**
   * Makes a folder's repository visible to the Git extension.
   *
   * It only opens repositories inside the workspace on its own, so an agent
   * pointed at a folder elsewhere would otherwise have no branch and no file
   * decorations. Opening it explicitly is what the Git API's `openRepository`
   * is for, and it also lights up the built-in decorations for those files.
   */
  async track(uri: vscode.Uri): Promise<void> {
    if (!this.api) return;
    const key = uri.toString();
    if (this.tracked.has(key)) return;
    this.tracked.add(key);

    if (this.api.getRepository(uri)) return;

    try {
      const root = (await this.api.getRepositoryRoot(uri)) ?? uri;
      const repo = await this.api.openRepository(root);
      if (repo) {
        this.watch(repo);
        this.changeEmitter.fire();
      }
    } catch {
      // Not a repository, or git is unavailable — nothing to show either way.
    }
  }

  summary(uri: vscode.Uri): RepoSummary | undefined {
    const repo = this.api?.getRepository(uri);
    if (!repo) return undefined;

    const { HEAD, workingTreeChanges, indexChanges, mergeChanges, untrackedChanges } = repo.state;
    return {
      ...(HEAD?.name ? { branch: HEAD.name } : {}),
      ahead: HEAD?.ahead ?? 0,
      behind: HEAD?.behind ?? 0,
      changes:
        workingTreeChanges.length +
        indexChanges.length +
        mergeChanges.length +
        (untrackedChanges?.length ?? 0),
    };
  }

  /** Compact one-liner for a tree item description, e.g. "main ↑2 · 3". */
  describe(uri: vscode.Uri): string | undefined {
    const summary = this.summary(uri);
    if (!summary?.branch) return undefined;

    const parts = [summary.branch];
    if (summary.ahead) parts.push(`↑${summary.ahead}`);
    if (summary.behind) parts.push(`↓${summary.behind}`);

    const head = parts.join(' ');
    return summary.changes ? `${head} · ${summary.changes}` : head;
  }

  dispose(): void {
    this.changeEmitter.dispose();
    for (const d of this.repoWatchers.values()) d.dispose();
    this.repoWatchers.clear();
    this.tracked.clear();
    for (const d of this.disposables) d.dispose();
  }
}

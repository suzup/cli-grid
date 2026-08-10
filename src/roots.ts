import * as vscode from 'vscode';
import { resolveFolder } from './paths.js';
import {
  removeAgentFromConfig,
  type AgentSpec,
  type ProjectWatcher,
} from './project.js';
import type { AgentRegistry } from './registry.js';

/**
 * The window's folder list, kept in step with the agents.
 *
 * An agent works in a folder, and until the window is told about that folder
 * nothing built into the workbench can see it: no entry in Source Control, so
 * nowhere to commit or push from; nothing in the Explorer; nothing for quick
 * open or a project-wide search to look through. Adding it as a workspace
 * folder is what makes all of that appear, and none of it is CLI Grid's to
 * reimplement.
 *
 * So the agent list and the folder list are one list seen twice, and this keeps
 * both directions honest: an agent's folder is put in when the agent is, and a
 * folder taken out of the window takes its agent with it.
 *
 * The project file stays where the setup lives, so the way in is still opening
 * the folder — the list is rebuilt from it on the way up rather than being
 * something the user has to save and reopen.
 */
export class WorkspaceRoots implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * Which agent works in which folder, as of the last settled config.
   *
   * Remembered rather than asked for, because the question is only ever put
   * while a folder is being removed — and the same event has the project
   * watcher re-reading the config, so what it can answer at that moment is
   * whatever its reload happens to have reached. This is the state from before.
   */
  private known = new Map<string, { root: vscode.Uri; spec: AgentSpec }>();

  constructor(
    private readonly projects: ProjectWatcher,
    private readonly registry: AgentRegistry,
  ) {
    this.remember();
    this.disposables.push(
      projects.onDidChange(() => this.remember()),
      vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        if (event.removed.length) void this.folderRemoved(event.removed);
      }),
    );
  }

  private remember(): void {
    this.known = new Map(
      this.projects.projects().flatMap((project) =>
        project.config.agents.map(
          (spec) =>
            [
              resolveFolder(project.uri, spec.folder).toString(),
              { root: project.uri, spec },
            ] as const,
        ),
      ),
    );
  }

  /**
   * Puts every configured agent's folder in the window.
   *
   * Never at index 0: replacing the first folder is the case the API says
   * restarts the extension host, which would take every running agent with it.
   * Appending has been measured not to, even when it turns a single-folder
   * window into a multi-folder one.
   */
  async sync(): Promise<void> {
    const wanted = this.agentFolders().filter((uri) => !this.covers(uri));
    if (!wanted.length) return;
    await this.append(wanted);
  }

  /** The folder an agent has just been given, if the window has no claim on it. */
  async add(folder: vscode.Uri): Promise<void> {
    if (this.covers(folder)) return;
    await this.append([folder]);
  }

  /**
   * Takes a folder back out, once nothing in the project works in it.
   *
   * Called after the agent has left the config, so the removal this causes
   * finds nothing to ask about and stops there.
   */
  async remove(folder: vscode.Uri): Promise<void> {
    if (this.agentFolders().some((uri) => uri.toString() === folder.toString())) return;

    const at = (vscode.workspace.workspaceFolders ?? []).findIndex(
      (existing) => existing.uri.toString() === folder.toString(),
    );
    // Index 0 is the folder the window was opened on — the project itself, and
    // not ours to close.
    if (at < 1) return;
    vscode.workspace.updateWorkspaceFolders(at, 1);
  }

  /**
   * The other direction: a folder dragged out of the window in the Explorer.
   *
   * "Remove Folder from Workspace" reads as hiding something, so the agents it
   * would take with it — their CLI, their mode, the name they were given — are
   * named and asked about once rather than quietly dropped. Declining leaves
   * them configured; the folder comes back the next time the project opens.
   */
  private async folderRemoved(removed: readonly vscode.WorkspaceFolder[]): Promise<void> {
    const orphans = removed.flatMap((folder) => this.known.get(folder.uri.toString()) ?? []);
    if (!orphans.length) return;

    const names = orphans.map(({ spec }) => spec.name?.trim() || spec.folder).join(', ');
    const remove = vscode.l10n.t('Remove');
    const answer = await vscode.window.showWarningMessage(
      orphans.length === 1
        ? vscode.l10n.t('Remove the agent in {0} from this project too?', names)
        : vscode.l10n.t('Remove these agents from this project too? {0}', names),
      { modal: true, detail: vscode.l10n.t('Their settings go with them. The folders themselves are untouched.') },
      remove,
    );
    if (answer !== remove) return;

    for (const { root, spec } of orphans) {
      const running = this.registry.find(root, spec.folder, spec.cli);
      if (running) this.registry.stop(running.id);
      await removeAgentFromConfig(root, spec);
    }
    await this.projects.refresh();
  }

  /** Absolute folders of every agent written down in this window's projects. */
  private agentFolders(): vscode.Uri[] {
    this.remember();
    return [...this.known.values()].map(({ root, spec }) => resolveFolder(root, spec.folder));
  }

  /**
   * Whether the window already reaches a folder.
   *
   * A folder inside one that is already open needs no root of its own — the
   * Explorer shows it, and the search and Source Control already cover it.
   */
  private covers(folder: vscode.Uri): boolean {
    return Boolean(vscode.workspace.getWorkspaceFolder(folder));
  }

  private async append(folders: readonly vscode.Uri[]): Promise<void> {
    const start = vscode.workspace.workspaceFolders?.length ?? 0;
    // Nothing is open, so this would be index 0 — the restart case. There is
    // also no project to have agents in, so there is nothing to lose by it.
    if (!start) return;

    const added = vscode.workspace.updateWorkspaceFolders(
      start,
      null,
      ...folders.map((uri) => ({ uri })),
    );
    if (!added) return;

    // The workbench applies the change asynchronously, and a caller that goes
    // straight on to launch an agent in one of these folders needs it to have
    // landed — Source Control and the Explorer pick it up from here.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, 2000);
      const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => finish());
      function finish() {
        clearTimeout(timer);
        sub.dispose();
        resolve();
      }
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

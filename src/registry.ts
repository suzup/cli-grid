import * as vscode from 'vscode';
import { setting } from './config.js';
import { basename } from './paths.js';
import type { AgentProfile, LaunchMode, RunningAgent } from './types.js';

let counter = 0;

export interface LaunchTarget {
  root: vscode.Uri;
  folderRef: string;
  folder: vscode.Uri;
  /** The name the agent was given, if any; the folder name stands in for it. */
  name?: string;
  /** 1-based editor group the terminal should open in. */
  viewColumn?: number;
}

/**
 * What the tab says: the agent first, the CLI after.
 *
 * The same way round as the row in the view, and for the same reason — with
 * four panes open, which agent a tab belongs to is what you are scanning for,
 * and every one of them says Claude Code.
 */
export function terminalName(profile: AgentProfile, target: LaunchTarget): string {
  return `${target.name?.trim() || basename(target.folder.path)} · ${profile.label}`;
}

/** Tracks which terminal is which agent. Config lives in the project file. */
export class AgentRegistry implements vscode.Disposable {
  private readonly agents = new Map<string, RunningAgent>();
  private readonly disposables: vscode.Disposable[] = [];

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor() {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => this.forget(terminal)),
      vscode.window.onDidChangeActiveTerminal(() => this.changeEmitter.fire()),
      // The backstop for the line above. A terminal that has gone leaves a
      // closed tab behind whatever else happens, so this is the event that says
      // "look again" when the one about the terminal itself does not arrive.
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        if (event.closed.length) this.prune();
      }),
    );
  }

  list(): RunningAgent[] {
    this.prune();
    return [...this.agents.values()];
  }

  /**
   * Drops agents whose terminal the workbench no longer has.
   *
   * `onDidCloseTerminal` is how one normally leaves, and this is the check that
   * it arrived. Closing a pane and being left with a row that still says
   * "running" is worse than a row that updates late: the only thing left to do
   * with it is press stop on something that stopped a while ago, and until then
   * every count, layout pass and lock is working from an agent that is not
   * there. `window.terminals` is the workbench's own answer, so it cannot drift.
   */
  private prune(): void {
    if (!this.agents.size) return;

    const live = new Set<vscode.Terminal>(vscode.window.terminals);
    let dropped = false;
    for (const [id, agent] of this.agents) {
      if (live.has(agent.terminal)) continue;
      this.agents.delete(id);
      dropped = true;
    }

    // After this pass rather than during it: `list` is called from tree
    // rendering, and firing there would re-enter the render that asked.
    if (dropped) queueMicrotask(() => this.changeEmitter.fire());
  }

  inProject(root: vscode.Uri): RunningAgent[] {
    const key = root.toString();
    return this.list().filter((a) => a.root.toString() === key);
  }

  /** The running instance of a configured agent, if it is up. */
  find(root: vscode.Uri, folderRef: string, profileId: string): RunningAgent | undefined {
    return this.list().find(
      (a) =>
        a.root.toString() === root.toString() &&
        a.folderRef === folderRef &&
        a.profileId === profileId,
    );
  }

  byTerminal(terminal: vscode.Terminal): RunningAgent | undefined {
    return this.list().find((a) => a.terminal === terminal);
  }

  launch(profile: AgentProfile, mode: LaunchMode, target: LaunchTarget): RunningAgent {
    const strategy = setting('launchStrategy');

    const args = mode === 'resume' ? profile.args.resume : profile.args.new;

    const options: vscode.TerminalOptions = {
      name: terminalName(profile, target),
      cwd: target.folder,
      iconPath: new vscode.ThemeIcon(profile.icon),
      isTransient: true,
      ...(profile.color ? { color: new vscode.ThemeColor(profile.color) } : {}),
      ...(profile.env ? { env: profile.env } : {}),
      location: { viewColumn: target.viewColumn ?? vscode.ViewColumn.Active },
      ...(strategy === 'exec' ? { shellPath: profile.command, shellArgs: args } : {}),
    };

    const terminal = vscode.window.createTerminal(options);

    if (strategy === 'shell') {
      // Going through a login shell is what makes nvm/mise/~/.local/bin work.
      terminal.sendText([profile.command, ...args].map(quoteArg).join(' '), true);
    }

    const agent: RunningAgent = {
      id: `agent-${++counter}`,
      profileId: profile.id,
      label: profile.label,
      mode,
      root: target.root,
      folderRef: target.folderRef,
      folder: target.folder,
      terminal,
      startedAt: Date.now(),
    };

    this.agents.set(agent.id, agent);
    this.changeEmitter.fire();
    return agent;
  }

  stop(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.terminal.dispose();
    this.agents.delete(id);
    this.changeEmitter.fire();
  }

  private forget(terminal: vscode.Terminal): void {
    const agent = this.byTerminal(terminal);
    if (!agent) return;
    this.agents.delete(agent.id);
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/**
 * Best-effort shell quoting for the command typed into the terminal.
 * Arguments come from user config, so spaces and quotes must survive.
 */
function quoteArg(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_\-./:=@]+$/.test(arg)) return arg;

  if (process.platform === 'win32') {
    return `"${arg.replace(/(["\\])/g, '\\$1')}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

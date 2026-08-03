import * as vscode from 'vscode';
import { basename } from './paths.js';
import type { AgentProfile, LaunchMode, RunningAgent } from './types.js';

let counter = 0;

export interface LaunchTarget {
  root: vscode.Uri;
  folderRef: string;
  folder: vscode.Uri;
  /** 1-based editor group the terminal should open in. */
  viewColumn?: number;
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
    );
  }

  list(): RunningAgent[] {
    return [...this.agents.values()];
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
    const strategy = vscode.workspace
      .getConfiguration('agentGrid')
      .get<'shell' | 'exec'>('launchStrategy', 'shell');

    const folderName = basename(target.folder.path);
    const args = mode === 'resume' ? profile.args.resume : profile.args.new;

    const options: vscode.TerminalOptions = {
      name: `${profile.label} · ${folderName}`,
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

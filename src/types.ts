import type * as vscode from 'vscode';

/**
 * Whether a CLI is started fresh or told to pick up its previous conversation.
 * CLI Grid never reads or writes conversation state — it only decides which
 * arguments to pass, and the CLI owns everything after that.
 */
export type LaunchMode = 'new' | 'resume';

export interface ProfileArgs {
  new: string[];
  resume: string[];
}

export interface AgentProfile {
  id: string;
  label: string;
  command: string;
  args: ProfileArgs;
  defaultMode?: LaunchMode;
  /** Codicon id, e.g. "sparkle". */
  icon: string;
  /** Theme colour id used for the terminal tab, e.g. "terminal.ansiYellow". */
  color?: string;
  env?: Record<string, string>;
  /**
   * Keys to press after a message has been typed and submitted, for a CLI that
   * is busy: on its own, Enter only queues the message behind the work it is
   * meant to interrupt.
   */
  sendNow?: string[];
  /**
   * Keys that stop a busy CLI, pressed before the message is typed: for one
   * whose prompt has no way to take a queued message at once, the message goes
   * to a CLI that has stopped instead. Pressed to an idle one, they must do
   * nothing.
   */
  interrupt?: string[];
  hidden?: boolean;
}

/** What `cliGrid.profiles` may set: any part of a profile, over a built-in one. */
export interface ProfileOverride {
  label?: string;
  command?: string;
  args?: Partial<ProfileArgs>;
  defaultMode?: LaunchMode;
  icon?: string;
  color?: string;
  env?: Record<string, string>;
  sendNow?: string[];
  interrupt?: string[];
  hidden?: boolean;
}

export interface RunningAgent {
  /** Also what the terminal carries as `CLI_GRID_AGENT`. */
  id: string;
  profileId: string;
  label: string;
  mode: LaunchMode;
  /** Project root — the opened folder whose config declares this agent. */
  root: vscode.Uri;
  /** Config-relative folder reference, e.g. "." or "api". */
  folderRef: string;
  /** Absolute folder the CLI runs in. */
  folder: vscode.Uri;
  terminal: vscode.Terminal;
  startedAt: number;
}

export interface LayoutPreset {
  id: string;
  label: string;
  detail: string;
  /** Column count per row: [2, 2] is a 2x2 grid. */
  rows: number[];
}

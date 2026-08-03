import type * as vscode from 'vscode';

/**
 * Whether a CLI is started fresh or told to pick up its previous conversation.
 * Agent Grid never reads or writes conversation state — it only decides which
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
  hidden?: boolean;
}

/** A profile with `resume` args is the only kind that can offer resume mode. */
export function supportsMode(profile: AgentProfile, mode: LaunchMode): boolean {
  return mode === 'new' || profile.args.resume.length > 0;
}

export interface RunningAgent {
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

export const LAYOUT_PRESETS: LayoutPreset[] = [
  { id: 'single', label: '1', detail: 'Single pane', rows: [1] },
  { id: 'grid-2x1', label: '2 × 1', detail: 'Two columns', rows: [2] },
  { id: 'grid-1x2', label: '1 × 2', detail: 'Two rows', rows: [1, 1] },
  { id: 'grid-3x1', label: '3 × 1', detail: 'Three columns', rows: [3] },
  { id: 'grid-2x2', label: '2 × 2', detail: 'Four panes', rows: [2, 2] },
  { id: 'grid-3x2', label: '3 × 2', detail: 'Six panes', rows: [3, 3] },
  { id: 'grid-4x2', label: '4 × 2', detail: 'Eight panes', rows: [4, 4] },
];

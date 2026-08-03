import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { AgentProfile, LaunchMode, ProfileArgs } from './types.js';

/**
 * Built-in profiles. Arguments were taken from each CLI's own documentation:
 *
 * - claude: `--continue` reloads the most recent conversation in the cwd,
 *   `--resume` opens the CLI's own session picker.
 * - codex:  `resume` is a subcommand; `--last` skips its picker.
 * - gemini: `--resume` opens its picker; it has no "most recent" shortcut.
 *
 * Resume defaults are deliberately absent: `claude --continue` exits with an
 * error in a folder that has no prior conversation, so opting in is the user's
 * call rather than ours.
 */
const BUILT_IN: AgentProfile[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    args: { new: [], resume: ['--continue'] },
    icon: 'sparkle',
    color: 'terminal.ansiYellow',
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    args: { new: [], resume: ['resume', '--last'] },
    icon: 'rocket',
    color: 'terminal.ansiGreen',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    command: 'gemini',
    args: { new: [], resume: ['--resume'] },
    icon: 'star-full',
    color: 'terminal.ansiBlue',
  },
];

interface ProfileOverride {
  label?: string;
  command?: string;
  args?: Partial<ProfileArgs>;
  defaultMode?: LaunchMode;
  icon?: string;
  color?: string;
  env?: Record<string, string>;
  hidden?: boolean;
}

export function readProfiles(): AgentProfile[] {
  const overrides = vscode.workspace
    .getConfiguration('agentry')
    .get<Record<string, ProfileOverride>>('profiles', {});

  const merged = new Map<string, AgentProfile>();
  for (const base of BUILT_IN) merged.set(base.id, { ...base });

  for (const [id, override] of Object.entries(overrides ?? {})) {
    const base = merged.get(id);
    if (!override?.command && !base) continue; // custom entries must name a command

    merged.set(id, {
      id,
      label: override.label ?? base?.label ?? id,
      command: override.command ?? base?.command ?? id,
      args: {
        new: override.args?.new ?? base?.args.new ?? [],
        resume: override.args?.resume ?? base?.args.resume ?? [],
      },
      ...(override.defaultMode ?? base?.defaultMode
        ? { defaultMode: override.defaultMode ?? base?.defaultMode }
        : {}),
      icon: override.icon ?? base?.icon ?? 'terminal',
      ...(override.color ?? base?.color ? { color: override.color ?? base?.color } : {}),
      ...(override.env ?? base?.env ? { env: { ...base?.env, ...override.env } } : {}),
      ...(override.hidden !== undefined ? { hidden: override.hidden } : {}),
    });
  }

  return [...merged.values()].filter((p) => !p.hidden);
}

export function findProfile(id: string): AgentProfile | undefined {
  return readProfiles().find((p) => p.id === id);
}

export function defaultMode(profile: AgentProfile): LaunchMode {
  const global = vscode.workspace
    .getConfiguration('agentry')
    .get<LaunchMode>('defaultMode', 'new');
  return profile.defaultMode ?? global;
}

/** The mode an agent will actually start in, once every default is applied. */
export function effectiveMode(profileId: string, declared?: LaunchMode): LaunchMode {
  if (declared) return declared;
  const profile = findProfile(profileId);
  return profile ? defaultMode(profile) : 'new';
}

/* ---------------------------- availability ---------------------------- */

const availability = new Map<string, boolean>();

/**
 * Resolves a command the way the user's shell would.
 *
 * The extension host's PATH often misses nvm, mise and `~/.local/bin`, so a
 * plain PATH scan reports false negatives for exactly the CLIs we care about.
 * A login shell gets the same answer the terminal would.
 */
export async function isAvailable(command: string): Promise<boolean> {
  const cached = availability.get(command);
  if (cached !== undefined) return cached;

  const result = await new Promise<boolean>((resolve) => {
    const isWindows = process.platform === 'win32';
    const [file, args] = isWindows
      ? ['where', [command]]
      : [process.env.SHELL ?? '/bin/bash', ['-lc', `command -v ${JSON.stringify(command)}`]];

    execFile(
      file as string,
      args as string[],
      { timeout: 5000, windowsHide: true, cwd: os.homedir() },
      (err, stdout) => resolve(!err && stdout.trim().length > 0),
    );
  });

  availability.set(command, result);
  return result;
}

export function clearAvailabilityCache(): void {
  availability.clear();
}

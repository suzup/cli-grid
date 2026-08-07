import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { profileOverrides, setting } from './config.js';
import type { AgentProfile, LaunchMode } from './types.js';

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

/**
 * The built-ins with `cliGrid.profiles` applied over them.
 *
 * Memoised: `findProfile` is called per tree row per refresh, and each call
 * would otherwise re-read the settings and rebuild every profile. The cache is
 * dropped whenever the setting changes.
 */
let merged: AgentProfile[] | undefined;

export function readProfiles(): AgentProfile[] {
  return (merged ??= mergeProfiles());
}

function mergeProfiles(): AgentProfile[] {
  const overrides = profileOverrides();

  const byId = new Map<string, AgentProfile>();
  for (const base of BUILT_IN) byId.set(base.id, { ...base });

  for (const [id, override] of Object.entries(overrides ?? {})) {
    const base = byId.get(id);
    if (!override?.command && !base) continue; // custom entries must name a command

    byId.set(id, {
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

  return [...byId.values()].filter((p) => !p.hidden);
}

/** A profile with `resume` args is the only kind that can offer resume mode. */
export function supportsMode(profile: AgentProfile, mode: LaunchMode): boolean {
  return mode === 'new' || profile.args.resume.length > 0;
}

export function findProfile(id: string): AgentProfile | undefined {
  return readProfiles().find((p) => p.id === id);
}

export function defaultMode(profile: AgentProfile): LaunchMode {
  return profile.defaultMode ?? setting('defaultMode');
}

/**
 * The mode an agent will actually start in, once every default is applied.
 *
 * The one place that rule lives: a one-off override or what the project file
 * says, then the profile's own default, then the global setting. Callers that
 * already hold the profile pass it, so the tree does not look it up per row.
 */
export function effectiveMode(
  profile: AgentProfile | string | undefined,
  declared?: LaunchMode,
): LaunchMode {
  if (declared) return declared;
  const resolved = typeof profile === 'string' ? findProfile(profile) : profile;
  return resolved ? defaultMode(resolved) : 'new';
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

/**
 * Forgets both caches.
 *
 * They are dropped together on purpose: a changed `command` is exactly the case
 * where a remembered "not on PATH" would be wrong about the new one.
 */
export function clearProfileCache(): void {
  merged = undefined;
  availability.clear();
}

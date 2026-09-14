import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Finding and ending Claude sessions that are already running in VS Code.
 *
 * `claude --continue` reopens the conversation the folder last had, and it will
 * happily do so while that conversation is live in another window — two
 * processes on one session break Claude's Remote Control, which can no longer
 * tell which one is "the" client. So before this extension resumes a session it
 * has to find the other process, end it, and close the terminal it ran in.
 *
 * Everything here is read from `/proc` and the config dir because the answer is
 * machine state, not workbench state: the other window is a different VS Code
 * process with its own terminals, and nothing this extension can see knows
 * about it.
 *
 * No `vscode` import: this half is pure Linux process inspection, so it can be
 * tested without a workbench.
 */

/** How far up the process tree to walk looking for the terminal's pty host. */
const MAX_HOPS = 32;

/** Every process in a session, plus the terminal shell to close afterwards. */
export interface ProcessRef {
  pid: number;
  start: string;
}

export interface RunningSession extends ProcessRef {
  sessionId: string;
  /**
   * The VS Code terminal shell to close once claude is gone. Absent when claude
   * itself is the terminal's root process, or it is not under a pty host
   * (extension panel, unknown host).
   */
  shell?: ProcessRef;
}

/**
 * The machine, behind an interface.
 *
 * Every read is here so `findVsCodeSessions` and `endSessions` can be pointed
 * at a fixture instead of the real `/proc` and the real sessions directory —
 * the alternative is a test that kills the developer's own sessions.
 */
export interface ProcessHost {
  /** Raw contents of `<configDir>/sessions/*.json`. Unreadable files skipped. */
  sessionFiles(): Promise<string[]>;
  /** `/proc/<pid>/stat` fields 4 and 22, or undefined if the process is gone. */
  stat(pid: number): Promise<{ ppid: number; start: string } | undefined>;
  /** `/proc/<pid>/environ`, NUL-split. Empty when unreadable. */
  environ(pid: number): Promise<string[]>;
  /** `/proc/<pid>/cmdline` with NULs as spaces. Empty when unreadable. */
  cmdline(pid: number): Promise<string>;
  /** fs.realpath, falling back to the input when the path is gone. */
  realpath(p: string): Promise<string>;
  /** A signal, best effort: a process that is already gone is not an error. */
  kill(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
}

/** The real machine. `configDir` defaults to Claude's own resolution order. */
export function linuxHost(configDir?: string): ProcessHost {
  const dir = configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const sessions = join(dir, 'sessions');

  return {
    async sessionFiles(): Promise<string[]> {
      let names: string[];
      try {
        names = await fs.readdir(sessions);
      } catch {
        return []; // No config dir yet is the same as no sessions.
      }

      const files = await Promise.all(
        names
          .filter((name) => name.endsWith('.json'))
          .map(async (name) => {
            try {
              return await fs.readFile(join(sessions, name), 'utf8');
            } catch {
              return undefined; // A file that vanished mid-read, or no access.
            }
          }),
      );
      return files.filter((text): text is string => text !== undefined);
    },

    async stat(pid: number) {
      let text: string;
      try {
        text = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      } catch {
        return undefined;
      }

      // The comm field is wrapped in parens and may itself contain spaces and
      // parens, so the fields start after the last ')', not the first space.
      const rest = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
      const ppid = Number(rest[1]);
      const start = rest[19];
      if (!Number.isInteger(ppid) || start === undefined) return undefined;
      return { ppid, start };
    },

    async environ(pid: number) {
      try {
        const text = await fs.readFile(`/proc/${pid}/environ`, 'utf8');
        return text.split('\0');
      } catch {
        return [];
      }
    },

    async cmdline(pid: number) {
      try {
        const text = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
        return text.replace(/\0/g, ' ');
      } catch {
        return '';
      }
    },

    async realpath(p: string) {
      try {
        return await fs.realpath(p);
      } catch {
        return p; // A path that is already gone is still itself for a compare.
      }
    },

    kill(pid: number, signal: NodeJS.Signals) {
      try {
        process.kill(pid, signal);
      } catch {
        // ESRCH: it left on its own. EPERM: not ours to signal. Neither is a
        // failure of the caller's intent.
      }
    },

    sleep(ms: number) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

/**
 * Claude sessions running inside VS Code with this cwd.
 *
 * "Inside VS Code" is the part that matters: a terminal opened outside a window
 * is the user's own and not this extension's to end, and nothing in the session
 * file distinguishes the two — the environment is what does. Never throws;
 * returns [] on anything that is not Linux.
 */
export async function findVsCodeSessions(
  folder: string,
  host: ProcessHost,
): Promise<RunningSession[]> {
  if (process.platform !== 'linux') return [];

  const target = await host.realpath(folder);
  const found = new Map<number, RunningSession>();

  for (const text of await host.sessionFiles()) {
    const session = await match(text, target, host);
    if (session) found.set(session.pid, session);
  }

  return [...found.values()];
}

/** One file's worth of the check. Undefined when the file is not a match. */
async function match(
  text: string,
  target: string,
  host: ProcessHost,
): Promise<RunningSession | undefined> {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined; // A half-written file from a process that just exited.
  }

  const { pid, cwd, procStart, sessionId, entrypoint } = record;
  if (typeof pid !== 'number' || !Number.isInteger(pid)) return undefined;
  if (typeof cwd !== 'string') return undefined;

  if ((await host.realpath(cwd)) !== target) return undefined;

  const stat = await host.stat(pid);
  if (!stat) return undefined;
  // A live pid is not enough: it may be some unrelated process that took the
  // number after this session died. The start time is what pins it.
  if (typeof procStart === 'string' && procStart !== stat.start) return undefined;

  if (!(await inVsCode(pid, entrypoint, host))) return undefined;
  if (pid === process.pid) return undefined; // Never end ourselves.

  const session: RunningSession = {
    pid,
    start: stat.start,
    sessionId: typeof sessionId === 'string' ? sessionId : '',
  };
  const shell = await terminalShell(session, host);
  if (shell) session.shell = shell;
  return session;
}

/**
 * Whether the process is one of the window's, and not a terminal of the user's
 * own. The VS Code extension panel wears no TERM_PROGRAM but says so in its
 * entrypoint, which is the other half of the same question.
 */
async function inVsCode(
  pid: number,
  entrypoint: unknown,
  host: ProcessHost,
): Promise<boolean> {
  if (entrypoint === 'claude-vscode') return true;
  const env = await host.environ(pid);
  return env.some(
    (entry) => entry === 'TERM_PROGRAM=vscode' || entry.startsWith('VSCODE_IPC_HOOK_CLI='),
  );
}

/**
 * The terminal shell this claude was started from, if it has one.
 *
 * The chain is claude → claude-mux → the terminal's bash → the pty host, and
 * the shell to close is the one directly under the pty host. Going by the host
 * rather than by "looks like bash" is what separates a terminal from a
 * `bash -c` some other process spawned. A claude that is the pty host's own
 * child has no wrapper shell to close, and one under the extension host (the
 * panel) has no terminal at all, so both come back empty.
 */
async function terminalShell(
  session: RunningSession,
  host: ProcessHost,
): Promise<ProcessRef | undefined> {
  let current: ProcessRef = { pid: session.pid, start: session.start };

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const stat = await host.stat(current.pid);
    if (!stat || stat.ppid <= 1) return undefined; // Ran out of tree.

    const parent = await host.cmdline(stat.ppid);
    if (parent.includes('--type=ptyHost')) {
      return current.pid === session.pid ? undefined : current;
    }
    if (parent.includes('--type=extensionHost')) return undefined;

    const parentStat = await host.stat(stat.ppid);
    if (!parentStat) return undefined;
    current = { pid: stat.ppid, start: parentStat.start };
  }

  return undefined; // Deeper than any real terminal; not worth guessing.
}

/**
 * Ends them all, concurrently. Never throws.
 *
 * Claude is asked to leave first — SIGTERM lets it flush the conversation — and
 * only then is the shell closed, because closing a terminal out from under a
 * live claude leaves it without a tty. The shell is the one that needs SIGHUP:
 * interactive bash ignores SIGTERM.
 */
export async function endSessions(
  sessions: RunningSession[],
  host: ProcessHost,
  timing: { graceMs?: number; pollMs?: number } = {},
): Promise<void> {
  const graceMs = timing.graceMs ?? 5000;
  const pollMs = timing.pollMs ?? 100;
  await Promise.all(sessions.map((s) => endSession(s, host, graceMs, pollMs)));
}

async function endSession(
  session: RunningSession,
  host: ProcessHost,
  graceMs: number,
  pollMs: number,
): Promise<void> {
  await stop(session, 'SIGTERM', graceMs, pollMs, host);
  if (await alive(session, host)) await stop(session, 'SIGKILL', 1000, pollMs, host);

  if (!session.shell) return;
  await stop(session.shell, 'SIGHUP', 2000, pollMs, host);
  if (await alive(session.shell, host)) await stop(session.shell, 'SIGKILL', 1000, pollMs, host);
}

/** Sends one signal and waits for the process to leave, up to `graceMs`. */
async function stop(
  ref: ProcessRef,
  signal: NodeJS.Signals,
  graceMs: number,
  pollMs: number,
  host: ProcessHost,
): Promise<void> {
  // Asked again here, not once up front: between listing and killing is time
  // enough for the session to end and its pid to be taken by something else.
  if (!(await alive(ref, host))) return;
  host.kill(ref.pid, signal);

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!(await alive(ref, host))) return;
    await host.sleep(pollMs);
  }
}

/** Alive means the same process, judged by start time, not just the pid. */
async function alive(ref: ProcessRef, host: ProcessHost): Promise<boolean> {
  const stat = await host.stat(ref.pid);
  return stat !== undefined && stat.start === ref.start;
}

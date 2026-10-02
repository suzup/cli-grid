import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { SECTION, setting } from './config.js';
import { findProfile } from './profiles.js';

/**
 * Typing into an agent from outside the window.
 *
 * A CLI that is waiting at its prompt can only be answered by whoever holds its
 * terminal, and that is the workbench: the pty belongs to VS Code, so no other
 * process can write to it. A script that wants to answer one — a phone bridge,
 * a scheduler, another agent — therefore has to ask the window to type for it.
 *
 * Every terminal CLI Grid opens carries two environment variables, and whatever
 * the CLI runs inherits them: `CLI_GRID_AGENT`, a name for that terminal, and
 * `CLI_GRID_SOCKET`, where the window that owns it is listening. (A third,
 * `CLI_GRID_PROFILE`, says which CLI it is.) A hook the CLI
 * fires can hand both to anything else, which can then connect and say "type
 * this into that one". The address travels with the session, so several windows
 * need no directory of each other and no port to share: each has its own socket
 * and each session knows which.
 *
 * Listening is off unless `cliGrid.remoteInput` is set: it lets any process of
 * the same user drive a terminal, and that should be a choice.
 */

export const AGENT_ENV = 'CLI_GRID_AGENT';
export const SOCKET_ENV = 'CLI_GRID_SOCKET';
export const PROFILE_ENV = 'CLI_GRID_PROFILE';

/**
 * Between the text and the Enter that submits it. Sent as one write, a TUI
 * reads the pair as a paste that happens to end in a newline and leaves it
 * sitting in the prompt.
 */
const ENTER_DELAY_MS = 150;

/** For the CLI to have queued the message before it is told to take it now. */
const SEND_NOW_DELAY_MS = 400;

/** A request is one line; nothing an agent should be told is longer than this. */
const MAX_REQUEST_BYTES = 1 << 20;

export interface Request {
  agent: string;
  text: string;
  /** The agent may be busy: interrupt it with this rather than queue behind it. */
  now?: boolean;
}

export type Reply = { ok: true } | { ok: false; error: string };

/** Unique across windows, which a counter per window would not be. */
export function newAgentId(): string {
  return randomBytes(4).toString('hex');
}

/**
 * Where a window listens: a socket file, or on Windows a named pipe.
 *
 * Not a TCP port — two windows would have to agree on who gets which, and a
 * path made of random bytes needs no agreement.
 */
export function newSocketPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  tmp: string = tmpdir(),
): string {
  const name = `cli-grid-${randomBytes(6).toString('hex')}`;
  if (platform === 'win32') return `\\\\.\\pipe\\${name}`;
  return join(env.XDG_RUNTIME_DIR || tmp, `${name}.sock`);
}

/**
 * What to write to the terminal for a message, without the Enter.
 *
 * More than one line goes in as a bracketed paste, which is how a TUI tells a
 * newline in the text from the one that submits. Escape characters are dropped
 * so the text cannot close the paste early or carry sequences of its own.
 */
export function keystrokes(text: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const body = text.replace(/\r\n?/g, '\n').replace(/\x1b/g, '').trim();
  if (!body) return undefined;
  return body.includes('\n') ? `\x1b[200~${body}\x1b[201~` : body;
}

/** One line of JSON: `{"agent": "<CLI_GRID_AGENT>", "text": "..."}`, and optionally `"now": true`. */
export function parseRequest(line: string): Request | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null) return undefined;
    const { agent, text, now } = value as Record<string, unknown>;
    if (typeof agent !== 'string' || !agent || typeof text !== 'string') return undefined;
    return { agent, text, ...(now === true ? { now: true } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Answers each connection's one request with one line and hangs up.
 *
 * Apart from the workbench so it can be tested against a real socket.
 */
export function serve(path: string, handle: (request: Request) => Promise<Reply>): net.Server {
  const server = net.createServer((socket) => {
    let received = '';
    let answered = false;

    const answer = (reply: Reply) => {
      if (answered) return;
      answered = true;
      socket.end(`${JSON.stringify(reply)}\n`);
    };

    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: string) => {
      if (answered) return;
      received += chunk;
      const end = received.indexOf('\n');
      if (end < 0) {
        if (received.length > MAX_REQUEST_BYTES) answer({ ok: false, error: 'request too long' });
        return;
      }
      const request = parseRequest(received.slice(0, end));
      if (!request) {
        answer({ ok: false, error: 'bad request' });
        return;
      }
      handle(request).then(answer, () => answer({ ok: false, error: 'failed' }));
    });
  });
  server.on('error', () => server.close());
  server.listen(path, () => {
    // A pipe has no mode; a socket file is created with the umask's.
    if (process.platform !== 'win32') fs.chmod(path, 0o600, () => {});
  });
  return server;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What a terminal was opened with, if CLI Grid opened it. */
function launchEnv(terminal: vscode.Terminal, name: string): string | undefined {
  const env = (terminal.creationOptions as vscode.TerminalOptions).env;
  return env?.[name] ?? undefined;
}

/**
 * The agents of this window, by the name their terminal was opened with.
 *
 * Read off the terminals rather than kept in a table: the workbench remembers
 * what each was created with, so the answer survives the extension host
 * restarting under terminals that are still running.
 */
export function agentTerminals(): Map<string, vscode.Terminal> {
  const found = new Map<string, vscode.Terminal>();
  for (const terminal of vscode.window.terminals) {
    const id = launchEnv(terminal, AGENT_ENV);
    if (id) found.set(id, terminal);
  }
  return found;
}

/**
 * Whether the shell a terminal was opened with has nothing running under it.
 *
 * That is a CLI that has exited and left its shell behind, and the one time
 * typing must not happen: the text would run as a command. Only answerable
 * where the kernel lists a process's children; anywhere else it is "no", and
 * the sender is trusted to know its agent is alive.
 */
async function leftAtShell(terminal: vscode.Terminal): Promise<boolean> {
  // Opened on the CLI itself: when it exits the terminal goes with it.
  if ((terminal.creationOptions as vscode.TerminalOptions).shellPath) return false;
  const pid = await terminal.processId;
  if (!pid) return false;
  try {
    const children = await fs.promises.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
    return children.trim() === '';
  } catch {
    return false;
  }
}

export class Remote implements vscode.Disposable {
  private server: net.Server | undefined;
  private path: string | undefined;
  /** One message at a time: two typed at once arrive as one garbled line. */
  private typing: Promise<unknown> = Promise.resolve();
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SECTION}.remoteInput`)) this.sync();
    });
    this.sync();
  }

  /** What a terminal being opened for an agent should carry. */
  env(id: string, profileId: string): Record<string, string> {
    return { [AGENT_ENV]: id, [PROFILE_ENV]: profileId, ...(this.path ? { [SOCKET_ENV]: this.path } : {}) };
  }

  /**
   * Types `text` into an agent of this window and submits it.
   *
   * `now` is for an agent that may be in the middle of something: the keys its
   * profile names are pressed afterwards, which is what makes a busy CLI stop
   * and read the message instead of holding it until the work is done.
   */
  send(id: string, text: string, now = false): Promise<Reply> {
    const result = this.typing.then(() => this.type(id, text, now));
    this.typing = result.catch(() => undefined);
    return result;
  }

  /** The same message to every agent of this window, now; how many took it. */
  async broadcast(text: string): Promise<number> {
    const replies = await Promise.all(
      [...agentTerminals().keys()].map((id) => this.send(id, text, true)),
    );
    return replies.filter((reply) => reply.ok).length;
  }

  private async type(id: string, text: string, now: boolean): Promise<Reply> {
    const terminal = agentTerminals().get(id);
    if (!terminal) return { ok: false, error: 'no such agent' };
    const typed = keystrokes(text);
    if (!typed) return { ok: false, error: 'empty text' };
    if (await leftAtShell(terminal)) return { ok: false, error: 'agent has exited' };

    terminal.sendText(typed, false);
    await pause(ENTER_DELAY_MS);
    terminal.sendText('\r', false);

    const keys = now ? findProfile(launchEnv(terminal, PROFILE_ENV) ?? '')?.sendNow : undefined;
    for (const [index, key] of (keys ?? []).entries()) {
      await pause(index ? ENTER_DELAY_MS : SEND_NOW_DELAY_MS);
      terminal.sendText(key, false);
    }
    return { ok: true };
  }

  private sync(): void {
    if (!setting('remoteInput')) {
      this.close();
      return;
    }
    if (this.server) return;

    // The address is in the environment of every terminal already open, so an
    // extension host that restarts has to come back at the one they were given.
    const known = vscode.window.terminals
      .map((terminal) => launchEnv(terminal, SOCKET_ENV))
      .find((path) => path);
    this.path = known ?? newSocketPath();

    // What a host that did not shut down cleanly left behind.
    if (process.platform !== 'win32') fs.rmSync(this.path, { force: true });
    this.server = serve(this.path, (request) => this.send(request.agent, request.text, request.now));
  }

  private close(): void {
    this.server?.close();
    this.server = undefined;
    this.path = undefined;
  }

  dispose(): void {
    this.subscription.dispose();
    this.close();
  }
}

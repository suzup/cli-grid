import * as vscode from 'vscode';
import type { AgentRegistry } from './registry.js';
import type { Piece } from './transcripts.js';

/**
 * What an agent's terminal was sent, kept as the lines it drew.
 *
 * A terminal link provider is handed one line and nothing around it, and the
 * other half of a wrapped path is on the line above or below. The workbench
 * will not say what is there — but an agent is started by typing its command
 * into a shell the workbench integrates with, and that lets an extension read
 * everything the command writes. So the lines are kept as they go by, and a
 * piece of a path is put back next to its neighbours whichever CLI drew it,
 * with no record of the conversation to consult.
 */

/** As far back as a pane is remembered. A CLI redraws a lot; this is minutes of it. */
const MAX_LINES = 40_000;

/** How much is left unparsed before it is turned into lines. */
const SETTLE = 16 * 1024;

/** Nothing arrives this long without a line break unless it never will. */
const MAX_PENDING = 1024 * 1024;

/** How many lines a path is followed over, either way. A pane is not that narrow. */
const MAX_WRAPS = 3;

/** Paths one piece is allowed to come back as. */
const MAX_JOINED = 8;

/* eslint-disable no-control-regex */
/** A title, a hyperlink, a shell integration mark: text the screen never shows. */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[([0-?]*)[ -/]*([@-~])/g;
const ESCAPE = /\x1b[()*+][0-9A-Za-z]|\x1b[^[\]]/g;
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/** The sequences that put the cursor on another row, or back along this one. */
const MOVES = 'ABEFGHdf';

const PATH = '[^\\s"\'`()[\\]{}<>|,;│┃┆┊╎╏┋]+';
const EDGE = '[\\s│┃┆┊╎╏┋]*';
/** The first word on a line, and what follows it. */
const FIRST = new RegExp(`^${EDGE}(${PATH})(.*)$`);
/** The last word on a line, and what comes before it. */
const LAST = new RegExp(`^(.*?)(${PATH})${EDGE}$`);
const BLANK = new RegExp(`^${EDGE}$`);

/** `:12`, and the full stop of the sentence a path ended. */
const LOCATION = /(?::\d+)*\.*$/;

/** What makes a run of characters worth checking against the disk. */
const PATHLIKE = /[\\/]|\.[A-Za-z\d]{1,8}$/;

/** The lines one terminal has drawn, the most recent last. */
export class Recording {
  private readonly settled: string[] = [];
  private pending = '';

  push(data: string): void {
    this.pending += data;
    if (this.pending.length < SETTLE) return;

    // A line break is never inside an escape sequence, so it is a safe place
    // to stop parsing and pick up again.
    let cut = this.pending.lastIndexOf('\n');
    if (cut === -1) {
      if (this.pending.length < MAX_PENDING) return;
      cut = this.pending.length;
    }

    const whole = this.pending.slice(0, cut).replace(/\r$/, '');
    for (const line of toLines(whole)) this.settled.push(line);
    this.pending = this.pending.slice(cut + 1);

    const over = this.settled.length - MAX_LINES;
    if (over > 0) this.settled.splice(0, over);
  }

  lines(): string[] {
    return [...this.settled, ...toLines(this.pending)];
  }
}

/**
 * The text a stream of terminal output draws, a row to a line.
 *
 * Not an emulation: a CLI that redraws leaves every version of a row here, one
 * after another. That is enough, because all that is asked of these lines is
 * what was written next to what — and a row and the one under it are written
 * one after the other however the cursor got there.
 */
export function toLines(raw: string): string[] {
  return raw
    .replace(OSC, '')
    .replace(CSI, (_, params: string, final: string) => {
      // A gap skipped over rather than printed is still a gap between words.
      if (final === 'C') return ' '.repeat(Math.min(Number(params) || 1, 200));
      return MOVES.includes(final) ? '\n' : '';
    })
    .replace(ESCAPE, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .split('\n');
}

/**
 * The paths a piece of a terminal line was drawn as part of, latest first.
 *
 * The piece is found where it was drawn — ending its line if it is a head,
 * starting it if it is a tail — and the word the next line starts with, or the
 * last line ended on, is put back against it. Nothing here knows whether the
 * result is a file; a line of prose ends on a word too.
 */
export function rejoin(lines: string[], piece: Piece): string[] {
  if (!piece.openLeft && !piece.openRight) return [];

  const same = (word: string | undefined): boolean =>
    word !== undefined &&
    word.startsWith(piece.text) &&
    /^[.:\d]*$/.test(word.slice(piece.text.length));

  const found = new Set<string>();

  for (let at = lines.length - 1; at >= 0 && found.size < MAX_JOINED; at--) {
    const line = lines[at] ?? '';
    if (!line.includes(piece.text)) continue;

    const first = FIRST.exec(line);
    const last = LAST.exec(line);
    if (piece.openLeft && !same(first?.[1])) continue;
    if (piece.openRight && !same(last?.[2])) continue;

    const lefts = piece.openLeft ? ['', ...above(lines, at)] : [''];
    const rights = piece.openRight ? ['', ...below(lines, at)] : [''];

    for (const left of lefts) {
      for (const right of rights) {
        if (!left && !right) continue;
        const path = `${left}${piece.text}${right}`.replace(LOCATION, '');
        if (PATHLIKE.test(path)) found.add(path);
      }
    }
  }

  return [...found].slice(0, MAX_JOINED);
}

/** What the lines above end on, growing a line at a time: the nearest, then two… */
function above(lines: string[], at: number): string[] {
  const grown: string[] = [];
  let joined = '';

  for (let row = at - 1, wraps = 0; row >= 0 && wraps < MAX_WRAPS; row--) {
    const line = lines[row] ?? '';
    // A cursor that moved without writing leaves an empty line of its own.
    if (BLANK.test(line)) continue;

    const last = LAST.exec(line);
    if (!last?.[2]) break;
    joined = `${last[2]}${joined}`;
    grown.push(joined);
    wraps++;

    // Only a word with a line to itself can have started on the one before.
    if (!BLANK.test(last[1] ?? '')) break;
  }
  return grown;
}

/** What the lines below start with, growing the same way. */
function below(lines: string[], at: number): string[] {
  const grown: string[] = [];
  let joined = '';

  for (let row = at + 1, wraps = 0; row < lines.length && wraps < MAX_WRAPS; row++) {
    const line = lines[row] ?? '';
    if (BLANK.test(line)) continue;

    const first = FIRST.exec(line);
    if (!first?.[1]) break;
    joined = `${joined}${first[1]}`;
    grown.push(joined);
    wraps++;

    if (!BLANK.test(first[2] ?? '')) break;
  }
  return grown;
}

/** Records what every agent's terminal is sent, for as long as it is open. */
export class AgentOutput implements vscode.Disposable {
  private readonly recordings = new WeakMap<vscode.Terminal, Recording>();
  private readonly subscription: vscode.Disposable | undefined;

  constructor(registry: AgentRegistry) {
    // Newer than the oldest workbench this runs in, which simply goes without.
    if (!('onDidStartTerminalShellExecution' in vscode.window)) return;

    this.subscription = vscode.window.onDidStartTerminalShellExecution((event) => {
      if (registry.byTerminal(event.terminal)) void this.record(event);
    });
  }

  /** The lines a terminal has drawn, or nothing if it was never listened to. */
  linesOf(terminal: vscode.Terminal): string[] | undefined {
    return this.recordings.get(terminal)?.lines();
  }

  private async record(event: vscode.TerminalShellExecutionStartEvent): Promise<void> {
    let recording = this.recordings.get(event.terminal);
    if (!recording) {
      recording = new Recording();
      this.recordings.set(event.terminal, recording);
    }

    try {
      for await (const data of event.execution.read()) recording.push(data);
    } catch {
      // The terminal closed under the stream; what was read is still good.
    }
  }

  dispose(): void {
    this.subscription?.dispose();
  }
}

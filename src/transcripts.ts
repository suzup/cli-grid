import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * What a CLI wrote down of its own conversation, as somewhere to look a path up.
 *
 * A terminal link provider is handed one line and nothing around it, so a path
 * the CLI wrapped reaches it as a piece with no way to ask for the other one.
 * The CLI, though, keeps the conversation on disk as it goes, and there the
 * path is whole: the piece on the line is the start, the end or the middle of
 * a word in that file, and the word is the path.
 *
 * No `vscode` import: this is files and text, so it can be tested without a
 * workbench.
 */

/** How much of the end of a transcript is read. The line on screen is recent. */
const TAIL_BYTES = 4 * 1024 * 1024;

/** The last few conversations; the one on screen is among them. */
const MAX_FILES = 5;

/** How much text around a path is compared with what the line has around it. */
const CONTEXT = 16;

/** The characters a path is made of — what the terminal's tokens are, less `\`. */
const PATH_CHAR = /[^\s"'`()[\]{}<>|,;\\│┃┆┊╎╏┋]/;

/** What a renderer adds or takes away around a word: markup, bullets, borders. */
const DECORATION = /[\s`*#_~│┃┆┊╎╏┋●⏺•]/g;

/** A piece of a path as a terminal line has it. */
export interface Piece {
  text: string;
  /** Nothing before it on its line, so the path may have begun on the one above. */
  openLeft: boolean;
  /** Nothing after it on its line, so the path may run on to the one below. */
  openRight: boolean;
  /** The rest of the line, either side. */
  before: string;
  after: string;
}

interface Source {
  dir: string;
  extension: string;
  /** Levels of dated folders between `dir` and the files. */
  depth: number;
}

/**
 * Where a built-in CLI keeps its conversations.
 *
 * Claude Code files them by the folder it ran in; Codex by the day they began;
 * Devin all in one place. None of it needs reading as the format it is — a path
 * is the same run of characters in any of them. opencode keeps a database
 * instead, read on its own below.
 */
function sourceOf(profileId: string, folder: string): Source | undefined {
  const env = process.env;
  switch (profileId) {
    case 'claude':
      return {
        dir: join(
          env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
          'projects',
          folder.replace(/[^A-Za-z0-9]/g, '-'),
        ),
        extension: '.jsonl',
        depth: 0,
      };
    case 'codex':
      return {
        dir: join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
        extension: '.jsonl',
        depth: 3,
      };
    case 'devin':
      return {
        dir: join(
          env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
          'devin',
          'cli',
          'transcripts',
        ),
        extension: '.json',
        depth: 0,
      };
    default:
      return undefined;
  }
}

/** The ends of the conversations a CLI last wrote in or about `folder`, newest first. */
export async function recentTranscripts(profileId: string, folder: string): Promise<string[]> {
  if (profileId === 'opencode') return opencodeTranscripts(folder);

  const source = sourceOf(profileId, folder);
  if (!source) return [];

  const files = await filesIn(source.dir, source.extension, source.depth);
  files.sort((a, b) => b.mtime - a.mtime);

  const texts = await Promise.all(files.slice(0, MAX_FILES).map((file) => tailOf(file.path)));
  return texts.filter((text) => text.length > 0);
}

/**
 * opencode keeps its conversations in one SQLite database, a row for each piece
 * of a message, each piece the JSON the CLI had in hand — and the folder each
 * conversation ran in beside it, so only that folder's are read.
 *
 * Read with the runtime's own SQLite, which a VS Code server has and an older
 * Electron may not; where there is none, there is nothing to look in.
 */
async function opencodeTranscripts(folder: string): Promise<string[]> {
  const path = join(
    process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
    'opencode',
    'opencode.db',
  );
  let db: DatabaseSync;
  try {
    const sqlite = await import('node:sqlite');
    db = new sqlite.DatabaseSync(path, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const sessions = db
      .prepare('SELECT id FROM session WHERE directory = ? ORDER BY time_updated DESC LIMIT ?')
      .all(folder, MAX_FILES) as { id: string }[];
    const pieces = db.prepare(
      'SELECT data FROM part WHERE session_id = ? ORDER BY time_created DESC, id DESC',
    );

    const texts: string[] = [];
    for (const { id } of sessions) {
      // Newest first, until there is as much as a file's tail would hold.
      const kept: string[] = [];
      let length = 0;
      for (const { data } of pieces.iterate(id) as Iterable<{ data: string }>) {
        kept.push(data);
        length += data.length;
        if (length >= TAIL_BYTES) break;
      }
      const text = unescape(kept.reverse().join('\n'));
      if (text.length > 0) texts.push(text);
    }
    return texts;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * The files under a directory, going only into its last two folders by name at
 * each level — dated folders sort by date, and a conversation that ran past
 * midnight is still in yesterday's.
 */
async function filesIn(
  dir: string,
  extension: string,
  depth: number,
): Promise<{ path: string; mtime: number }[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  if (depth > 0) {
    const latest = names.sort().slice(-2);
    const nested = await Promise.all(
      latest.map((name) => filesIn(join(dir, name), extension, depth - 1)),
    );
    return nested.flat();
  }

  const found = await Promise.all(
    names
      .filter((name) => name.endsWith(extension))
      .map(async (name) => {
        const path = join(dir, name);
        try {
          return { path, mtime: (await fs.stat(path)).mtimeMs };
        } catch {
          return undefined;
        }
      }),
  );
  return found.filter((file) => file !== undefined);
}

/** The last stretch of a file as the text it holds, or nothing if it cannot be read. */
async function tailOf(path: string): Promise<string> {
  try {
    const handle = await fs.open(path, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return unescape(buffer.toString('utf8'));
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

/**
 * JSON's escapes, undone in place. A line break in the conversation is `\n` in
 * the file, and left as it is the `n` would read as the first letter of the
 * path after it.
 */
function unescape(json: string): string {
  return json.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escaped: string) => {
    if (escaped.length === 5) return String.fromCharCode(parseInt(escaped.slice(1), 16));
    return 'ntrbf'.includes(escaped) ? ' ' : escaped;
  });
}

/**
 * The paths in `text` that a piece of a terminal line is part of, the likeliest
 * first.
 *
 * A piece with the rest of its line on one side is known to start or end there,
 * so only the open side is let grow. Where the same piece belongs to several
 * paths — the head `/srv/shots/d` does, of every file under `demo` — the words
 * next to it on the line settle it more often than not: the conversation has
 * the same words next to the same path. What is still tied comes back in the
 * order it was last said, latest first.
 */
export function pathsIn(text: string, piece: Piece): string[] {
  const before = plain(piece.before).slice(-CONTEXT);
  const after = plain(piece.after).slice(0, CONTEXT);

  const found = new Map<string, { score: number; at: number }>();

  for (let at = text.indexOf(piece.text); at !== -1; at = text.indexOf(piece.text, at + 1)) {
    let start = at;
    while (start > 0 && PATH_CHAR.test(text.charAt(start - 1))) start--;
    if (start < at && !piece.openLeft) continue;

    let end = at + piece.text.length;
    while (end < text.length && PATH_CHAR.test(text.charAt(end))) end++;
    // The line had it without the `:12` or the full stop the word ends in here.
    const rest = text.slice(at + piece.text.length, end);
    if (!piece.openRight && !/^[.:\d]*$/.test(rest)) continue;

    const path = text.slice(start, end).replace(/(?::\d+)*\.*$/, '');
    if (path.length <= piece.text.length) continue;

    let score = 0;
    if (before && plain(text.slice(Math.max(0, start - 200), start)).endsWith(before)) score++;
    if (after && plain(text.slice(end, end + 200)).startsWith(after)) score++;

    const known = found.get(path);
    if (!known || score >= known.score) found.set(path, { score, at });
  }

  const best = Math.max(0, ...[...found.values()].map((entry) => entry.score));
  return [...found]
    .filter(([, entry]) => entry.score === best)
    .sort(([, a], [, b]) => b.at - a.at)
    .map(([path]) => path);
}

function plain(text: string): string {
  return text.replace(DECORATION, '');
}

import { homedir, tmpdir } from 'node:os';
import * as vscode from 'vscode';
import type { EditorGrid } from './grid.js';
import { rejoin } from './output.js';
import { basename, dirnameOf, exists, join, relativeTo, resolveFolder } from './paths.js';
import type { AgentRegistry } from './registry.js';
import { pathsIn, recentTranscripts, type Piece } from './transcripts.js';
import type { RunningAgent } from './types.js';

/** Extensions the workbench opens in its image preview rather than as text. */
const IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;

/**
 * A run of characters that could be a path: no spaces, no punctuation a CLI
 * puts around one, and none of the lines it draws its boxes with — a prompt
 * with a border ends every line in one.
 */
const TOKEN = /[^\s"'`()[\]{}<>|,;│┃┆┊╎╏┋]+/g;

/** `[image] <path>` running to the end of the line — the CLI's own marker. */
const MARKER = /\[image\][:\s]\s*([^\s│┃┆┊╎╏┋]+)[\s│┃┆┊╎╏┋]*$/i;

/** Not ours: the workbench opens a link with a scheme in a browser. */
const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

/** Nothing on a line but the indent and the border a CLI draws. */
const BLANK = /^[\s│┃┆┊╎╏┋]*$/;

/** `:12`, and the full stop of the sentence a path ended. Neither is in the name. */
const LOCATION = /(?::\d+)*\.*$/;

/** A path from the root, a home or a drive, and at least one folder deep. */
const ABSOLUTE = /^(?:~?\/|[A-Za-z]:[\\/])[^\\/]+[\\/]/;

/** How a path that names a file ends, as far as its shape can say. */
const EXTENSION = /\.[A-Za-z\d]{1,8}$/;

/** Paths one piece could be part of that are checked against the disk. */
const MAX_FOLLOWED = 20;

/** Directories a single click may read before giving up on finding the file. */
const MAX_DIRS = 400;

/** How far under a root the search goes. A scratchpad sits three or four down. */
const MAX_DEPTH = 6;

/** How far under a directory the file the cut hid can be. */
const IMAGE_DEPTH = 2;

/** Enough images to choose between; a directory of a thousand is not a choice. */
const MAX_IMAGES = 50;

/** Never worth walking, and each of them is enormous. */
const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', 'target', 'build', 'dist']);

interface PathLink extends vscode.TerminalLink {
  /** The text as the terminal has it, which may be half of a path. */
  piece: Piece;
  /** Named as an image by its extension or by the CLI, so worth searching for. */
  image: boolean;
  agent: RunningAgent;
  /** The terminal's lines as they were when the link was made. */
  drawn: string[] | undefined;
}

/** What an agent's terminal has drawn, where anything was listening. */
export interface DrawnLines {
  linesOf(terminal: vscode.Terminal): string[] | undefined;
}

/**
 * Makes the paths a CLI broke in half openable, in the agents' terminals.
 *
 * The workbench already links a path it can find on disk, and with the agent
 * panes locked that lands beside the grid — so on a line the CLI printed whole
 * there is nothing here to add. What it cannot do is follow a path the CLI
 * broke in half. An agent's pane is a third of the editor area wide, the CLI
 * wraps its output to that width itself rather than letting the terminal do it,
 * and a path long enough to matter — `/tmp/…/<session>/scratchpad/shot.png` is
 * over a hundred characters — arrives as two lines that are each a piece of a
 * name. Neither piece is a file, so the workbench falls through to opening it
 * as an external program, which on WSL hands a Linux path to Windows and fails
 * with "the system cannot find the file specified".
 *
 * So the halves are put back together, from the best account of them there is.
 * What the terminal was sent has the two lines one after the other, whatever
 * the CLI and whatever the file. Failing that — a terminal nobody was listening
 * to, a line long scrolled away — the CLI's own record of the conversation has
 * the path whole, and the piece is the start or the end of it there. And where
 * there is neither, an image is still looked for on the file system: what is on
 * the line is a prefix of a real path, or a suffix of one, and either is
 * usually enough to name exactly one file.
 */
export class PathLinks implements vscode.TerminalLinkProvider<PathLink> {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly grid: EditorGrid,
    private readonly output: DrawnLines,
  ) {}

  /**
   * Hover is not the place to search the disk — this runs for every line the
   * mouse crosses. An image is linked on its shape alone, and says so when it
   * is clicked if it names nothing. Any other piece costs a stat or two: a path
   * that exists as written is the workbench's to link, line number and all,
   * and only one that does not is a half.
   *
   * With the terminal's own lines to go by, a half is whatever joins up with
   * the line next to it into a file, of any shape. Without them it has to look
   * like one: a path from the root, or the end of a file name.
   */
  async provideTerminalLinks(context: vscode.TerminalLinkContext): Promise<PathLink[]> {
    const agent = this.registry.byTerminal(context.terminal);
    if (!agent) return [];

    const line = context.line;
    const drawn = this.output.linesOf(context.terminal);
    const link = (token: PathToken, image: boolean): PathLink => ({
      startIndex: token.index,
      length: token.text.length,
      tooltip: image ? vscode.l10n.t('Open the image') : vscode.l10n.t('Open the file'),
      piece: pieceAt(line, token),
      image,
      agent,
      drawn,
    });

    const images = imageTokens(line);
    const links = images.map((token) => link(token, true));
    const shaped = cutTokens(line);

    for (const token of endTokens(line)) {
      if (images.some((image) => image.index === token.index)) continue;

      const candidate = link(token, false);
      const looksCut = shaped.some((cut) => cut.index === token.index);
      const joins = drawn ? rejoin(drawn, candidate.piece) : [];
      if (!looksCut && !joins.length) continue;

      if (await exists(resolveFolder(agent.folder, expandHome(token.text)))) continue;
      if (!looksCut && !(await filesAmong(joins, agent)).length) continue;
      links.push(candidate);
    }
    return links;
  }

  async handleTerminalLink(link: PathLink): Promise<void> {
    const uri = await this.resolve(link);
    if (!uri) {
      void vscode.window.showWarningMessage(
        link.image
          ? vscode.l10n.t('CLI Grid could not find an image named {0}.', link.piece.text)
          : vscode.l10n.t('CLI Grid could not find the file {0} is part of.', link.piece.text),
      );
      return;
    }

    await this.grid.openFile(uri);
  }

  /**
   * The file a piece of a line names, if exactly one answers to it.
   *
   * Whole path first — the common case, and the only one that costs a single
   * stat. Then the lines either side of it in the terminal, then what the CLI
   * itself wrote down. Last, for an image, the file system: a piece that still
   * ends in an image extension is the tail of a wrapped path; one that does not
   * is the head of it.
   */
  private async resolve(link: PathLink): Promise<vscode.Uri | undefined> {
    const { piece, image, agent } = link;
    const uri = resolveFolder(agent.folder, expandHome(piece.text));
    if (await exists(uri)) return uri;

    const lines = this.output.linesOf(agent.terminal) ?? link.drawn;
    const shown = lines ? await filesAmong(rejoin(lines, piece), agent) : [];
    if (shown.length) return shown.length === 1 ? shown[0] : choose(shown);

    const said = await saidBy(agent, piece);
    if (said.length) return said.length === 1 ? said[0] : choose(said);
    if (!image) return undefined;

    // Everything past here compares against a uri path, which is separated the
    // one way whatever the CLI printed.
    const text = expandHome(piece.text).replace(/\\/g, '/');
    return IMAGE.test(text) ? bySuffix(text, agent) : byPrefix(text, agent);
  }
}

interface PathToken {
  text: string;
  index: number;
}

/**
 * The pieces of a line that could name an image.
 *
 * Anything ending in an image extension qualifies, which covers a whole path
 * and the tail of a broken one alike. A head has no extension to go on — the
 * name it was cut out of is on the next line — so it is only taken from the
 * CLI's own `[image]` marker, rather than from every path-shaped word in the
 * output.
 */
export function imageTokens(line: string): PathToken[] {
  const found: PathToken[] = [];

  for (const match of line.matchAll(TOKEN)) {
    // A path at the end of a sentence keeps the full stop out of the name.
    const text = match[0].replace(/\.+$/, '');
    if (match.index === undefined || SCHEME.test(text) || !IMAGE.test(text)) continue;
    found.push({ text, index: match.index });
  }
  if (found.length) return found;

  const marker = MARKER.exec(line);
  const cut = marker?.[1];
  // A word that is not a path at all, or an address rather than a file.
  if (!marker || !cut || !cut.includes('/') || SCHEME.test(cut)) return found;

  return [{ text: cut, index: marker.index + marker[0].lastIndexOf(cut) }];
}

/**
 * The ends of a line that could be half of a path of any kind.
 *
 * Only the ends, because a wrap is where a line stops: the head of a path is
 * the last thing on its line and the tail the first on the next. A head is
 * recognised by starting where a path starts, a tail by ending the way a file
 * name does.
 */
export function cutTokens(line: string): PathToken[] {
  const found: PathToken[] = [];

  for (const match of line.matchAll(TOKEN)) {
    const text = match[0].replace(LOCATION, '');
    if (match.index === undefined || SCHEME.test(text)) continue;

    const { openLeft, openRight } = pieceAt(line, { text, index: match.index });
    const head = openRight && ABSOLUTE.test(text);
    const tail = openLeft && !ABSOLUTE.test(text) && /[\\/]/.test(text) && EXTENSION.test(text);
    if (head || tail) found.push({ text, index: match.index });
  }
  return found;
}

/** The first and last words of a line: where a wrap would have left a half. */
function endTokens(line: string): PathToken[] {
  const found: PathToken[] = [];

  for (const match of line.matchAll(TOKEN)) {
    const text = match[0].replace(LOCATION, '');
    if (match.index === undefined || !text || SCHEME.test(text)) continue;

    const { openLeft, openRight } = pieceAt(line, { text, index: match.index });
    if (openLeft || openRight) found.push({ text, index: match.index });
  }
  return found;
}

/** A token with what its line has either side of it. */
function pieceAt(line: string, token: PathToken): Piece {
  const before = line.slice(0, token.index);
  const after = line.slice(token.index + token.text.length);
  return {
    text: token.text,
    openLeft: BLANK.test(before),
    openRight: BLANK.test(after.replace(/^(?::\d+)*\.*/, '')),
    before,
    after,
  };
}

/**
 * The files the CLI named in its own record of the conversation with a path
 * this piece is part of, the likeliest first.
 */
async function saidBy(agent: RunningAgent, piece: Piece): Promise<vscode.Uri[]> {
  const wanted = { ...piece, text: piece.text.replace(/\\/g, '/') };

  for (const text of await recentTranscripts(agent.profileId, agent.folder.fsPath)) {
    const files = await filesAmong(pathsIn(text, wanted), agent);
    if (files.length) return files;
  }
  return [];
}

/**
 * Those of some paths that are files, in the order given. A path that was
 * mentioned and never written, or put together out of two words that only
 * happened to be next to each other, is not something to open.
 */
async function filesAmong(paths: string[], agent: RunningAgent): Promise<vscode.Uri[]> {
  const files = new Map<string, vscode.Uri>();

  for (const path of paths.slice(0, MAX_FOLLOWED)) {
    const uri = resolveFolder(agent.folder, expandHome(path));
    if (isFile(await statOf(uri))) files.set(uri.toString(), uri);
  }
  return [...files.values()];
}

/** Asks which of several files a piece meant, in the order they are given. */
async function choose(files: vscode.Uri[]): Promise<vscode.Uri | undefined> {
  const pick = await vscode.window.showQuickPick(
    files.map((uri) => ({ label: basename(uri.path), description: dirnameOf(uri).path, uri })),
    { title: vscode.l10n.t('CLI Grid — which file?') },
  );
  return pick?.uri;
}

/**
 * Follows a path that was cut short, one segment at a time.
 *
 * Every segment but the last names a directory that exists, so the walk only
 * has to guess at the end of it: `…/scratchpad/ctx-po` is the file whose name
 * starts that way, and `…/882a34a3-62f6-4e` the one directory whose does. More
 * than one match and the line does not identify a file, which is where this
 * stops rather than picking for the user.
 */
async function byPrefix(text: string, agent: RunningAgent): Promise<vscode.Uri | undefined> {
  const drive = /^([A-Za-z]:)\//.exec(text);
  const segments = text.slice(drive?.[0].length ?? 0).split('/').filter(Boolean);
  if (!segments.length) return undefined;

  let uri = startOf(text, drive?.[1], agent);
  let last: vscode.FileType | undefined;

  for (const segment of segments) {
    const child = join(uri, segment);
    const stat = await statOf(child);
    if (stat) {
      uri = child;
      last = stat;
      continue;
    }

    const entries = await entriesOf(uri);
    const matches = entries.filter(([name]) => name.startsWith(segment));
    const only = matches.length === 1 ? matches[0] : undefined;
    if (!only) return undefined;

    uri = join(uri, only[0]);
    last = only[1];
  }

  if (isFile(last)) return IMAGE.test(uri.path) ? uri : undefined;
  // The cut fell on a directory — the file's own name is on the line below.
  return imageIn(uri);
}

/** Where a walk of `text` starts: the file system's root, a drive, or the cwd. */
function startOf(text: string, drive: string | undefined, agent: RunningAgent): vscode.Uri {
  if (drive) return vscode.Uri.file(`${drive}/`);
  return text.startsWith('/') ? agent.folder.with({ path: '/' }) : agent.folder;
}

/**
 * Finds the file a tail names, by the end of its path.
 *
 * `8c-a899-4163cb4b005d/scratchpad/ctx-post.png` is not a path anyone can
 * resolve, but a real path ends with it, and there are only so many places an
 * agent writes to: the folder it runs in, the project around it, and the
 * temporary directory its CLI keeps a session in.
 */
async function bySuffix(text: string, agent: RunningAgent): Promise<vscode.Uri | undefined> {
  // A tail starts inside a directory's name — `…-4e | 8c-a899-…` — so the end
  // of the path is compared as text rather than segment by segment. A piece
  // with no separator in it is a whole file name instead, and there "ends with"
  // would take shot.png for screenshot.png.
  const whole = text.includes('/');
  const wanted = (uri: vscode.Uri) =>
    whole ? uri.path.endsWith(text) : basename(uri.path) === text;

  const seen = new Set<string>();

  // One root at a time, nearest first, and each with its own budget. Sharing
  // one, the temporary directory — which on a machine that has been running
  // agents for a week holds hundreds of session folders — would spend what the
  // walk of the agent's own folder needed; interleaving them, worse still.
  for (const root of [agent.folder, agent.root, vscode.Uri.file(tmpdir())]) {
    if (seen.has(root.toString())) continue;
    const found = await walk(root, wanted, { left: MAX_DIRS }, seen);
    if (found) return found;
  }

  return undefined;
}

/** Breadth-first and bounded, so a click can never turn into a disk scan. */
async function walk(
  root: vscode.Uri,
  wanted: (uri: vscode.Uri) => boolean,
  budget: { left: number },
  seen: Set<string>,
): Promise<vscode.Uri | undefined> {
  const queue = [{ uri: root, depth: 0 }];
  seen.add(root.toString());

  while (queue.length && budget.left > 0) {
    const next = queue.shift();
    if (!next) break;
    budget.left--;

    for (const [name, type] of await entriesOf(next.uri)) {
      const child = join(next.uri, name);
      if (isFile(type)) {
        if (wanted(child)) return child;
        continue;
      }
      if (next.depth + 1 > MAX_DEPTH || SKIP.has(name)) continue;
      if (seen.has(child.toString())) continue;
      seen.add(child.toString());
      queue.push({ uri: child, depth: next.depth + 1 });
    }
  }

  return undefined;
}

/**
 * The image a directory holds, asking when it holds several.
 *
 * A cut that fell on a directory name leaves the file's own name on the line
 * below, so the directory is all there is to go on — and where a CLI keeps a
 * session, the images are a level under it rather than in it: the head ends at
 * `…/<session>` and the file is `…/<session>/scratchpad/shot.png`.
 *
 * Newest first, because the line was printed as the file was written, but the
 * choice is still the user's — opening a different image than the one under the
 * cursor is worse than one more keypress.
 */
async function imageIn(dir: vscode.Uri): Promise<vscode.Uri | undefined> {
  const files = await imagesUnder(dir, IMAGE_DEPTH);
  if (files.length <= 1) return files[0];

  const dated = await Promise.all(
    files.map(async (uri) => ({ uri, mtime: (await statOf(uri, true))?.mtime ?? 0 })),
  );
  dated.sort((a, b) => b.mtime - a.mtime);

  const pick = await vscode.window.showQuickPick(
    dated.map(({ uri }) => ({
      label: basename(uri.path),
      description: relativeTo(dir, dirnameOf(uri)),
      uri,
    })),
    { title: vscode.l10n.t('CLI Grid — which image?') },
  );
  return pick?.uri;
}

/** Every image a directory holds, and those a level or two under it. */
async function imagesUnder(
  dir: vscode.Uri,
  depth: number,
  found: vscode.Uri[] = [],
): Promise<vscode.Uri[]> {
  for (const [name, type] of await entriesOf(dir)) {
    if (found.length >= MAX_IMAGES) break;

    if (isFile(type)) {
      if (IMAGE.test(name)) found.push(join(dir, name));
      continue;
    }
    if (depth > 0 && !SKIP.has(name)) await imagesUnder(join(dir, name), depth - 1, found);
  }
  return found;
}

/** `~` is the shell's, not the file system's, so it never reaches a stat. */
function expandHome(text: string): string {
  return text === '~' || text.startsWith('~/') ? `${homedir()}${text.slice(1)}` : text;
}

async function statOf(uri: vscode.Uri, full: true): Promise<vscode.FileStat | undefined>;
async function statOf(uri: vscode.Uri): Promise<vscode.FileType | undefined>;
async function statOf(
  uri: vscode.Uri,
  full = false,
): Promise<vscode.FileStat | vscode.FileType | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return full ? stat : stat.type;
  } catch {
    return undefined;
  }
}

/**
 * `FileType` is a bit field: a symlink to a file is `File | SymbolicLink`, and
 * a scratchpad that is a link to somewhere with room on it is a real thing to
 * find at the end of a path.
 */
function isFile(type: vscode.FileType | undefined): boolean {
  return type !== undefined && (type & vscode.FileType.File) !== 0;
}

/** A directory listing, or nothing at all where it cannot be read. */
async function entriesOf(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
  try {
    return await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return [];
  }
}

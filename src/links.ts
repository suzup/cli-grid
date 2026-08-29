import { homedir, tmpdir } from 'node:os';
import * as vscode from 'vscode';
import type { EditorGrid } from './grid.js';
import { basename, dirnameOf, exists, join, relativeTo, resolveFolder } from './paths.js';
import type { AgentRegistry } from './registry.js';
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

interface ImageLink extends vscode.TerminalLink {
  /** The text as the terminal has it, which may be half of a path. */
  text: string;
  agent: RunningAgent;
}

/**
 * Makes the image paths a CLI prints openable, in the agents' terminals.
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
 * So the halves are put back together against the file system: what is on the
 * line is a prefix of a real path, or a suffix of one, and either is usually
 * enough to name exactly one file.
 */
export class ImageLinks implements vscode.TerminalLinkProvider<ImageLink> {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly grid: EditorGrid,
  ) {}

  /**
   * Hover is not the place to touch the disk — this runs for every line the
   * mouse crosses — so nothing here is checked against the file system. A link
   * that turns out to name nothing says so when it is clicked.
   */
  provideTerminalLinks(context: vscode.TerminalLinkContext): ImageLink[] {
    const agent = this.registry.byTerminal(context.terminal);
    if (!agent) return [];

    return imageTokens(context.line).map((token) => ({
      startIndex: token.index,
      length: token.text.length,
      tooltip: vscode.l10n.t('Open the image'),
      text: token.text,
      agent,
    }));
  }

  async handleTerminalLink(link: ImageLink): Promise<void> {
    const uri = await this.resolve(link.text, link.agent);
    if (!uri) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('CLI Grid could not find an image named {0}.', link.text),
      );
      return;
    }

    await this.grid.openFile(uri);
  }

  /**
   * The file a piece of a line names, if exactly one answers to it.
   *
   * Whole path first — the common case, and the only one that costs a single
   * stat. A piece that still ends in an image extension is the tail of a
   * wrapped path; one that does not is the head of it.
   */
  private async resolve(text: string, agent: RunningAgent): Promise<vscode.Uri | undefined> {
    const uri = resolveFolder(agent.folder, expandHome(text));
    if (await exists(uri)) return uri;

    // Everything past here compares against a uri path, which is separated the
    // one way whatever the CLI printed.
    const piece = expandHome(text).replace(/\\/g, '/');
    return IMAGE.test(piece) ? bySuffix(piece, agent) : byPrefix(piece, agent);
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

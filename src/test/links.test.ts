// Must come first: it stands in for the `vscode` module the rest of these
// imports reach for.
import { reset, state } from './vscode.js';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { URI } from 'vscode-uri';
import type { EditorGrid } from '../grid.js';
import { PathLinks, cutTokens, imageTokens } from '../links.js';
import { Recording, rejoin, toLines } from '../output.js';
import type { AgentRegistry } from '../registry.js';
import { pathsIn } from '../transcripts.js';
import type { RunningAgent } from '../types.js';

/**
 * A path an agent printed, from the terminal back to the file it names.
 *
 * The lines here are what Claude Code puts in a pane a third of the editor
 * area wide: the CLI wraps them itself, so what the workbench sees on a line is
 * often a piece of a path rather than one, and the piece is what has to be
 * followed.
 */

let dir: string;
let folder: URI;
/** Somewhere no search from the agent's folder would reach. */
let away: string;
let configDir: string | undefined;

/** The files the terminal lines below are about. */
const SESSION = 'claude-1000/-home-dev-project/882a34a3-62f6-4e8c-a899-4163cb4b005d';

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-grid-links-'));
  folder = URI.file(dir);

  await fs.mkdir(path.join(dir, SESSION, 'scratchpad'), { recursive: true });
  await fs.writeFile(path.join(dir, SESSION, 'scratchpad', 'ctx-post.png'), 'png');
  await fs.mkdir(path.join(dir, 'media'), { recursive: true });
  await fs.writeFile(path.join(dir, 'media', 'icon.png'), 'png');

  away = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-grid-away-'));
  await fs.mkdir(path.join(away, 'outline', 'demo'), { recursive: true });
  for (const name of ['hair.glb', 'hair_keys.glb', 'look.png', 'render.png']) {
    await fs.writeFile(path.join(away, 'outline', 'demo', name), 'x');
  }

  // What Claude Code keeps of the conversation the lines below are from.
  configDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
  const project = path.join(dir, 'claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'));
  const demo = `${away}/outline/demo`;
  const said = [
    `Preview:\n\n\`${demo}/look.png\`\n\nDone.`,
    `Mesh:\n\n\`${demo}/hair.glb\` (watertight) \`${demo}/hair_keys.glb\` (morph targets)`,
    `Rendered \`${demo}/render.png\` as well, and \`${demo}/never-written.glb\`.`,
  ];
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(
    path.join(project, 'session.jsonl'),
    said
      .map((text) => JSON.stringify({ message: { content: [{ type: 'text', text }] } }))
      .join('\n'),
  );
});

after(async () => {
  if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configDir;
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(away, { recursive: true, force: true });
});

beforeEach(() => {
  reset();
  drawn = undefined;
});

/** What the terminal was sent, in the tests that have one that was listened to. */
let drawn: string[] | undefined;

const agent = (profileId?: string) =>
  ({ folder, root: folder, terminal: {}, profileId } as unknown as RunningAgent);

/** The provider, with the two things it collaborates with stood in for. */
function provider(profileId?: string): { links: PathLinks; opened: URI[] } {
  const opened: URI[] = [];
  const grid = { openFile: async (uri: URI) => void opened.push(uri) } as unknown as EditorGrid;
  const registry = { byTerminal: () => agent(profileId) } as unknown as AgentRegistry;
  return { links: new PathLinks(registry, grid, { linesOf: () => drawn }), opened };
}

/** The files clicking every image link on a line opens, by path. */
async function click(line: string, profileId?: string): Promise<string[]> {
  const { links, opened } = provider(profileId);
  const found = await links.provideTerminalLinks({ terminal: {}, line } as never);
  for (const link of found) await links.handleTerminalLink(link);
  return opened.map((uri) => uri.path);
}

describe('what on a line could be an image', () => {
  it('takes a whole path, and not the size the CLI prints after it', () => {
    const line = '  › [image] /tmp/shots/ctx-post.png (31.7KB)';

    assert.deepEqual(imageTokens(line), [{ text: '/tmp/shots/ctx-post.png', index: 12 }]);
  });

  it('takes the tail of a path the CLI broke in half', () => {
    const tail = '8c-a899-4163cb4b005d/scratchpad/ctx-post.png';

    assert.deepEqual(imageTokens(`  ${tail} (31.7KB)`), [{ text: tail, index: 2 }]);
  });

  it('takes the head of one only where the CLI said it was an image', () => {
    const head = '/tmp/claude-1000/-home-dev-project/882a34a3-62f6-4e';

    assert.deepEqual(imageTokens(`  › [image] ${head}`), [{ text: head, index: 12 }]);
    // The same shape of word, with nothing saying it names an image.
    assert.deepEqual(imageTokens(`  cd ${head}`), []);
  });

  it('leaves alone the paths that are not images', () => {
    assert.deepEqual(imageTokens('  Read src/links.ts (240 lines)'), []);
    assert.deepEqual(imageTokens('  npm run build'), []);
  });

  it('leaves an address to the workbench, which opens it in a browser', () => {
    assert.deepEqual(imageTokens('  https://example.com/shot.png'), []);
    assert.deepEqual(imageTokens('  › [image] https://example.com/a/b'), []);
  });

  it('reads a line the CLI drew a box around', () => {
    const head = '/tmp/claude-1000/-home-dev-project/882a34a3-62f6-4e';

    assert.deepEqual(imageTokens(`│ › [image] ${head} │`), [{ text: head, index: 12 }]);
    assert.deepEqual(imageTokens('│ wrote media/icon.png │'), [
      { text: 'media/icon.png', index: 8 },
    ]);
  });

  it('keeps the full stop that ended the sentence out of the name', () => {
    assert.deepEqual(imageTokens('  Saved it to media/icon.png.'), [
      { text: 'media/icon.png', index: 14 },
    ]);
  });
});

describe('following one', () => {
  it('opens a path the line carried whole', async () => {
    const whole = `${dir}/${SESSION}/scratchpad/ctx-post.png`;

    assert.deepEqual(await click(`  › [image] ${whole} (31.7KB)`), [whole]);
  });

  it('opens one written relative to the folder the agent runs in', async () => {
    assert.deepEqual(await click('  wrote media/icon.png'), [`${dir}/media/icon.png`]);
  });

  it('rejoins a head that was cut inside a name', async () => {
    // The rest of it — `…4163cb4b005d/scratchpad/ctx-post.png` — is on the next
    // line, and the workbench never sees the two together.
    const head = `${dir}/claude-1000/-home-dev-project/882a34a3-62f6-4e`;

    assert.deepEqual(await click(`  › [image] ${head}`), [
      `${dir}/${SESSION}/scratchpad/ctx-post.png`,
    ]);
  });

  it('rejoins a tail by the end of the path it belongs to', async () => {
    assert.deepEqual(await click('  8c-a899-4163cb4b005d/scratchpad/ctx-post.png (31.7KB)'), [
      `${dir}/${SESSION}/scratchpad/ctx-post.png`,
    ]);
  });

  it('asks rather than choosing when a cut leaves several images', async () => {
    const second = path.join(dir, SESSION, 'scratchpad', 'ctx-d2r.png');
    await fs.writeFile(second, 'png');
    state.answer = 'ctx-d2r.png';

    try {
      assert.deepEqual(await click(`  › [image] ${dir}/${SESSION}/scratchpa`), [second]);
      assert.deepEqual(
        state.picks.map((list) => list.map((item) => item.label).sort()),
        [['ctx-d2r.png', 'ctx-post.png']],
      );
    } finally {
      await fs.rm(second);
    }
  });

  it('says so rather than opening something else when nothing answers', async () => {
    assert.deepEqual(await click(`  › [image] ${dir}/claude-1000/-home-dev-project/9`), []);
    assert.equal(state.prompts.length, 1);
  });

  it('has nothing to say in a terminal that is not an agent', async () => {
    const grid = { openFile: async () => {} } as unknown as EditorGrid;
    const registry = { byTerminal: () => undefined } as unknown as AgentRegistry;
    const links = new PathLinks(registry, grid, { linesOf: () => undefined });

    assert.deepEqual(
      await links.provideTerminalLinks({ terminal: {}, line: '  › [image] /tmp/a.png' } as never),
      [],
    );
  });
});

describe('what on a line could be half of any path', () => {
  it('takes a path from the root that the line ends on', () => {
    assert.deepEqual(cutTokens('  hair.glb (watertight) /srv/models/h'), [
      { text: '/srv/models/h', index: 24 },
    ]);
    // The same path with the sentence going on after it was not cut there.
    assert.deepEqual(cutTokens('  cd /srv/models/h and look'), []);
  });

  it('takes a file name with folders before it that the line starts on', () => {
    assert.deepEqual(cutTokens('  air/outline/hair_keys.glb (morph targets)'), [
      { text: 'air/outline/hair_keys.glb', index: 2 },
    ]);
    assert.deepEqual(cutTokens('  see air/outline/hair_keys.glb'), []);
  });

  it('leaves the line number and the full stop out of it', () => {
    assert.deepEqual(cutTokens('  /srv/models/hair.ts:12.'), [
      { text: '/srv/models/hair.ts', index: 2 },
    ]);
  });

  it('leaves alone a word, a route and an address', () => {
    assert.deepEqual(cutTokens('  Node.js is installed'), []);
    assert.deepEqual(cutTokens('  GET /health'), []);
    assert.deepEqual(cutTokens('  https://example.com/models/h'), []);
  });
});

describe('finding a piece in what the CLI wrote down', () => {
  const text = [
    'Preview: `/srv/demo/look.png` Done.',
    'Mesh: `/srv/demo/hair.glb` (watertight) `/srv/demo/hair_keys.glb` (morph targets)',
    'See src/links.ts:113.',
  ].join(' ');
  const piece = (line: string, part: string) => {
    const index = line.lastIndexOf(part);
    const before = line.slice(0, index);
    const after = line.slice(index + part.length);
    return { text: part, openLeft: !before.trim(), openRight: !after.trim(), before, after };
  };

  it('grows a tail back to the path it ends', () => {
    const line = '  emo/hair_keys.glb (morph targets)';

    assert.deepEqual(pathsIn(text, piece(line, 'emo/hair_keys.glb')), ['/srv/demo/hair_keys.glb']);
  });

  it('tells heads apart by the words before them', () => {
    const line = '  /srv/demo/hair.glb (watertight) /srv/de';

    assert.deepEqual(pathsIn(text, piece(line, '/srv/de')), ['/srv/demo/hair_keys.glb']);
    // Alone on its line it could be any of them, the last one said first.
    assert.deepEqual(pathsIn(text, piece('  /srv/de', '/srv/de')), [
      '/srv/demo/hair_keys.glb',
      '/srv/demo/hair.glb',
      '/srv/demo/look.png',
    ]);
  });

  it('does not grow the side the line went on from', () => {
    assert.deepEqual(pathsIn(text, piece('  open rv/demo/look.png now', 'rv/demo/look.png')), []);
  });

  it('drops the line number a path was written with', () => {
    assert.deepEqual(pathsIn(text, piece('  rc/links.ts', 'rc/links.ts')), ['src/links.ts']);
  });
});

describe('following one the CLI wrote down', () => {
  it('opens a file of any kind from the tail of its path', async () => {
    assert.deepEqual(await click('  ine/demo/hair_keys.glb (morph targets)', 'claude'), [
      `${away}/outline/demo/hair_keys.glb`,
    ]);
  });

  it('opens the one the head was followed by, going by the line', async () => {
    const line = `  ${away}/outline/demo/hair.glb (watertight) ${away}/outl`;

    // The first path is whole, so it is the workbench's; only the head is ours.
    assert.deepEqual(await click(line, 'claude'), [`${away}/outline/demo/hair_keys.glb`]);
  });

  it('asks when a head could go on to several files, and offers only real ones', async () => {
    state.answer = 'render.png';

    assert.deepEqual(await click(`  ${away}/outline/de`, 'claude'), [
      `${away}/outline/demo/render.png`,
    ]);
    assert.deepEqual(
      state.picks.map((list) => list.map((item) => item.label).sort()),
      [['hair.glb', 'hair_keys.glb', 'look.png', 'render.png']],
    );
  });

  it('opens an image whose folder no search would have reached', async () => {
    assert.deepEqual(await click('  emo/look.png', 'claude'), [`${away}/outline/demo/look.png`]);
  });
});

describe('what a terminal was sent, as the lines it drew', () => {
  const ESC = '\x1b';

  it('drops the colours and keeps the rows', () => {
    const raw =
      `${ESC}[38;5;153m/srv/demo/hai${ESC}[39m${ESC}[K\r\n` +
      `  ${ESC}[1mr.glb${ESC}[22m done\r\n`;

    assert.deepEqual(toLines(raw), ['/srv/demo/hai', '  r.glb done', '']);
  });

  it('starts a line wherever the cursor is sent to another row', () => {
    const raw = `${ESC}[3;1H/srv/demo/hai${ESC}[4;1Hr.glb${ESC}]0;title\x07${ESC}[2Cdone`;

    assert.deepEqual(toLines(raw), ['', '/srv/demo/hai', 'r.glb  done']);
  });

  it('keeps the lines in order across the chunks they arrive in', () => {
    const recording = new Recording();
    recording.push(`one${ESC}[`);
    recording.push('1mtwo\r\nthr');
    recording.push('ee\r\n'.padEnd(20_000, ' '));
    recording.push('\r\nfour');

    assert.deepEqual(
      recording.lines().map((line) => line.trim()),
      ['onetwo', 'three', '', 'four'],
    );
  });
});

describe('putting a piece back next to the line it was cut from', () => {
  const lines = [
    '● Mesh:',
    '  /srv/demo/hair.glb (watertight) /srv/de',
    '  mo/hair_keys.glb (morph targets)',
    '',
    '  See src/integration/gr',
    '  id.test.ts:70 for the',
    '  rest.',
    '│ /srv/a-very-long-folder-na │',
    '│ me/and-another-long-one/fi │',
    '│ le.bin                     │',
  ];
  const piece = (line: string, part: string) => {
    const index = line.lastIndexOf(part);
    const before = line.slice(0, index);
    const after = line.slice(index + part.length);
    const blank = (text: string) => !text.replace(/[│\s]/g, '');
    return { text: part, openLeft: blank(before), openRight: blank(after), before, after };
  };

  it('joins a head to what the next line starts with', () => {
    assert.deepEqual(rejoin(lines, piece(lines[1]!, '/srv/de')), ['/srv/demo/hair_keys.glb']);
  });

  it('joins a tail to what the line before ended on', () => {
    assert.deepEqual(rejoin(lines, piece(lines[2]!, 'mo/hair_keys.glb')), [
      '/srv/demo/hair_keys.glb',
    ]);
  });

  it('does the same for a path that does not start at the root', () => {
    assert.deepEqual(rejoin(lines, piece(lines[4]!, 'src/integration/gr')), [
      'src/integration/grid.test.ts',
    ]);
    assert.deepEqual(rejoin(lines, piece(lines[5]!, 'id.test.ts')), [
      'src/integration/grid.test.ts',
    ]);
  });

  it('follows a path over more than two lines, from any of them', () => {
    const whole = '/srv/a-very-long-folder-name/and-another-long-one/file.bin';

    assert.ok(rejoin(lines, piece(lines[7]!, '/srv/a-very-long-folder-na')).includes(whole));
    assert.ok(rejoin(lines, piece(lines[8]!, 'me/and-another-long-one/fi')).includes(whole));
    assert.ok(rejoin(lines, piece(lines[9]!, 'le.bin')).includes(whole));
  });

  it('has nothing for a word in the middle of a line', () => {
    assert.deepEqual(rejoin(lines, piece('  a (watertight) b', '(watertight)')), []);
  });
});

describe('following one the terminal drew', () => {
  // No profile: nothing the CLI wrote down is read, only the lines themselves.
  const wrapped = () => [
    '  Mesh:',
    `  ${away}/outline/demo/hair.glb (watertight) ${away}/outl`,
    '  ine/demo/hair_keys.glb (morph targets)',
    '  and the last word of this line is the',
    '  first of nothing at all.',
    '  Tests are in media/ic',
    '  on.png as before.',
  ];

  it('opens the file from the head and from the tail', async () => {
    drawn = wrapped();

    assert.deepEqual(await click(drawn[1]!), [`${away}/outline/demo/hair_keys.glb`]);
    assert.deepEqual(await click(drawn[2]!), [`${away}/outline/demo/hair_keys.glb`]);
  });

  it('opens one written relative to the folder, cut where no shape gives it away', async () => {
    drawn = wrapped();

    assert.deepEqual(await click(drawn[5]!), [`${dir}/media/icon.png`]);
  });

  it('links nothing on a line that only ends on a word', async () => {
    drawn = wrapped();
    const { links } = provider();

    assert.deepEqual(
      await links.provideTerminalLinks({ terminal: {}, line: drawn[3]! } as never),
      [],
    );
  });
});

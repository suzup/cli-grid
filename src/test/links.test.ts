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
import { ImageLinks, imageTokens } from '../links.js';
import type { AgentRegistry } from '../registry.js';
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

/** The files the terminal lines below are about. */
const SESSION = 'claude-1000/-home-dev-project/882a34a3-62f6-4e8c-a899-4163cb4b005d';

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-grid-links-'));
  folder = URI.file(dir);

  await fs.mkdir(path.join(dir, SESSION, 'scratchpad'), { recursive: true });
  await fs.writeFile(path.join(dir, SESSION, 'scratchpad', 'ctx-post.png'), 'png');
  await fs.mkdir(path.join(dir, 'media'), { recursive: true });
  await fs.writeFile(path.join(dir, 'media', 'icon.png'), 'png');
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(() => reset());

const agent = () =>
  ({ folder, root: folder, terminal: {} } as unknown as RunningAgent);

/** The provider, with the two things it collaborates with stood in for. */
function provider(): { links: ImageLinks; opened: URI[] } {
  const opened: URI[] = [];
  const grid = { openFile: async (uri: URI) => void opened.push(uri) } as unknown as EditorGrid;
  const registry = { byTerminal: () => agent() } as unknown as AgentRegistry;
  return { links: new ImageLinks(registry, grid), opened };
}

/** The files clicking every image link on a line opens, by path. */
async function click(line: string): Promise<string[]> {
  const { links, opened } = provider();
  const found = links.provideTerminalLinks({ terminal: {}, line } as never);
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

  it('has nothing to say in a terminal that is not an agent', () => {
    const grid = { openFile: async () => {} } as unknown as EditorGrid;
    const registry = { byTerminal: () => undefined } as unknown as AgentRegistry;
    const links = new ImageLinks(registry, grid);

    assert.deepEqual(
      links.provideTerminalLinks({ terminal: {}, line: '  › [image] /tmp/a.png' } as never),
      [],
    );
  });
});

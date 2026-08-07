// Must come first: it stands in for the `vscode` module the rest of these
// imports reach for.
import './vscode.js';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { URI } from 'vscode-uri';
import {
  CONFIG_RELATIVE,
  addAgentToConfig,
  hasConfig,
  openableConfigUri,
  readConfig,
  removeAgentFromConfig,
  reorderAgents,
  updateAgentInConfig,
  writeConfig,
} from '../project.js';

let dir: string;
let root: URI;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-grid-project-'));
  root = URI.file(dir);
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(path.join(dir, '.vscode'), { recursive: true, force: true });
});

/** Writes a config file verbatim, which is how a hand-edited one arrives. */
async function put(name: string, text: string): Promise<void> {
  await fs.mkdir(path.join(dir, '.vscode'), { recursive: true });
  await fs.writeFile(path.join(dir, '.vscode', name), text);
}

describe('finding the config', () => {
  it('reports nothing in a plain folder', async () => {
    assert.equal(await hasConfig(root), false);
    assert.equal(await readConfig(root), undefined);
  });

  it('offers the current name as the place a new one would go', async () => {
    assert.equal((await openableConfigUri(root)).path, `${root.path}/${CONFIG_RELATIVE}`);
  });

  // The extension was renamed twice before it settled, and a project written
  // under an older name has to keep working.
  it('falls back to the names this file used to have', async () => {
    for (const legacy of ['agent-grid.json', 'agentry.json']) {
      await put(legacy, '{"agents":[{"cli":"claude","folder":"."}]}');

      assert.equal(await hasConfig(root), true, legacy);
      assert.equal((await readConfig(root))?.agents.length, 1, legacy);
      assert.ok((await openableConfigUri(root)).path.endsWith(legacy), legacy);

      await fs.rm(path.join(dir, '.vscode', legacy));
    }
  });

  it('prefers the current name when both are there', async () => {
    await put('agentry.json', '{"agents":[{"cli":"codex","folder":"."}]}');
    await put('cli-grid.json', '{"agents":[{"cli":"claude","folder":"."}]}');

    assert.equal((await readConfig(root))?.agents[0]?.cli, 'claude');
  });
});

describe('reading a hand-edited config', () => {
  it('tolerates comments and trailing commas', async () => {
    await put(
      'cli-grid.json',
      `{
         // the split this window opens in
         "layout": "grid-2x2",
         /* one agent per service */
         "agents": [
           { "cli": "claude", "folder": "api" },
         ],
       }`,
    );

    const config = await readConfig(root);
    assert.equal(config?.layout, 'grid-2x2');
    assert.deepEqual(config?.agents, [{ cli: 'claude', folder: 'api' }]);
  });

  it('drops an agent with no cli, and defaults a missing folder to the root', async () => {
    await put(
      'cli-grid.json',
      '{"agents":[{"folder":"api"},{"cli":"claude"},{"cli":"codex","folder":"  "}]}',
    );

    assert.deepEqual((await readConfig(root))?.agents, [
      { cli: 'claude', folder: '.' },
      { cli: 'codex', folder: '.' },
    ]);
  });

  it('keeps a declared mode and leaves it off otherwise', async () => {
    await put(
      'cli-grid.json',
      '{"agents":[{"cli":"claude","folder":".","mode":"resume"},{"cli":"codex","folder":"."}]}',
    );

    const [claude, codex] = (await readConfig(root))!.agents;
    assert.equal(claude?.mode, 'resume');
    assert.ok(codex && !('mode' in codex), 'no mode key rather than an undefined one');
  });

  // Better an empty project than a broken window: the file is reported and the
  // views come up with nothing in them.
  it('survives a file that is not json at all', async () => {
    await put('cli-grid.json', '{ this is not json');
    assert.deepEqual(await readConfig(root), { agents: [] });
  });
});

describe('writing', () => {
  it('creates .vscode and round-trips', async () => {
    await writeConfig(root, { layout: 'grid-2x1', agents: [{ cli: 'claude', folder: 'api' }] });

    const config = await readConfig(root);
    assert.equal(config?.layout, 'grid-2x1');
    assert.deepEqual(config?.agents, [{ cli: 'claude', folder: 'api' }]);
  });

  it('leaves out a layout that was never chosen', async () => {
    await writeConfig(root, { agents: [] });

    const text = await fs.readFile(path.join(dir, '.vscode', 'cli-grid.json'), 'utf8');
    assert.equal(text.includes('layout'), false);
    assert.equal(text.includes('$schema'), false, 'the manifest binds the schema instead');
    assert.ok(text.endsWith('\n'), 'a trailing newline, like every other config file');
  });

  it('adds an agent once, however many times it is asked', async () => {
    const spec = { cli: 'claude', folder: 'api' };
    await addAgentToConfig(root, spec);
    await addAgentToConfig(root, spec);

    assert.equal((await readConfig(root))?.agents.length, 1);
  });

  it('keeps a name given to an agent', async () => {
    await writeConfig(root, { agents: [{ cli: 'claude', folder: 'api', name: 'billing' }] });
    assert.equal((await readConfig(root))?.agents[0]?.name, 'billing');
  });

  it('tells two CLIs in the same folder apart', async () => {
    await addAgentToConfig(root, { cli: 'claude', folder: 'api' });
    await addAgentToConfig(root, { cli: 'codex', folder: 'api' });
    assert.equal((await readConfig(root))?.agents.length, 2);

    await removeAgentFromConfig(root, { cli: 'claude', folder: 'api' });
    assert.deepEqual((await readConfig(root))?.agents, [{ cli: 'codex', folder: 'api' }]);
  });
});

describe('reordering', () => {
  const three = [
    { cli: 'claude', folder: 'a' },
    { cli: 'codex', folder: 'b' },
    { cli: 'gemini', folder: 'c' },
  ];
  const order = async () => (await readConfig(root))!.agents.map((a) => a.folder).join('');

  it('moves an agent above the one it was dropped on', async () => {
    await writeConfig(root, { agents: [...three] });
    await reorderAgents(root, [three[2]!], three[0]!);
    assert.equal(await order(), 'cab');
  });

  it('moves it to the end when nothing was named', async () => {
    await writeConfig(root, { agents: [...three] });
    await reorderAgents(root, [three[0]!], undefined);
    assert.equal(await order(), 'bca');
  });

  it('keeps a multiple selection together, in its own order', async () => {
    await writeConfig(root, { agents: [...three] });
    await reorderAgents(root, [three[0]!, three[2]!], three[1]!);
    assert.equal(await order(), 'acb');
  });

  // The target's index has to be found after the dragged rows are taken out,
  // or moving something downwards lands one place short.
  it('moves an agent downwards to the right place', async () => {
    await writeConfig(root, { agents: [...three] });
    await reorderAgents(root, [three[0]!], three[2]!);
    assert.equal(await order(), 'bac');
  });

  it('ignores an agent that is not in this project', async () => {
    await writeConfig(root, { agents: [...three] });
    await reorderAgents(root, [{ cli: 'claude', folder: 'elsewhere' }], three[0]!);
    assert.equal(await order(), 'abc');
  });
});

describe('editing one agent', () => {
  it('changes it in place, keeping its position', async () => {
    await writeConfig(root, {
      agents: [
        { cli: 'claude', folder: 'a' },
        { cli: 'codex', folder: 'b' },
      ],
    });

    const ok = await updateAgentInConfig(
      root,
      { cli: 'claude', folder: 'a' },
      { cli: 'gemini', folder: 'a', name: 'renamed' },
    );

    assert.equal(ok, true);
    assert.deepEqual((await readConfig(root))?.agents, [
      { cli: 'gemini', folder: 'a', name: 'renamed' },
      { cli: 'codex', folder: 'b' },
    ]);
  });

  // Two entries with the same folder and CLI are the same agent, so one would
  // shadow the other with no way to tell them apart.
  it('refuses a change that collides with another agent', async () => {
    const agents = [
      { cli: 'claude', folder: 'a' },
      { cli: 'codex', folder: 'a' },
    ];
    await writeConfig(root, { agents: [...agents] });

    const ok = await updateAgentInConfig(root, agents[0]!, { cli: 'codex', folder: 'a' });

    assert.equal(ok, false);
    assert.deepEqual((await readConfig(root))?.agents, agents);
  });

  it('reports nothing changed when the agent is gone', async () => {
    await writeConfig(root, { agents: [] });
    assert.equal(
      await updateAgentInConfig(root, { cli: 'claude', folder: 'a' }, { cli: 'codex', folder: 'a' }),
      false,
    );
  });
});

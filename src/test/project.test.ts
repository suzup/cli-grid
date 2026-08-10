// Must come first: it stands in for the `vscode` module the rest of these
// imports reach for.
import './vscode.js';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { URI } from 'vscode-uri';
import type { RunningAgent } from '../types.js';
import {
  CONFIG_RELATIVE,
  addAgentToConfig,
  hasConfig,
  inProjectOrder,
  type AgentSpec,
  isPinned,
  openableConfigUri,
  pinnedAgents,
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

/**
 * Which agents the project's start button brings up. Four agents in a project
 * is not four you want every time, so a row can be left out of the set without
 * leaving the list.
 */
describe('pins', () => {
  it('counts an agent in unless it says otherwise', () => {
    assert.equal(isPinned({ folder: '.', cli: 'claude' }), true);
    assert.equal(isPinned({ folder: '.', cli: 'claude', pinned: true }), true);
    assert.equal(isPinned({ folder: '.', cli: 'claude', pinned: false }), false);
  });

  it('keeps the order the project file has them in', () => {
    const agents: AgentSpec[] = [
      { folder: 'api', cli: 'claude' },
      { folder: 'docs', cli: 'claude', pinned: false },
      { folder: 'web', cli: 'codex' },
    ];

    assert.deepEqual(
      pinnedAgents({ agents }).map((spec) => spec.folder),
      ['api', 'web'],
    );
  });

  // A project written before pins existed starts everything, which is what it
  // did before — nothing has to be pinned for the button to work.
  it('starts everything in a config that says nothing about pins', async () => {
    await put('cli-grid.json', '{ "agents": [{ "cli": "claude" }, { "cli": "codex" }] }');

    assert.equal(pinnedAgents(await readConfig(root)).length, 2);
  });

  it('survives a round trip through the file', async () => {
    await writeConfig(root, {
      agents: [
        { folder: '.', cli: 'claude' },
        { folder: 'docs', cli: 'codex', pinned: false },
      ],
    });

    const config = await readConfig(root);
    assert.equal(config?.agents[0]?.pinned, undefined, 'the ordinary case stays unwritten');
    assert.equal(config?.agents[1]?.pinned, false);
  });
});

describe('inProjectOrder', () => {
  const project = (uri: URI, agents: AgentSpec[]) => ({ uri, config: { agents } });

  /** Only the fields the ordering reads; the rest of an agent is irrelevant. */
  const running = (id: string, uri: URI, folder: string, cli: string) =>
    ({ id, root: uri, folderRef: folder, profileId: cli }) as unknown as RunningAgent;

  const other = URI.file('/home/dev/other');

  // The bug this exists for: clicking a split re-arranged the panes into the
  // order the agents happened to have been started in, throwing away the order
  // the list was dragged into.
  it('follows the project file rather than the order they started in', () => {
    const config = [
      { cli: 'claude', folder: 'a' },
      { cli: 'claude', folder: 'b' },
      { cli: 'claude', folder: 'c' },
    ];
    const started = [
      running('2', root, 'c', 'claude'),
      running('3', root, 'a', 'claude'),
      running('1', root, 'b', 'claude'),
    ];

    assert.deepEqual(
      inProjectOrder([project(root, config)], started).map((agent) => agent.folderRef),
      ['a', 'b', 'c'],
    );
  });

  it('leaves out the agents in the file that are not running', () => {
    const config = [
      { cli: 'claude', folder: 'a' },
      { cli: 'claude', folder: 'b' },
    ];
    const started = [running('1', root, 'b', 'claude')];

    assert.deepEqual(inProjectOrder([project(root, config)], started).map((a) => a.id), ['1']);
  });

  // An agent launched without being saved has no place in the file to sit in,
  // and dropping it would leave its pane out of the arrangement entirely.
  it('keeps an ad-hoc agent, after the ones that are written down', () => {
    const started = [
      running('adhoc', root, 'z', 'claude'),
      running('saved', root, 'a', 'claude'),
    ];

    assert.deepEqual(
      inProjectOrder([project(root, [{ cli: 'claude', folder: 'a' }])], started).map((a) => a.id),
      ['saved', 'adhoc'],
    );
  });

  it('takes the projects in turn, so one window of two stays grouped', () => {
    const started = [
      running('2', other, 'a', 'claude'),
      running('1', root, 'a', 'claude'),
    ];
    const projects = [
      project(root, [{ cli: 'claude', folder: 'a' }]),
      project(other, [{ cli: 'claude', folder: 'a' }]),
    ];

    assert.deepEqual(inProjectOrder(projects, started).map((a) => a.id), ['1', '2']);
  });

  // Same folder, different CLIs: distinct agents, and the file says which pane
  // each one gets.
  it('tells two CLIs in one folder apart', () => {
    const config = [
      { cli: 'codex', folder: 'a' },
      { cli: 'claude', folder: 'a' },
    ];
    const started = [
      running('claude', root, 'a', 'claude'),
      running('codex', root, 'a', 'codex'),
    ];

    assert.deepEqual(
      inProjectOrder([project(root, config)], started).map((a) => a.id),
      ['codex', 'claude'],
    );
  });
});

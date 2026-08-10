// Must come first: it stands in for the `vscode` module the rest of these
// imports reach for.
import { reset, state } from './vscode.js';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { URI } from 'vscode-uri';
import { ProjectWatcher, readConfig, writeConfig, type AgentSpec } from '../project.js';
import { AgentRegistry } from '../registry.js';
import { WorkspaceRoots } from '../roots.js';

/**
 * The agent list and the window's folder list are the same list seen twice.
 * These are the two directions of that.
 */

let dir: string;
let root: URI;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-grid-roots-'));
  root = URI.file(dir);
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(() => reset());

afterEach(async () => {
  await fs.rm(path.join(dir, '.vscode'), { recursive: true, force: true });
});

/** The window, as the workbench would report it. */
function open(...folders: URI[]): void {
  state.folders.length = 0;
  for (const [index, uri] of folders.entries()) {
    state.folders.push({ uri, name: path.basename(uri.path), index });
  }
}

const paths = () => state.folders.map((folder) => folder.uri.path);

async function project(agents: AgentSpec[]): Promise<WorkspaceRoots> {
  await writeConfig(root, { agents });
  const projects = new ProjectWatcher();
  await projects.refresh();
  return new WorkspaceRoots(projects, new AgentRegistry());
}

describe('putting agent folders in the window', () => {
  it('adds the ones the window cannot already reach', async () => {
    open(root);
    const roots = await project([
      { cli: 'claude', folder: '/srv/api' },
      { cli: 'claude', folder: '/srv/web' },
    ]);

    await roots.sync();

    assert.deepEqual(paths(), [root.path, '/srv/api', '/srv/web']);
  });

  // The project folder is index 0 and stays there: replacing the first folder
  // is the case the API restarts the extension host for, which would take every
  // running agent down with it.
  it('never touches the folder the window was opened on', async () => {
    open(root);
    const roots = await project([{ cli: 'claude', folder: '/srv/api' }]);

    await roots.sync();

    assert.equal(state.folders[0]?.uri.path, root.path);
  });

  it('leaves a folder alone when one already open contains it', async () => {
    open(root);
    const roots = await project([{ cli: 'claude', folder: 'api' }]);

    await roots.sync();

    assert.deepEqual(paths(), [root.path], 'a folder inside the project needs no root of its own');
  });

  it('adds nothing twice, however often it runs', async () => {
    open(root);
    const roots = await project([{ cli: 'claude', folder: '/srv/api' }]);

    await roots.sync();
    await roots.sync();

    assert.deepEqual(paths(), [root.path, '/srv/api']);
  });

  // Adding the first folder of an empty window is the other restart case, and
  // there is no project in one anyway.
  it('does nothing in a window with no folder open', async () => {
    open();
    const roots = await project([{ cli: 'claude', folder: '/srv/api' }]);

    await roots.sync();

    assert.deepEqual(paths(), []);
  });
});

describe('taking one back out', () => {
  it('removes the folder once its agent has gone from the config', async () => {
    open(root, URI.file('/srv/api'));
    const roots = await project([]);

    await roots.remove(URI.file('/srv/api'));

    assert.deepEqual(paths(), [root.path]);
  });

  it('keeps it while another agent still works there', async () => {
    open(root, URI.file('/srv/api'));
    const roots = await project([{ cli: 'codex', folder: '/srv/api' }]);

    await roots.remove(URI.file('/srv/api'));

    assert.deepEqual(paths(), [root.path, '/srv/api']);
  });
});

describe('a folder taken out of the window by hand', () => {
  /** What the Explorer's "Remove Folder from Workspace" does, event and all. */
  const removeFolder = async (at: number) => {
    vscode.workspace.updateWorkspaceFolders(at, 1);
    // The event lands in a microtask and the handler that reads it is async.
    for (let tick = 0; tick < 20; tick++) await new Promise((done) => setTimeout(done, 5));
  };

  it('asks before it takes the agent with it', async () => {
    open(root, URI.file('/srv/api'));
    await project([{ cli: 'claude', folder: '/srv/api' }]);
    state.answer = 'Remove';

    await removeFolder(1);

    assert.equal(state.prompts.length, 1, 'the user was not asked');
    assert.deepEqual((await readConfig(root))?.agents, [], 'the agent outlived its folder');
  });

  it('leaves the agent alone when the answer is no', async () => {
    open(root, URI.file('/srv/api'));
    const spec: AgentSpec = { cli: 'claude', folder: '/srv/api' };
    await project([spec]);
    state.answer = undefined; // dismissed

    await removeFolder(1);

    assert.equal(state.prompts.length, 1);
    assert.deepEqual((await readConfig(root))?.agents, [spec]);
  });

  it('says nothing about a folder no agent works in', async () => {
    open(root, URI.file('/srv/notes'));
    await project([{ cli: 'claude', folder: '/srv/api' }]);

    await removeFolder(1);

    assert.deepEqual(state.prompts, []);
  });

  // One question for the lot of them, rather than one dialog per folder.
  it('asks once when several go at the same time', async () => {
    open(root, URI.file('/srv/api'), URI.file('/srv/web'));
    await project([
      { cli: 'claude', folder: '/srv/api' },
      { cli: 'claude', folder: '/srv/web' },
    ]);
    state.answer = 'Remove';

    vscode.workspace.updateWorkspaceFolders(1, 2);
    for (let tick = 0; tick < 20; tick++) await new Promise((done) => setTimeout(done, 5));

    assert.equal(state.prompts.length, 1);
    assert.deepEqual((await readConfig(root))?.agents, []);
  });
});

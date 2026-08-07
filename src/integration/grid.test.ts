import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { EditorGrid } from '../grid.js';
import { paneCount, presetById } from '../layout.js';

/**
 * What the editor area actually does, in a real workbench.
 *
 * These are the claims that no amount of unit testing can settle: that a split
 * produces the groups it says it does, that a file lands beside the grid rather
 * than on top of an agent, and that a pane holding an agent refuses one.
 */

/** The workbench applies a layout asynchronously; wait for it to agree. */
async function settle(what: string, holds: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!holds()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const groups = () => vscode.window.tabGroups.all;
const groupOf = (name: string) =>
  groups().find((group) => group.tabs.some((tab) => tab.label.includes(name)));

let dir: string;
const terminals: vscode.Terminal[] = [];

/** A terminal in the editor area is what an agent is, minus the CLI. */
function agentTerminal(column: number, name: string): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name,
    location: { viewColumn: column },
  });
  terminals.push(terminal);
  return terminal;
}

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-grid-ui-'));

  // The extension under test is loaded in this window and applies a layout of
  // its own on startup. `activate` returns before that finishes — it is started
  // and not awaited, deliberately, so activation is not held up by it — so wait
  // for the editor area to stop changing. Otherwise that pass lands in the
  // middle of whichever test happens to be running when startup completes.
  await vscode.extensions.getExtension('suzup.cli-grid')?.activate();
  await quiet();
});

/** Resolves once the editor area has held still for a moment. */
async function quiet(ms = 750): Promise<void> {
  let seen = '';
  for (;;) {
    const now = groups()
      .map((group) => `${group.viewColumn}:${group.tabs.length}`)
      .join();
    if (now === seen) return;
    seen = now;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

after(async () => {
  for (const terminal of terminals) terminal.dispose();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await fsp.rm(dir, { recursive: true, force: true });
});

afterEach(async () => {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
});

async function file(name: string, body = '// test\n'): Promise<vscode.Uri> {
  const uri = vscode.Uri.file(path.join(dir, name));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(body));
  return uri;
}

describe('applying a split', () => {
  it('produces one editor group per pane', async () => {
    const grid = new EditorGrid();
    const preset = presetById('grid-2x2')!;

    await grid.applyPreset(preset);
    await settle('four groups', () => groups().length === paneCount(preset));

    grid.dispose();
  });

  it('produces the panes of every preset it offers', async () => {
    const grid = new EditorGrid();

    for (const id of ['single', 'grid-2x1', 'grid-1x2', 'grid-3x1', 'grid-3x2']) {
      const preset = presetById(id)!;
      await grid.applyPreset(preset);
      await settle(`${id} groups`, () => groups().length === paneCount(preset));
    }

    grid.dispose();
  });
});

describe('opening a file beside the grid', () => {
  it('splits off one extra group and puts the file in it', async () => {
    const grid = new EditorGrid();
    const preset = presetById('grid-2x1')!;

    await grid.applyPreset(preset);
    await settle('the grid', () => groups().length === 2);

    await grid.openFile(await file('beside.ts'));
    // The grid keeps its two panes and the file gets a third beside them.
    await settle('the file pane', () => groups().length === paneCount(preset) + 1);

    const group = groupOf('beside.ts');
    assert.equal(group?.viewColumn, paneCount(preset) + 1, 'the file is in the last group');

    grid.dispose();
  });

  it('sends a second file to the same pane rather than splitting again', async () => {
    const grid = new EditorGrid();
    await grid.applyPreset(presetById('single')!);

    await grid.openFile(await file('first.ts'));
    await settle('the file pane', () => groups().length === 2);

    await grid.openFile(await file('second.ts'), false);
    await settle('both files', () => Boolean(groupOf('second.ts')));

    assert.equal(groups().length, 2, 'no third group appeared');
    assert.equal(groupOf('second.ts')?.viewColumn, 2);

    grid.dispose();
  });
});

describe('panes holding an agent', () => {
  it('keeps the terminal, and takes the file elsewhere', async () => {
    const grid = new EditorGrid();
    const preset = presetById('grid-2x1')!;

    await grid.applyPreset(preset);
    await settle('the grid', () => groups().length === 2);

    agentTerminal(1, 'agent-one');
    await settle('the terminal', () => Boolean(groupOf('agent-one')));

    await grid.openFile(await file('elsewhere.ts'));
    await settle('the file', () => Boolean(groupOf('elsewhere.ts')));

    const agent = groupOf('agent-one');
    assert.equal(agent?.viewColumn, 1, 'the agent stayed where it was');
    assert.notEqual(groupOf('elsewhere.ts')?.viewColumn, 1, 'the file did not land on it');

    grid.dispose();
  });

  // The whole point of locking: something that opens a file without saying
  // where — quick open, go to definition — must not take over an agent's pane.
  it('refuses a file opened with no group in mind', async () => {
    const grid = new EditorGrid();

    await grid.applyPreset(presetById('single')!);
    const terminal = agentTerminal(1, 'agent-lock');
    await settle('the terminal', () => Boolean(groupOf('agent-lock')));

    terminal.show(false);
    // Give the lock pass, which is driven by the tab event, time to run.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const uri = await file('unplaced.ts');
    await vscode.commands.executeCommand('vscode.open', uri);
    await settle('the file', () => Boolean(groupOf('unplaced.ts')));

    assert.notEqual(
      groupOf('unplaced.ts')?.viewColumn,
      groupOf('agent-lock')?.viewColumn,
      'the file opened on top of the agent',
    );

    grid.dispose();
  });
});

describe('the lock queue', () => {
  // Closing an agent is what sets a lock pass off, so the pass routinely runs
  // against a terminal that is on its way out. That used to throw, and the
  // rejection stayed in the queue: every later pass chained onto it, including
  // the unlock that runs before each launch, so nothing would start again.
  it('survives the terminal it was restoring focus to disappearing', async () => {
    const grid = new EditorGrid();
    await grid.applyPreset(presetById('grid-2x1')!);

    const doomed = agentTerminal(1, 'agent-doomed');
    await settle('the terminal', () => Boolean(groupOf('agent-doomed')));
    doomed.show(false);

    const pass = grid.unlockAll();
    doomed.dispose();
    await pass;

    // The queue is still usable, which is the part that matters.
    await grid.unlockAll();
    await grid.applyPreset(presetById('single')!);
    await settle('a working grid', () => groups().length === 1);

    grid.dispose();
  });
});

describe('arranging agents', () => {
  it('gives each one its own pane', async () => {
    const grid = new EditorGrid();
    const preset = presetById('grid-2x2')!;

    const four = [1, 2, 3, 4].map((n) => agentTerminal(1, `arranged-${n}`));
    await settle('four terminals', () =>
      four.every((_, index) => Boolean(groupOf(`arranged-${index + 1}`))),
    );

    await grid.arrange(four, preset);
    await settle('four groups', () => groups().length === 4);

    // One terminal per pane, rather than four stacked as tabs in the first.
    await settle('one per pane', () => groups().every((group) => group.tabs.length === 1));

    grid.dispose();
  });
});

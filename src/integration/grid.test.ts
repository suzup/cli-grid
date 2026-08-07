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
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}; editor area is ${layout()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** For failure messages: which groups exist and what is in them. */
function layout(): string {
  const shown = groups().map(
    (group) => `${group.viewColumn}[${group.tabs.map((tab) => tab.label).join(', ')}]`,
  );
  return shown.length ? shown.join(' ') : '(no groups)';
}

const groups = () => vscode.window.tabGroups.all;

/**
 * Where a file is, by its name.
 *
 * Only for files: a text editor has its label straight away, but a terminal
 * editor gets one when the terminal is rendered, and this window only renders
 * the visible one. Waiting on a terminal's label means waiting on something
 * that may never arrive, so terminals are found by what they are instead.
 */
const fileGroup = (name: string) =>
  groups().find((group) => group.tabs.some((tab) => tab.label.includes(name)));

const isTerminal = (tab: vscode.Tab) => tab.input instanceof vscode.TabInputTerminal;

/** The columns holding a terminal, in order. */
const terminalColumns = () =>
  groups().filter((group) => group.tabs.some(isTerminal)).map((group) => group.viewColumn);

const terminalCount = () =>
  groups().reduce((total, group) => total + group.tabs.filter(isTerminal).length, 0);

let dir: string;
const terminals: vscode.Terminal[] = [];

/**
 * A terminal in the editor area is what an agent is, minus the CLI.
 *
 * Shown, and waited for, before it is handed back. `arrange` places terminals
 * by focusing each in turn, and a terminal that has never been visible has no
 * rendered editor to focus — so it would never become active, the wait inside
 * `arrange` would time out, and the move would apply to whatever was active
 * instead. A real window renders them as they are created; this one does not.
 */
async function agentTerminal(column: number, name: string): Promise<vscode.Terminal> {
  const terminal = vscode.window.createTerminal({ name, location: { viewColumn: column } });
  terminals.push(terminal);

  terminal.show(false);
  await settle(`terminal ${name} to be live`, () => vscode.window.activeTerminal === terminal);
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

  // The extension under test is also live in this window, with an editor grid
  // of its own that reacts to terminals opening. With pane locking off it has
  // nothing to do, so it cannot move focus while a test is placing terminals —
  // the tests that are about locking turn it back on for themselves, and run
  // last for that reason.
  await lockPanes(false);
  await quiet();
});

function lockPanes(on: boolean): Thenable<void> {
  return vscode.workspace.getConfiguration('cliGrid').update('lockAgentPanes', on, true);
}

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

/**
 * Back to one empty group before the next test.
 *
 * Closing an editor is not instant, and a terminal left over from an earlier
 * test is indistinguishable from an agent to the code under test — it would sit
 * in the first group and make "one terminal per pane" false. So this waits for
 * the area to actually be empty rather than for the command to return.
 */
afterEach(async () => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await settle('an empty editor area', () => groups().every((group) => group.tabs.length === 0));
  await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
  await quiet();
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

    const group = fileGroup('beside.ts');
    assert.equal(group?.viewColumn, paneCount(preset) + 1, 'the file is in the last group');

    grid.dispose();
  });

  it('sends a second file to the same pane rather than splitting again', async () => {
    const grid = new EditorGrid();
    await grid.applyPreset(presetById('single')!);

    await grid.openFile(await file('first.ts'));
    await settle('the file pane', () => groups().length === 2);

    await grid.openFile(await file('second.ts'), false);
    await settle('both files', () => Boolean(fileGroup('second.ts')));

    assert.equal(groups().length, 2, 'no third group appeared');
    assert.equal(fileGroup('second.ts')?.viewColumn, 2);

    grid.dispose();
  });
});

describe('arranging agents', () => {
  it('gives each one its own pane', async () => {
    const grid = new EditorGrid();
    const preset = presetById('grid-2x2')!;

    const four: vscode.Terminal[] = [];
    for (const n of [1, 2, 3, 4]) four.push(await agentTerminal(1, `arranged-${n}`));
    await settle('four terminals', () => terminalCount() === 4);

    await grid.arrange(four, preset);
    await settle('four groups', () => groups().length === 4);

    // One terminal per pane, rather than four stacked as tabs in the first.
    await settle('one per pane', () => terminalColumns().join() === '1,2,3,4');

    grid.dispose();
  });
});

describe('panes holding an agent', () => {
  before(() => lockPanes(true));
  after(() => lockPanes(false));

  it('keeps the terminal, and takes the file elsewhere', async () => {
    const grid = new EditorGrid();
    const preset = presetById('grid-2x1')!;

    await grid.applyPreset(preset);
    await settle('the grid', () => groups().length === 2);

    await agentTerminal(1, 'agent-one');
    await settle('the terminal', () => terminalColumns().includes(1));

    await grid.openFile(await file('elsewhere.ts'));
    await settle('the file', () => Boolean(fileGroup('elsewhere.ts')));

    assert.deepEqual(terminalColumns(), [1], 'the agent stayed where it was');
    assert.notEqual(fileGroup('elsewhere.ts')?.viewColumn, 1, 'the file did not land on it');

    grid.dispose();
  });

  // The whole point of locking: something that opens a file without saying
  // where — quick open, go to definition — must not take over an agent's pane.
  it('refuses a file opened with no group in mind', async () => {
    const grid = new EditorGrid();

    await grid.applyPreset(presetById('single')!);
    const terminal = await agentTerminal(1, 'agent-lock');
    await settle('the terminal', () => terminalColumns().includes(1));

    terminal.show(false);
    // Give the lock pass, which is driven by the tab event, time to run.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const uri = await file('unplaced.ts');
    await vscode.commands.executeCommand('vscode.open', uri);
    await settle('the file', () => Boolean(fileGroup('unplaced.ts')));

    assert.notEqual(fileGroup('unplaced.ts')?.viewColumn, 1, 'the file opened on top of the agent');
    assert.deepEqual(terminalColumns(), [1], 'the agent is still in its pane');

    grid.dispose();
  });
});

describe('the lock queue', () => {
  before(() => lockPanes(true));
  after(() => lockPanes(false));

  // Closing an agent is what sets a lock pass off, so the pass routinely runs
  // against a terminal that is on its way out. That used to throw, and the
  // rejection stayed in the queue: every later pass chained onto it, including
  // the unlock that runs before each launch, so nothing would start again.
  it('survives the terminal it was restoring focus to disappearing', async () => {
    const grid = new EditorGrid();
    await grid.applyPreset(presetById('grid-2x1')!);

    const doomed = await agentTerminal(1, 'agent-doomed');
    await settle('the terminal', () => terminalColumns().includes(1));
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

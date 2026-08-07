// Must come first: it stands in for the `vscode` module the rest of these
// imports reach for.
import { reset, state } from './vscode.js';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { activate, deactivate } from '../extension.js';

/**
 * Activation, against the stub.
 *
 * This does not test what any command does — that needs a workbench. It tests
 * the wiring: that constructing every provider and registering every command
 * runs to completion, and that the set of commands the workbench will offer is
 * exactly the set the manifest promises. A missing import, a provider that
 * throws in its constructor, or a command declared in a menu and never
 * registered all show up here, and all of them are otherwise found by a user
 * seeing "command not found".
 */

const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const subscriptions: { dispose(): unknown }[] = [];

const context = {
  subscriptions,
  extension: { id: 'suzup.cli-grid' },
  globalState: {
    // Already shown, so activation does not stop on the intro dialog.
    get: (_key: string, fallback: unknown) => (typeof fallback === 'boolean' ? true : fallback),
    update: () => Promise.resolve(),
  },
};

before(() => {
  reset();
  activate(context as never);
});

describe('activate', () => {
  it('registers every command the manifest declares', () => {
    const declared = manifest.contributes.commands
      .map((command: { command: string }) => command.command)
      .sort();

    assert.deepEqual([...state.commands.keys()].sort(), declared);
  });

  it('registers nothing the manifest does not declare', () => {
    // The reverse of the above, stated separately so a failure says which way
    // the two have drifted.
    const declared = new Set(
      manifest.contributes.commands.map((command: { command: string }) => command.command),
    );
    for (const id of state.commands.keys()) {
      assert.ok(declared.has(id), `${id} is registered but not declared`);
    }
  });

  it('ties everything it creates to the extension lifetime', () => {
    // Views, providers, watchers, the status bar item and every command.
    assert.ok(subscriptions.length >= state.commands.size, 'commands are not all subscribed');
    for (const subscription of subscriptions) {
      assert.equal(typeof subscription.dispose, 'function');
    }
  });

  it('tells the workbench whether this folder is a project', async () => {
    // `setContext` is what the views' `when` clauses read; without it the
    // welcome content never switches.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(state.executed.includes('setContext'), 'context key was never set');
  });

  it('shows nothing on its own in a folder that is not a project', () => {
    assert.deepEqual(state.messages, []);
  });

  it('disposes cleanly', () => {
    deactivate();
    for (const subscription of subscriptions) subscription.dispose();
  });
});

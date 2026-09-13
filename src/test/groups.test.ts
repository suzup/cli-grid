// Must come first: it stands in for the `vscode` module the rest of these
// imports reach for.
import './vscode.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { URI } from 'vscode-uri';
import { orderGroups, stepGroup, type Group } from '../groups.js';

const entry = URI.file('/home/dev/agent-grid-tests');
const second = URI.file('/home/dev/agent-grid-tests2');
const third = URI.file('/home/dev/agent-grid-tests3');

function group(uri: URI): Group {
  return {
    uri: uri as never,
    name: uri.path.split('/').pop() ?? '',
    config: { agents: [] },
  };
}

const names = (groups: readonly Group[]) => groups.map((g) => g.name);

describe('the order the groups come in', () => {
  // The folder you opened is the way in, so it leads whatever the list says.
  it('puts the folder the window was opened on first', () => {
    const ordered = orderGroups(entry as never, ['../agent-grid-tests2'], [
      group(second),
      group(entry),
    ]);

    assert.deepEqual(names(ordered), ['agent-grid-tests', 'agent-grid-tests2']);
  });

  // The workbench appends folders in whatever order they were added, and that
  // is not the order anybody wrote down.
  it('follows the entry config rather than the workspace folder list', () => {
    const ordered = orderGroups(entry as never, [third.fsPath, second.fsPath], [
      group(entry),
      group(second),
      group(third),
    ]);

    assert.deepEqual(names(ordered), [
      'agent-grid-tests',
      'agent-grid-tests3',
      'agent-grid-tests2',
    ]);
  });

  // A folder can be a project without anyone having listed it — dragged into
  // the window, or an agent's own folder that carries a config. Dropping it
  // would leave its agents with nowhere to appear.
  it('keeps a project nothing listed, on the end', () => {
    const ordered = orderGroups(entry as never, [], [group(entry), group(second)]);
    assert.deepEqual(names(ordered), ['agent-grid-tests', 'agent-grid-tests2']);
  });

  it('ignores a listed folder that is not a project', () => {
    const ordered = orderGroups(entry as never, ['../nothing-here'], [group(entry)]);
    assert.deepEqual(names(ordered), ['agent-grid-tests']);
  });

  it('names each group once, however many times it is listed', () => {
    const ordered = orderGroups(entry as never, [second.fsPath, second.fsPath], [
      group(entry),
      group(second),
    ]);

    assert.deepEqual(names(ordered), ['agent-grid-tests', 'agent-grid-tests2']);
  });

  // Opening a group folder directly is a supported way in; it is then the only
  // group, and the entry config it would have read is its own.
  it('copes with no folder open at all', () => {
    assert.deepEqual(orderGroups(undefined, ['anything'], []), []);
  });
});

describe('stepping to the next group', () => {
  const three = [group(entry), group(second), group(third)];

  it('wraps round the end', () => {
    assert.equal(stepGroup(three, third as never, 1)?.name, 'agent-grid-tests');
    assert.equal(stepGroup(three, entry as never, -1)?.name, 'agent-grid-tests3');
  });

  it('moves one along in each direction', () => {
    assert.equal(stepGroup(three, entry as never, 1)?.name, 'agent-grid-tests2');
    assert.equal(stepGroup(three, second as never, -1)?.name, 'agent-grid-tests');
  });

  // Nothing to switch to, so the keybinding does nothing rather than
  // re-arranging the grid it is already showing.
  it('has nowhere to go with one group', () => {
    assert.equal(stepGroup([group(entry)], entry as never, 1), undefined);
    assert.equal(stepGroup([], undefined, 1), undefined);
  });

  // The active group can go away — its folder removed while the window is open.
  it('starts from the first when the active one is gone', () => {
    assert.equal(stepGroup(three, URI.file('/gone') as never, 1)?.name, 'agent-grid-tests2');
  });
});

// Must come first: it stands in for the `vscode` module the rest of these
// imports reach for.
import './vscode.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchProfile, namesOf } from '../running.js';
import type { AgentProfile } from '../types.js';

function profile(id: string, command = id): AgentProfile {
  return { id, label: id, command, args: { new: [], resume: [] }, icon: 'terminal' };
}

const PROFILES = [profile('claude'), profile('codex'), profile('devin'), profile('mine', '/opt/bin/my-cli.sh')];

describe('which CLI a terminal is running', () => {
  it('names a process by what it ran, and an interpreter by its script too', () => {
    assert.deepEqual(namesOf(['claude', '--continue']), ['claude']);
    assert.deepEqual(namesOf(['/home/u/.local/share/claude/versions/2.1.289']), ['2.1.289']);
    assert.deepEqual(namesOf(['node', '/home/u/.nvm/versions/node/v22/bin/codex']), ['node', 'codex']);
    assert.deepEqual(namesOf(['node', 'cli.mjs']), ['node', 'cli']);
    assert.deepEqual(namesOf([]), ['']);
  });

  it('finds the profile one of the shell’s children is', () => {
    assert.equal(matchProfile([['devin', '--permission-mode', 'bypass']], PROFILES)?.id, 'devin');
    assert.equal(matchProfile([['node', '/x/bin/codex']], PROFILES)?.id, 'codex');
    assert.equal(matchProfile([['/bin/bash', '/opt/bin/my-cli.sh']], PROFILES), undefined);
    assert.equal(matchProfile([['/opt/bin/my-cli.sh']], PROFILES)?.id, 'mine');
  });

  it('knows nothing from a shell running something else, or nothing', () => {
    assert.equal(matchProfile([['npm', 'test']], PROFILES), undefined);
    assert.equal(matchProfile([], PROFILES), undefined);
  });

  it('takes the first child that is a CLI', () => {
    assert.equal(matchProfile([['sleep', '5'], ['claude']], PROFILES)?.id, 'claude');
  });
});

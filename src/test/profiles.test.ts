// Must come first: it stands in for the `vscode` module the rest of these
// imports reach for.
import { reset, state } from './vscode.js';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  clearProfileCache,
  defaultMode,
  effectiveMode,
  findProfile,
  readProfiles,
  supportsMode,
} from '../profiles.js';
import type { ProfileOverride } from '../types.js';

/** Settings are read once and cached, so both have to be set up together. */
function configure(overrides: Record<string, ProfileOverride>): void {
  state.settings.set('cliGrid.profiles', overrides);
  clearProfileCache();
}

beforeEach(() => {
  reset();
  clearProfileCache();
});

describe('built-in profiles', () => {
  it('ships the three CLIs the extension is about', () => {
    assert.deepEqual(
      readProfiles().map((p) => p.id),
      ['claude', 'codex', 'gemini'],
    );
  });

  it('gives every one of them a resume form and no resume default', () => {
    for (const profile of readProfiles()) {
      assert.ok(profile.args.resume.length > 0, `${profile.id} cannot resume`);
      // Resuming where there is no previous conversation is an error in the CLI,
      // so opting in stays the user's call.
      assert.equal(profile.defaultMode, undefined, `${profile.id} defaults to resume`);
    }
  });
});

describe('overrides', () => {
  it('changes only what it names', () => {
    configure({ claude: { label: 'Claude' } });

    const claude = findProfile('claude');
    assert.equal(claude?.label, 'Claude');
    assert.equal(claude?.command, 'claude', 'the command is untouched');
    assert.deepEqual(claude?.args.resume, ['--continue'], 'the arguments are untouched');
  });

  it('merges one side of the arguments without dropping the other', () => {
    configure({ codex: { args: { new: ['--full-auto'] } } });

    const codex = findProfile('codex');
    assert.deepEqual(codex?.args.new, ['--full-auto']);
    assert.deepEqual(codex?.args.resume, ['resume', '--last']);
  });

  it('adds a new CLI when it names a command', () => {
    configure({ aider: { command: 'aider', label: 'Aider' } });

    const aider = findProfile('aider');
    assert.equal(aider?.command, 'aider');
    assert.equal(aider?.icon, 'terminal', 'falls back to a generic icon');
    assert.deepEqual(aider?.args, { new: [], resume: [] });
  });

  it('ignores an entry that names neither a command nor a built-in', () => {
    configure({ nonsense: { label: 'Nonsense' } });
    assert.equal(findProfile('nonsense'), undefined);
  });

  it('hides a built-in that is turned off', () => {
    configure({ gemini: { hidden: true } });

    assert.equal(findProfile('gemini'), undefined);
    assert.deepEqual(
      readProfiles().map((p) => p.id),
      ['claude', 'codex'],
    );
  });

  it('layers env over the built-in rather than replacing it', () => {
    configure({ claude: { env: { FOO: '1' } } });
    assert.deepEqual(findProfile('claude')?.env, { FOO: '1' });
  });
});

describe('the merge cache', () => {
  it('does not rebuild until it is told to', () => {
    const first = readProfiles();
    assert.equal(readProfiles(), first, 'the same array comes back');

    // Changing the setting behind its back is exactly what the invalidation
    // hook exists for; without it the stale list would survive.
    state.settings.set('cliGrid.profiles', { claude: { label: 'Changed' } });
    assert.equal(findProfile('claude')?.label, 'Claude Code');

    clearProfileCache();
    assert.equal(findProfile('claude')?.label, 'Changed');
  });
});

describe('supportsMode', () => {
  it('is true for new whatever the profile says', () => {
    const bare = { id: 'x', label: 'X', command: 'x', args: { new: [], resume: [] }, icon: 'terminal' };
    assert.equal(supportsMode(bare, 'new'), true);
    assert.equal(supportsMode(bare, 'resume'), false);
  });

  it('is true for resume once there are arguments for it', () => {
    assert.equal(supportsMode(findProfile('claude')!, 'resume'), true);
  });
});

describe('effectiveMode', () => {
  it('prefers what was declared over every default', () => {
    state.settings.set('cliGrid.defaultMode', 'resume');
    assert.equal(effectiveMode(findProfile('claude'), 'new'), 'new');
  });

  it('falls back to the profile, then to the global setting', () => {
    assert.equal(effectiveMode(findProfile('claude')), 'new');

    state.settings.set('cliGrid.defaultMode', 'resume');
    assert.equal(effectiveMode(findProfile('claude')), 'resume');

    configure({ claude: { defaultMode: 'new' } });
    state.settings.set('cliGrid.defaultMode', 'resume');
    assert.equal(effectiveMode(findProfile('claude')), 'new', 'the profile wins over the setting');
  });

  it('takes an id as readily as a profile', () => {
    assert.equal(effectiveMode('claude'), 'new');
    assert.equal(effectiveMode('no-such-cli'), 'new', 'and does not throw on an unknown one');
  });

  it('agrees with defaultMode, which is what the launcher compares against', () => {
    state.settings.set('cliGrid.defaultMode', 'resume');
    const claude = findProfile('claude')!;
    assert.equal(effectiveMode(claude), defaultMode(claude));
  });
});

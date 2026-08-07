// Must come first: it stands in for the `vscode` module the rest of these
// imports reach for.
import { reset } from './vscode.js';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { URI } from 'vscode-uri';
import { GitStatus } from '../git.js';
import { clearProfileCache, findProfile } from '../profiles.js';
import { ProjectWatcher, type AgentSpec } from '../project.js';
import { AgentRegistry, terminalName } from '../registry.js';
import { AgentNode, AgentsTreeProvider, agentLabel, nameFor } from '../tree.js';

const root = URI.file('/home/dev/work');

function node(spec: AgentSpec, running = false): AgentNode {
  const folder = spec.folder === '.' ? root : URI.file(`${root.path}/${spec.folder}`);
  return new AgentNode(root, spec, folder, running ? ({ mode: 'new' } as never) : undefined, false);
}

beforeEach(() => {
  reset();
  clearProfileCache();
});

describe('what an agent row is called', () => {
  it('is the last segment of the folder, not the whole path', () => {
    assert.equal(agentLabel(node({ cli: 'claude', folder: 'services/api' })), 'api');
  });

  it('is the project folder itself for an agent at the root', () => {
    assert.equal(agentLabel(node({ cli: 'claude', folder: '.' })), 'work');
  });

  it('is the last segment of an absolute folder elsewhere', () => {
    const spec = { cli: 'claude', folder: '/srv/other' };
    const elsewhere = new AgentNode(root, spec, URI.file('/srv/other'), undefined, false);
    assert.equal(agentLabel(elsewhere), 'other');
  });

  it('is the given name when there is one', () => {
    assert.equal(agentLabel(node({ cli: 'claude', folder: 'api', name: 'billing' })), 'billing');
  });

  it('falls back to the folder when the name is only spaces', () => {
    assert.equal(agentLabel(node({ cli: 'claude', folder: 'api', name: '   ' })), 'api');
  });
});

describe('what the tab says', () => {
  const claude = findProfile('claude')!;
  const target = (folder: string, name?: string) => ({
    root,
    folderRef: folder,
    folder: URI.file(`${root.path}/${folder}`),
    ...(name ? { name } : {}),
  });

  it('leads with the agent and follows with the CLI, like the row does', () => {
    assert.equal(terminalName(claude, target('api')), 'api · Claude Code');
  });

  it('uses the name the row shows when the agent has one', () => {
    assert.equal(terminalName(claude, target('api', 'billing')), 'billing · Claude Code');
  });
});

describe('the row itself', () => {
  const provider = () =>
    new AgentsTreeProvider(new ProjectWatcher(), new AgentRegistry(), new GitStatus());

  it('leads with the folder and describes it with the CLI', () => {
    const item = provider().getTreeItem(node({ cli: 'claude', folder: 'services/api' }));

    assert.equal(item.label, 'api');
    assert.ok(
      String(item.description).startsWith('Claude Code'),
      `the CLI should lead the description, got: ${String(item.description)}`,
    );
  });

  it('says an unknown cli by its id rather than dropping it', () => {
    const item = provider().getTreeItem(node({ cli: 'no-such-cli', folder: 'api' }));
    assert.ok(String(item.description).startsWith('no-such-cli'));
  });

  it('keeps the whole path in the hover, since the label is only a segment', () => {
    const item = provider().getTreeItem(node({ cli: 'claude', folder: 'services/api' }));
    const tooltip = String((item.tooltip as { value?: string })?.value);

    assert.ok(tooltip.includes('/home/dev/work/services/api'), tooltip);
    assert.ok(tooltip.includes('Claude Code'), tooltip);
  });
});

describe('what a typed name becomes', () => {
  it('is kept when it differs from the folder', () => {
    assert.equal(nameFor('billing', 'api'), 'billing');
  });

  // The box opens on the current label, so an agent with no name of its own
  // opens on its folder name. Pressing Enter on that is not choosing a name.
  it('is nothing when it is just the folder name back again', () => {
    assert.equal(nameFor('api', 'api'), undefined);
  });

  it('is nothing when it is cleared', () => {
    assert.equal(nameFor('', 'api'), undefined);
    assert.equal(nameFor('   ', 'api'), undefined);
  });

  it('is trimmed', () => {
    assert.equal(nameFor('  billing  ', 'api'), 'billing');
    assert.equal(nameFor('  api  ', 'api'), undefined);
  });
});

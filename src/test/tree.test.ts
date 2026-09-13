// Must come first: it stands in for the `vscode` module the rest of these
// imports reach for.
import { reset } from './vscode.js';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { URI } from 'vscode-uri';
import { GitStatus } from '../git.js';
import { EditorGrid } from '../grid.js';
import { GroupController } from '../groups.js';
import { clearProfileCache, findProfile } from '../profiles.js';
import { ProjectWatcher, type AgentSpec } from '../project.js';
import { AgentRegistry, terminalName } from '../registry.js';
import { WorkspaceRoots } from '../roots.js';
import { AgentNode, AgentsTreeProvider, ProjectNode, agentLabel, nameFor } from '../tree.js';

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

/** Enough of an extension context for the group controller to remember one thing. */
const context = {
  workspaceState: { get: () => undefined, update: () => Promise.resolve() },
} as never;

function provider(): AgentsTreeProvider {
  const projects = new ProjectWatcher();
  const registry = new AgentRegistry();
  const roots = new WorkspaceRoots(projects, registry);
  const groups = new GroupController(context, projects, registry, new EditorGrid(), roots);
  return new AgentsTreeProvider(projects, registry, new GitStatus(), groups);
}

describe('the row itself', () => {

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

  // The pin is an inline button, so it only shows on hover — the row has to
  // say at rest that the start button will skip it, or it looks broken.
  it('says so on its face when the project start would skip it', () => {
    const item = provider().getTreeItem(node({ cli: 'claude', folder: 'api', pinned: false }));

    assert.ok(String(item.description).includes('manual only'), String(item.description));
    assert.ok(
      String((item.tooltip as { value?: string })?.value).includes('skips this one'),
    );
  });

  it('says nothing about pins on an agent that starts with the rest', () => {
    const item = provider().getTreeItem(node({ cli: 'claude', folder: 'api' }));
    assert.ok(!String(item.description).includes('manual only'));
  });

  // Which way round the pin points is what the two menu entries key off, so the
  // context value has to carry it — and still start with what it used to, since
  // the start and stop buttons match on that.
  it('carries the pin in the context value', () => {
    const on = provider().getTreeItem(node({ cli: 'claude', folder: 'api' }));
    const off = provider().getTreeItem(node({ cli: 'claude', folder: 'api', pinned: false }));

    assert.equal(on.contextValue, 'cliGrid.agent.stopped.new.pinned');
    assert.equal(off.contextValue, 'cliGrid.agent.stopped.new.unpinned');
  });

  it('keeps the whole path in the hover, since the label is only a segment', () => {
    const item = provider().getTreeItem(node({ cli: 'claude', folder: 'services/api' }));
    const tooltip = String((item.tooltip as { value?: string })?.value);

    assert.ok(tooltip.includes('/home/dev/work/services/api'), tooltip);
    assert.ok(tooltip.includes('Claude Code'), tooltip);
  });
});

describe('a group row', () => {
  const row = (active: boolean, grouped: boolean, removable = false) =>
    provider().getTreeItem(new ProjectNode(root, 'work', active, grouped, removable));

  // One group is not a choice, so the row stays the folder it always was.
  it('is an ordinary project row while there is nothing to switch between', () => {
    const item = row(true, false);

    assert.equal(item.contextValue, 'cliGrid.project');
    assert.equal((item.iconPath as { id: string }).id, 'root-folder');
    assert.equal(item.collapsibleState, 2);
    assert.ok(!String(item.description).includes('showing'));
  });

  it('says which group the grid is showing once there is more than one', () => {
    const shown = row(true, true);
    const other = row(false, true);

    assert.equal(shown.contextValue, 'cliGrid.project.active');
    assert.equal(other.contextValue, 'cliGrid.project.inactive');
    assert.ok(String(shown.description).includes('showing'), String(shown.description));
    assert.equal((shown.iconPath as { id: string }).id, 'circle-filled');
    assert.equal((other.iconPath as { id: string }).id, 'circle-outline');
  });

  // Collapsed, because the whole point is that only one set of rows is in front
  // of you at a time.
  it('leaves the group it is not showing folded up', () => {
    assert.equal(row(true, true).collapsibleState, 2);
    assert.equal(row(false, true).collapsibleState, 1);
  });

  // The folder the window was opened on is the way in, so it has no remove.
  it('marks only the groups that can be taken back out', () => {
    assert.equal(row(false, true, false).contextValue, 'cliGrid.project.inactive');
    assert.equal(row(false, true, true).contextValue, 'cliGrid.project.inactive.added');
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

import * as vscode from 'vscode';
import type { GitStatus } from './git.js';
import type { GroupController } from './groups.js';
import { basename, resolveFolder } from './paths.js';
import { effectiveMode, findProfile } from './profiles.js';
import {
  isPinned,
  reorderAgents,
  sameAgent,
  type AgentSpec,
  type ProjectWatcher,
} from './project.js';
import type { AgentRegistry } from './registry.js';
import type { RunningAgent } from './types.js';

export class ProjectNode {
  readonly kind = 'project';
  constructor(
    readonly uri: vscode.Uri,
    readonly name: string,
    /** Whether this is the group the grid is showing. */
    readonly active: boolean,
    /** Whether the window has more than one group to choose between. */
    readonly grouped: boolean,
    /** Whether it can be taken back out — the folder you opened cannot. */
    readonly removable: boolean,
  ) {}
}

export class AgentNode {
  readonly kind = 'agent';
  constructor(
    readonly root: vscode.Uri,
    readonly spec: AgentSpec,
    readonly folder: vscode.Uri,
    /** Present while the CLI is up; absent means the row is a launch button. */
    readonly running: RunningAgent | undefined,
    /** True when the agent is live but not written to the project config. */
    readonly adHoc: boolean,
  ) {}
}

export type Node = ProjectNode | AgentNode;

/** What the row shows: a name if one was given, else the folder it runs in. */
export function agentLabel(node: AgentNode): string {
  return node.spec.name?.trim() || basename(node.folder.path);
}

/**
 * The name to store for what someone typed, or nothing at all.
 *
 * The rename box opens on the current label, so an agent with no name of its
 * own opens on its folder name. Accepting that unchanged is not choosing a
 * name — it is leaving things as they were — and writing it down would put a
 * line in the project file that changes nothing and then goes stale.
 */
export function nameFor(input: string, folder: string): string | undefined {
  const trimmed = input.trim();
  return trimmed && trimmed !== folder ? trimmed : undefined;
}

/**
 * The workbench's own mime type for this tree, which is what makes a drag that
 * starts and ends inside it carry the nodes themselves rather than text.
 * It is the view id, lowercased.
 */
const AGENT_MIME = 'application/vnd.code.tree.cligrid.agents';

export class AgentsTreeProvider
  implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>, vscode.Disposable
{
  readonly dragMimeTypes = [AGENT_MIME];
  readonly dropMimeTypes = [AGENT_MIME];

  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly projects: ProjectWatcher,
    private readonly registry: AgentRegistry,
    private readonly git: GitStatus,
    private readonly groups: GroupController,
  ) {
    this.disposables.push(
      projects.onDidChange(() => this.refresh()),
      registry.onDidChange(() => this.refresh()),
      git.onDidChange(() => this.refresh()),
      groups.onDidChange(() => this.refresh()),
    );
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      const groups = this.groups.list();
      const entry = groups[0]?.uri.toString();
      return groups.map(
        (group) =>
          new ProjectNode(
            group.uri,
            group.name,
            this.groups.isActive(group.uri),
            groups.length > 1,
            group.uri.toString() !== entry,
          ),
      );
    }
    if (element.kind === 'project') return this.agentsIn(element.uri);
    return [];
  }

  /** Configured agents first, then anything launched ad hoc in this project. */
  private agentsIn(root: vscode.Uri): AgentNode[] {
    const config = this.projects.configFor(root);
    const nodes: AgentNode[] = [];
    const claimed = new Set<string>();

    for (const spec of config?.agents ?? []) {
      const running = this.registry.find(root, spec.folder, spec.cli);
      if (running) claimed.add(running.id);
      nodes.push(new AgentNode(root, spec, resolveFolder(root, spec.folder), running, false));
    }

    for (const agent of this.registry.inProject(root)) {
      if (claimed.has(agent.id)) continue;
      nodes.push(
        new AgentNode(
          root,
          { folder: agent.folderRef, cli: agent.profileId },
          agent.folder,
          agent,
          true,
        ),
      );
    }

    return nodes;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node.kind === 'project' ? this.projectItem(node) : this.agentItem(node);
  }

  /**
   * Only agents that are written down can be dragged.
   *
   * The order lives in the project file, so an ad-hoc agent — running but not
   * saved — has no place in it to move to.
   */
  handleDrag(source: readonly Node[], transfer: vscode.DataTransfer): void {
    const agents = source.filter((node): node is AgentNode => node.kind === 'agent' && !node.adHoc);
    if (agents.length) transfer.set(AGENT_MIME, new vscode.DataTransferItem(agents));
  }

  /**
   * Dropping on a row puts the dragged agents above it; dropping past the last
   * one, or on the project, puts them at the end.
   *
   * Reordering is confined to one project: `folder` is written relative to its
   * own root, so the same reference means a different place under another one.
   */
  async handleDrop(target: Node | undefined, transfer: vscode.DataTransfer): Promise<void> {
    const dragged = transfer.get(AGENT_MIME)?.value as AgentNode[] | undefined;
    const first = dragged?.[0];
    if (!dragged?.length || !first) return;

    const root = first.root;
    if (target && target.kind === 'agent' && target.root.toString() !== root.toString()) return;
    if (target && target.kind === 'project' && target.uri.toString() !== root.toString()) return;
    if (target?.kind === 'agent' && dragged.some((node) => sameAgent(node.spec, target.spec))) {
      return; // Dropped on itself.
    }

    const before = target?.kind === 'agent' ? target.spec : undefined;
    await reorderAgents(root, dragged.map((node) => node.spec), before);
    await this.projects.refresh();
  }

  /**
   * A project row, which is also a group row once there is more than one.
   *
   * With a single group there is nothing to switch between, so the row stays
   * exactly what it was: a folder, expanded, with the git branch beside it. The
   * dot and the collapsed rows only appear when they mean something.
   */
  private projectItem(node: ProjectNode): vscode.TreeItem {
    const open = node.active || !node.grouped;
    const item = new vscode.TreeItem(
      node.name,
      open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    // A resourceUri lets the built-in git decorations colour this exactly as
    // they colour the Explorer.
    item.resourceUri = node.uri;
    item.iconPath = node.grouped
      ? new vscode.ThemeIcon(
          node.active ? 'circle-filled' : 'circle-outline',
          new vscode.ThemeColor(node.active ? 'charts.blue' : 'disabledForeground'),
        )
      : new vscode.ThemeIcon('root-folder');

    // The suffixes decide which of the group actions the row offers.
    item.contextValue = node.grouped
      ? `cliGrid.project.${node.active ? 'active' : 'inactive'}${node.removable ? '.added' : ''}`
      : 'cliGrid.project';

    const running = this.registry.inProject(node.uri).length;
    item.description = [
      node.grouped && node.active ? vscode.l10n.t('showing') : '',
      node.grouped && !node.active && running
        ? vscode.l10n.t('{0} running off screen', running)
        : '',
      this.git.describe(node.uri),
    ]
      .filter(Boolean)
      .join('  ·  ');

    item.tooltip = new vscode.MarkdownString(
      [
        `**${node.name}**`,
        '',
        node.uri.fsPath,
        node.grouped && !node.active ? vscode.l10n.t('Select to show this group in the grid.') : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    // Clicking the row is the obvious way to switch, so it is one — the inline
    // button, the view title and the keybinding are the same command by other
    // routes. The row also folds open on the click, which is where its agents
    // were going to be anyway.
    if (node.grouped && !node.active) {
      item.command = {
        command: 'cliGrid.showGroup',
        title: vscode.l10n.t('Show This Group'),
        arguments: [node],
      };
    }
    return item;
  }

  private agentItem(node: AgentNode): vscode.TreeItem {
    const profile = findProfile(node.spec.cli);
    const cli = profile?.label ?? node.spec.cli;

    // The folder is what you are actually looking for in this list — which
    // repository is this? — so it leads, and the CLI describes it. Only the last
    // segment: `services/api` is read as "api", and the full path is a hover
    // away. Where that is not distinct enough, an agent can be given a name.
    const label = agentLabel(node);

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `${node.root.toString()}::${node.spec.folder}::${node.spec.cli}`;

    const mode = effectiveMode(node.spec.cli, node.spec.mode);
    const state = node.running
      ? node.running.mode === 'resume'
        ? vscode.l10n.t('running · resumed')
        : vscode.l10n.t('running')
      : mode === 'resume'
        ? vscode.l10n.t('stopped · starts resumed')
        : vscode.l10n.t('stopped');
    // An un-pinned agent is easy to forget about and then wonder why the start
    // button skipped it, so the row says so at rest rather than only on hover.
    const pinned = isPinned(node.spec);
    item.description = [
      cli,
      state,
      pinned || node.adHoc ? '' : vscode.l10n.t('manual only'),
      node.adHoc ? vscode.l10n.t('unsaved') : '',
    ]
      .filter(Boolean)
      .join('  ·  ');

    item.iconPath = node.running
      ? new vscode.ThemeIcon(
          profile?.icon ?? 'terminal',
          profile?.color ? new vscode.ThemeColor(profile.color) : undefined,
        )
      : new vscode.ThemeIcon('debug-start', new vscode.ThemeColor('disabledForeground'));

    // The suffix decides which of the two start buttons this row shows, and the
    // last segment which way round the pin points.
    const kind = node.running
      ? node.adHoc
        ? 'cliGrid.agent.running.adhoc'
        : 'cliGrid.agent.running'
      : `cliGrid.agent.stopped.${mode}`;
    item.contextValue = node.adHoc ? kind : `${kind}.${pinned ? 'pinned' : 'unpinned'}`;

    const git = this.git.describe(node.folder);
    item.tooltip = new vscode.MarkdownString(
      [
        `**${label}**`,
        '',
        `${vscode.l10n.t('CLI')}: ${cli}`,
        // The label is only the last segment, so the hover is where the whole
        // path lives — two agents can easily be in folders both called "api".
        `${vscode.l10n.t('Folder')}: ${node.folder.fsPath}`,
        git ? `${vscode.l10n.t('Branch')}: \`${git}\`` : '',
        pinned || node.adHoc ? '' : vscode.l10n.t('Starting the project skips this one.'),
        node.running
          ? `${vscode.l10n.t('Started')}: ${new Date(node.running.startedAt).toLocaleTimeString()}`
          : vscode.l10n.t('Select to start'),
      ]
        .filter(Boolean)
        .join('\n'),
    );

    item.command = {
      command: node.running ? 'cliGrid.focusAgent' : 'cliGrid.startAgent',
      title: node.running ? vscode.l10n.t('Focus Agent') : vscode.l10n.t('Start Agent'),
      arguments: [node],
    };

    return item;
  }

  dispose(): void {
    this.changeEmitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

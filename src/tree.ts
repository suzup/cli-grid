import * as vscode from 'vscode';
import type { GitStatus } from './git.js';
import { resolveFolder } from './paths.js';
import { effectiveMode, findProfile } from './profiles.js';
import type { AgentSpec, ProjectWatcher } from './project.js';
import type { AgentRegistry } from './registry.js';
import type { RunningAgent } from './types.js';

export class ProjectNode {
  readonly kind = 'project';
  constructor(
    readonly uri: vscode.Uri,
    readonly name: string,
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

export class AgentsTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly projects: ProjectWatcher,
    private readonly registry: AgentRegistry,
    private readonly git: GitStatus,
  ) {
    this.disposables.push(
      projects.onDidChange(() => this.refresh()),
      registry.onDidChange(() => this.refresh()),
      git.onDidChange(() => this.refresh()),
    );
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      return this.projects.projects().map((p) => new ProjectNode(p.uri, p.name));
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

  private projectItem(node: ProjectNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
    // A resourceUri lets the built-in git decorations colour this exactly as
    // they colour the Explorer.
    item.resourceUri = node.uri;
    item.iconPath = new vscode.ThemeIcon('root-folder');
    item.contextValue = 'cliGrid.project';
    item.description = this.git.describe(node.uri);
    item.tooltip = new vscode.MarkdownString(`**${node.name}**\n\n${node.uri.fsPath}`);
    return item;
  }

  private agentItem(node: AgentNode): vscode.TreeItem {
    const profile = findProfile(node.spec.cli);
    const label = profile?.label ?? node.spec.cli;

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `${node.root.toString()}::${node.spec.folder}::${node.spec.cli}`;

    const mode = effectiveMode(node.spec.cli, node.spec.mode);
    const where = node.spec.folder === '.' ? '' : node.spec.folder;
    const state = node.running
      ? node.running.mode === 'resume'
        ? vscode.l10n.t('running · resumed')
        : vscode.l10n.t('running')
      : mode === 'resume'
        ? vscode.l10n.t('stopped · starts resumed')
        : vscode.l10n.t('stopped');
    item.description = [where, state, node.adHoc ? vscode.l10n.t('unsaved') : '']
      .filter(Boolean)
      .join('  ·  ');

    item.iconPath = node.running
      ? new vscode.ThemeIcon(
          profile?.icon ?? 'terminal',
          profile?.color ? new vscode.ThemeColor(profile.color) : undefined,
        )
      : new vscode.ThemeIcon('debug-start', new vscode.ThemeColor('disabledForeground'));

    // The suffix decides which of the two start buttons this row shows.
    item.contextValue = node.running
      ? node.adHoc
        ? 'cliGrid.agent.running.adhoc'
        : 'cliGrid.agent.running'
      : `cliGrid.agent.stopped.${mode}`;

    const git = this.git.describe(node.folder);
    item.tooltip = new vscode.MarkdownString(
      [
        `**${label}**`,
        '',
        `${vscode.l10n.t('Folder')}: ${node.folder.fsPath}`,
        git ? `${vscode.l10n.t('Branch')}: \`${git}\`` : '',
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

import * as vscode from 'vscode';
import { registerCommands } from './commands.js';
import { SECTION, setting } from './config.js';
import { GitStatus } from './git.js';
import { EditorGrid } from './grid.js';
import { Launcher } from './launcher.js';
import { LayoutController, LayoutTreeProvider } from './layouts.js';
import { ImageLinks } from './links.js';
import { clearProfileCache } from './profiles.js';
import { ProjectWatcher, openableConfigUri } from './project.js';
import { AgentRegistry } from './registry.js';
import { WorkspaceRoots } from './roots.js';
import { StatusBar } from './statusbar.js';
import { AgentsTreeProvider, type AgentNode, type Node, type ProjectNode } from './tree.js';

const INTRO_SHOWN_KEY = 'cliGrid.introShown';

export function activate(context: vscode.ExtensionContext): void {
  const projects = new ProjectWatcher();
  const git = new GitStatus();
  const registry = new AgentRegistry();
  const grid = new EditorGrid();
  const roots = new WorkspaceRoots(projects, registry);
  const launcher = new Launcher(projects, registry, grid, context, roots);
  const tree = new AgentsTreeProvider(projects, registry, git);
  const layoutView = new LayoutTreeProvider();
  const layouts = new LayoutController(layoutView, grid, registry, projects);
  const statusBar = new StatusBar(projects, registry);
  const links = new ImageLinks(registry, grid);

  context.subscriptions.push(projects, git, registry, grid, roots, tree, layoutView, statusBar);

  context.subscriptions.push(
    registry.onDidChange(() => layoutView.setAgentCount(registry.list().length)),
    // Every configured agent's folder is a folder of this window, so the
    // Explorer, Source Control and quick open all reach it without CLI Grid
    // standing in for any of them.
    projects.onDidChange(() => void roots.sync()),
    // The paths an agent prints are the window's files, and a pane three
    // columns wide is where a CLI breaks one in half.
    vscode.window.registerTerminalLinkProvider(links),
    vscode.window.createTreeView('cliGrid.layout', { treeDataProvider: layoutView }),
    vscode.window.createTreeView('cliGrid.agents', {
      treeDataProvider: tree,
      showCollapseAll: true,
      // Dragging a row reorders the project file, which is also the order
      // `startAll` hands out panes in.
      canSelectMany: true,
      dragAndDropController: tree,
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SECTION}.profiles`)) {
        clearProfileCache();
        tree.refresh();
      }
    }),
  );

  /** The project a command should act on when it was not invoked on a row. */
  const rootOf = (node?: ProjectNode) => node?.uri ?? projects.projects()[0]?.uri;

  registerCommands(context, {
    'cliGrid.initProject': () => projects.init(),

    'cliGrid.newAgent': (node?: Node) =>
      launcher.newAgent(node && node.kind === 'project' ? node.uri : undefined),

    'cliGrid.startAgent': (node?: AgentNode) => node && startAgent(node),
    'cliGrid.startResumed': (node?: AgentNode) => node && startAgent(node, 'resume'),
    'cliGrid.startFresh': (node?: AgentNode) => node && startAgent(node, 'new'),

    'cliGrid.startAll': async (node?: ProjectNode) => {
      const root = rootOf(node);
      if (root) await launcher.startAll(root);
    },

    // Reopening a folder is exactly when you want the previous conversations
    // back, so bringing them all up that way is a single button.
    'cliGrid.startAllResumed': async (node?: ProjectNode) => {
      const root = rootOf(node);
      if (root) await launcher.startAll(root, 'resume');
    },

    'cliGrid.pinAgent': (node?: AgentNode) => node && launcher.setPinned(node, true),
    'cliGrid.unpinAgent': (node?: AgentNode) => node && launcher.setPinned(node, false),

    'cliGrid.editAgent': (node?: AgentNode) => node && launcher.editAgent(node),
    'cliGrid.removeAgent': (node?: AgentNode) => node && launcher.removeAgent(node),
    'cliGrid.saveAgent': (node?: AgentNode) => node && launcher.saveAgent(node),

    'cliGrid.stopAgent': (node?: AgentNode) => {
      if (node?.running) registry.stop(node.running.id);
    },

    'cliGrid.restartAgent': async (node?: AgentNode) => {
      if (!node) return;
      if (node.running) registry.stop(node.running.id);
      await launcher.start(node);
    },

    'cliGrid.focusAgent': (node?: AgentNode) => {
      const agent = node?.running ?? registry.list()[0];
      agent?.terminal.show(true);
    },

    'cliGrid.applyLayout': (id?: string) => id && layouts.apply(id),

    'cliGrid.openConfig': async (node?: ProjectNode) => {
      const root = rootOf(node);
      if (root) await grid.openFile(await openableConfigUri(root), false);
    },

    'cliGrid.showAgents': () =>
      vscode.commands.executeCommand('workbench.view.extension.cliGrid'),

    'cliGrid.refresh': async () => {
      clearProfileCache();
      await projects.refresh();
      tree.refresh();
    },
  });

  const startAgent = (node: AgentNode, mode?: 'new' | 'resume') => launcher.start(node, mode);

  void start(context, projects, launcher, layouts, roots);
}

export function deactivate(): void {
  // Terminals are owned by the workbench and are cleaned up with the window.
}

async function start(
  context: vscode.ExtensionContext,
  projects: ProjectWatcher,
  launcher: Launcher,
  layouts: LayoutController,
  roots: WorkspaceRoots,
): Promise<void> {
  await projects.refresh();

  // Before anything else looks at the window: the folders the agents work in
  // are part of what this window is, and the layout and the views that follow
  // should be reading a workspace that is already complete.
  await roots.sync();

  await layouts.restore();

  if (setting('autoStart')) {
    for (const project of projects.projects()) await launcher.startAll(project.uri);
  }

  await showIntroOnce(context, projects);
}

/**
 * One-time pointer at the Agents view.
 *
 * Without it a first-time user has no reason to scroll to the bottom of a
 * crowded Explorer, and the view is where everything starts.
 */
async function showIntroOnce(
  context: vscode.ExtensionContext,
  projects: ProjectWatcher,
): Promise<void> {
  if (context.globalState.get<boolean>(INTRO_SHOWN_KEY, false)) return;
  await context.globalState.update(INTRO_SHOWN_KEY, true);

  const show = vscode.l10n.t('Open CLI Grid');
  const tour = vscode.l10n.t('Get Started');

  const answer = await vscode.window.showInformationMessage(
    projects.any
      ? vscode.l10n.t('This folder is a CLI Grid project. Open it from the CLI Grid icon in the Activity Bar.')
      : vscode.l10n.t('CLI Grid is installed. Look for its icon in the Activity Bar on the left.'),
    show,
    tour,
  );

  if (answer === show) {
    await vscode.commands.executeCommand('cliGrid.showAgents');
  } else if (answer === tour) {
    await vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      `${context.extension.id}#cliGrid.getStarted`,
    );
  }
}

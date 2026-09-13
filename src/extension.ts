import * as vscode from 'vscode';
import { registerCommands } from './commands.js';
import { SECTION, setting } from './config.js';
import { GitStatus } from './git.js';
import { EditorGrid } from './grid.js';
import { GroupController } from './groups.js';
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
  const groups = new GroupController(context, projects, registry, grid, roots);
  const launcher = new Launcher(projects, registry, grid, context, roots, groups);
  const tree = new AgentsTreeProvider(projects, registry, git, groups);
  const layoutView = new LayoutTreeProvider();
  const layouts = new LayoutController(layoutView, grid, registry, projects, groups);
  const statusBar = new StatusBar(projects, registry, groups);
  const links = new ImageLinks(registry, grid);

  context.subscriptions.push(
    projects,
    git,
    registry,
    grid,
    roots,
    groups,
    tree,
    layoutView,
    statusBar,
  );

  context.subscriptions.push(
    // The count Auto follows is the group on screen, since that is the grid the
    // split it picks has to fit.
    registry.onDidChange(() => layouts.syncView()),
    // A switch changes both the split in force and the agents it is sized for.
    groups.onDidChange(() => layouts.syncView()),
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
  const rootOf = (node?: ProjectNode) => node?.uri ?? groups.active()?.uri;

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

    'cliGrid.focusAgent': async (node?: AgentNode) => {
      const agent = node?.running ?? registry.list()[0];
      if (!agent) return;
      // An agent in another group is parked in the panel. Revealing it there
      // would answer the click, but not with the pane the row was pointing at.
      await groups.ensureActive(agent.root);
      agent.terminal.show(true);
    },

    'cliGrid.applyLayout': (id?: string) => id && layouts.apply(id),

    'cliGrid.switchGroup': () => groups.pick(),
    'cliGrid.showGroup': (node?: ProjectNode) => node && groups.switchTo(node.uri),
    'cliGrid.nextGroup': () => groups.step(1),
    'cliGrid.previousGroup': () => groups.step(-1),
    'cliGrid.addGroup': () => groups.add(),
    'cliGrid.removeGroup': (node?: ProjectNode) => node && groups.remove(node.uri),

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

  void start(context, projects, launcher, layouts, roots, groups);
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
  groups: GroupController,
): Promise<void> {
  await projects.refresh();

  // First of all, because every folder a group names is a project of this
  // window and everything below counts projects. Opening one folder is still
  // the only way in — the rest of the list comes out of its config.
  await groups.sync();
  await projects.refresh();

  // Before anything else looks at the window: the folders the agents work in
  // are part of what this window is, and the layout and the views that follow
  // should be reading a workspace that is already complete.
  await roots.sync();

  groups.restore();
  await layouts.restore();

  // Only the group on screen: the others have no panes, and starting them would
  // be starting CLIs into a grid nobody is looking at.
  const active = groups.active();
  if (setting('autoStart') && active) await launcher.startAll(active.uri);

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

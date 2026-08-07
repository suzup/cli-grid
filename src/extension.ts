import * as vscode from 'vscode';
import { registerCommands } from './commands.js';
import { SECTION, setting, updateSetting } from './config.js';
import { registerFileCommands } from './fileops.js';
import { FilesTreeProvider, searchFiles } from './files.js';
import { GitStatus } from './git.js';
import { EditorGrid } from './grid.js';
import { Launcher } from './launcher.js';
import { LayoutController, LayoutTreeProvider } from './layouts.js';
import { basename, dirnameOf, relativeTo } from './paths.js';
import { clearProfileCache } from './profiles.js';
import { ProjectWatcher, openableConfigUri } from './project.js';
import { AgentRegistry } from './registry.js';
import { StatusBar } from './statusbar.js';
import { AgentsTreeProvider, type AgentNode, type Node, type ProjectNode } from './tree.js';

const INTRO_SHOWN_KEY = 'cliGrid.introShown';

export function activate(context: vscode.ExtensionContext): void {
  const projects = new ProjectWatcher();
  const git = new GitStatus();
  const registry = new AgentRegistry();
  const grid = new EditorGrid();
  const launcher = new Launcher(projects, registry, grid, context);
  const tree = new AgentsTreeProvider(projects, registry, git);
  const files = new FilesTreeProvider(registry, git);
  const layoutView = new LayoutTreeProvider();
  const layouts = new LayoutController(layoutView, grid, registry, projects);
  const statusBar = new StatusBar(projects, registry);

  context.subscriptions.push(projects, git, registry, grid, tree, files, layoutView, statusBar);

  const filesView = vscode.window.createTreeView('cliGrid.files', {
    treeDataProvider: files,
    showCollapseAll: true,
    // Multi-select and dragging out to an editor, a terminal or another window
    // are what make this behave like a file tree rather than a list of links.
    canSelectMany: true,
    dragAndDropController: files,
  });
  const syncFilesHeader = () => {
    filesView.description = files.headerFor();
  };
  syncFilesHeader();
  registerFileCommands(context, filesView, files);

  const trackGitFolders = () => {
    for (const project of projects.projects()) void git.track(project.uri);
    for (const agent of registry.list()) void git.track(agent.folder);
  };

  context.subscriptions.push(
    registry.onDidChange(() => {
      layoutView.setAgentCount(registry.list().length);
      trackGitFolders();
    }),
    projects.onDidChange(trackGitFolders),
    filesView,
    files.onDidChangeScope(syncFilesHeader),
    git.onDidChange(syncFilesHeader),
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
      if (!agent) return;
      agent.terminal.show(true);
      // Point the Files view at what this CLI is actually working on.
      files.follow(agent.folder);
    },

    'cliGrid.applyLayout': (id?: string) => id && layouts.apply(id),

    // Quick Open searches the folder the window was opened on, which in a CLI
    // Grid project is a wrapper holding the folders the work is actually in.
    // This searches the one the selected CLI is working in — the folder whose
    // output you have in front of you — and takes `Ctrl+P` over for it.
    'cliGrid.findFile': async () => {
      const scope = files.currentScope();
      const agentFolder = registry
        .list()
        .some((agent) => agent.folder.toString() === scope?.toString());

      // Until an agent is focused the tree is showing the folder the window was
      // opened on, and searching that is the workbench's own job — done better,
      // with its index. So `Ctrl+P` stays itself right up to the point where
      // there is something more specific for it to mean.
      if (!scope || !agentFolder) {
        await vscode.commands.executeCommand('workbench.action.quickOpen');
        return;
      }

      const picked = await vscode.window.showQuickPick(searchItems(scope), {
        placeHolder: vscode.l10n.t('Search files in {0}', basename(scope.path)),
        // The folder a name sits in is half of telling two `index.ts` apart.
        matchOnDescription: true,
      });
      if (picked) await grid.openFile(picked.uri);
    },

    'cliGrid.toggleHiddenFiles': async () => {
      await updateSetting('showHiddenFiles', !setting('showHiddenFiles'));
      files.refresh();
    },

    'cliGrid.openConfig': async (node?: ProjectNode) => {
      const root = rootOf(node);
      if (root) await grid.openFile(await openableConfigUri(root), false);
    },

    // Everything the Files view opens goes through here, so it lands beside the
    // grid instead of on top of an agent.
    'cliGrid.openFile': (uri?: vscode.Uri) => uri && grid.openFile(uri),

    'cliGrid.showAgents': () =>
      vscode.commands.executeCommand('workbench.view.extension.cliGrid'),

    'cliGrid.refresh': async () => {
      clearProfileCache();
      await projects.refresh();
      tree.refresh();
      files.refresh();
    },
  });

  /** Starting an agent is also selecting it, so the Files view comes along. */
  async function startAgent(node: AgentNode, mode?: 'new' | 'resume'): Promise<void> {
    await launcher.start(node, mode);
    files.follow(node.folder);
  }

  void start(context, projects, launcher, layouts);
}

interface FileItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
}

/**
 * The files under a folder as something to pick from.
 *
 * The name leads and the folder describes it, so typing matches a file name
 * first and the path only once `matchOnDescription` widens it — which is the
 * order you think in when you know what a file is called.
 */
async function searchItems(scope: vscode.Uri): Promise<FileItem[]> {
  const { files, truncated } = await searchFiles(scope);

  if (truncated) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('{0} has too many files to list them all; searching the first {1}.',
        basename(scope.path),
        files.length,
      ),
    );
  }

  return files.map((uri) => {
    const folder = relativeTo(scope, dirnameOf(uri));
    return {
      uri,
      label: basename(uri.path),
      description: folder === '.' ? undefined : folder,
    } satisfies FileItem;
  });
}

export function deactivate(): void {
  // Terminals are owned by the workbench and are cleaned up with the window.
}

async function start(
  context: vscode.ExtensionContext,
  projects: ProjectWatcher,
  launcher: Launcher,
  layouts: LayoutController,
): Promise<void> {
  await projects.refresh();
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

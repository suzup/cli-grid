import * as vscode from 'vscode';
import { FilesTreeProvider } from './files.js';
import { GitStatus } from './git.js';
import { registerFileCommands } from './fileops.js';
import { EditorGrid } from './grid.js';
import { Launcher } from './launcher.js';
import { AUTO_LAYOUT, resolveLayout } from './layout.js';
import { LayoutTreeProvider } from './layoutView.js';
import { clearAvailabilityCache } from './profiles.js';
import {
  ProjectWatcher,
  hasConfig,
  openableConfigUri,
  updateConfig,
  writeConfig,
} from './project.js';
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
  const layouts = new LayoutTreeProvider();
  const statusBar = new StatusBar(projects, registry);

  context.subscriptions.push(projects, git, registry, grid, tree, files, layouts, statusBar);

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
      layouts.setAgentCount(registry.list().length);
      trackGitFolders();
    }),
    projects.onDidChange(trackGitFolders),
    filesView,
    files.onDidChangeScope(syncFilesHeader),
    git.onDidChange(syncFilesHeader),
    vscode.window.createTreeView('cliGrid.layout', { treeDataProvider: layouts }),
    vscode.window.createTreeView('cliGrid.agents', {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('cliGrid.profiles')) {
        clearAvailabilityCache();
        tree.refresh();
      }
    }),
  );

  const register = (id: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register('cliGrid.initProject', async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const first = folders[0];
    if (!first) {
      const open = vscode.l10n.t('Open Folder...');
      const answer = await vscode.window.showInformationMessage(
        vscode.l10n.t('Open the folder you want to work in first.'),
        open,
      );
      if (answer === open) await vscode.commands.executeCommand('workbench.action.files.openFolder');
      return;
    }

    // With several folders open, set up the one that is not a project yet.
    let root = first.uri;
    if (folders.length > 1) {
      const candidates: vscode.WorkspaceFolder[] = [];
      for (const folder of folders) {
        if (!(await hasConfig(folder.uri))) candidates.push(folder);
      }
      const target = candidates[0] ?? first;
      if (candidates.length > 1) {
        const picked = await vscode.window.showQuickPick(
          candidates.map((f) => ({ label: `$(root-folder) ${f.name}`, description: f.uri.fsPath, uri: f.uri })),
          { title: vscode.l10n.t('Which folder should become a CLI Grid project?') },
        );
        if (!picked) return;
        root = picked.uri;
      } else {
        root = target.uri;
      }
    }

    if (await hasConfig(root)) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('This folder is already a CLI Grid project.'),
      );
      await projects.refresh();
      return;
    }

    try {
      await writeConfig(root, { agents: [] });
    } catch (err) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Could not write {0}: {1}', '.vscode/cli-grid.json', String(err)),
      );
      return;
    }
    await projects.refresh();
    await vscode.commands.executeCommand('cliGrid.showAgents');
  });

  register('cliGrid.newAgent', (node?: Node) =>
    launcher.newAgent(node && node.kind === 'project' ? node.uri : undefined),
  );

  register('cliGrid.startAgent', async (node?: AgentNode) => {
    if (!node) return;
    await launcher.start(node);
    files.setScope(node.folder);
  });

  register('cliGrid.startAll', async (node?: ProjectNode) => {
    const root = node?.uri ?? projects.projects()[0]?.uri;
    if (root) await launcher.startAll(root);
  });

  // Reopening a folder is exactly when you want the previous conversations
  // back, so bringing them all up that way is a single button.
  register('cliGrid.startAllResumed', async (node?: ProjectNode) => {
    const root = node?.uri ?? projects.projects()[0]?.uri;
    if (root) await launcher.startAll(root, 'resume');
  });

  register('cliGrid.startResumed', async (node?: AgentNode) => {
    if (!node) return;
    await launcher.start(node, 'resume');
    files.setScope(node.folder);
  });

  register('cliGrid.startFresh', async (node?: AgentNode) => {
    if (!node) return;
    await launcher.start(node, 'new');
    files.setScope(node.folder);
  });

  register('cliGrid.removeAgent', (node?: AgentNode) => node && launcher.removeAgent(node));

  register('cliGrid.saveAgent', (node?: AgentNode) => node && launcher.saveAgent(node));

  register('cliGrid.stopAgent', (node?: AgentNode) => {
    if (node?.running) registry.stop(node.running.id);
  });

  register('cliGrid.restartAgent', async (node?: AgentNode) => {
    if (!node) return;
    if (node.running) registry.stop(node.running.id);
    await launcher.start(node);
  });

  register('cliGrid.focusAgent', (node?: AgentNode) => {
    const agent = node?.running ?? registry.list()[0];
    if (!agent) return;

    agent.terminal.show(true);
    // Point the Files view at what this CLI is actually working on.
    if (vscode.workspace.getConfiguration('cliGrid').get<boolean>('revealOnFocus', true)) {
      files.setScope(agent.folder);
    }
  });

  register('cliGrid.applyLayout', async (id?: string) => {
    if (!id) return;
    const running = registry.list();
    const preset = resolveLayout(id, running.length);
    if (!preset) return;

    // Applies the split and distributes the terminals into it; a grid with
    // every terminal stacked in one pane is not a grid.
    await grid.arrange(running.map((a) => a.terminal), preset);
    layouts.setCurrent(id);

    // The split belongs to the window, so it is recorded once, on the project
    // that owns the config the user is most likely reading.
    const root = projects.projects()[0]?.uri;
    if (root) {
      await updateConfig(root, (config) => {
        config.layout = preset.id;
      });
      await projects.refresh();
    }
  });

  register('cliGrid.toggleHiddenFiles', async () => {
    const config = vscode.workspace.getConfiguration('cliGrid');
    const next = !config.get<boolean>('showHiddenFiles', false);
    await config.update('showHiddenFiles', next, vscode.ConfigurationTarget.Global);
    files.refresh();
  });

  register('cliGrid.openConfig', async (node?: ProjectNode) => {
    const root = node?.uri ?? projects.projects()[0]?.uri;
    if (!root) return;
    await grid.openFile(await openableConfigUri(root), false);
  });

  // Everything the Files view opens goes through here, so it lands beside the
  // grid instead of on top of an agent.
  register('cliGrid.openFile', async (uri?: vscode.Uri) => {
    if (uri) await grid.openFile(uri);
  });

  register('cliGrid.showAgents', () =>
    vscode.commands.executeCommand('workbench.view.extension.cliGrid'),
  );

  register('cliGrid.refresh', async () => {
    clearAvailabilityCache();
    await projects.refresh();
    tree.refresh();
    files.refresh();
  });

  void start(context, projects, launcher, layouts, grid);
}

export function deactivate(): void {
  // Terminals are owned by the workbench and are cleaned up with the window.
}

async function start(
  context: vscode.ExtensionContext,
  projects: ProjectWatcher,
  launcher: Launcher,
  layouts: LayoutTreeProvider,
  grid: EditorGrid,
): Promise<void> {
  await projects.refresh();

  const project = projects.projects().find((p) => p.config.layout);
  const layout = project?.config.layout ?? AUTO_LAYOUT;
  layouts.setCurrent(layout);

  const preset = resolveLayout(layout, project?.config.agents.length ?? 0);
  // Only a project gets its restored editors moved into the file pane; in any
  // other folder the window should look exactly as it was left.
  if (preset) await grid.applyPreset(preset, projects.any);

  if (vscode.workspace.getConfiguration('cliGrid').get<boolean>('autoStart', false)) {
    for (const p of projects.projects()) await launcher.startAll(p.uri);
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

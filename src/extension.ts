import * as vscode from 'vscode';
import { FilesTreeProvider } from './files.js';
import { GitStatus } from './git.js';
import { Launcher } from './launcher.js';
import { AUTO_LAYOUT, applyLayout, arrange, resolveLayout } from './layout.js';
import { LayoutTreeProvider } from './layoutView.js';
import { clearAvailabilityCache } from './profiles.js';
import { ProjectWatcher, configUri, hasConfig, updateConfig, writeConfig } from './project.js';
import { AgentRegistry } from './registry.js';
import { StatusBar } from './statusbar.js';
import { AgentsTreeProvider, type AgentNode, type Node, type ProjectNode } from './tree.js';

const INTRO_SHOWN_KEY = 'agentry.introShown';

export function activate(context: vscode.ExtensionContext): void {
  const projects = new ProjectWatcher();
  const git = new GitStatus();
  const registry = new AgentRegistry();
  const launcher = new Launcher(projects, registry, context);
  const tree = new AgentsTreeProvider(projects, registry, git);
  const files = new FilesTreeProvider(registry, git);
  const layouts = new LayoutTreeProvider();
  const statusBar = new StatusBar(projects, registry);

  context.subscriptions.push(projects, git, registry, tree, files, layouts, statusBar);

  const filesView = vscode.window.createTreeView('agentry.files', {
    treeDataProvider: files,
    showCollapseAll: true,
  });
  const syncFilesHeader = () => {
    filesView.description = files.headerFor();
  };
  syncFilesHeader();

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
    vscode.window.createTreeView('agentry.layout', { treeDataProvider: layouts }),
    vscode.window.createTreeView('agentry.agents', {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('agentry.profiles')) {
        clearAvailabilityCache();
        tree.refresh();
      }
    }),
  );

  const register = (id: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register('agentry.initProject', async () => {
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
          { title: vscode.l10n.t('Which folder should become an Agentry project?') },
        );
        if (!picked) return;
        root = picked.uri;
      } else {
        root = target.uri;
      }
    }

    if (await hasConfig(root)) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('This folder is already an Agentry project.'),
      );
      await projects.refresh();
      return;
    }

    try {
      await writeConfig(root, { agents: [] });
    } catch (err) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Could not write {0}: {1}', '.vscode/agentry.json', String(err)),
      );
      return;
    }
    await projects.refresh();
    await vscode.commands.executeCommand('agentry.showAgents');
  });

  register('agentry.newAgent', (node?: Node) =>
    launcher.newAgent(node && node.kind === 'project' ? node.uri : undefined),
  );

  register('agentry.startAgent', async (node?: AgentNode) => {
    if (!node) return;
    await launcher.start(node);
    files.setScope(node.folder);
  });

  register('agentry.startAll', async (node?: ProjectNode) => {
    const root = node?.uri ?? projects.projects()[0]?.uri;
    if (root) await launcher.startAll(root);
  });

  register('agentry.removeAgent', (node?: AgentNode) => node && launcher.removeAgent(node));

  register('agentry.saveAgent', (node?: AgentNode) => node && launcher.saveAgent(node));

  register('agentry.stopAgent', (node?: AgentNode) => {
    if (node?.running) registry.stop(node.running.id);
  });

  register('agentry.restartAgent', async (node?: AgentNode) => {
    if (!node) return;
    if (node.running) registry.stop(node.running.id);
    await launcher.start(node);
  });

  register('agentry.focusAgent', (node?: AgentNode) => {
    const agent = node?.running ?? registry.list()[0];
    if (!agent) return;

    agent.terminal.show(true);
    // Point the Files view at what this CLI is actually working on.
    if (vscode.workspace.getConfiguration('agentry').get<boolean>('revealOnFocus', true)) {
      files.setScope(agent.folder);
    }
  });

  register('agentry.applyLayout', async (id?: string) => {
    if (!id) return;
    const running = registry.list();
    const preset = resolveLayout(id, running.length);
    if (!preset) return;

    await applyLayout(preset);
    // A grid with every terminal stacked in the first pane is not a grid.
    await arrange(running.map((a) => a.terminal), preset);
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

  register('agentry.toggleHiddenFiles', async () => {
    const config = vscode.workspace.getConfiguration('agentry');
    const next = !config.get<boolean>('showHiddenFiles', false);
    await config.update('showHiddenFiles', next, vscode.ConfigurationTarget.Global);
    files.refresh();
  });

  register('agentry.openConfig', async (node?: ProjectNode) => {
    const root = node?.uri ?? projects.projects()[0]?.uri;
    if (!root) return;
    const document = await vscode.workspace.openTextDocument(configUri(root));
    await vscode.window.showTextDocument(document);
  });

  register('agentry.showAgents', () =>
    vscode.commands.executeCommand('workbench.view.extension.agentry'),
  );

  register('agentry.refresh', async () => {
    clearAvailabilityCache();
    await projects.refresh();
    tree.refresh();
    files.refresh();
  });

  void start(context, projects, launcher, layouts);
}

export function deactivate(): void {
  // Terminals are owned by the workbench and are cleaned up with the window.
}

async function start(
  context: vscode.ExtensionContext,
  projects: ProjectWatcher,
  launcher: Launcher,
  layouts: LayoutTreeProvider,
): Promise<void> {
  await projects.refresh();

  const project = projects.projects().find((p) => p.config.layout);
  const layout = project?.config.layout ?? AUTO_LAYOUT;
  layouts.setCurrent(layout);

  const preset = resolveLayout(layout, project?.config.agents.length ?? 0);
  if (preset) await applyLayout(preset);

  if (vscode.workspace.getConfiguration('agentry').get<boolean>('autoStart', false)) {
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

  const show = vscode.l10n.t('Open Agentry');
  const tour = vscode.l10n.t('Get Started');

  const answer = await vscode.window.showInformationMessage(
    projects.any
      ? vscode.l10n.t('This folder is an Agentry project. Open it from the Agentry icon in the Activity Bar.')
      : vscode.l10n.t('Agentry is installed. Look for its icon in the Activity Bar on the left.'),
    show,
    tour,
  );

  if (answer === show) {
    await vscode.commands.executeCommand('agentry.showAgents');
  } else if (answer === tour) {
    await vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      `${context.extension.id}#agentry.getStarted`,
    );
  }
}

import * as vscode from 'vscode';
import type { EditorGrid } from './grid.js';
import { columnFor, resolveLayout } from './layout.js';
import { basename, dirnameOf, relativeTo, resolveFolder } from './paths.js';
import { defaultMode, findProfile, isAvailable, readProfiles } from './profiles.js';
import {
  CONFIG_RELATIVE,
  addAgentToConfig,
  hasConfig,
  removeAgentFromConfig,
  type AgentSpec,
  type ProjectWatcher,
} from './project.js';
import type { AgentRegistry } from './registry.js';
import type { AgentNode } from './tree.js';
import { supportsMode, type AgentProfile, type LaunchMode } from './types.js';

const RECENT_KEY = 'cliGrid.recentFolders';
const RECENT_LIMIT = 10;

export class Launcher {
  constructor(
    private readonly projects: ProjectWatcher,
    private readonly registry: AgentRegistry,
    private readonly grid: EditorGrid,
    private readonly context: vscode.ExtensionContext,
  ) {}

  /**
   * Folder -> CLI -> terminal, writing the choice into the project config.
   *
   * The first agent added to a plain folder is what turns it into a CLI Grid
   * project; there is no separate setup step to discover.
   */
  async newAgent(preselectedRoot?: vscode.Uri): Promise<void> {
    const root = preselectedRoot ?? (await this.pickProject());
    if (!root) return;

    const folder = await this.pickTargetFolder(root);
    if (!folder) return;

    const choice = await this.pickProfile(folder);
    if (!choice) return;

    const folderRef = relativeTo(root, folder);
    const spec: AgentSpec = {
      folder: folderRef,
      cli: choice.profile.id,
      ...(choice.mode !== defaultMode(choice.profile) ? { mode: choice.mode } : {}),
    };

    const first = !(await hasConfig(root));
    try {
      await addAgentToConfig(root, spec);
    } catch (err) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Could not write {0}: {1}', CONFIG_RELATIVE, String(err)),
      );
      return;
    }
    await this.projects.refresh();

    if (first) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'This folder is now a CLI Grid project. Its setup lives in {0} — commit it to share, or add it to .gitignore to keep it local.',
          CONFIG_RELATIVE,
        ),
      );
    }

    const column = await this.nextColumn(root);
    await this.grid.unlockAll();
    const agent = this.registry.launch(choice.profile, choice.mode, {
      root,
      folderRef,
      folder,
      viewColumn: column,
    });
    agent.terminal.show(false);
  }

  /**
   * Pane a newly launched agent belongs in.
   *
   * In auto mode a new agent can change which split is correct, so the layout is
   * re-applied first and the agent lands in the pane that just appeared.
   */
  private async nextColumn(root: vscode.Uri): Promise<number> {
    const running = this.registry.inProject(root).length;
    const configured = this.projects.configFor(root)?.layout;
    const preset = resolveLayout(configured, running + 1);
    if (!preset) return 1;
    if (configured === 'auto') await this.grid.applyPreset(preset);
    return columnFor(running, preset);
  }

  /**
   * Starts an agent that is already declared in the config.
   *
   * `modeOverride` is a one-off: reopening a folder and picking up the previous
   * conversation is the common case, but it should not silently rewrite what the
   * project file says the default is.
   */
  async start(node: AgentNode, modeOverride?: LaunchMode): Promise<void> {
    const profile = findProfile(node.spec.cli);
    if (!profile) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('No CLI profile named "{0}". Add one under cliGrid.profiles.', node.spec.cli),
      );
      return;
    }

    const existing = this.registry.find(node.root, node.spec.folder, node.spec.cli);
    if (existing) {
      existing.terminal.show(false);
      return;
    }

    const column = await this.nextColumn(node.root);
    await this.grid.unlockAll();
    const agent = this.registry.launch(
      profile,
      modeOverride ?? node.spec.mode ?? defaultMode(profile),
      {
        root: node.root,
        folderRef: node.spec.folder,
        folder: node.folder,
        viewColumn: column,
      },
    );
    agent.terminal.show(false);
  }

  /**
   * Starts every configured agent, laying the panes out first so each one opens
   * where it belongs instead of stacking as tabs in the active group.
   */
  async startAll(root: vscode.Uri, modeOverride?: LaunchMode): Promise<void> {
    const config = this.projects.configFor(root);
    const specs = config?.agents ?? [];
    if (!specs.length) return;

    const preset = resolveLayout(config?.layout, specs.length);
    if (preset) await this.grid.applyPreset(preset);
    await this.grid.unlockAll();

    for (const [index, spec] of specs.entries()) {
      if (this.registry.find(root, spec.folder, spec.cli)) continue;
      const profile = findProfile(spec.cli);
      if (!profile) continue;
      this.registry.launch(profile, modeOverride ?? spec.mode ?? defaultMode(profile), {
        root,
        folderRef: spec.folder,
        folder: resolveFolder(root, spec.folder),
        viewColumn: columnFor(index, preset),
      });
    }
  }

  async removeAgent(node: AgentNode): Promise<void> {
    const running = this.registry.find(node.root, node.spec.folder, node.spec.cli);
    if (running) this.registry.stop(running.id);
    await removeAgentFromConfig(node.root, node.spec);
    await this.projects.refresh();
  }

  /** Writes an ad-hoc agent into the project config so it comes back next time. */
  async saveAgent(node: AgentNode): Promise<void> {
    await addAgentToConfig(node.root, node.spec);
    await this.projects.refresh();
  }

  /* ------------------------------ project step ----------------------------- */

  private async pickProject(): Promise<vscode.Uri | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    if (folders.length === 0) {
      const open = vscode.l10n.t('Open Folder...');
      const answer = await vscode.window.showInformationMessage(
        vscode.l10n.t('Open the folder you want to work in first.'),
        open,
      );
      if (answer === open) {
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
      }
      return undefined;
    }

    const only = folders[0];
    if (folders.length === 1 && only) return only.uri;

    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({
        label: `$(root-folder) ${f.name}`,
        description: f.uri.fsPath,
        uri: f.uri,
      })),
      {
        title: vscode.l10n.t('CLI Grid — which project?'),
        placeHolder: vscode.l10n.t('This window has more than one folder open'),
        matchOnDescription: true,
      },
    );
    return picked?.uri;
  }

  /* ------------------------------ folder step ------------------------------ */

  /**
   * Which folder the CLI runs in.
   *
   * Straight to the folder dialog, opened at the parent of whatever was picked
   * last. Agents almost always land in a sibling of the previous one, so a list
   * of folders already in use is a step in the way rather than a shortcut.
   */
  private async pickTargetFolder(root: vscode.Uri): Promise<vscode.Uri | undefined> {
    const previous = this.recentFolders()[0];
    const startAt = parentOf(previous ?? root);

    const chosen = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      defaultUri: startAt,
      openLabel: vscode.l10n.t('Run the agent here'),
      title: vscode.l10n.t('CLI Grid — which folder should the CLI run in?'),
    });

    const folder = chosen?.[0];
    if (folder) await this.remember(folder);
    return folder;
  }

  private recentFolders(): vscode.Uri[] {
    return this.context.globalState
      .get<string[]>(RECENT_KEY, [])
      .map((s) => vscode.Uri.parse(s));
  }

  private async remember(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const rest = this.recentFolders()
      .map((u) => u.toString())
      .filter((u) => u !== key);
    await this.context.globalState.update(RECENT_KEY, [key, ...rest].slice(0, RECENT_LIMIT));
  }

  /* ------------------------------- CLI step -------------------------------- */

  private async pickProfile(
    folder: vscode.Uri,
  ): Promise<{ profile: AgentProfile; mode: LaunchMode } | undefined> {
    const profiles = readProfiles();

    interface ProfileItem extends vscode.QuickPickItem {
      profile: AgentProfile;
    }

    const build = (available: Map<string, boolean>): ProfileItem[] =>
      profiles.map((profile) => {
        const mode = defaultMode(profile);
        const alternate = mode === 'new' ? 'resume' : 'new';
        const known = available.get(profile.id);

        return {
          label: `$(${profile.icon}) ${profile.label}`,
          description: mode === 'resume' ? vscode.l10n.t('resume') : vscode.l10n.t('new'),
          ...(known === false
            ? { detail: vscode.l10n.t('$(warning) "{0}" was not found on PATH', profile.command) }
            : {}),
          buttons: supportsMode(profile, alternate)
            ? [
                {
                  // A clock reads as "the earlier conversation"; a plus reads as
                  // "a fresh one". Neither is a refresh.
                  iconPath: new vscode.ThemeIcon(alternate === 'resume' ? 'history' : 'add'),
                  tooltip:
                    alternate === 'resume'
                      ? vscode.l10n.t('Resume the previous conversation')
                      : vscode.l10n.t('Start a new conversation'),
                },
              ]
            : [],
          profile,
        };
      });

    return await new Promise((resolve) => {
      const quickPick = vscode.window.createQuickPick<ProfileItem>();
      quickPick.title = vscode.l10n.t('CLI Grid — which CLI? ({0})', basename(folder.path));
      quickPick.placeholder = vscode.l10n.t(
        'Enter to use the default mode, or use the button for the other one',
      );
      quickPick.matchOnDetail = true;
      quickPick.busy = true;
      quickPick.items = build(new Map());

      let settled = false;
      const finish = (value: { profile: AgentProfile; mode: LaunchMode } | undefined) => {
        if (settled) return;
        settled = true;
        resolve(value);
        quickPick.hide();
      };

      quickPick.onDidAccept(() => {
        const item = quickPick.selectedItems[0];
        if (item) finish({ profile: item.profile, mode: defaultMode(item.profile) });
      });

      quickPick.onDidTriggerItemButton(({ item }) => {
        const alternate = defaultMode(item.profile) === 'new' ? 'resume' : 'new';
        finish({ profile: item.profile, mode: alternate });
      });

      quickPick.onDidHide(() => {
        finish(undefined);
        quickPick.dispose();
      });

      quickPick.show();

      // Availability is resolved through a login shell, so it can take a moment;
      // the list stays usable while it lands.
      void Promise.all(
        profiles.map(async (p) => [p.id, await isAvailable(p.command)] as const),
      ).then((entries) => {
        if (settled) return;
        const active = quickPick.activeItems[0];
        quickPick.items = build(new Map(entries));
        if (active) {
          const same = quickPick.items.find((i) => i.profile.id === active.profile.id);
          if (same) quickPick.activeItems = [same];
        }
        quickPick.busy = false;
      });
    });
  }
}

/** Where the folder dialog should open: one level above the last choice. */
function parentOf(uri: vscode.Uri): vscode.Uri {
  return dirnameOf(uri);
}


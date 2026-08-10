import * as vscode from 'vscode';
import type { EditorGrid } from './grid.js';
import { AUTO_LAYOUT, LAYOUT_PRESETS, autoPreset, paneCount, resolveLayout } from './layout.js';
import { inProjectOrder, pinnedAgents, updateConfig, type ProjectWatcher } from './project.js';
import type { AgentRegistry } from './registry.js';
import type { LayoutPreset } from './types.js';

/**
 * Choosing a split, applying it, and remembering it.
 *
 * The split belongs to the window rather than to any one agent, so it is stored
 * once — on the first project — and restored when that folder is opened again.
 */
export class LayoutController {
  constructor(
    private readonly view: LayoutTreeProvider,
    private readonly grid: EditorGrid,
    private readonly registry: AgentRegistry,
    private readonly projects: ProjectWatcher,
  ) {}

  /** The layout in force, which is what the checkmark in the view follows. */
  async apply(id: string): Promise<void> {
    // In the order the Agents view lists them, not the order they were started
    // in: the panes are how a split is read, and the list is where their order
    // was decided.
    const running = inProjectOrder(this.projects.projects(), this.registry.list());
    const preset = resolveLayout(id, running.length);
    if (!preset) return;

    // Applies the split and distributes the terminals into it; a grid with
    // every terminal stacked in one pane is not a grid.
    await this.grid.arrange(
      running.map((agent) => agent.terminal),
      preset,
    );
    this.view.setCurrent(id);

    // Recorded on the project that owns the config the user is most likely to
    // be reading, since one window only ever has one split.
    const root = this.projects.projects()[0]?.uri;
    if (!root) return;
    await updateConfig(root, (config) => {
      config.layout = preset.id;
    });
    await this.projects.refresh();
  }

  /**
   * Brings back the split a project was left in, on startup.
   *
   * Only a project gets its restored editors moved into the file pane; in any
   * other folder the window should look exactly as it was left.
   */
  async restore(): Promise<void> {
    const project = this.projects.projects().find((p) => p.config.layout);
    const id = project?.config.layout ?? AUTO_LAYOUT;
    this.view.setCurrent(id);

    // Sized for the agents the start button would bring up, since that is what
    // is about to fill it — an un-pinned agent would leave an empty pane.
    const preset = resolveLayout(id, pinnedAgents(project?.config).length);
    if (preset) await this.grid.applyPreset(preset, this.projects.any);
  }
}

/**
 * The splits as a visible list rather than a hidden command.
 *
 * Arranging panes is the thing users reach for constantly, so it gets a row
 * they can see and click, with a little diagram instead of an icon that would
 * look identical to the other layout icons.
 */
export class LayoutTreeProvider implements vscode.TreeDataProvider<LayoutPreset>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<LayoutPreset | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private current: string | undefined;
  private agents = 0;

  /** Auto's label shows the split it would pick right now. */
  setAgentCount(count: number): void {
    if (this.agents === count) return;
    this.agents = count;
    this.changeEmitter.fire(undefined);
  }

  setCurrent(id: string | undefined): void {
    if (this.current === id) return;
    this.current = id;
    this.changeEmitter.fire(undefined);
  }

  getChildren(element?: LayoutPreset): LayoutPreset[] {
    if (element) return [];
    return [{ id: AUTO_LAYOUT, label: '', detail: '', rows: [] }, ...LAYOUT_PRESETS];
  }

  getTreeItem(preset: LayoutPreset): vscode.TreeItem {
    const auto = preset.id === AUTO_LAYOUT;
    const effective = auto ? autoPreset(this.agents) : preset;

    const item = new vscode.TreeItem(
      auto
        ? `${diagram(effective)}   ${vscode.l10n.t('Auto')}`
        : `${diagram(preset)}   ${preset.label}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `layout:${preset.id}`;
    // The presets are data, so their descriptions reach `t` as a variable. The
    // key is still the English string, which is all the lookup needs — only the
    // extraction tool cares, and this bundle is maintained by hand.
    const detail = vscode.l10n.t(preset.detail);
    item.description = auto
      ? vscode.l10n.t('follows the agent count — now {0}', effective.label)
      : `${detail}  ·  ${paneCount(preset)}`;
    item.iconPath = new vscode.ThemeIcon(
      preset.id === this.current ? 'check' : 'blank',
    );
    item.contextValue = 'cliGrid.layout';
    item.tooltip = detail;
    item.command = {
      command: 'cliGrid.applyLayout',
      title: detail,
      arguments: [preset.id],
    };
    return item;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

/** Sketch of the split: one block per pane, rows separated by a slash. */
function diagram(preset: LayoutPreset): string {
  return preset.rows.map((columns) => '▣'.repeat(columns)).join(' ╱ ');
}

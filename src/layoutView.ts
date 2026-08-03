import * as vscode from 'vscode';
import { AUTO_LAYOUT, autoPreset, paneCount } from './layout.js';
import { LAYOUT_PRESETS, type LayoutPreset } from './types.js';

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
    item.description = auto
      ? vscode.l10n.t('follows the agent count — now {0}', effective.label)
      : `${preset.detail}  ·  ${paneCount(preset)}`;
    item.iconPath = new vscode.ThemeIcon(
      preset.id === this.current ? 'check' : 'blank',
    );
    item.contextValue = 'agentGrid.layout';
    item.tooltip = preset.detail;
    item.command = {
      command: 'agentGrid.applyLayout',
      title: preset.detail,
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

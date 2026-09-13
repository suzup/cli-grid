import * as vscode from 'vscode';
import type { GroupController } from './groups.js';
import type { ProjectWatcher } from './project.js';
import type { AgentRegistry } from './registry.js';

/**
 * A second, always-visible entry point next to the Activity Bar icon — it also
 * carries the running count, which the icon cannot show.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly projects: ProjectWatcher,
    private readonly registry: AgentRegistry,
    private readonly groups: GroupController,
  ) {
    this.item = vscode.window.createStatusBarItem(
      'cliGrid.status',
      vscode.StatusBarAlignment.Left,
      90,
    );
    this.item.name = 'CLI Grid';
    this.item.command = 'cliGrid.showAgents';

    this.disposables.push(
      this.item,
      registry.onDidChange(() => this.update()),
      projects.onDidChange(() => this.update()),
      groups.onDidChange(() => this.update()),
    );

    this.update();
  }

  update(): void {
    const running = this.registry.list().length;
    const active = this.groups.active();
    const many = this.groups.many;

    this.item.text = running > 0 ? `$(zap) ${running}` : '$(zap) CLI Grid';

    const lines = [
      running > 0
        ? vscode.l10n.t('{0} agent(s) running', running)
        : vscode.l10n.t('No agents running'),
      this.projects.any
        ? vscode.l10n.t('{0} configured in this folder', active?.config.agents.length ?? 0)
        : vscode.l10n.t('This folder is not a CLI Grid project'),
    ];
    // Only worth a line when there is more than one group; otherwise it names
    // the folder every other part of the window already names.
    if (many && active) lines.push(vscode.l10n.t('Showing the group {0}', active.name));
    lines.push('', vscode.l10n.t('Click to open CLI Grid'));

    this.item.tooltip = lines.join('\n');
    this.item.show();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

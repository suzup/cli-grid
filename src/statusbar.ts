import * as vscode from 'vscode';
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
  ) {
    this.item = vscode.window.createStatusBarItem(
      'agentGrid.status',
      vscode.StatusBarAlignment.Left,
      90,
    );
    this.item.name = 'Agent Grid';
    this.item.command = 'agentGrid.showAgents';

    this.disposables.push(
      this.item,
      registry.onDidChange(() => this.update()),
      projects.onDidChange(() => this.update()),
    );

    this.update();
  }

  update(): void {
    const running = this.registry.list().length;
    const configured = this.projects
      .projects()
      .reduce((total, p) => total + p.config.agents.length, 0);

    this.item.text = running > 0 ? `$(zap) ${running}` : '$(zap) Agent Grid';
    this.item.tooltip = [
      running > 0
        ? vscode.l10n.t('{0} agent(s) running', running)
        : vscode.l10n.t('No agents running'),
      this.projects.any
        ? vscode.l10n.t('{0} configured in this folder', configured)
        : vscode.l10n.t('This folder is not an Agent Grid project'),
      '',
      vscode.l10n.t('Click to open Agent Grid'),
    ].join('\n');
    this.item.show();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

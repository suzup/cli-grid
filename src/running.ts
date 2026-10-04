import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { setting, SECTION } from './config.js';
import { basename } from './paths.js';
import { readProfiles } from './profiles.js';
import { updateAgentInConfig, type ProjectWatcher } from './project.js';
import type { AgentRegistry } from './registry.js';
import type { AgentProfile, RunningAgent } from './types.js';

/**
 * Which CLI a terminal is running now, as opposed to the one it was opened for.
 *
 * A terminal opened on the shell outlives its CLI: quit Devin and start Claude
 * at the prompt it leaves, and the tab, the environment it was given and every
 * table here still say Devin. Most of that is only a wrong label, but the keys
 * that make a busy CLI read a message now are each CLI's own — Esc is codex's
 * "send immediately" and Claude's "stop what you are doing".
 */

/** Runtimes a CLI may be started through, where its own name is the script. */
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3']);

/** What a path names a command as: no directory, no script extension. */
function commandName(path: string): string {
  return basename(path).replace(/\.(c|m)?js$|\.(exe|cmd|sh)$/, '');
}

/** The names a process could be the CLI by: what it ran, and for an interpreter, its script. */
export function namesOf(argv: readonly string[]): string[] {
  const [first = '', second = ''] = argv;
  const name = commandName(first);
  return INTERPRETERS.has(name) && second ? [name, commandName(second)] : [name];
}

/** The profile one of these processes is an instance of, if any is. */
export function matchProfile(
  argvs: readonly (readonly string[])[],
  profiles: readonly AgentProfile[],
): AgentProfile | undefined {
  for (const argv of argvs) {
    const names = namesOf(argv);
    const profile = profiles.find((p) => names.includes(commandName(p.command)));
    if (profile) return profile;
  }
  return undefined;
}

/**
 * The CLI running under a terminal's shell, read off the process table.
 *
 * Only answerable where the kernel lists a process's children, and only for a
 * terminal opened on the shell: one opened on the CLI itself goes when it does.
 * Anything else — no answer, or a command that is no profile's — is "not
 * known", and the profile the terminal was opened for stands.
 */
export async function runningProfile(terminal: vscode.Terminal): Promise<AgentProfile | undefined> {
  if ((terminal.creationOptions as vscode.TerminalOptions).shellPath) return undefined;
  const pid = await terminal.processId;
  if (!pid) return undefined;
  try {
    const children = (await fs.promises.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'))
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const argvs = await Promise.all(
      children.map(async (child) =>
        (await fs.promises.readFile(`/proc/${child}/cmdline`, 'utf8').catch(() => ''))
          .split('\0')
          .filter(Boolean),
      ),
    );
    return matchProfile(argvs, readProfiles());
  } catch {
    return undefined;
  }
}

/** For the command a shell was told to run to have become a process. */
const SETTLE_MS = 1500;

/**
 * Notices an agent's terminal starting a different CLI, and moves the agent to it.
 *
 * The running agent follows always — anything else would be a row that says
 * Devin above a pane running Claude. Whether the project file follows too is
 * `cliGrid.followSwitchedCli`: trying another CLI once is as likely as moving
 * to it for good, so by default it asks.
 */
export class CliSwitches implements vscode.Disposable {
  private readonly subscription: vscode.Disposable | undefined;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly projects: ProjectWatcher,
  ) {
    // Newer than the oldest workbench this runs in, which simply goes without.
    if (!('onDidStartTerminalShellExecution' in vscode.window)) return;

    this.subscription = vscode.window.onDidStartTerminalShellExecution((event) => {
      const agent = registry.byTerminal(event.terminal);
      if (agent) setTimeout(() => void this.check(agent), SETTLE_MS);
    });
  }

  private async check(agent: RunningAgent): Promise<void> {
    const profile = await runningProfile(agent.terminal);
    if (!profile || profile.id === agent.profileId) return;

    const from = agent.profileId;
    const fromLabel = agent.label;
    this.registry.switchProfile(agent.id, profile);

    const spec = this.projects
      .configFor(agent.root)
      ?.agents.find((a) => a.folder === agent.folderRef && a.cli === from);
    if (!spec) return;

    const follow = setting('followSwitchedCli');
    if (follow === 'never') return;
    if (follow === 'ask') {
      const name = spec.name?.trim() || basename(agent.folder.path);
      const always = vscode.l10n.t('Always');
      const yes = vscode.l10n.t('Use {0}', profile.label);
      const answer = await vscode.window.showInformationMessage(
        vscode.l10n.t('{0} is running {1} now. Start {1} there from now on, instead of {2}?', name, profile.label, fromLabel),
        yes,
        always,
      );
      if (answer === always) {
        await vscode.workspace
          .getConfiguration(SECTION)
          .update('followSwitchedCli', 'always', vscode.ConfigurationTarget.Global);
      } else if (answer !== yes) {
        return;
      }
    }
    await updateAgentInConfig(agent.root, spec, { ...spec, cli: profile.id });
  }

  dispose(): void {
    this.subscription?.dispose();
  }
}

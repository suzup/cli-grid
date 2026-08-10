import * as vscode from 'vscode';
import type { LaunchMode, ProfileOverride } from './types.js';

/** The manifest's section name, and what a configuration-change event carries. */
export const SECTION = 'cliGrid';

/**
 * Every setting this extension reads, with its default.
 *
 * The manifest has to declare these as well — it is what the settings UI
 * renders — so the two are checked against each other by `npm test` rather than
 * by anyone remembering. Reading a setting anywhere else means a default that
 * can quietly drift away from the one users are shown.
 */
export const DEFAULTS = {
  defaultMode: 'new' as LaunchMode,
  launchStrategy: 'shell' as 'shell' | 'exec',
  autoStart: false,
  lockAgentPanes: true,
};

export type Settings = typeof DEFAULTS;

export function setting<K extends keyof Settings>(name: K): Settings[K] {
  return vscode.workspace.getConfiguration(SECTION).get<Settings[K]>(name, DEFAULTS[name]);
}

/** Free-form, so it sits outside `DEFAULTS` rather than pretending to a shape. */
export function profileOverrides(): Record<string, ProfileOverride> {
  return vscode.workspace
    .getConfiguration(SECTION)
    .get<Record<string, ProfileOverride>>('profiles', {});
}

import * as vscode from 'vscode';

/**
 * A command handler.
 *
 * `never[]` is what lets a handler with typed parameters be registered without a
 * cast: the workbench passes whatever the menu, keybinding or caller supplies,
 * so the handler itself is where the shape is checked, not the registration.
 */
export type CommandHandler = (...args: never[]) => unknown;

/** Registers a command and ties it to the extension's lifetime. */
export function registerCommand(
  context: vscode.ExtensionContext,
  id: string,
  handler: CommandHandler,
): void {
  context.subscriptions.push(vscode.commands.registerCommand(id, handler));
}

/**
 * Registers a whole table of them.
 *
 * Written as a table so that what the extension does stays legible as a list:
 * a handler long enough to hide the shape of that list belongs on whichever
 * class owns the state it works on.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  table: Record<string, CommandHandler>,
): void {
  for (const [id, handler] of Object.entries(table)) registerCommand(context, id, handler);
}

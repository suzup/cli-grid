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

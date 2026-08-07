import * as vscode from 'vscode';
import { registerCommand, type CommandHandler } from './commands.js';
import { confirmDelete } from './config.js';
import { FileNode, contains, freeName, type FilesTreeProvider } from './files.js';
import { basename, dirnameOf, exists, join } from './paths.js';

/**
 * What the Explorer's context menu does, on the Files view.
 *
 * Where the workbench already has the operation and will take a resource
 * argument — copy path, reveal, open in terminal — the command is forwarded to
 * it rather than reimplemented, so it keeps behaving the way it does everywhere
 * else. The rest is done through `WorkspaceEdit`, which is the same road the
 * Explorer takes: rename fires the file-operation participants, so TypeScript
 * and friends fix up imports, and every step lands on the undo stack.
 *
 * Only two things are genuinely ours: the input box, because a custom tree
 * cannot edit a row in place, and delete, because the built-in command asks for
 * confirmation once per invocation and a multi-select would stack up dialogs.
 */
export function registerFileCommands(
  context: vscode.ExtensionContext,
  view: vscode.TreeView<FileNode>,
  files: FilesTreeProvider,
): void {
  let clipboard: { uris: vscode.Uri[]; cut: boolean } | undefined;

  /**
   * Keyboard shortcuts arrive with no arguments and a view title button passes
   * something that is not a row, so the view's own selection is the fallback.
   */
  const chosen = (node?: FileNode, nodes?: FileNode[]): FileNode[] => {
    const many = nodes?.filter((n) => n instanceof FileNode) ?? [];
    if (many.length) return many;
    if (node instanceof FileNode) return [node];
    return [...view.selection];
  };

  /** A view title button passes something that is not a row, hence the guard. */
  const folderOf = (node: FileNode | undefined): vscode.Uri | undefined =>
    node instanceof FileNode ? node.folder : files.currentScope();

  const register = (id: string, handler: CommandHandler) =>
    registerCommand(context, id, handler);

  /** Forwards to a workbench command that resolves its own multi-select. */
  const forward = (id: string, command: string) =>
    register(id, async (node?: FileNode, nodes?: FileNode[]) => {
      for (const target of chosen(node, nodes)) {
        await vscode.commands.executeCommand(command, target.uri);
      }
    });

  forward('cliGrid.copyPath', 'copyFilePath');
  forward('cliGrid.copyRelativePath', 'copyRelativeFilePath');
  forward('cliGrid.revealInOS', 'revealFileInOS');
  forward('cliGrid.revealInExplorer', 'revealInExplorer');
  forward('cliGrid.openInTerminal', 'openInIntegratedTerminal');

  register('cliGrid.newFile', async (node?: FileNode) => {
    const dir = folderOf(node);
    if (!dir) return;

    const name = await askName(dir, vscode.l10n.t('Name of the new file'));
    if (!name) return;

    const uri = join(dir, name);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { ignoreIfExists: false });
    if (!(await applied(edit))) return;

    files.refresh();
    await vscode.commands.executeCommand('cliGrid.openFile', uri);
  });

  register('cliGrid.newFolder', async (node?: FileNode) => {
    const dir = folderOf(node);
    if (!dir) return;

    const name = await askName(dir, vscode.l10n.t('Name of the new folder'));
    if (!name) return;

    try {
      await vscode.workspace.fs.createDirectory(join(dir, name));
    } catch (err) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not create {0}: {1}', name, String(err)));
      return;
    }
    files.refresh();
  });

  register('cliGrid.rename', async (node?: FileNode, nodes?: FileNode[]) => {
    const target = chosen(node, nodes)[0];
    if (!target) return;

    const dir = dirnameOf(target.uri);
    const name = await askName(dir, vscode.l10n.t('New name'), target.name);
    if (!name || name === target.name) return;

    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(target.uri, join(dir, name), { overwrite: false });
    if (await applied(edit)) files.refresh();
  });

  register('cliGrid.delete', async (node?: FileNode, nodes?: FileNode[]) => {
    const targets = chosen(node, nodes);
    if (targets.length && (await remove(targets))) files.refresh();
  });

  register('cliGrid.copy', (node?: FileNode, nodes?: FileNode[]) => {
    clipboard = { uris: chosen(node, nodes).map((n) => n.uri), cut: false };
  });

  register('cliGrid.cut', (node?: FileNode, nodes?: FileNode[]) => {
    clipboard = { uris: chosen(node, nodes).map((n) => n.uri), cut: true };
  });

  register('cliGrid.paste', async (node?: FileNode, nodes?: FileNode[]) => {
    const dir = folderOf(chosen(node, nodes)[0]);
    if (!dir || !clipboard?.uris.length) return;

    const failures: string[] = [];
    for (const source of clipboard.uris) {
      const name = basename(source.path);
      if (contains(source, dir)) {
        failures.push(vscode.l10n.t('{0} contains the folder you are pasting into', name));
        continue;
      }

      try {
        const destination = await freeName(dir, name);
        if (clipboard.cut) {
          // A move through the workspace edit, so open editors follow and
          // whoever cares about the path gets told about it.
          const edit = new vscode.WorkspaceEdit();
          edit.renameFile(source, destination, { overwrite: false });
          await vscode.workspace.applyEdit(edit);
        } else {
          await vscode.workspace.fs.copy(source, destination, { overwrite: false });
        }
      } catch (err) {
        failures.push(`${name}: ${String(err)}`);
      }
    }

    // A cut is spent once pasted; a copy can go to several places.
    if (clipboard.cut) clipboard = undefined;
    files.refresh();
    if (failures.length) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not paste {0}', failures.join(', ')));
    }
  });
}

/**
 * Deletes to the trash, asking once for the whole selection.
 *
 * `explorer.confirmDelete` is the workbench's own setting for this; someone who
 * has turned it off there does not want to be asked here either.
 */
async function remove(targets: readonly FileNode[]): Promise<boolean> {
  const first = targets[0];
  if (!first) return false;

  const label =
    targets.length === 1
      ? first.name
      : vscode.l10n.t('the {0} selected files', String(targets.length));

  if (confirmDelete()) {
    const move = vscode.l10n.t('Move to Trash');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t("Are you sure you want to delete {0}?", label),
      { modal: true, detail: vscode.l10n.t('You can restore it from the trash.') },
      move,
    );
    if (answer !== move) return false;
  }

  const failures: string[] = [];
  let useTrash = true;

  for (const target of targets) {
    try {
      await vscode.workspace.fs.delete(target.uri, { recursive: true, useTrash });
    } catch (err) {
      if (!useTrash) {
        failures.push(`${target.name}: ${String(err)}`);
        continue;
      }

      // Plenty of file systems, remotes especially, have no trash to move to.
      const permanently = vscode.l10n.t('Delete Permanently');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t('There is no trash on this file system.'),
        { modal: true, detail: vscode.l10n.t('Deleting {0} cannot be undone.', label) },
        permanently,
      );
      if (answer !== permanently) break;

      useTrash = false;
      try {
        await vscode.workspace.fs.delete(target.uri, { recursive: true });
      } catch (retry) {
        failures.push(`${target.name}: ${String(retry)}`);
      }
    }
  }

  if (failures.length) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Could not delete {0}', failures.join(', ')));
  }
  return true;
}

/**
 * The name box, with the checks the Explorer's inline editor makes.
 *
 * A custom tree cannot be edited in place, so this is the one part of the
 * Explorer's behaviour that has to look different.
 */
async function askName(
  dir: vscode.Uri,
  prompt: string,
  value?: string,
): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    prompt,
    ...(value ? { value, valueSelection: [0, stemLength(value)] } : {}),
    validateInput: async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return vscode.l10n.t('A name is required.');
      if (/[\\/]/.test(trimmed)) return vscode.l10n.t('A name cannot contain a slash.');
      if (trimmed === value) return undefined;
      if (await exists(join(dir, trimmed))) {
        return vscode.l10n.t('{0} already exists in this folder.', trimmed);
      }
      return undefined;
    },
  });

  return name?.trim() || undefined;
}

/** So renaming `index.ts` preselects `index`, the way the Explorer does. */
function stemLength(name: string): number {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? dot : name.length;
}

async function applied(edit: vscode.WorkspaceEdit): Promise<boolean> {
  try {
    if (await vscode.workspace.applyEdit(edit)) return true;
    void vscode.window.showErrorMessage(vscode.l10n.t('The workbench refused the change.'));
  } catch (err) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Could not apply the change: {0}', String(err)));
  }
  return false;
}

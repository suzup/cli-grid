import * as vscode from 'vscode';

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

export function dirnameOf(uri: vscode.Uri): vscode.Uri {
  const trimmed = uri.path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return uri.with({ path: index <= 0 ? '/' : trimmed.slice(0, index) });
}

export function join(uri: vscode.Uri, ...segments: string[]): vscode.Uri {
  const path = [uri.path.replace(/\/+$/, ''), ...segments.filter(Boolean)].join('/');
  return uri.with({ path });
}

/** Relative POSIX path from `root` to `target`, or `"."` when they are equal. */
export function relativeTo(root: vscode.Uri, target: vscode.Uri): string {
  const rootParts = root.path.split('/').filter(Boolean);
  const targetParts = target.path.split('/').filter(Boolean);

  let shared = 0;
  while (
    shared < rootParts.length &&
    shared < targetParts.length &&
    rootParts[shared] === targetParts[shared]
  ) {
    shared++;
  }

  const up = rootParts.length - shared;
  const down = targetParts.slice(shared);
  if (up === 0 && down.length === 0) return '.';
  // Outside the root entirely — an absolute path is clearer than "../../..".
  if (up > 0) return target.fsPath;
  return down.join('/');
}

/** Resolves a config-relative folder reference back to a Uri. */
export function resolveFolder(root: vscode.Uri, reference: string): vscode.Uri {
  const trimmed = reference.trim();
  if (!trimmed || trimmed === '.') return root;
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return root.with({ path: trimmed.replace(/\\/g, '/') });
  }
  return join(root, ...trimmed.replace(/\\/g, '/').split('/').filter(Boolean));
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

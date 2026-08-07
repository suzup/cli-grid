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

/**
 * Resolves a config-relative folder reference back to a Uri.
 *
 * The inverse of `relativeTo`, so it has to accept the absolute form that
 * function falls back to — including a Windows path, which is what `fsPath`
 * gives there.
 */
export function resolveFolder(root: vscode.Uri, reference: string): vscode.Uri {
  const trimmed = reference.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed === '.') return root;

  // A drive letter can only mean a local file, and `Uri.file` is what puts the
  // leading slash on the path. `root.with({ path: 'C:/…' })` would produce a
  // uri whose path does not start with one, which is not a valid file uri and
  // whose `fsPath` comes back mangled.
  if (/^[A-Za-z]:\//.test(trimmed)) return vscode.Uri.file(trimmed);

  // Absolute, but on the same file system as the project: keep the root's
  // scheme and authority so folders on a remote still resolve.
  if (trimmed.startsWith('/')) return root.with({ path: trimmed });

  return join(root, ...trimmed.split('/').filter(Boolean));
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

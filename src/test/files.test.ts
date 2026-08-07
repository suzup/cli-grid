// Must come first: it stands in for the `vscode` module the rest of these
// imports reach for.
import './vscode.js';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { URI } from 'vscode-uri';
import { FileNode, contains, freeName } from '../files.js';

let dir: string;
let root: URI;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-grid-files-'));
  root = URI.file(dir);
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const touch = (name: string) => fs.writeFile(path.join(dir, name), '');

describe('FileNode.folder', () => {
  it('is the folder itself, or the one holding the file', () => {
    const folder = new FileNode(URI.file('/a/b'), 'b', true);
    const file = new FileNode(URI.file('/a/b/c.ts'), 'c.ts', false);

    assert.equal(folder.folder.path, '/a/b');
    assert.equal(file.folder.path, '/a/b');
  });
});

describe('contains', () => {
  const uri = (p: string) => URI.file(p);

  it('counts a folder as containing itself', () => {
    assert.equal(contains(uri('/a/b'), uri('/a/b')), true);
  });

  it('counts anything below it', () => {
    assert.equal(contains(uri('/a'), uri('/a/b/c')), true);
  });

  // The check exists to stop a copy that never terminates, so a sibling whose
  // name merely starts the same must not be mistaken for a child.
  it('does not confuse a sibling with a shared prefix', () => {
    assert.equal(contains(uri('/a/b'), uri('/a/bc')), false);
    assert.equal(contains(uri('/a/b'), uri('/a')), false);
  });

  it('ignores a trailing slash on either side', () => {
    assert.equal(contains(uri('/a/b/'), uri('/a/b')), true);
    assert.equal(contains(uri('/a/b'), uri('/a/b/')), true);
  });
});

describe('freeName', () => {
  it('leaves a name that is free alone', async () => {
    assert.equal((await freeName(root, 'fresh.ts')).path, `${root.path}/fresh.ts`);
  });

  it('adds " copy" before the extension, so the file still opens as itself', async () => {
    await touch('taken.ts');
    assert.equal((await freeName(root, 'taken.ts')).path, `${root.path}/taken copy.ts`);
  });

  it('counts up while the copies are also taken', async () => {
    await touch('many.ts');
    await touch('many copy.ts');
    await touch('many copy 2.ts');

    assert.equal((await freeName(root, 'many.ts')).path, `${root.path}/many copy 3.ts`);
  });

  it('treats a leading dot as part of the name, not an extension', async () => {
    await touch('.env');
    assert.equal((await freeName(root, '.env')).path, `${root.path}/.env copy`);
  });

  it('handles a name with no extension', async () => {
    await touch('Makefile');
    assert.equal((await freeName(root, 'Makefile')).path, `${root.path}/Makefile copy`);
  });
});

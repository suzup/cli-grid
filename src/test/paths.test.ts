// Must come first: it stands in for the `vscode` module the rest of these
// imports reach for.
import './vscode.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { URI } from 'vscode-uri';
import { basename, dirnameOf, join, relativeTo, resolveFolder } from '../paths.js';

const posix = URI.file('/home/dev/project');
const remote = URI.parse('vscode-remote://ssh-remote%2Bbox/home/dev/project');

// Built by hand rather than with `URI.file`, which reads `process.platform` and
// so would not produce a Windows uri while these tests run on Linux CI.
const windows = URI.from({ scheme: 'file', path: '/C:/Users/dev/project' });

describe('basename', () => {
  it('takes the last segment, trailing slash or not', () => {
    assert.equal(basename('/home/dev/project'), 'project');
    assert.equal(basename('/home/dev/project/'), 'project');
    assert.equal(basename('project'), 'project');
    assert.equal(basename('/'), '');
  });
});

describe('dirnameOf', () => {
  it('goes one level up and keeps the scheme', () => {
    assert.equal(dirnameOf(posix).path, '/home/dev');
    assert.equal(dirnameOf(remote).authority, remote.authority);
    assert.equal(dirnameOf(remote).path, '/home/dev');
  });

  it('stops at the root rather than falling off it', () => {
    assert.equal(dirnameOf(URI.file('/home')).path, '/');
    assert.equal(dirnameOf(URI.file('/')).path, '/');
  });
});

describe('join', () => {
  it('appends segments without doubling separators', () => {
    assert.equal(join(posix, '.vscode', 'cli-grid.json').path, '/home/dev/project/.vscode/cli-grid.json');
    assert.equal(join(URI.file('/'), 'tmp').path, '/tmp');
  });
});

describe('relativeTo / resolveFolder', () => {
  it('describes the root itself as "."', () => {
    assert.equal(relativeTo(posix, posix), '.');
    assert.equal(resolveFolder(posix, '.').toString(), posix.toString());
  });

  it('round-trips a folder inside the root', () => {
    const api = join(posix, 'services', 'api');
    const reference = relativeTo(posix, api);

    assert.equal(reference, 'services/api');
    assert.equal(resolveFolder(posix, reference).toString(), api.toString());
  });

  it('round-trips a folder outside the root', () => {
    const sibling = URI.file('/home/dev/other');
    const reference = relativeTo(posix, sibling);

    assert.equal(reference, '/home/dev/other');
    assert.equal(resolveFolder(posix, reference).toString(), sibling.toString());
  });

  // The folder dialog lets an agent run anywhere, so the absolute fallback is a
  // normal path rather than an edge case — and on Windows `relativeTo` writes
  // `fsPath`, which is a drive letter and backslashes.
  it('resolves a Windows path to a valid file uri', () => {
    const resolved = resolveFolder(windows, 'C:\\Users\\dev\\other');

    assert.equal(resolved.toString(), 'file:///c%3A/Users/dev/other');
    assert.ok(resolved.path.startsWith('/'), 'the path must start with a slash');
    assert.equal(resolved.authority, '');
  });

  // The regression: this used to go through `root.with({ path: 'C:/…' })`, and a
  // path with no leading slash is only tolerated when there is no authority. A
  // config written on a Windows machine and reopened over a remote threw.
  it('resolves a Windows path even when the root is on a remote', () => {
    const resolved = resolveFolder(remote, 'C:\\Users\\dev\\other');

    assert.equal(resolved.scheme, 'file', 'a drive letter is always a local path');
    assert.equal(resolved.authority, '');
  });

  it('keeps a remote folder on its remote', () => {
    const api = join(remote, 'api');
    const resolved = resolveFolder(remote, relativeTo(remote, api));

    assert.equal(resolved.toString(), api.toString());

    // Absolute references stay on the same host too, rather than becoming local.
    const elsewhere = resolveFolder(remote, '/srv/app');
    assert.equal(elsewhere.scheme, remote.scheme);
    assert.equal(elsewhere.authority, remote.authority);
    assert.equal(elsewhere.path, '/srv/app');
  });

  it('accepts a reference written with backslashes', () => {
    assert.equal(resolveFolder(posix, 'services\\api').path, '/home/dev/project/services/api');
  });
});

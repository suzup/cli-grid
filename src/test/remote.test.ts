// Must come first: it stands in for the `vscode` module the rest of these
// imports reach for.
import './vscode.js';

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';
import { keystrokes, newAgentId, newSocketPath, parseRequest, Remote, serve, type ListRequest, type Reply, type Request } from '../remote.js';

/** One request over a real socket, and the line that comes back. */
function ask(path: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let reply = '';
    const socket = net.connect(path, () => socket.write(line));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (reply += chunk));
    socket.on('end', () => resolve(reply));
    socket.on('error', reject);
  });
}

async function withServer(
  handle: (request: Request | ListRequest) => Promise<Reply>,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const path = join(mkdtempSync(join(tmpdir(), 'cli-grid-')), 's.sock');
  const server = serve(path, handle);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(path);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('remote input', () => {
  it('names agents so that two windows cannot collide', () => {
    assert.match(newAgentId(), /^[0-9a-f]{8}$/);
    assert.notEqual(newAgentId(), newAgentId());
  });

  it('listens on a socket file, or a named pipe on Windows', () => {
    assert.match(newSocketPath('linux', { XDG_RUNTIME_DIR: '/run/user/1' }, '/tmp'), /^\/run\/user\/1\/cli-grid-[0-9a-f]{12}\.sock$/);
    assert.match(newSocketPath('darwin', {}, '/tmp'), /^\/tmp\/cli-grid-[0-9a-f]{12}\.sock$/);
    assert.match(newSocketPath('win32', {}, 'C:\\Temp'), /^\\\\\.\\pipe\\cli-grid-[0-9a-f]{12}$/);
    assert.notEqual(newSocketPath('linux', {}, '/tmp'), newSocketPath('linux', {}, '/tmp'));
  });

  it('types one line as it is', () => {
    assert.equal(keystrokes('  go ahead \n'), 'go ahead');
  });

  it('pastes several lines so the newlines do not submit', () => {
    assert.equal(keystrokes('a\r\nb'), '\x1b[200~a\nb\x1b[201~');
  });

  it('drops escape characters and refuses empty text', () => {
    assert.equal(keystrokes('a\x1b[201~b\nc'), '\x1b[200~a[201~b\nc\x1b[201~');
    assert.equal(keystrokes(' \n '), undefined);
  });

  it('reads a request', () => {
    assert.deepEqual(parseRequest('{"agent":"ab12","text":"go"}'), { agent: 'ab12', text: 'go' });
    assert.deepEqual(parseRequest('{"agent":"ab12","text":"stop","now":true}'), { agent: 'ab12', text: 'stop', now: true });
    assert.deepEqual(parseRequest('{"agent":"ab12","text":"go","now":"yes"}'), { agent: 'ab12', text: 'go' });
    assert.deepEqual(parseRequest('{"list":true}'), { list: true });
  });

  it('refuses what is not a request', () => {
    for (const line of ['', 'go', '[]', 'null', '{"agent":"","text":"go"}', '{"agent":"a"}', '{"agent":1,"text":"go"}', '{"list":"yes"}'])
      assert.equal(parseRequest(line), undefined, line);
  });

  it('presses what makes a busy CLI read the message, only when asked to', async () => {
    const typed: Record<string, string[]> = {};
    const terminal = (agent: string, profile: string) => ({
      creationOptions: { env: { CLI_GRID_AGENT: agent, CLI_GRID_PROFILE: profile } },
      processId: Promise.resolve(undefined),
      sendText: (text: string) => (typed[agent] ??= []).push(text),
    });
    const window = vscode.window as unknown as { terminals: unknown[] };
    window.terminals = [terminal('aa', 'codex'), terminal('bb', 'gemini')];
    const remote = new Remote();
    try {
      assert.deepEqual(await remote.send('aa', 'go'), { ok: true });
      assert.deepEqual(typed.aa, ['go', '\r']);

      assert.equal(await remote.broadcast('stop'), 2);
      assert.deepEqual(typed.aa, ['go', '\r', 'stop', '\r', '\x1b']);
      assert.deepEqual(typed.bb, ['stop', '\r']);
    } finally {
      remote.dispose();
      window.terminals = [];
    }
  });

  it('answers a request with what the window did', async () => {
    const seen: (Request | ListRequest)[] = [];
    await withServer(
      (request) => {
        seen.push(request);
        if ('list' in request) return Promise.resolve({ ok: true, agents: [] });
        return Promise.resolve(request.agent === 'ab12' ? { ok: true } : { ok: false, error: 'no such agent' });
      },
      async (path) => {
        assert.deepEqual(JSON.parse(await ask(path, '{"agent":"ab12","text":"가\\n나"}\n')), { ok: true });
        assert.deepEqual(JSON.parse(await ask(path, '{"agent":"zz","text":"go"}\n')), { ok: false, error: 'no such agent' });
        assert.deepEqual(JSON.parse(await ask(path, '{"list":true}\n')), { ok: true, agents: [] });
      },
    );
    assert.deepEqual(seen[0], { agent: 'ab12', text: '가\n나' });
    assert.deepEqual(seen[2], { list: true });
  });

  it('lists the agents of the window with the folder each was opened in', async () => {
    const window = vscode.window as unknown as { terminals: unknown[] };
    window.terminals = [
      { creationOptions: { cwd: '/work/site', env: { CLI_GRID_AGENT: 'aa', CLI_GRID_PROFILE: 'claude' } }, processId: Promise.resolve(undefined) },
      { creationOptions: { cwd: { fsPath: '/work/api' }, env: { CLI_GRID_AGENT: 'bb', CLI_GRID_PROFILE: 'devin' } }, processId: Promise.resolve(undefined) },
      { creationOptions: { cwd: '/work/site' }, processId: Promise.resolve(undefined) },
    ];
    const remote = new Remote();
    try {
      assert.deepEqual(await remote.list(), {
        ok: true,
        agents: [
          { agent: 'aa', profile: 'claude', cwd: '/work/site', exited: false },
          { agent: 'bb', profile: 'devin', cwd: '/work/api', exited: false },
        ],
      });
    } finally {
      remote.dispose();
      window.terminals = [];
    }
  });

  it('answers a bad request without calling the window', async () => {
    await withServer(
      () => Promise.reject(new Error('not reached')),
      async (path) => {
        assert.deepEqual(JSON.parse(await ask(path, 'hello\n')), { ok: false, error: 'bad request' });
      },
    );
  });

  it('answers when the window fails', async () => {
    await withServer(
      () => Promise.reject(new Error('boom')),
      async (path) => {
        assert.deepEqual(JSON.parse(await ask(path, '{"agent":"a","text":"b"}\n')), { ok: false, error: 'failed' });
      },
    );
  });
});

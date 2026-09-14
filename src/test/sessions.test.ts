import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  endSessions,
  findVsCodeSessions,
  type ProcessHost,
  type ProcessRef,
  type RunningSession,
} from '../sessions.js';

type Signal = NodeJS.Signals;

type FakeProcess = {
  ppid: number;
  start: string;
  env: string[];
  cmdline: string;
  onSignal?: (signal: Signal) => void;
  ignore?: Set<Signal>;
};

class FakeHost implements ProcessHost {
  readonly processes = new Map<number, FakeProcess>();
  readonly kills: [number, Signal][] = [];
  readonly paths = new Map<string, string>();

  constructor(readonly files: string[] = []) {}

  add(
    pid: number,
    process: Partial<FakeProcess> & Pick<FakeProcess, 'ppid' | 'start'>,
  ): void {
    this.processes.set(pid, {
      ppid: process.ppid,
      start: process.start,
      env: process.env ?? [],
      cmdline: process.cmdline ?? '',
      onSignal: process.onSignal,
      ignore: process.ignore,
    });
  }

  async sessionFiles(): Promise<string[]> {
    return this.files;
  }

  async stat(pid: number): Promise<{ ppid: number; start: string } | undefined> {
    const process = this.processes.get(pid);
    return process && { ppid: process.ppid, start: process.start };
  }

  async environ(pid: number): Promise<string[]> {
    return this.processes.get(pid)?.env ?? [];
  }

  async cmdline(pid: number): Promise<string> {
    return this.processes.get(pid)?.cmdline ?? '';
  }

  async realpath(path: string): Promise<string> {
    return this.paths.get(path) ?? path;
  }

  kill(pid: number, signal: Signal): void {
    this.kills.push([pid, signal]);
    const process = this.processes.get(pid);
    if (!process || process.ignore?.has(signal)) return;

    process.onSignal?.(signal);
    if (signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGHUP') {
      this.processes.delete(pid);
    }
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2)));
  }
}

function record(pid: number, cwd = '/workspace/project', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ pid, cwd, procStart: `start-${pid}`, sessionId: `session-${pid}`, ...extra });
}

function session(pid: number, start = `start-${pid}`, shell?: ProcessRef): RunningSession {
  return { pid, start, sessionId: `session-${pid}`, ...(shell ? { shell } : {}) };
}

function assertSignals(host: FakeHost, expected: [number, Signal][]): void {
  assert.deepEqual(host.kills, expected);
}

describe('findVsCodeSessions', () => {
  it('matches live VS Code Claude processes and de-duplicates session files', async () => {
    const host = new FakeHost();
    host.paths.set('/workspace/link', '/workspace/project');
    host.paths.set('/workspace/project-alias', '/workspace/project');
    host.add(1101, { ppid: 1, start: 'start-1101', env: ['TERM_PROGRAM=vscode'], cmdline: 'claude' });
    host.add(1102, {
      ppid: 1,
      start: 'start-1102',
      env: ['VSCODE_IPC_HOOK_CLI=/tmp/vscode.sock'],
      cmdline: 'claude',
    });
    host.add(1103, { ppid: 1, start: 'start-1103', env: [], cmdline: 'claude' });

    const first = record(1101, '/workspace/project-alias');
    host.files.push(
      first,
      first,
      record(1102),
      record(1103, '/workspace/project', { entrypoint: 'claude-vscode' }),
    );

    const found = await findVsCodeSessions('/workspace/link', host);

    assert.deepEqual(
      found.map(({ pid, start, sessionId, shell }) => ({ pid, start, sessionId, shell })),
      [
        { pid: 1101, start: 'start-1101', sessionId: 'session-1101', shell: undefined },
        { pid: 1102, start: 'start-1102', sessionId: 'session-1102', shell: undefined },
        { pid: 1103, start: 'start-1103', sessionId: 'session-1103', shell: undefined },
      ],
    );
  });

  it('skips unrelated, dead, reused, malformed, and self processes', async () => {
    const host = new FakeHost();
    host.add(1201, { ppid: 1, start: 'start-1201', env: ['TERM_PROGRAM=vscode'] });
    host.add(1203, { ppid: 1, start: 'current-1203', env: ['TERM_PROGRAM=vscode'] });
    host.add(1204, { ppid: 1, start: 'start-1204', env: [] });
    host.add(process.pid, { ppid: 1, start: 'self', env: ['TERM_PROGRAM=vscode'] });

    host.files.push(
      record(1201, '/elsewhere'),
      record(1202),
      record(1203),
      record(1204),
      '{not json',
      JSON.stringify({ cwd: '/workspace/project', procStart: 'start-1206' }),
      JSON.stringify({ pid: 1206.5, cwd: '/workspace/project', procStart: 'start-1206' }),
      record(process.pid, '/workspace/project', { entrypoint: 'claude-vscode' }),
    );

    assert.deepEqual(await findVsCodeSessions('/workspace/project', host), []);
  });

  it('finds the shell directly below a pty host through wrapper processes', async () => {
    const host = new FakeHost([
      record(1301),
    ]);
    host.add(1304, { ppid: 1, start: 'pty', cmdline: 'code --type=ptyHost' });
    host.add(1303, { ppid: 1304, start: 'bash', cmdline: 'bash -i' });
    host.add(1302, { ppid: 1303, start: 'mux', cmdline: 'claude-mux' });
    host.add(1301, { ppid: 1302, start: 'start-1301', env: ['TERM_PROGRAM=vscode'], cmdline: 'claude' });

    const found = await findVsCodeSessions('/workspace/project', host);

    assert.deepEqual(found, [
      {
        pid: 1301,
        start: 'start-1301',
        sessionId: 'session-1301',
        shell: { pid: 1303, start: 'bash' },
      },
    ]);
  });

  it('does not report a shell for a direct pty child, extension host, or orphan', async () => {
    const host = new FakeHost([
      record(1401),
      record(1403),
      record(1405),
    ]);
    host.add(1402, { ppid: 1, start: 'pty-1', cmdline: 'code --type=ptyHost' });
    host.add(1401, { ppid: 1402, start: 'start-1401', env: ['TERM_PROGRAM=vscode'] });
    host.add(1404, { ppid: 1, start: 'extension', cmdline: 'code --type=extensionHost' });
    host.add(1403, { ppid: 1404, start: 'start-1403', env: ['TERM_PROGRAM=vscode'] });
    host.add(1405, { ppid: 1, start: 'start-1405', env: ['TERM_PROGRAM=vscode'] });

    const found = await findVsCodeSessions('/workspace/project', host);

    assert.deepEqual(found, [
      { pid: 1401, start: 'start-1401', sessionId: 'session-1401' },
      { pid: 1403, start: 'start-1403', sessionId: 'session-1403' },
      { pid: 1405, start: 'start-1405', sessionId: 'session-1405' },
    ]);
  });
});

describe('endSessions', () => {
  it('terminates Claude before its shell and sends nothing else', async () => {
    const host = new FakeHost();
    host.add(2001, { ppid: 1, start: 'claude' });
    host.add(2002, { ppid: 1, start: 'shell' });

    await endSessions([session(2001, 'claude', { pid: 2002, start: 'shell' })], host, {
      graceMs: 30,
      pollMs: 2,
    });

    assertSignals(host, [
      [2001, 'SIGTERM'],
      [2002, 'SIGHUP'],
    ]);
  });

  it('escalates Claude to SIGKILL when it ignores SIGTERM', async () => {
    const host = new FakeHost();
    host.add(2101, { ppid: 1, start: 'claude', ignore: new Set(['SIGTERM']) });

    await endSessions([session(2101, 'claude')], host, { graceMs: 30, pollMs: 2 });

    assertSignals(host, [
      [2101, 'SIGTERM'],
      [2101, 'SIGKILL'],
    ]);
  });

  it('escalates a shell to SIGKILL when it ignores SIGHUP', async () => {
    const host = new FakeHost();
    host.add(2201, { ppid: 1, start: 'claude' });
    host.add(2202, { ppid: 1, start: 'shell', ignore: new Set(['SIGHUP']) });

    await endSessions([session(2201, 'claude', { pid: 2202, start: 'shell' })], host, {
      graceMs: 30,
      pollMs: 2,
    });

    assertSignals(host, [
      [2201, 'SIGTERM'],
      [2202, 'SIGHUP'],
      [2202, 'SIGKILL'],
    ]);
  });

  it('does not signal a pid whose start time no longer matches', async () => {
    const host = new FakeHost();
    host.add(2301, { ppid: 1, start: 'new-process' });

    await endSessions([session(2301, 'old-process')], host, { graceMs: 30, pollMs: 2 });

    assertSignals(host, []);
  });

  it('signals only Claude when there is no shell', async () => {
    const host = new FakeHost();
    host.add(2401, { ppid: 1, start: 'claude' });

    await endSessions([session(2401, 'claude')], host, { graceMs: 30, pollMs: 2 });

    assertSignals(host, [[2401, 'SIGTERM']]);
  });

  it('ends every session in the input', async () => {
    const host = new FakeHost();
    host.add(2501, { ppid: 1, start: 'claude-1' });
    host.add(2502, { ppid: 1, start: 'claude-2' });
    host.add(2503, { ppid: 1, start: 'claude-3' });

    await endSessions(
      [session(2501, 'claude-1'), session(2502, 'claude-2'), session(2503, 'claude-3')],
      host,
      { graceMs: 30, pollMs: 2 },
    );

    assert.deepEqual(
      host.kills.sort(([left], [right]) => left - right),
      [
        [2501, 'SIGTERM'],
        [2502, 'SIGTERM'],
        [2503, 'SIGTERM'],
      ],
    );
  });
});

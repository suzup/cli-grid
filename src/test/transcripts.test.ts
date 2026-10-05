import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { recentTranscripts } from '../transcripts.js';

/**
 * opencode's conversations, which are rows in a database rather than files: the
 * folder each ran in is a column, and each piece of a message is JSON.
 */
let dataHome: string;
let saved: string | undefined;

before(async () => {
  dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-grid-opencode-'));
  saved = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;

  await fs.mkdir(path.join(dataHome, 'opencode'));
  const db = new DatabaseSync(path.join(dataHome, 'opencode', 'opencode.db'));
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL);
  `);
  const session = db.prepare('INSERT INTO session VALUES (?, ?, ?)');
  session.run('older', '/work/api', 1);
  session.run('newer', '/work/api', 2);
  session.run('elsewhere', '/work/web', 3);
  const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)');
  const said = (text: string) => JSON.stringify({ type: 'text', text });
  part.run('a1', 'older', 10, said('Wrote /work/api/out/old.png'));
  part.run('b1', 'newer', 20, said('Rendered:\n/work/api/out/look.png'));
  part.run('b2', 'newer', 21, said('and /work/api/out/back.png'));
  part.run('c1', 'elsewhere', 30, said('/work/web/out/other.png'));
  db.close();
});

after(async () => {
  if (saved === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = saved;
  await fs.rm(dataHome, { recursive: true, force: true });
});

describe('what opencode wrote down', () => {
  it("reads the folder's conversations, the latest first, in the order they were said", async () => {
    const texts = await recentTranscripts('opencode', '/work/api');
    assert.equal(texts.length, 2);
    assert.match(texts[0] ?? '', /look\.png[\s\S]*back\.png/);
    assert.match(texts[1] ?? '', /old\.png/);
    assert.ok(!texts.join('').includes('other.png'));
  });

  it('reads a line break as a break, not as the letter n before the path', async () => {
    const [text = ''] = await recentTranscripts('opencode', '/work/api');
    assert.ok(text.includes('/work/api/out/look.png'));
    assert.ok(!text.includes('n/work/api/out/look.png'));
  });

  it('has nothing for a folder it never ran in, or with no database at all', async () => {
    assert.deepEqual(await recentTranscripts('opencode', '/work/none'), []);
    process.env.XDG_DATA_HOME = path.join(dataHome, 'missing');
    try {
      assert.deepEqual(await recentTranscripts('opencode', '/work/api'), []);
    } finally {
      process.env.XDG_DATA_HOME = dataHome;
    }
  });
});

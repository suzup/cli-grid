// Must come first: it stands in for the `vscode` module the rest of these
// imports reach for.
import './vscode.js';

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULTS, SECTION } from '../config.js';
import { LAYOUT_PRESETS } from '../layout.js';

/**
 * The manifest says things the source also says, and nothing in the compiler
 * connects the two. Every check here is a drift that would otherwise be found
 * by a user: a setting whose default is not the one it behaves like, a menu
 * pointing at a command that does not exist, a string that renders as its own
 * placeholder.
 */

// Compiled to `out/test`, so the repository is two levels up.
const root = path.resolve(__dirname, '../..');
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

const manifest = read('package.json');
const nls: Record<string, string> = read('package.nls.json');
const nlsKo: Record<string, string> = read('package.nls.ko.json');
const bundleKo: Record<string, string> = read('l10n/bundle.l10n.ko.json');

const settings: Record<string, { default?: unknown }> = Object.fromEntries(
  (Array.isArray(manifest.contributes.configuration)
    ? manifest.contributes.configuration
    : [manifest.contributes.configuration]
  ).flatMap((block: { properties: object }) => Object.entries(block.properties)),
);

describe('settings', () => {
  it('declares every setting the code reads, with the same default', () => {
    for (const [name, value] of Object.entries(DEFAULTS)) {
      const declared = settings[`${SECTION}.${name}`];
      assert.ok(declared, `${SECTION}.${name} is read in the code but not in the manifest`);
      assert.deepEqual(declared.default, value, `${SECTION}.${name} default`);
    }
  });

  it('reads every setting it declares', () => {
    const known = new Set([...Object.keys(DEFAULTS), 'profiles']);
    for (const name of Object.keys(settings)) {
      const short = name.slice(SECTION.length + 1);
      assert.ok(known.has(short), `${name} is offered to users but never read`);
    }
  });
});

describe('commands', () => {
  const declared = new Set<string>(
    manifest.contributes.commands.map((c: { command: string }) => c.command),
  );

  it('gives every command a title', () => {
    for (const command of manifest.contributes.commands) {
      assert.ok(command.title, `${command.command} has no title`);
    }
  });

  it('only puts declared commands in menus', () => {
    const menus: Record<string, { command?: string }[]> = manifest.contributes.menus ?? {};
    for (const [where, items] of Object.entries(menus)) {
      for (const item of items) {
        if (!item.command) continue;
        assert.ok(declared.has(item.command), `${where} shows undeclared ${item.command}`);
      }
    }
  });

  it('only binds keys to declared commands', () => {
    for (const binding of manifest.contributes.keybindings ?? []) {
      assert.ok(declared.has(binding.command), `a keybinding runs undeclared ${binding.command}`);
    }
  });
});

describe('manifest strings', () => {
  // `%key%` in the manifest is resolved from package.nls.json at load time; a
  // missing key renders as the literal `%key%` in the UI.
  const placeholders = [...JSON.stringify(manifest).matchAll(/%([\w.]+)%/g)].map((m) => m[1]!);

  it('resolves every placeholder', () => {
    for (const key of new Set(placeholders)) {
      assert.ok(key in nls, `%${key}% has no entry in package.nls.json`);
    }
  });

  it('translates every one of them', () => {
    for (const key of Object.keys(nls)) {
      assert.ok(key in nlsKo, `${key} is missing from package.nls.ko.json`);
    }
  });

  it('has no entry nothing refers to', () => {
    const used = new Set(placeholders);
    for (const key of Object.keys(nls)) {
      assert.ok(used.has(key), `${key} is translated but never used`);
    }
  });
});

describe('runtime strings', () => {
  // `l10n.t()` looks its argument up in the bundle by the English text itself,
  // so a key that does not match exactly silently falls back to English.
  const source = readdirSync(path.join(root, 'src'))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => readFileSync(path.join(root, 'src', file), 'utf8'))
    .join('\n');

  const used = new Set([
    ...[...source.matchAll(/l10n\.t\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) =>
      m[2]!.replace(/\\(['"])/g, '$1'),
    ),
    // The presets are data, so their descriptions reach `t` as a variable and
    // no literal appears at the call site. They are still keys in the bundle.
    ...LAYOUT_PRESETS.map((preset) => preset.detail),
  ]);

  it('translates every string the code shows', () => {
    for (const message of used) {
      assert.ok(message in bundleKo, `not in the ko bundle: ${message}`);
    }
  });

  it('has no translation nothing shows', () => {
    for (const key of Object.keys(bundleKo)) {
      assert.ok(used.has(key), `translated but never shown: ${key}`);
    }
  });
});

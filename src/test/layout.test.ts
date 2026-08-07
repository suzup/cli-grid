import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUTO_LAYOUT,
  FILE_PANE_SIZE,
  LAYOUT_PRESETS,
  autoPreset,
  columnFor,
  paneCount,
  presetById,
  resolveLayout,
  rowsOf,
  toSpec,
} from '../layout.js';

const grid2x2 = presetById('grid-2x2')!;

describe('presets', () => {
  it('counts panes across every row', () => {
    assert.equal(paneCount(grid2x2), 4);
    assert.equal(paneCount(presetById('grid-4x2')!), 8);
  });

  it('is ordered smallest first, which autoPreset relies on', () => {
    const counts = LAYOUT_PRESETS.map(paneCount);
    assert.deepEqual(counts, [...counts].sort((a, b) => a - b));
  });
});

describe('autoPreset', () => {
  it('takes the smallest split that gives every agent a pane', () => {
    assert.equal(autoPreset(1).id, 'single');
    assert.equal(autoPreset(2).id, 'grid-2x1');
    assert.equal(autoPreset(4).id, 'grid-2x2');
    assert.equal(autoPreset(5).id, 'grid-3x2');
  });

  it('never returns nothing for a silly count', () => {
    assert.equal(autoPreset(0).id, 'single');
    // More agents than panes is allowed — they wrap into tabs.
    assert.equal(autoPreset(99).id, 'grid-4x2');
  });
});

describe('resolveLayout', () => {
  it('follows the agent count only for the auto sentinel', () => {
    assert.equal(resolveLayout(AUTO_LAYOUT, 4)?.id, 'grid-2x2');
    assert.equal(resolveLayout('single', 4)?.id, 'single');
  });

  it('has no opinion when nothing is configured or the id is unknown', () => {
    assert.equal(resolveLayout(undefined, 4), undefined);
    assert.equal(resolveLayout('grid-9x9', 4), undefined);
  });
});

describe('columnFor', () => {
  it('wraps once there are more agents than panes', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => columnFor(i, grid2x2)), [1, 2, 3, 4, 1]);
  });

  it('falls back to the first group with no preset', () => {
    assert.equal(columnFor(3, undefined), 1);
  });
});

describe('toSpec', () => {
  it('splits into rows at the top level, then columns inside them', () => {
    assert.deepEqual(toSpec(grid2x2, false), {
      orientation: 0,
      groups: [
        { size: 0.5, groups: [{ size: 0.5 }, { size: 0.5 }] },
        { size: 0.5, groups: [{ size: 0.5 }, { size: 0.5 }] },
      ],
    });
  });

  it('wraps the grid in a column split when the file pane is up', () => {
    const spec = toSpec(grid2x2, true);

    // Orientation flips: the outer split is now columns, so the grid's own rows
    // still come out as rows one level down.
    assert.equal(spec.orientation, 1);
    assert.equal(spec.groups.length, 2);
    assert.deepEqual(spec.groups[0]?.groups, rowsOf(grid2x2));
    assert.equal(spec.groups[1]?.size, FILE_PANE_SIZE);
    assert.equal(spec.groups[1]?.groups, undefined, 'the file pane is a single group');
  });

  it('leaves the file pane last, which is how the grid finds it again', () => {
    const spec = toSpec(presetById('grid-3x2')!, true);
    assert.equal(spec.groups.at(-1)?.size, FILE_PANE_SIZE);
  });

  it('gives every pane an equal share of its row', () => {
    for (const preset of LAYOUT_PRESETS) {
      const rows = rowsOf(preset);
      const total = rows.reduce((sum, row) => sum + (row.size ?? 0), 0);
      assert.equal(Math.round(total * 1000) / 1000, 1, `${preset.id} rows fill the height`);

      for (const row of rows) {
        const width = row.groups?.reduce((sum, group) => sum + (group.size ?? 0), 0) ?? 0;
        assert.equal(Math.round(width * 1000) / 1000, 1, `${preset.id} columns fill the row`);
      }
    }
  });
});

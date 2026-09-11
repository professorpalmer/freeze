'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app.js');

test('freezeAllShortestPaths: two equal-length routes', () => {
  const nodes = [
    { id: 'josh', name: 'Josh Freese' },
    { id: 'johnny', name: 'Johnny Health' },
    { id: 'trent', name: 'Trent Reznor' },
    { id: 'dylan', name: 'Dylan Brady (100 gecs)' },
  ];
  const edges = [
    { id: 'e1', from: 'johnny', to: 'trent' },
    { id: 'e2', from: 'trent', to: 'josh' },
    { id: 'e3', from: 'johnny', to: 'dylan' },
    { id: 'e4', from: 'dylan', to: 'josh' },
  ];
  const model = app.freezeGraphModel(nodes, edges);
  const paths = app.freezeAllShortestPaths(model, model.byId.get('johnny'), model.byId.get('josh'));
  assert.equal(paths.length, 2);
  assert.ok(paths.every((path) => path.disconnected === false));
  assert.ok(paths.every((path) => path.nodes.length === 3));
  const lines = paths.map((path) => path.nodes.map((n) => n.name).join(' → '));
  assert.ok(lines.includes('Johnny Health → Trent Reznor → Josh Freese'));
  assert.ok(lines.includes('Johnny Health → Dylan Brady (100 gecs) → Josh Freese'));
});

test('freezeLowAccessNodes: excludes Josh and high-degree notes', () => {
  const nodes = [
    { id: 'josh', name: 'Josh Freese' },
    { id: 'a', name: 'Low One' },
    { id: 'b', name: 'Low Two' },
    { id: 'c', name: 'Busy' },
  ];
  const edges = [
    { from: 'josh', to: 'a' },
    { from: 'josh', to: 'b' },
    { from: 'josh', to: 'c' },
    { from: 'c', to: 'a' },
    { from: 'c', to: 'b' },
    { from: 'c', to: 'extra1' },
  ];
  nodes.push({ id: 'extra1', name: 'Extra One' });
  nodes.push({ id: 'extra2', name: 'Extra Two' });
  nodes.push({ id: 'extra3', name: 'Extra Three' });
  nodes.push({ id: 'extra4', name: 'Extra Four' });
  edges.push({ from: 'c', to: 'extra2' });
  edges.push({ from: 'c', to: 'extra3' });
  edges.push({ from: 'c', to: 'extra4' });
  const model = app.freezeGraphModel(nodes, edges);
  const lows = app.freezeLowAccessNodes(model, app.FREESE_LOOSE_END_DEGREE);
  const ids = lows.map((row) => row.id);
  assert.ok(!ids.includes('josh'));
  assert.ok(!ids.includes('c'));
  assert.ok(ids.includes('a'));
  assert.ok(ids.includes('extra1'));
  assert.equal(app.FREESE_LOOSE_END_DEGREE, 5);
});

test('freezeAutoSortLayout: Josh at 0,0 and farther hops sit outside', () => {
  const nodes = [
    { id: 'josh', name: 'Josh Freese', w: 80, h: 40 },
    { id: 'kid', name: 'Travis Barker', w: 90, h: 28 },
    { id: 'outer', name: 'Outer Note', w: 80, h: 28 },
  ];
  const edges = [
    { id: 'e1', from: 'josh', to: 'kid' },
    { id: 'e2', from: 'kid', to: 'outer' },
  ];
  const result = app.freezeAutoSortLayout(nodes, edges, 'josh');
  const origin = result.positions.get('josh');
  const child = result.positions.get('kid');
  const outer = result.positions.get('outer');
  assert.ok(origin);
  assert.ok(child);
  assert.ok(outer);
  assert.equal(origin.x, 0);
  assert.equal(origin.y, 0);
  const r1 = Math.hypot(child.x, child.y);
  const r2 = Math.hypot(outer.x, outer.y);
  const hop1 = app.FREESE_RING_BASE + app.FREESE_RING_STEP;
  assert.ok(r1 >= hop1 - 1, `hop-1 radius ${r1} should be >= ${hop1}`);
  assert.ok(r2 > r1, `hop-2 radius ${r2} should be outside hop-1 ${r1}`);
});

test('freezeAutoSortLayout: hop-1 siblings share one ring', () => {
  const nodes = [{ id: 'josh', name: 'Josh Freese', w: 80, h: 40 }];
  const edges = [];
  for (let i = 0; i < 30; i += 1) {
    const id = `n${String(i).padStart(2, '0')}`;
    nodes.push({ id, name: `Note ${id}`, w: 80, h: 28 });
    edges.push({ from: 'josh', to: id });
  }
  const result = app.freezeAutoSortLayout(nodes, edges, 'josh');
  const hop1 = app.FREESE_RING_BASE + app.FREESE_RING_STEP;
  for (let i = 0; i < 30; i += 1) {
    const id = `n${String(i).padStart(2, '0')}`;
    const point = result.positions.get(id);
    const r = Math.hypot(point.x, point.y);
    assert.ok(Math.abs(r - hop1) < 1, `${id} radius ${r} should be ${hop1}`);
  }
  assert.equal(result.positions.get('josh').x, 0);
  assert.equal(result.positions.get('josh').y, 0);
});

test('freezeBoardSnapshot copies world so later mutation does not leak', () => {
  const world = { w: 1000, h: 800 };
  const snap = app.freezeBoardSnapshot({ nodes: [], edges: [] }, null, null, null, world);
  world.w = 99999;
  assert.equal(snap.world.w, 1000);
  assert.equal(snap.world.h, 800);
  assert.notEqual(snap.world, world);
});

test('freezeCameraLooksAtNotes rejects an origin shot of a far Trad cluster', () => {
  const nodes = [{ id: 'josh', name: 'Josh Freese', cx: 17600, cy: 20100 }];
  const viewport = { w: 1600, h: 900 };
  const originCam = { tx: 800, ty: 450, scale: 0.7 };
  const onJosh = { tx: 800 - 17600 * 0.7, ty: 450 - 20100 * 0.7, scale: 0.7 };
  assert.equal(app.freezeCameraLooksAtNotes(originCam, nodes, viewport), false);
  assert.equal(app.freezeCameraLooksAtNotes(onJosh, nodes, viewport), true);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app.js');

test('freezeNodeClearance: Josh hub is 200', () => {
  assert.equal(app.freezeNodeClearance(0, 80), 200);
  assert.equal(app.freezeNodeClearance(0, 0), 200);
});

test('freezeNodeClearance: travis-like hops=1 deg=48 is 186', () => {
  assert.equal(app.freezeNodeClearance(1, 48), 186);
});

test('freezeNodeClearance: floor 36 and cap 200', () => {
  assert.equal(app.freezeNodeClearance(10, 0), 36);
  assert.equal(app.freezeNodeClearance(1, 120), 200);
});

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

test('freezeAutoSortLayout: Josh at 0,0 and child sits past clearance sum', () => {
  const nodes = [
    { id: 'josh', name: 'Josh Freese', w: 80, h: 40 },
    { id: 'kid', name: 'Travis Barker', w: 90, h: 28 },
  ];
  const edges = [{ id: 'e', from: 'josh', to: 'kid' }];
  const result = app.freezeAutoSortLayout(nodes, edges, 'josh');
  const origin = result.positions.get('josh');
  const child = result.positions.get('kid');
  assert.ok(origin);
  assert.ok(child);
  assert.equal(result.origin.x, 0);
  assert.equal(result.origin.y, 0);
  assert.equal(origin.x, 0);
  assert.equal(origin.y, 0);
  const need = app.freezeNodeClearance(0, 1) + app.freezeNodeClearance(1, 1);
  const dist = Math.hypot(child.x - origin.x, child.y - origin.y);
  assert.ok(dist >= need - 1, `child distance ${dist} should be >= ${need - 1}`);
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

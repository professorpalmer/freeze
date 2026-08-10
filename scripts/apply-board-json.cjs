#!/usr/bin/env node
/**
 * Apply a Freese Index local-board-snapshot JSON to board-data.js.
 * Preserves Traditionology layout (world + x/y) — does not re-pad.
 *
 * Usage:
 *   node scripts/apply-board-json.cjs path/to/freese-index-board.json
 *   cat board.json | node scripts/apply-board-json.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'board-data.js');

function readInput(argv) {
  const file = argv[2];
  if (file && file !== '-') {
    return fs.readFileSync(path.resolve(file), 'utf8');
  }
  return fs.readFileSync(0, 'utf8');
}

function scrubBlurb(blurb) {
  const text = String(blurb || '');
  if (/redstring/i.test(text)) return '';
  return text;
}

function normalizeNode(node) {
  const name = String(node.name || node.text || 'Untitled').replace(/\s+/g, ' ').trim() || 'Untitled';
  const isJosh = /^josh\s+freese$/i.test(name);
  return {
    id: String(node.id),
    type: node.type || node.rsColor || 'yellow',
    name,
    role: node.role || (isJosh
      ? 'Drummer · composer · first-call session player'
      : 'Subject on the Freese Index board'),
    blurb: scrubBlurb(node.blurb),
    x: Number(node.x),
    y: Number(node.y),
    tilt: typeof node.tilt === 'number' ? node.tilt : undefined,
    big: node.big || isJosh || undefined,
    paper: node.paper || undefined,
    pin: node.pin || undefined,
    attachments: Array.isArray(node.attachments) ? node.attachments : [],
  };
}

function normalizeEdge(edge, i) {
  return {
    id: String(edge.id || `e${i}`),
    from: edge.from || edge.source,
    to: edge.to || edge.target,
    label: String(edge.label || 'connected').trim() || 'connected',
    tier: edge.tier || 'related',
    strength: edge.strength || 'medium',
    evidence: edge.evidence || undefined,
  };
}

function contentWorld(nodes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const w = 180;
    const h = 120;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + w);
    maxY = Math.max(maxY, n.y + h);
  }
  const pad = 240;
  return {
    w: Math.max(1200, Math.ceil(maxX - minX + pad * 2)),
    h: Math.max(900, Math.ceil(maxY - minY + pad * 2)),
    // keep absolute coords — do not translate
  };
}

function validate(snap) {
  if (!snap || typeof snap !== 'object') throw new Error('Board JSON must be an object');
  if (!Array.isArray(snap.nodes) || snap.nodes.length < 100) {
    throw new Error('Board needs at least 100 nodes');
  }
  if (!Array.isArray(snap.edges)) throw new Error('Board needs an edges array');
  const hasJosh = snap.nodes.some((n) => /^josh\s+freese$/i.test(String(n.name || '')));
  if (!hasJosh) throw new Error('Board must include a Josh Freese note');
}

function toBoardData(snap) {
  validate(snap);
  const nodes = snap.nodes.map(normalizeNode).filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
  if (nodes.length < 100) throw new Error('Too few nodes with valid positions');
  const edges = snap.edges.map(normalizeEdge).filter((e) => e.from && e.to);
  const josh = nodes.find((n) => /^josh\s+freese$/i.test(n.name));
  const worldIn = snap.world && typeof snap.world === 'object' ? snap.world : null;
  // Prefer author world when sane; otherwise derive from content AABB (no 16k pad).
  let world;
  if (worldIn && Number(worldIn.w) > 0 && Number(worldIn.h) > 0 && Number(worldIn.w) < 20000 && Number(worldIn.h) < 20000) {
    world = { w: Math.ceil(Number(worldIn.w)), h: Math.ceil(Number(worldIn.h)) };
  } else {
    // Huge local cork (50k+) — keep note positions but shrink declared world to content + modest pad
    // by translating cluster to origin.
    let minX = Infinity;
    let minY = Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
    }
    const pad = 400;
    for (const n of nodes) {
      n.x = Math.round((n.x - minX + pad) * 10) / 10;
      n.y = Math.round((n.y - minY + pad) * 10) / 10;
    }
    world = contentWorld(nodes);
    world.w = Math.ceil(world.w);
    world.h = Math.ceil(world.h);
  }

  return {
    source: {
      name: 'FREESE INDEX',
      importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      nodeCount: nodes.length,
      edgeCount: edges.length,
      origin: 'traditionology-local-snapshot',
      savedAt: snap.meta && snap.meta.savedAt ? snap.meta.savedAt : undefined,
    },
    world,
    joshId: (josh && josh.id) || snap.joshId || null,
    nodes,
    edges,
  };
}

function main() {
  const raw = readInput(process.argv);
  const snap = JSON.parse(raw);
  // Accept either local snapshot or already-shaped FREESE_BOARD
  const board = snap.nodes && snap.meta && snap.meta.kind === 'local-board-snapshot'
    ? toBoardData(snap)
    : toBoardData({
      meta: snap.meta || { kind: 'local-board-snapshot' },
      world: snap.world,
      joshId: snap.joshId,
      nodes: snap.nodes,
      edges: snap.edges,
    });

  const body = JSON.stringify(board);
  const header = '/* Auto-generated Freese Index board snapshot. Apply via scripts/apply-board-json.cjs. */\n';
  fs.writeFileSync(OUT, `${header}window.FREESE_BOARD = ${body};\n`, 'utf8');
  process.stdout.write(
    `Wrote board-data.js (${board.nodes.length} nodes, ${board.edges.length} edges, world ${board.world.w}x${board.world.h})\n`
  );
}

main();

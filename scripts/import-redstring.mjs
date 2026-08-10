#!/usr/bin/env node
/**
 * Re-import Traditionology's public RedString Freese Index board into board-data.js.
 * Runtime stays offline — this script is the only network fetch.
 *
 * Usage: node scripts/import-redstring.mjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BOARD_ID = 'a6fae60e-3c24-4bde-95f0-d7ece7d9e654';
const API = `https://www.redstringhq.com/api/boards/${BOARD_ID}`;
const ROOT = path.resolve(__dirname, '..');

const COLOR_TYPE = {
  pink: 'pink',
  yellow: 'yellow',
  green: 'green',
  blue: 'blue',
};

function tidyName(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'Untitled';
  return raw.replace(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g, (word) => {
    if (word.length <= 3 && word === word.toUpperCase()) return word.toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

async function main() {
  const res = await fetch(API);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const raw = await res.json();
  const board = raw.board || raw;
  const nodesIn = typeof board.nodes_json === 'string' ? JSON.parse(board.nodes_json) : board.nodes_json;
  const edgesIn = typeof board.edges_json === 'string' ? JSON.parse(board.edges_json) : board.edges_json;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodesIn) {
    const w = (n.measured && n.measured.width) || 180;
    const h = (n.measured && n.measured.height) || 120;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }

  const pad = 3600;
  const srcW = Math.max(1, maxX - minX);
  const srcH = Math.max(1, maxY - minY);
  // Keep the imported cluster compact; open cork around it comes from pad (not from stretching notes).
  const scale = Math.min(1.15, Math.min((5200) / srcW, (4000) / srcH));
  const mapX = (x) => (x - minX) * scale + pad;
  const mapY = (y) => (y - minY) * scale + pad;

  const nodes = nodesIn.map((n) => {
    const color = (n.data && n.data.color) || 'yellow';
    const type = COLOR_TYPE[color] || 'yellow';
    const rawText = String((n.data && n.data.text) || '');
    const isJosh = /^josh\s+freese$/i.test(rawText.replace(/\s+/g, ' ').trim());
    return {
      id: n.id,
      type,
      name: tidyName(rawText),
      role: isJosh ? 'Drummer · composer · first-call session player' : 'Subject on the Freese Index board',
      blurb: isJosh
        ? 'American drummer whose career threads through punk, new wave, industrial, and arena rock — the hub of this board.'
        : `Imported from Traditionology's public RedString Freese Index board (${color} note).`,
      x: Math.round(mapX(n.position.x) * 10) / 10,
      y: Math.round(mapY(n.position.y) * 10) / 10,
      tilt: typeof n.data?.rotation === 'number' ? Math.max(-8, Math.min(8, n.data.rotation)) : undefined,
      big: isJosh || undefined,
      rsColor: color,
    };
  });

  const josh = nodes.find((n) => /^josh freese$/i.test(n.name));
  const joshId = josh ? josh.id : null;

  const edges = edgesIn.map((e, i) => {
    const label = tidyName((e.data && e.data.label) || '') || 'connected';
    const touches = joshId && (e.source === joshId || e.target === joshId);
    return {
      id: e.id || `e${i}`,
      from: e.source,
      to: e.target,
      label,
      tier: touches ? 'core' : 'related',
      strength: touches ? 'high' : 'medium',
    };
  });

  const world = {
    w: Math.ceil(pad * 2 + srcW * scale),
    h: Math.ceil(pad * 2 + srcH * scale),
  };

  const payload = {
    source: {
      name: board.name || 'FREESE INDEX',
      url: `https://www.redstringhq.com/board/${BOARD_ID}`,
      importedAt: new Date().toISOString(),
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
    world,
    joshId,
    nodes,
    edges,
  };

  const out = path.join(ROOT, 'board-data.js');
  fs.writeFileSync(
    out,
    `/* Auto-generated from public RedString board snapshot. Do not edit by hand — re-run scripts/import-redstring.mjs */\n` +
      `window.FREESE_BOARD = ${JSON.stringify(payload)};\n`
  );
  fs.writeFileSync(
    path.join(ROOT, 'scripts/redstring-snapshot.json'),
    JSON.stringify(
      {
        boardId: BOARD_ID,
        url: payload.source.url,
        fetchedAt: payload.source.importedAt,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        world,
      },
      null,
      2
    ) + '\n'
  );
  console.log(`Wrote ${nodes.length} nodes / ${edges.length} edges → ${path.relative(ROOT, out)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

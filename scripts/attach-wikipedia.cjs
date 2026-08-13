#!/usr/bin/env node
/**
 * Attach Wikipedia URLs onto Freese Index notes via the public search API.
 * Does not invent pages: only writes when the top result title is a close match.
 *
 * Dry run (default):
 *   node scripts/attach-wikipedia.cjs
 *
 * Apply to board-data.js:
 *   node scripts/attach-wikipedia.cjs --write
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const BOARD_FILE = path.join(ROOT, 'board-data.js');
const WRITE = process.argv.includes('--write');
const DELAY_MS = 120;

function loadBoard() {
  const src = fs.readFileSync(BOARD_FILE, 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const board = sandbox.window.FREESE_BOARD || sandbox.FREESE_BOARD;
  if (!board || !Array.isArray(board.nodes)) throw new Error('board-data.js did not expose FREESE_BOARD');
  return { src, board };
}

function tidy(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function closeMatch(noteName, resultTitle) {
  const a = tidy(noteName);
  const b = tidy(resultTitle);
  if (!a || !b) return false;
  if (a === b) return true;
  if (b.startsWith(a + ' ') || a.startsWith(b + ' ')) return true;
  return false;
}

function hasWikipedia(node) {
  const attachments = Array.isArray(node.attachments) ? node.attachments : [];
  return attachments.some((a) => /wikipedia\.org/i.test(String((a && a.url) || '')));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchWikipedia(name) {
  const url = 'https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&namespace=0&format=json&search=' +
    encodeURIComponent(name);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'FreeseIndex/1.0 (board wiki attach; professorpalmer/freeze)' },
  });
  if (!res.ok) throw new Error(`Wikipedia ${res.status} for ${name}`);
  const data = await res.json();
  const title = data && data[1] && data[1][0];
  const pageUrl = data && data[3] && data[3][0];
  return { title: title || '', url: pageUrl || '' };
}

async function main() {
  const { board } = loadBoard();
  const matched = [];
  const skipped = [];
  let checked = 0;

  for (const node of board.nodes) {
    const name = String(node.name || '').trim();
    if (!name || /^untitled$/i.test(name)) {
      skipped.push({ name, reason: 'empty' });
      continue;
    }
    if (hasWikipedia(node)) {
      skipped.push({ name, reason: 'already-attached' });
      continue;
    }
    checked += 1;
    let hit;
    try {
      hit = await searchWikipedia(name);
    } catch (err) {
      skipped.push({ name, reason: String(err.message || err) });
      continue;
    }
    if (hit.url && closeMatch(name, hit.title)) {
      matched.push({ id: node.id, name, title: hit.title, url: hit.url });
      if (WRITE) {
        if (!Array.isArray(node.attachments)) node.attachments = [];
        node.attachments.push({ label: 'Wikipedia', url: hit.url });
      }
    } else {
      skipped.push({ name, reason: hit.title ? `no-match:${hit.title}` : 'no-result' });
    }
    await sleep(DELAY_MS);
  }

  if (WRITE && matched.length) {
    const header = '/* Auto-generated Freese Index board snapshot. Apply via scripts/apply-board-json.cjs. */\n';
    fs.writeFileSync(BOARD_FILE, `${header}window.FREESE_BOARD = ${JSON.stringify(board)};\n`, 'utf8');
  }

  process.stdout.write(JSON.stringify({
    write: WRITE,
    nodes: board.nodes.length,
    checked,
    attached: matched.length,
    skipped: skipped.length,
    matches: matched.slice(0, 20),
  }, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

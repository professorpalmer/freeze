#!/usr/bin/env node
/**
 * Freese Index publish API — apply board snapshot and push to origin/master.
 * POST /api/publish  JSON: { passphrase, board }
 *
 * Env:
 *   FREESE_PUBLISH_PASS  default traditionology
 *   PORT                 default 8787
 */
'use strict';

const http = require('http');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INCOMING = path.join(ROOT, 'incoming', 'board.json');
const PASS = process.env.FREESE_PUBLISH_PASS || 'traditionology';
const PORT = Number(process.env.PORT || 8787);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Freese-Pass',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  });
  res.end(payload);
}

function validateBoard(board) {
  if (!board || typeof board !== 'object') return 'missing board';
  if (!Array.isArray(board.nodes) || board.nodes.length < 100) return 'need >=100 nodes';
  if (!Array.isArray(board.edges)) return 'need edges';
  const hasJosh = board.nodes.some((n) => /^josh\s+freese$/i.test(String(n.name || '')));
  if (!hasJosh) return 'missing Josh Freese note';
  return null;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${cmd} failed`).trim());
  }
  return result.stdout || '';
}

function publishBoard(board) {
  fs.mkdirSync(path.dirname(INCOMING), { recursive: true });
  fs.writeFileSync(INCOMING, JSON.stringify(board), 'utf8');
  run('node', ['scripts/apply-board-json.cjs', 'incoming/board.json']);
  run('git', ['add', 'incoming/board.json', 'board-data.js']);
  const porcelain = run('git', ['status', '--porcelain', 'incoming/board.json', 'board-data.js']);
  if (!String(porcelain).trim()) {
    return { committed: false, message: 'public board already matches' };
  }
  run('git', ['commit', '-m', 'publish: Traditionology board → public board-data.js']);
  run('git', ['push', 'origin', 'HEAD']);
  return { committed: true };
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return json(res, 200, { ok: true, service: 'freese-publish' });
  }
  if (req.method === 'POST' && req.url && req.url.startsWith('/api/publish')) {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 12 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        const pass = String(body.passphrase || req.headers['x-freese-pass'] || '');
        if (pass !== PASS) return json(res, 401, { ok: false, error: 'bad passphrase' });
        const board = body.board || body;
        const err = validateBoard(board);
        if (err) return json(res, 400, { ok: false, error: err });
        const result = publishBoard(board);
        return json(res, 200, {
          ok: true,
          nodes: board.nodes.length,
          edges: board.edges.length,
          ...result,
        });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
      }
    });
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`freese-publish listening on ${PORT}\n`);
});

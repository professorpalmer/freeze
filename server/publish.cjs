#!/usr/bin/env node
/**
 * Freese Index web server — static site + on-site publish API.
 *
 * POST /api/publish  { passphrase, board }
 * No GitHub UI for editors — same-origin only.
 *
 * Env:
 *   FREESE_PUBLISH_PASS  default traditionology
 *   PORT                 default 8787 (Render sets PORT)
 *   FREESE_DEPLOY_KEY    optional PEM override
 */
'use strict';

const http = require('http');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const INCOMING = path.join(ROOT, 'incoming', 'board.json');
const DEPLOY_KEY_PATH = path.join(__dirname, 'deploy_key');
const PASS = process.env.FREESE_PUBLISH_PASS || 'traditionology';
const PORT = Number(process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
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

function ensureDeployKey() {
  if (process.env.FREESE_DEPLOY_KEY) {
    fs.writeFileSync(DEPLOY_KEY_PATH, process.env.FREESE_DEPLOY_KEY.replace(/\\n/g, '\n'), {
      mode: 0o600,
    });
  }
  const b64Path = path.join(__dirname, 'deploy_key.b64');
  if (!fs.existsSync(DEPLOY_KEY_PATH) && fs.existsSync(b64Path)) {
    fs.writeFileSync(DEPLOY_KEY_PATH, Buffer.from(fs.readFileSync(b64Path, 'utf8').trim(), 'base64'), {
      mode: 0o600,
    });
  }
  if (!fs.existsSync(DEPLOY_KEY_PATH)) {
    throw new Error('Publish is not configured on this host yet.');
  }
  try {
    fs.chmodSync(DEPLOY_KEY_PATH, 0o600);
  } catch (_) { /* ignore */ }
  return DEPLOY_KEY_PATH;
}

function gitEnv() {
  const key = ensureDeployKey();
  return {
    ...process.env,
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: `ssh -i ${key} -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes`,
  };
}

function git(work, args) {
  const result = spawnSync('git', args, {
    cwd: work,
    encoding: 'utf8',
    env: gitEnv(),
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'git failed').trim().slice(0, 800));
  }
  return result.stdout || '';
}

function publishBoard(board) {
  fs.mkdirSync(path.dirname(INCOMING), { recursive: true });
  fs.writeFileSync(INCOMING, JSON.stringify(board), 'utf8');

  const apply = spawnSync('node', ['scripts/apply-board-json.cjs', 'incoming/board.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (apply.status !== 0) {
    throw new Error((apply.stderr || apply.stdout || 'apply failed').trim().slice(0, 800));
  }

  // Always clone fresh so ephemeral hosts (Render) can push without a dirty checkout.
  const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'freese-publish-'));
  try {
    git(work, ['clone', '--depth', '1', 'git@github.com:professorpalmer/freeze.git', '.']);
    fs.copyFileSync(path.join(ROOT, 'board-data.js'), path.join(work, 'board-data.js'));
    fs.mkdirSync(path.join(work, 'incoming'), { recursive: true });
    fs.copyFileSync(INCOMING, path.join(work, 'incoming', 'board.json'));

    const porcelain = git(work, ['status', '--porcelain', 'board-data.js', 'incoming/board.json']);
    if (!String(porcelain).trim()) {
      return { committed: false, message: 'public board already matches' };
    }

    git(work, ['config', 'user.name', 'freese-publish-bot']);
    git(work, ['config', 'user.email', 'freese-publish@users.noreply.github.com']);
    git(work, ['add', 'board-data.js', 'incoming/board.json']);
    git(work, ['commit', '-m', 'publish: Traditionology board → public board-data.js']);
    git(work, ['push', 'origin', 'HEAD']);
    return { committed: true };
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  }
}

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath.split('?')[0]);
  const cleaned = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(root, cleaned);
  if (!full.startsWith(root)) return null;
  return full;
}

function serveStatic(req, res) {
  const u = new URL(req.url || '/', 'http://127.0.0.1');
  const rel = u.pathname === '/' ? '/index.html' : u.pathname;
  const file = safeJoin(ROOT, rel);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  if (path.resolve(file) === path.resolve(DEPLOY_KEY_PATH)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const cache =
    ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json'
      ? 'no-cache'
      : 'public, max-age=300';
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (req.method === 'GET' && (url === '/health' || url.startsWith('/health?'))) {
    return json(res, 200, { ok: true, service: 'freese-index' });
  }

  if (req.method === 'POST' && url.startsWith('/api/publish')) {
    try {
      const raw = await readBody(req, 12 * 1024 * 1024);
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
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res);
  }

  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`freese-index listening on ${PORT}\n`);
});

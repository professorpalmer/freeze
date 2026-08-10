/* ============================================================================
   Freese Index — independent mockup of a RedString-style investigation board
   ----------------------------------------------------------------------------
   · Pure client-side runtime: no network requests, no auth, no external assets.
   · Graph data is a static snapshot in board-data.js (imported offline from the
     public RedString Freese Index board via scripts/import-redstring.mjs).
   · Graph is rendered into a SINGLE inline <svg>. Edges are batched into
     tiered <path> elements (base + active + path accent), labels share one
     <g>, and each node is one <g>.
   · Hot path is rAF-coalesced: pan/zoom never filter the full edge list,
     thrash classLists, or write localStorage mid-gesture. Cork grows in
     chunks; far zoom paints on canvas; near zoom keeps lean SVG stickies.
   ========================================================================== */

'use strict';

/* ---------------------------------------------------------------------------
   Pure graph helpers (safe under Node — no DOM side effects).
--------------------------------------------------------------------------- */

function freezeIndexBoardBridge() {
  return typeof window !== 'undefined' && window.__freezeIndexBoard;
}

function freezeGraphNodes() {
  let source = [];
  if (typeof NODES !== 'undefined') source = NODES;
  else if (typeof nodes !== 'undefined') source = nodes;
  else if (typeof NODE_DATA !== 'undefined') source = NODE_DATA;
  if (Array.isArray(source)) return source;
  return source && typeof source === 'object' ? Object.values(source) : [];
}

function freezeNodeText(value) {
  if (Array.isArray(value)) return value.map(freezeNodeText).filter(Boolean).join(', ');
  if (value && typeof value === 'object') return freezeNodeText(value.name || value.label || value.id);
  return value == null ? '' : String(value);
}

function freezeNodeId(node) {
  return freezeNodeText(node && (node.id ?? node.key ?? node.slug ?? node.name));
}

function freezeNodeName(node) {
  return freezeNodeText(node && (node.name ?? node.label ?? node.title ?? node.id));
}

function freezeNodeRole(node) {
  return freezeNodeText(node && (node.role ?? node.title ?? node.subtitle));
}

function freezeNodeBlurb(node) {
  return freezeNodeText(node && (node.blurb ?? node.summary ?? node.description ?? node.bio));
}

function freezeNodeAffiliation(node) {
  return freezeNodeText(node && (node.affiliation ?? node.affiliations ?? node.group ?? node.organization));
}

function freezeNodeType(node) {
  const type = freezeNodeText(node && (node.type ?? node.kind ?? node.category));
  if (type && typeof TYPES !== 'undefined' && TYPES[type] && TYPES[type].label) return TYPES[type].label;
  return type || 'Node';
}

function freezeNodeTypeKey(node) {
  return freezeNodeText(node && (node.type ?? node.kind ?? node.category));
}

function freezeEdgeEndpoint(edge, side) {
  const alternate = side === 'source' ? 'from' : 'to';
  const fallback = side === 'source' ? 0 : 1;
  const value = edge && (edge[side] ?? edge[alternate] ?? edge[side === 'source' ? 'a' : 'b'] ?? edge[fallback]);
  return freezeNodeText(value && typeof value === 'object' ? (value.id ?? value.key ?? value.name) : value);
}

function freezeEdgeLabel(edge) {
  return freezeNodeText(edge && (edge.relationship ?? edge.relation ?? edge.label ?? edge.kind ?? edge.type)) || 'connected to';
}

function freezeJoshId() {
  const board = freezeBoardPayload();
  if (board && board.joshId) return String(board.joshId);
  return 'josh';
}

function freezeBoardPayload() {
  if (typeof window !== 'undefined' && window.FREESE_BOARD && typeof window.FREESE_BOARD === 'object') {
    return window.FREESE_BOARD;
  }
  if (typeof FREESE_BOARD !== 'undefined' && FREESE_BOARD && typeof FREESE_BOARD === 'object') {
    return FREESE_BOARD;
  }
  return { nodes: [], edges: [], world: { w: 2000, h: 1400 }, joshId: null, source: null };
}

function freezeNormalizeEdgeMeta(edge) {
  const from = freezeEdgeEndpoint(edge, 'source');
  const to = freezeEdgeEndpoint(edge, 'target');
  const joshId = freezeJoshId();
  const touchesSubject = from === joshId || to === joshId || from === 'josh' || to === 'josh';
  const kind = freezeNodeText(edge && edge.kind);
  const tier = freezeNodeText(edge && edge.tier)
    || (touchesSubject ? 'core' : (kind === 'membership' ? 'strong' : 'related'));
  const strength = freezeNodeText(edge && edge.strength)
    || (tier === 'core' ? 'high' : tier === 'strong' ? 'medium' : 'low');
  // Never treat endpoint fields (source/target/from/to) as evidence.
  const evidence = freezeNodeText(edge && (edge.evidence ?? edge.note ?? edge.citation));
  return {
    tier,
    strength,
    evidence,
    kind: kind || tier,
    label: freezeEdgeLabel(edge),
  };
}

function freezeConnectedAffiliations(node, model) {
  const listed = freezeNodeAffiliation(node);
  if (listed) return listed;
  if (!model || !model.adjacency || !model.byId) return '';
  const id = freezeNodeId(node);
  const neighbors = model.adjacency.get(id) || [];
  const names = [];
  const seen = new Set();
  neighbors.forEach(({ id: otherId }) => {
    const other = model.byId.get(otherId);
    if (!other) return;
    const name = freezeNodeName(other);
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  });
  return names.slice(0, 12).join(', ');
}

function freezeGraphModel(rawNodes, rawEdges) {
  const nodes = rawNodes != null
    ? (Array.isArray(rawNodes) ? rawNodes : Object.values(rawNodes || {}))
    : freezeGraphNodes();
  const byId = new Map();
  const byName = new Map();
  nodes.forEach((node, index) => {
    const id = freezeNodeId(node) || String(index);
    byId.set(id, node);
    const name = freezeNodeName(node);
    if (name) byName.set(name.toLowerCase(), node);
  });
  const adjacency = new Map(nodes.map((node, index) => [freezeNodeId(node) || String(index), []]));
  const edges = [];
  const edgeSource = rawEdges != null
    ? rawEdges
    : (typeof EDGES !== 'undefined' && Array.isArray(EDGES) ? EDGES : []);
  (Array.isArray(edgeSource) ? edgeSource : []).forEach((edge) => {
    const rawSource = freezeEdgeEndpoint(edge, 'source');
    const rawTarget = freezeEdgeEndpoint(edge, 'target');
    if (!rawSource || !rawTarget) return;
    const sourceNode = byId.get(rawSource) || byName.get(rawSource.toLowerCase());
    const targetNode = byId.get(rawTarget) || byName.get(rawTarget.toLowerCase());
    if (!sourceNode || !targetNode) return;
    const meta = freezeNormalizeEdgeMeta(edge);
    const normalized = {
      id: freezeNodeText(edge && edge.id),
      source: freezeNodeId(sourceNode),
      target: freezeNodeId(targetNode),
      from: freezeNodeId(sourceNode),
      to: freezeNodeId(targetNode),
      label: meta.label,
      tier: meta.tier,
      strength: meta.strength,
      kind: meta.kind,
      evidence: meta.evidence,
    };
    edges.push(normalized);
    if (!adjacency.has(normalized.source)) adjacency.set(normalized.source, []);
    if (!adjacency.has(normalized.target)) adjacency.set(normalized.target, []);
    adjacency.get(normalized.source).push({ id: normalized.target, edge: normalized });
    adjacency.get(normalized.target).push({ id: normalized.source, edge: normalized });
  });
  return { nodes, byId, byName, adjacency, edges };
}

function freezeResolveNode(value, model) {
  if (!value || !model) return null;
  if (typeof value === 'object') {
    const id = freezeNodeId(value);
    if (id && model.byId.has(id)) return model.byId.get(id);
    const name = freezeNodeName(value).toLowerCase();
    return (name && model.byName.get(name)) || null;
  }
  const text = String(value);
  return model.byId.get(text) || model.byName.get(text.toLowerCase()) || null;
}

function freezeShortestPath(model, start) {
  const josh = model.nodes.find((node) => freezeNodeName(node).toLowerCase() === 'josh freese')
    || model.nodes.find((node) => /josh[-_ ]freese/i.test(freezeNodeId(node)));
  if (!start || !josh) return { target: josh || null, nodes: [], edges: [], disconnected: true };
  const startId = freezeNodeId(start);
  const targetId = freezeNodeId(josh);
  if (startId === targetId) return { target: josh, nodes: [start], edges: [], disconnected: false };

  const previous = new Map([[startId, null]]);
  const via = new Map();
  const queue = [startId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === targetId) break;
    (model.adjacency.get(current) || []).forEach(({ id, edge }) => {
      if (previous.has(id)) return;
      previous.set(id, current);
      via.set(id, edge);
      queue.push(id);
    });
  }
  if (!previous.has(targetId)) return { target: josh, nodes: [start], edges: [], disconnected: true };

  const pathIds = [];
  const pathEdges = [];
  let cursor = targetId;
  while (cursor != null) {
    pathIds.unshift(cursor);
    if (via.has(cursor)) pathEdges.unshift(via.get(cursor));
    cursor = previous.get(cursor);
  }
  return {
    target: josh,
    nodes: pathIds.map((id) => model.byId.get(id)).filter(Boolean),
    edges: pathEdges,
    disconnected: false,
  };
}

function freezeDescribeHop(edge, model, fromId, toId) {
  if (!edge) return '';
  const storedSourceId = edge.source || edge.from;
  const storedTargetId = edge.target || edge.to;
  const sourceId = fromId || storedSourceId;
  const targetId = toId || storedTargetId;
  const fromName = freezeNodeName(model.byId.get(sourceId)) || sourceId;
  const toName = freezeNodeName(model.byId.get(targetId)) || targetId;
  const meta = freezeNormalizeEdgeMeta(edge);
  const bits = `${meta.label || edge.label} · ${meta.tier}/${meta.strength}`;
  const evidence = meta.evidence ? ` — ${meta.evidence}` : '';
  return `${fromName} → ${toName}: ${bits}${evidence}`;
}

function freezePathSummary(node, model, path) {
  const result = path || freezeShortestPath(model, node);
  if (!result.target) return { summary: 'Josh Freese is not present in this graph.', hops: [], path: result };
  if (result.disconnected) {
    return {
      summary: `${freezeNodeName(node)} is disconnected from Josh Freese.`,
      hops: [],
      path: result,
    };
  }
  if (result.edges.length === 0) {
    return { summary: 'Josh Freese is the selected subject.', hops: [], path: result };
  }
  const names = result.nodes.map(freezeNodeName).join(' → ');
  return {
    summary: `Path to Josh Freese: ${names} (${result.nodes.length - 1} hop${result.nodes.length - 1 === 1 ? '' : 's'})`,
    hops: result.edges.map((edge, index) => {
      const fromId = freezeNodeId(result.nodes[index]);
      const toId = freezeNodeId(result.nodes[index + 1]);
      return freezeDescribeHop(edge, model, fromId, toId);
    }),
    path: result,
  };
}

function freezeSearchNodes(model, query, limit) {
  const cap = Number.isFinite(limit) ? Math.max(1, limit) : 12;
  const q = String(query || '').trim().toLowerCase();
  const scored = [];
  model.nodes.forEach((node) => {
    const affiliations = freezeConnectedAffiliations(node, model);
    const haystack = [
      freezeNodeName(node),
      freezeNodeRole(node),
      freezeNodeBlurb(node),
      freezeNodeType(node),
      freezeNodeTypeKey(node),
      affiliations,
      freezeNodeId(node),
    ].join(' ').toLowerCase();
    if (q && !haystack.includes(q)) return;
    scored.push({ node, affiliations });
  });
  scored.sort((a, b) => freezeNodeName(a.node).localeCompare(freezeNodeName(b.node)));
  return {
    total: scored.length,
    matches: scored.slice(0, cap),
    capped: scored.length > cap,
  };
}

function freezeNodeCoordinates(node, element) {
  const position = node && (node.position || node.coordinates);
  let x = node && (node.cx ?? (position && (position.cx ?? position.x)) ?? node.fx);
  let y = node && (node.cy ?? (position && (position.cy ?? position.y)) ?? node.fy);

  // Prefer finalized centers; if only chip top-left exists, derive the center.
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    const left = node && (node.x ?? (position && position.x));
    const top = node && (node.y ?? (position && position.y));
    if (Number.isFinite(Number(left)) && Number.isFinite(Number(top))) {
      const w = Number(node && node.w) || 0;
      const h = Number(node && node.h) || 0;
      x = Number(left) + w / 2;
      y = Number(top) + h / 2;
    }
  }

  if ((!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) && element) {
    const match = String(element.getAttribute('transform') || '')
      .match(/translate\(\s*(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)\s*\)/);
    if (match) {
      const w = Number(node && node.w);
      const h = Number(node && node.h);
      x = Number(match[1]) + (Number.isFinite(w) ? w / 2 : 0);
      y = Number(match[2]) + (Number.isFinite(h) ? h / 2 : 0);
    }
  }
  return { x: Number(x), y: Number(y) };
}

function freezeBoardSnapshot(model, selected, path) {
  return {
    meta: {
      title: 'Freese Index',
      kind: 'local-board-snapshot',
      localOnly: true,
      savedAt: new Date().toISOString(),
      nodeCount: model.nodes.length,
      edgeCount: model.edges.length,
    },
    joshId: typeof freezeJoshId === 'function' ? freezeJoshId() : null,
    world: (typeof BOARD_WORLD !== 'undefined' && BOARD_WORLD) || null,
    nodes: model.nodes.map((node) => ({
      id: freezeNodeId(node),
      name: freezeNodeName(node),
      type: freezeNodeTypeKey(node),
      role: freezeNodeRole(node),
      blurb: freezeNodeBlurb(node),
      x: node.x,
      y: node.y,
      tilt: node.tilt,
      big: node.big || undefined,
      paper: node.paper,
      pin: node.pin,
      attachments: Array.isArray(node.attachments) ? node.attachments : [],
    })),
    edges: model.edges.map((edge) => ({
      id: edge.id,
      from: edge.from || edge.source,
      to: edge.to || edge.target,
      label: edge.label,
      tier: edge.tier,
      strength: edge.strength,
      evidence: edge.evidence || undefined,
    })),
    selected: selected
      ? { id: freezeNodeId(selected), name: freezeNodeName(selected) }
      : null,
    path: path
      ? {
          disconnected: !!path.disconnected,
          nodeIds: (path.nodes || []).map(freezeNodeId),
          hops: (path.edges || []).map((edge) => ({
            from: edge.from || edge.source,
            to: edge.to || edge.target,
            label: edge.label,
            tier: edge.tier,
            strength: edge.strength,
            evidence: edge.evidence || undefined,
          })),
        }
      : null,
  };
}

const FREESE_STORAGE_KEY = 'freese-index-board-v1';

function freezeReadLocalBoard() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(FREESE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.nodes) || !parsed.nodes.length) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function freezeWriteLocalBoard(payload) {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(FREESE_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

function freezeReadShareFlags() {
  if (typeof location === 'undefined') return { viewOnly: false, shared: false };
  try {
    const q = new URLSearchParams(location.search || '');
    const viewParam = String(q.get('view') || q.get('mode') || '').toLowerCase();
    const viewOnly = viewParam === '1' || viewParam === 'true' || viewParam === 'view' || viewParam === 'readonly';
    const shared = q.get('shared') === '1' || q.get('fresh') === '1';
    const hash = String(location.hash || '').replace(/^#/, '').toLowerCase();
    if (hash === 'view' || hash.startsWith('view/') || hash.startsWith('view&')) {
      return { viewOnly: true, shared };
    }
    return { viewOnly, shared };
  } catch (_) {
    return { viewOnly: false, shared: false };
  }
}

function freezeHydrateBoardPayload(seed) {
  const flags = freezeReadShareFlags();
  // Shared/view links can opt out of this browser's local edits (?shared=1).
  const local = flags.shared ? null : freezeReadLocalBoard();
  if (!local) return seed;
  return {
    source: {
      ...(seed && seed.source ? seed.source : {}),
      local: true,
      savedAt: local.meta && local.meta.savedAt,
      nodeCount: local.nodes.length,
      edgeCount: (local.edges || []).length,
    },
    world: local.world || (seed && seed.world) || { w: 2000, h: 1400 },
    joshId: local.joshId || (seed && seed.joshId) || null,
    nodes: local.nodes,
    edges: Array.isArray(local.edges) ? local.edges : [],
  };
}

function freezeLocalShareUrl(selectedId, opts) {
  if (typeof location === 'undefined') {
    return selectedId ? `#node=${encodeURIComponent(selectedId)}` : '#board';
  }
  const url = new URL(location.href);
  const viewOnly = !!(opts && opts.viewOnly);
  url.search = '';
  if (viewOnly) url.searchParams.set('view', '1');
  if (opts && opts.shared) url.searchParams.set('shared', '1');
  url.hash = selectedId ? `node=${encodeURIComponent(selectedId)}` : '';
  return url.toString();
}

/** Empty cork around the note cluster — room to pin without hitting the edge. */
const OPEN_BOARD_MARGIN = 16000;
/** Deep zoom like a map globe — keep scrolling out past the cluster into cork void. */
const ZOOM_MIN = 0.0008;
const ZOOM_MAX = 8;
const LOD_FAR_SCALE = 0.55;   // canvas names + yarn
const LOD_COSMOS_SCALE = 0.085; // constellation dots; whole board fits in view

/** Grow cork so content has open margin on every side (room to pin more notes). */
function freezeEnsureOpenBoardMargin(nodes, world, marginPx) {
  const margin = Number.isFinite(marginPx) ? marginPx : OPEN_BOARD_MARGIN;
  const list = Array.isArray(nodes) ? nodes : [];
  const next = world && world.w && world.h ? { w: world.w, h: world.h } : { w: 2000, h: 1400 };
  if (!list.length) {
    next.w = Math.max(next.w, margin * 2);
    next.h = Math.max(next.h, margin * 2);
    return { world: next, shifted: false };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of list) {
    const w = Number(n.w) || 120;
    const h = Number(n.h) || 56;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + w);
    maxY = Math.max(maxY, n.y + h);
  }
  const needLeft = Math.max(0, margin - minX);
  const needTop = Math.max(0, margin - minY);
  let shifted = false;
  if (needLeft || needTop) {
    for (const n of list) {
      n.x += needLeft;
      n.y += needTop;
      if (Number.isFinite(n.cx)) n.cx += needLeft;
      if (Number.isFinite(n.cy)) n.cy += needTop;
    }
    maxX += needLeft;
    maxY += needTop;
    shifted = true;
  }
  next.w = Math.max(next.w, Math.ceil(maxX + margin));
  next.h = Math.max(next.h, Math.ceil(maxY + margin));
  return { world: next, shifted };
}

/* ---------------------------------------------------------------------------
   Local search panel (browser only).
--------------------------------------------------------------------------- */

function freezeClearElement(element) {
  while (element && element.firstChild) element.removeChild(element.firstChild);
}

function freezeQuadPoint(p0x, p0y, p1x, p1y, t) {
  const mx = (p0x + p1x) / 2;
  const my = (p0y + p1y) / 2;
  const sag = Math.min(26, Math.hypot(p1x - p0x, p1y - p0y) * 0.06);
  const cx = mx;
  const cy = my + sag;
  return {
    x: (1 - t) * (1 - t) * p0x + 2 * (1 - t) * t * cx + t * t * p1x,
    y: (1 - t) * (1 - t) * p0y + 2 * (1 - t) * t * cy + t * t * p1y,
  };
}

/** Build curved path `d` from finalized node centers (cx/cy), never chip top-left. */
function freezeHighlightPath(model, path) {
  if (!path || path.disconnected || !(path.edges || []).length) return '';
  let d = '';
  path.edges.forEach((edge) => {
    const sourceNode = model.byId.get(edge.source || edge.from);
    const targetNode = model.byId.get(edge.target || edge.to);
    const source = freezeNodeCoordinates(sourceNode);
    const target = freezeNodeCoordinates(targetNode);
    if (!Number.isFinite(source.x) || !Number.isFinite(target.x)) return;
    const mx = (source.x + target.x) / 2;
    const my = (source.y + target.y) / 2;
    const sag = Math.min(26, Math.hypot(target.x - source.x, target.y - source.y) * 0.06);
    d += `M${source.x.toFixed(1)},${source.y.toFixed(1)} Q${mx.toFixed(1)},${(my + sag).toFixed(1)} ${target.x.toFixed(1)},${target.y.toFixed(1)}`;
  });
  return d;
}

function freezeBuildSearchPanel(model, activate) {
  let panel = document.getElementById('freeze-search-panel');
  if (panel) return panel;
  panel = document.createElement('aside');
  panel.id = 'freeze-search-panel';
  panel.className = 'freeze-search';
  panel.setAttribute('aria-label', 'Search graph');
  panel.innerHTML =
    '<label for="freeze-search-input">Search people, bands, and projects</label>' +
    '<input id="freeze-search-input" type="search" autocomplete="off" placeholder="Name, role, type, or affiliation" aria-controls="freeze-search-results">' +
    '<p id="freeze-search-count" class="freeze-search-count" aria-live="polite"></p>' +
    '<ul id="freeze-search-results" role="listbox" aria-label="Search results"></ul>';
  document.body.appendChild(panel);

  const input = panel.querySelector('#freeze-search-input');
  const results = panel.querySelector('#freeze-search-results');
  const count = panel.querySelector('#freeze-search-count');

  const renderResults = () => {
    freezeClearElement(results);
    const query = String(input.value || '').trim();
    if (!query) {
      count.textContent = `${(typeof NODES !== 'undefined' && Array.isArray(NODES) ? NODES.length : model.nodes.length)} subjects on the board`;
      results.setAttribute('aria-label', count.textContent);
      const empty = document.createElement('li');
      empty.className = 'freeze-search-empty';
      empty.textContent = 'Type to filter by name, role, type, or affiliation';
      results.appendChild(empty);
      return;
    }

    const liveModel = (typeof NODES !== 'undefined' && Array.isArray(NODES))
      ? freezeGraphModel(NODES, EDGES)
      : model;
    const found = freezeSearchNodes(liveModel, query, 12);
    if (!found.total) {
      count.textContent = 'No matches';
    } else if (found.capped) {
      count.textContent = `Showing ${found.matches.length} of ${found.total} matches`;
    } else {
      count.textContent = `${found.total} match${found.total === 1 ? '' : 'es'}`;
    }
    results.setAttribute('aria-label', count.textContent);

    if (!found.matches.length) {
      const empty = document.createElement('li');
      empty.className = 'freeze-search-empty';
      empty.textContent = 'No matching subjects';
      results.appendChild(empty);
      return;
    }

    found.matches.forEach(({ node, affiliations }) => {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'freeze-search-item';
      const role = freezeNodeRole(node);
      const type = freezeNodeType(node);
      button.innerHTML =
        `<span class="freeze-search-name">${freezeNodeName(node)}</span>` +
        `<span class="freeze-search-meta">${type}${role ? ` · ${role}` : ''}${affiliations ? ` · ${affiliations}` : ''}</span>`;
      button.title = freezeNodeBlurb(node) || role || type;
      button.addEventListener('click', () => activate(node));
      item.appendChild(button);
      results.appendChild(item);
    });
  };

  input.addEventListener('input', renderResults);
  renderResults();
  return panel;
}

function freezeStartSearch(model, activate) {
  if (document.getElementById('freeze-search-panel')) return;
  freezeBuildSearchPanel(model, activate);
}

/* ---------------------------------------------------------------------------
   Graph data — static snapshot from Traditionology's public RedString board
   (board-data.js). Runtime stays offline; re-import with:
   node scripts/import-redstring.mjs
--------------------------------------------------------------------------- */

const TYPES = {
  // Sticky colors match RedString note palette
  pink:   { color: '#ffe0e6', paper: '#ffe0e6', ink: '#3a1820', pin: '#c62828', label: 'Pink note' },
  yellow: { color: '#fff3a8', paper: '#fff3a8', ink: '#2a2418', pin: '#c62828', label: 'Yellow note' },
  green:  { color: '#d8f0c8', paper: '#d8f0c8', ink: '#1e2a18', pin: '#3d7a38', label: 'Green note' },
  blue:   { color: '#c5e4f7', paper: '#c5e4f7', ink: '#1a2a38', pin: '#1e5a8a', label: 'Blue note' },
  // legacy aliases (older demo seed)
  person:  { color: '#fff3a8', paper: '#fff3a8', ink: '#2a2418', pin: '#c62828', label: 'Person' },
  band:    { color: '#c5e4f7', paper: '#c5e4f7', ink: '#1a2a38', pin: '#1e5a8a', label: 'Band / group' },
  project: { color: '#d8f0c8', paper: '#d8f0c8', ink: '#1e2a18', pin: '#3d7a38', label: 'Project / record' },
  subject: { color: '#ffe0e6', paper: '#ffe0e6', ink: '#3a1820', pin: '#c62828', label: 'Board subject' },
};

const BOARD = freezeHydrateBoardPayload(freezeBoardPayload());
let NODES = Array.isArray(BOARD.nodes) ? BOARD.nodes.slice() : [];
let EDGES = Array.isArray(BOARD.edges) ? BOARD.edges.slice() : [];
let BOARD_WORLD = (BOARD.world && BOARD.world.w && BOARD.world.h)
  ? { w: BOARD.world.w, h: BOARD.world.h }
  : { w: 2000, h: 1400 };
{
  // Room to pin — imported boards were cork-tight; open a huge margin on every side.
  const opened = freezeEnsureOpenBoardMargin(NODES, BOARD_WORLD, OPEN_BOARD_MARGIN);
  BOARD_WORLD = opened.world;
}

/** Stable sticky-note tilt in degrees from node id (−5…5). */
function stickyTiltDegrees(id) {
  let h = 2166136261;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 11) - 5;
}

/* sticky-note geometry — pure function of the data (safe to run under Node) */
function finalizeNodes() {
  const byId = new Map();
  for (const n of NODES) {
    const type = TYPES[n.type] || TYPES.person;
    n.h = n.big ? 78 : 56;
    n.w = Math.max(118, 34 + n.name.length * 8.4 + (n.big ? 24 : 0));
    n.cx = n.x + n.w / 2;
    n.cy = n.y + n.h / 2;
    n.color = type.color;
    n.paper = n.paper || type.paper;
    n.ink = n.ink || type.ink;
    n.pin = n.pin || type.pin;
    n.tilt = Number.isFinite(n.tilt) ? n.tilt : stickyTiltDegrees(n.id);
    byId.set(n.id, n);
  }
  const adj = new Map();
  for (const e of EDGES) {
    const meta = freezeNormalizeEdgeMeta(e);
    e.tier = meta.tier;
    e.strength = meta.strength;
    e.kind = meta.kind;
    if (meta.evidence) e.evidence = meta.evidence;
    (adj.get(e.from) || adj.set(e.from, []).get(e.from)).push(e);
    (adj.get(e.to) || adj.set(e.to, []).get(e.to)).push(e);
  }
  for (const n of NODES) n.neighbors = adj.get(n.id) || [];
  return byId;
}

/* ---------------------------------------------------------------------------
   Browser bootstrap (skipped under Node so the data above stays testable)
--------------------------------------------------------------------------- */

if (typeof document !== 'undefined') {
  (function main() {
    let byId = finalizeNodes();
    let graphModel = freezeGraphModel(NODES, EDGES);
    const WORLD = { w: BOARD_WORLD.w, h: BOARD_WORLD.h };
    const SHARE_FLAGS = freezeReadShareFlags();

    const svg = document.getElementById('graph');
    const world = document.getElementById('world');
    const boardBg = document.getElementById('board-bg');
    const boardBgShade = document.getElementById('board-bg-shade');
    function syncBoardSurfaceSize() {
      if (boardBg) {
        boardBg.setAttribute('width', String(WORLD.w));
        boardBg.setAttribute('height', String(WORLD.h));
      }
      if (boardBgShade) {
        boardBgShade.setAttribute('width', String(WORLD.w));
        boardBgShade.setAttribute('height', String(WORLD.h));
      }
    }
    syncBoardSurfaceSize();
    const nodesG = document.getElementById('nodes');
    const labelsG = document.getElementById('edge-labels');
    const edgesCorePath = document.getElementById('edges-core');
    const edgesStrongPath = document.getElementById('edges-strong');
    const edgesPath = document.getElementById('edges');
    const activePath = document.getElementById('edges-active');
    const pathAccent = document.getElementById('edges-path');
    const readout = document.getElementById('readout');
    const toast = document.getElementById('toast');
    const zoomPct = document.getElementById('zoom-pct');
    const noteModal = document.getElementById('note-modal');
    const noteForm = document.getElementById('note-form');
    const noteAttachments = document.getElementById('note-attachments');
    const modeBtn = document.getElementById('btn-mode');
    const modeLabel = document.getElementById('mode-label');
    const chromeBtn = document.getElementById('btn-chrome');

    /* ----- view state ----- */
    const view = { tx: 0, ty: 0, scale: 1, fitted: false };
    const ui = {
      dim: false,
      interactive: false,
      editing: false,
      viewOnly: !!SHARE_FLAGS.viewOnly,
      chromeVisible: true,
      selected: null,
      hovered: null,
      active: null,
      path: null,
      linkFrom: null,
    };
    const drag = { mode: null, id: null, sx: 0, sy: 0, nx: 0, ny: 0, moved: false };
    const pointers = new Map(); // pointerId -> {x,y}
    let pinch = null;           // {dist, mx, my}
    let persistTimer = null;

    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const NODE_DRAW_ORDER = { subject: 0, project: 1, band: 2, person: 3, pink: 4, yellow: 5, green: 6, blue: 7 };

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function newId(prefix) {
      return prefix + '-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    }

    function persistBoard(immediate) {
      if (ui.viewOnly) return;
      const write = () => {
        const snap = freezeBoardSnapshot(graphModel, ui.selected ? byId.get(ui.selected) : null, ui.path);
        freezeWriteLocalBoard(snap);
      };
      if (immediate) {
        clearTimeout(persistTimer);
        write();
        return;
      }
      clearTimeout(persistTimer);
      persistTimer = setTimeout(write, 350);
    }

    function applyWorldSize(next) {
      WORLD.w = next.w;
      WORLD.h = next.h;
      BOARD_WORLD.w = next.w;
      BOARD_WORLD.h = next.h;
      syncBoardSurfaceSize();
    }

    function expandWorldIfNeeded() {
      const opened = freezeEnsureOpenBoardMargin(NODES, WORLD, OPEN_BOARD_MARGIN);
      if (opened.world.w !== WORLD.w || opened.world.h !== WORLD.h || opened.shifted) {
        applyWorldSize(opened.world);
        if (opened.shifted) {
          byId = finalizeNodes();
          graphModel = freezeGraphModel(NODES, EDGES);
          remountNodes();
        }
        return true;
      }
      return false;
    }

    function rebuildGraphModel() {
      byId = finalizeNodes();
      graphModel = freezeGraphModel(NODES, EDGES);
      rebuildEdgeTier();
    }

    function remountNodes() {
      nodesG.textContent = '';
      nodeEls.clear();
      visibleNodeIds = new Set();
      buildNodes();
      rebuildNodeIndex();
    }

    function refreshBoard({ persist = true, fit = false } = {}) {
      rebuildGraphModel();
      remountNodes();
      renderEdges();
      renderLabels();
      if (ui.selected && byId.has(ui.selected)) {
        setPathForNode(ui.selected);
        updateReadout(ui.selected);
      } else {
        clearSelection();
      }
      if (fit) fitView(false);
      if (persist) persistBoard(false);
    }

    /* ================= build the static graph DOM ================= */

    const nodeEls = new Map();

    function quadAt(p0x, p0y, p1x, p1y, t) {
      return freezeQuadPoint(p0x, p0y, p1x, p1y, t);
    }

    function edgePathData(edges, rect) {
      // Straight segments — quadratic yarn sag is too expensive at ~700 edges.
      let d = '';
      for (const e of edges) {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) continue;
        if (rect && !segmentHitsRect(a.cx, a.cy, b.cx, b.cy, rect)) continue;
        d += `M${a.cx.toFixed(1)},${a.cy.toFixed(1)}L${b.cx.toFixed(1)},${b.cy.toFixed(1)}`;
      }
      return d;
    }

    // Tier lists rebuilt only when the edge set changes — never filter 770 edges per frame.
    let edgesByTierCache = { related: [], strong: [], core: [] };
    function rebuildEdgeTier() {
      const next = { related: [], strong: [], core: [] };
      for (const e of EDGES) {
        const tier = e.tier || 'related';
        (next[tier] || next.related).push(e);
      }
      edgesByTierCache = next;
    }
    rebuildEdgeTier();

    function edgesByTier(tier) {
      return edgesByTierCache[tier] || edgesByTierCache.related;
    }

    /* ---------- spatial index + viewport (keeps ~500 notes feeling light) ---------- */

    const SPATIAL_CELL = 240;
    let spatialBuckets = new Map();
    let visibleNodeIds = new Set();
    let lodCanvas = document.getElementById('lod-canvas');
    let lodCtx = lodCanvas ? lodCanvas.getContext('2d', { alpha: true }) : null;
    let lodCanvasCssW = 0;
    let lodCanvasCssH = 0;
    let frameRaf = 0;
    let frameNeeds = { transform: false, cull: false, edges: false, labels: false, lodPaint: false };
    let lastViewport = null;
    let lodFarOn = false;
    let lodCosmosOn = false;
    let lodFontFamily = '';
    let cosmosPersistDirty = false;
    const COSMOS_GROW_CHUNK = 12000;

    function spatialKey(cx, cy) {
      return ((Math.floor(cx / SPATIAL_CELL)) + ',' + Math.floor(cy / SPATIAL_CELL));
    }

    function rebuildSpatialIndex() {
      const next = new Map();
      for (const n of NODES) {
        const key = spatialKey(n.cx, n.cy);
        let bucket = next.get(key);
        if (!bucket) {
          bucket = [];
          next.set(key, bucket);
        }
        bucket.push(n);
      }
      spatialBuckets = next;
    }

    function viewportWorldRect(padPx) {
      const pad = (padPx == null ? 96 : padPx) / Math.max(view.scale, ZOOM_MIN);
      const cw = svg.clientWidth || 1;
      const ch = svg.clientHeight || 1;
      return {
        minX: (-view.tx) / view.scale - pad,
        minY: (-view.ty) / view.scale - pad,
        maxX: (-view.tx + cw) / view.scale + pad,
        maxY: (-view.ty + ch) / view.scale + pad,
      };
    }

    function segmentHitsRect(x1, y1, x2, y2, rect) {
      if (
        (x1 >= rect.minX && x1 <= rect.maxX && y1 >= rect.minY && y1 <= rect.maxY) ||
        (x2 >= rect.minX && x2 <= rect.maxX && y2 >= rect.minY && y2 <= rect.maxY)
      ) {
        return true;
      }
      const minX = x1 < x2 ? x1 : x2;
      const maxX = x1 > x2 ? x1 : x2;
      const minY = y1 < y2 ? y1 : y2;
      const maxY = y1 > y2 ? y1 : y2;
      return !(maxX < rect.minX || minX > rect.maxX || maxY < rect.minY || minY > rect.maxY);
    }

    function nodesTouchingRect(rect) {
      const out = [];
      const x0 = Math.floor(rect.minX / SPATIAL_CELL);
      const y0 = Math.floor(rect.minY / SPATIAL_CELL);
      const x1 = Math.floor(rect.maxX / SPATIAL_CELL);
      const y1 = Math.floor(rect.maxY / SPATIAL_CELL);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const bucket = spatialBuckets.get(gx + ',' + gy);
          if (!bucket) continue;
          for (const n of bucket) {
            if (n.x + n.w < rect.minX || n.x > rect.maxX || n.y + n.h < rect.minY || n.y > rect.maxY) continue;
            out.push(n);
          }
        }
      }
      return out;
    }

    function isFarLod() {
      return view.scale < LOD_FAR_SCALE;
    }

    function isCosmosLod() {
      return view.scale < LOD_COSMOS_SCALE;
    }

    function formatZoomLabel(scale) {
      const pct = scale * 100;
      if (pct >= 10) return Math.round(pct) + '%';
      if (pct >= 1) return pct.toFixed(1).replace(/\.0$/, '') + '%';
      if (pct >= 0.1) return pct.toFixed(2) + '%';
      return pct.toFixed(3) + '%';
    }

    function ensureLodCanvasSize() {
      if (!lodCanvas || !lodCtx) return false;
      const cssW = svg.clientWidth || 0;
      const cssH = svg.clientHeight || 0;
      if (!cssW || !cssH) return false;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const needW = Math.round(cssW * dpr);
      const needH = Math.round(cssH * dpr);
      if (lodCanvas.width !== needW || lodCanvas.height !== needH || lodCanvasCssW !== cssW || lodCanvasCssH !== cssH) {
        lodCanvas.width = needW;
        lodCanvas.height = needH;
        lodCanvas.style.width = cssW + 'px';
        lodCanvas.style.height = cssH + 'px';
        lodCanvasCssW = cssW;
        lodCanvasCssH = cssH;
      }
      lodCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return true;
    }

    function paintLodCanvas(rect) {
      if (!ensureLodCanvasSize()) return;
      const ctx = lodCtx;
      const w = lodCanvasCssW;
      const h = lodCanvasCssH;
      ctx.clearRect(0, 0, w, h);

      const s = view.scale;
      const tx = view.tx;
      const ty = view.ty;
      const cosmos = s < LOD_COSMOS_SCALE;
      const dimmed = ui.dim && !ui.active;
      // Deep cosmos: dots only — yarn becomes noise and burns fill rate.
      const paintYarn = !cosmos || s >= 0.025;

      if (paintYarn) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const tiers = cosmos
          ? [
              { list: edgesByTierCache.strong, stroke: dimmed ? 'rgba(198, 40, 40, 0.08)' : 'rgba(198, 40, 40, 0.28)', width: 0.9 },
              { list: edgesByTierCache.core, stroke: dimmed ? 'rgba(198, 40, 40, 0.12)' : 'rgba(198, 40, 40, 0.42)', width: 1.15 },
            ]
          : [
              { list: edgesByTierCache.related, stroke: dimmed ? 'rgba(179, 58, 50, 0.08)' : 'rgba(179, 58, 50, 0.38)', width: 1.05 },
              { list: edgesByTierCache.strong, stroke: dimmed ? 'rgba(198, 40, 40, 0.1)' : 'rgba(198, 40, 40, 0.5)', width: 1.25 },
              { list: edgesByTierCache.core, stroke: dimmed ? 'rgba(198, 40, 40, 0.12)' : 'rgba(198, 40, 40, 0.62)', width: 1.45 },
            ];
        for (const style of tiers) {
          ctx.beginPath();
          ctx.strokeStyle = style.stroke;
          ctx.lineWidth = style.width;
          let any = false;
          for (const e of style.list) {
            const a = byId.get(e.from), b = byId.get(e.to);
            if (!a || !b) continue;
            if (!segmentHitsRect(a.cx, a.cy, b.cx, b.cy, rect)) continue;
            ctx.moveTo(a.cx * s + tx, a.cy * s + ty);
            ctx.lineTo(b.cx * s + tx, b.cy * s + ty);
            any = true;
          }
          if (any) ctx.stroke();
        }
      }

      const visible = nodesTouchingRect(rect);
      if (!lodFontFamily) {
        lodFontFamily = getComputedStyle(document.body).getPropertyValue('--font-note').trim()
          || 'Georgia, "Times New Roman", serif';
      }

      if (cosmos) {
        // Constellation — fillRect dots beat arc(); hub names only.
        for (const n of visible) {
          const sx = n.cx * s + tx;
          const sy = n.cy * s + ty;
          if (sx < -8 || sy < -8 || sx > w + 8 || sy > h + 8) continue;
          const r = n.big ? 3 : (s > 0.04 ? 2 : 1);
          ctx.fillStyle = n.pin || n.color || '#c62828';
          ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.font = '600 11px ' + lodFontFamily;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(247, 241, 225, 0.88)';
        for (const n of visible) {
          if (!n.big) continue;
          const sx = n.cx * s + tx;
          const sy = n.cy * s + ty + 5;
          if (sx < -80 || sy < -20 || sx > w + 80 || sy > h + 20) continue;
          ctx.strokeText(n.name, sx, sy);
          ctx.fillStyle = n.ink || '#2a1a0c';
          ctx.fillText(n.name, sx, sy);
        }
        return;
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 11px ' + lodFontFamily;
      for (const n of visible) {
        const sx = n.cx * s + tx;
        const sy = (n.cy + (n.big ? 4 : 2)) * s + ty;
        if (sx < -40 || sy < -20 || sx > w + 40 || sy > h + 20) continue;
        ctx.lineWidth = 3.2;
        ctx.strokeStyle = 'rgba(247, 241, 225, 0.9)';
        ctx.strokeText(n.name, sx, sy);
        ctx.fillStyle = n.ink || '#2a1a0c';
        ctx.fillText(n.name, sx, sy);
        if (n.big && n.role) {
          ctx.font = '500 9px ' + lodFontFamily;
          ctx.strokeText(n.role, sx, sy + 12);
          ctx.fillText(n.role, sx, sy + 12);
          ctx.font = '600 11px ' + lodFontFamily;
        }
      }
    }

    function applyNodeCulling(rect) {
      const nextVisible = new Set();
      for (const n of nodesTouchingRect(rect)) nextVisible.add(n.id);
      // Always keep selection / path / link endpoints mounted for chrome.
      if (ui.selected) nextVisible.add(ui.selected);
      if (ui.linkFrom) nextVisible.add(ui.linkFrom);
      if (ui.path && ui.path.nodes) {
        for (const n of ui.path.nodes) {
          const id = freezeNodeId(n);
          if (id) nextVisible.add(id);
        }
      }
      for (const [id, g] of nodeEls) {
        g.classList.toggle('is-culled', !nextVisible.has(id));
      }
      visibleNodeIds = nextVisible;
    }

    function renderEdges() {
      const rect = isFarLod() ? null : (lastViewport || viewportWorldRect());
      // Near LOD: SVG yarn, viewport-culled. Far LOD: canvas owns the bulk web.
      if (edgesCorePath) edgesCorePath.setAttribute('d', isFarLod() ? '' : edgePathData(edgesByTier('core'), rect));
      if (edgesStrongPath) edgesStrongPath.setAttribute('d', isFarLod() ? '' : edgePathData(edgesByTier('strong'), rect));
      edgesPath.setAttribute('d', isFarLod() ? '' : edgePathData(edgesByTier('related'), rect));
      const activeId = ui.active;
      const active = activeId ? EDGES.filter((e) => e.from === activeId || e.to === activeId) : [];
      activePath.setAttribute('d', edgePathData(active, null));
      renderPathAccent();
    }

    function renderPathAccent() {
      if (!pathAccent) return;
      pathAccent.setAttribute('d', freezeHighlightPath(graphModel, ui.path || { edges: [] }));
    }

    function renderLabels() {
      labelsG.textContent = '';
      if (isFarLod()) return; // canvas owns readable names when zoomed out
      // At board scale, only label the active star + Freese path — never all 700+ strings.
      const pathEdgeIds = new Set((ui.path && ui.path.edges ? ui.path.edges : []).map((e) => e.id).filter(Boolean));
      const activeId = ui.active;
      const relevant = EDGES.filter((e) => {
        if (pathEdgeIds.has(e.id)) return true;
        if (activeId && (e.from === activeId || e.to === activeId)) return true;
        return false;
      });
      if (!relevant.length) return;
      const fs = 10.5 / view.scale;
      const sw = 3 / view.scale;
      for (const e of relevant) {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) continue;
        const p = quadAt(a.cx, a.cy, b.cx, b.cy, 0.5);
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('class', 'edge-label hl');
        if (pathEdgeIds.has(e.id)) t.classList.add('path-hl');
        t.setAttribute('x', p.x.toFixed(1));
        t.setAttribute('y', (p.y - 6 / view.scale).toFixed(1));
        t.setAttribute('font-size', fs.toFixed(2));
        t.setAttribute('stroke-width', sw.toFixed(2));
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('data-e', e.id);
        t.setAttribute('data-tier', e.tier || 'related');
        t.textContent = e.label;
        labelsG.appendChild(t);
      }
    }

    function applyLabelHighlights() {
      renderLabels();
    }

    function scheduleFrame(flags) {
      if (flags) {
        if (flags.transform) frameNeeds.transform = true;
        if (flags.cull) frameNeeds.cull = true;
        if (flags.edges) frameNeeds.edges = true;
        if (flags.labels) frameNeeds.labels = true;
        if (flags.lodPaint) frameNeeds.lodPaint = true;
      }
      if (frameRaf) return;
      frameRaf = requestAnimationFrame(runFrame);
    }

    function flushFrame() {
      if (frameRaf) {
        cancelAnimationFrame(frameRaf);
        frameRaf = 0;
      }
      frameNeeds = { transform: true, cull: true, edges: true, labels: true, lodPaint: true };
      runFrame();
    }

    function runFrame() {
      frameRaf = 0;
      const needs = frameNeeds;
      frameNeeds = { transform: false, cull: false, edges: false, labels: false, lodPaint: false };

      if (needs.transform) {
        world.setAttribute('transform', `translate(${view.tx},${view.ty}) scale(${view.scale})`);
        zoomPct.textContent = formatZoomLabel(view.scale);
        const far = isFarLod();
        const cosmos = isCosmosLod();
        if (far !== lodFarOn) {
          lodFarOn = far;
          document.body.classList.toggle('lod-far', far);
        }
        if (cosmos !== lodCosmosOn) {
          lodCosmosOn = cosmos;
          document.body.classList.toggle('lod-cosmos', cosmos);
        }
      }

      const rect = viewportWorldRect();
      lastViewport = rect;

      if (needs.cull || needs.transform) applyNodeCulling(rect);
      if (needs.edges || needs.transform) renderEdges();
      // Skip label DOM rebuild while panning/dragging — keeps 60fps on the cork.
      if ((needs.labels || needs.transform) && drag.mode !== 'node' && drag.mode !== 'pan') renderLabels();
      if ((needs.lodPaint || needs.transform || needs.cull) && isFarLod()) {
        paintLodCanvas(rect);
      } else if (!isFarLod() && lodCtx && lodCanvasCssW) {
        lodCtx.clearRect(0, 0, lodCanvasCssW, lodCanvasCssH);
      }
    }

    function scheduleEdgeRedraw() {
      if (isFarLod()) scheduleFrame({ lodPaint: true });
      else scheduleFrame({ edges: true, labels: true, lodPaint: true, cull: true });
    }

    function applyTransform() {
      // Far/cosmos: canvas owns yarn+names — don't rebuild SVG path strings every pan frame.
      if (view.scale < LOD_FAR_SCALE) {
        scheduleFrame({ transform: true, cull: true, lodPaint: true });
      } else {
        scheduleFrame({
          transform: true,
          cull: true,
          edges: true,
          labels: drag.mode !== 'pan' && drag.mode !== 'node',
        });
      }
    }

    function buildNodes() {
      // Lean sticky DOM (~3 shapes/note). Fancy tape/shadow chrome was choking phones at ~500.
      const sorted = NODES.slice().sort((a, b) => (NODE_DRAW_ORDER[a.type] || 0) - (NODE_DRAW_ORDER[b.type] || 0));
      const frag = document.createDocumentFragment();
      for (const n of sorted) {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'node' + (n.big ? ' big' : ''));
        g.setAttribute('data-node-id', n.id);
        g.setAttribute('data-type', n.type);
        g.setAttribute('id', n.id);
        g.setAttribute('transform', `translate(${n.x},${n.y})`);
        g.setAttribute('role', 'group');
        g.setAttribute('aria-label', `${n.name} — ${n.role || 'note'}`);

        const note = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        note.setAttribute('class', 'note');
        if (n.tilt) note.setAttribute('transform', `rotate(${n.tilt} ${n.w / 2} ${n.h / 2})`);

        const chip = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        chip.setAttribute('class', 'chip');
        chip.setAttribute('width', n.w);
        chip.setAttribute('height', n.h);
        chip.setAttribute('rx', 2);
        chip.setAttribute('fill', n.paper);

        const pin = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        pin.setAttribute('class', 'pin');
        pin.setAttribute('cx', n.w / 2);
        pin.setAttribute('cy', 7);
        pin.setAttribute('r', n.big ? 5 : 3.8);
        pin.setAttribute('fill', n.pin);

        const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lbl.setAttribute('class', 'lbl');
        lbl.setAttribute('x', n.w / 2);
        lbl.setAttribute('y', n.big ? 36 : 32);
        lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('fill', n.ink);
        lbl.textContent = n.name;

        note.appendChild(chip);
        note.appendChild(pin);
        note.appendChild(lbl);

        if (n.big) {
          const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          sub.setAttribute('class', 'sub');
          sub.setAttribute('x', n.w / 2);
          sub.setAttribute('y', 54);
          sub.setAttribute('text-anchor', 'middle');
          sub.setAttribute('fill', n.ink);
          sub.textContent = n.role;
          note.appendChild(sub);
        }

        g.appendChild(note);
        frag.appendChild(g);
        nodeEls.set(n.id, g);
      }
      nodesG.appendChild(frag);
      visibleNodeIds = new Set();
      rebuildSpatialIndex();
    }

    function fitView(announce) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of NODES) {
        minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
      }
      // Show empty cork around the cluster so Fit doesn't look wall-to-wall notes.
      const pad = Math.min(2800, Math.max(900, Math.round(OPEN_BOARD_MARGIN * 0.15)));
      const bw = maxX - minX + pad * 2, bh = maxY - minY + pad * 2;
      const cw = svg.clientWidth, ch = svg.clientHeight;
      view.scale = clamp(Math.min(cw / bw, ch / bh), ZOOM_MIN, 1.6);
      view.tx = (cw - bw * view.scale) / 2 - (minX - pad) * view.scale;
      view.ty = (ch - bh * view.scale) / 2 - (minY - pad) * view.scale;
      applyTransform();
      if (announce) showToast('Fitted — keep zooming out for the full cork cosmos.');
    }

    /** Grow cork when the camera approaches the edge so the board feels endless. */
    function growCosmosForViewport() {
      const softPad = Math.max(4000, Math.round(OPEN_BOARD_MARGIN * 0.25));
      const rect = viewportWorldRect(0);
      // Hot path: most pans are inside the soft pad — bail before any alloc/DOM.
      if (
        rect.minX >= softPad &&
        rect.minY >= softPad &&
        rect.maxX <= WORLD.w - softPad &&
        rect.maxY <= WORLD.h - softPad
      ) {
        return false;
      }

      let nextW = WORLD.w;
      let nextH = WORLD.h;
      let shiftX = 0;
      let shiftY = 0;
      // Grow in chunks so we don't resize the cork every pointermove near the edge.
      if (rect.minX < softPad) {
        shiftX = Math.ceil((softPad - rect.minX) / COSMOS_GROW_CHUNK) * COSMOS_GROW_CHUNK;
      }
      if (rect.minY < softPad) {
        shiftY = Math.ceil((softPad - rect.minY) / COSMOS_GROW_CHUNK) * COSMOS_GROW_CHUNK;
      }
      if (rect.maxX > WORLD.w - softPad) {
        nextW = WORLD.w + Math.ceil((rect.maxX + softPad - WORLD.w) / COSMOS_GROW_CHUNK) * COSMOS_GROW_CHUNK;
      }
      if (rect.maxY > WORLD.h - softPad) {
        nextH = WORLD.h + Math.ceil((rect.maxY + softPad - WORLD.h) / COSMOS_GROW_CHUNK) * COSMOS_GROW_CHUNK;
      }
      if (!shiftX && !shiftY && nextW === WORLD.w && nextH === WORLD.h) return false;

      if (shiftX || shiftY) {
        for (const n of NODES) {
          n.x += shiftX;
          n.y += shiftY;
          n.cx += shiftX;
          n.cy += shiftY;
        }
        nextW += shiftX;
        nextH += shiftY;
        view.tx -= shiftX * view.scale;
        view.ty -= shiftY * view.scale;
        for (const n of NODES) {
          const g = nodeEls.get(n.id);
          if (g) g.setAttribute('transform', `translate(${n.x},${n.y})`);
        }
        rebuildSpatialIndex();
      }
      applyWorldSize({ w: nextW, h: nextH });
      cosmosPersistDirty = true;
      return true;
    }

    function flushCosmosPersist() {
      if (!cosmosPersistDirty) return;
      cosmosPersistDirty = false;
      persistBoard(false);
    }

    function clampPan() {
      growCosmosForViewport();
      // Loose slack — cork keeps expanding, so pan feels like a globe not a boxed map.
      const slack = 0.55;
      const cw = svg.clientWidth, ch = svg.clientHeight;
      view.tx = clamp(view.tx, cw - WORLD.w * view.scale - cw * slack, cw * slack);
      view.ty = clamp(view.ty, ch - WORLD.h * view.scale - ch * slack, ch * slack);
    }

    function zoomAt(cx, cy, factor) {
      const ns = clamp(view.scale * factor, ZOOM_MIN, ZOOM_MAX);
      const k = ns / view.scale;
      view.tx = cx - (cx - view.tx) * k;
      view.ty = cy - (cy - view.ty) * k;
      view.scale = ns;
      clampPan();
      applyTransform();
    }

    /* ================= hit testing ================= */

    function worldPoint(clientX, clientY) {
      const r = svg.getBoundingClientRect();
      return {
        x: (clientX - r.left - view.tx) / view.scale,
        y: (clientY - r.top - view.ty) / view.scale,
      };
    }

    function hitNode(px, py) {
      // Probe spatial neighborhood only — O(cells) instead of scanning all 484 every move.
      const pad = 4;
      const rect = { minX: px - pad, minY: py - pad, maxX: px + pad, maxY: py + pad };
      const candidates = nodesTouchingRect(rect);
      candidates.sort((a, b) => (NODE_DRAW_ORDER[a.type] || 0) - (NODE_DRAW_ORDER[b.type] || 0));
      for (let i = candidates.length - 1; i >= 0; i--) {
        const n = candidates[i];
        if (px >= n.x && px <= n.x + n.w && py >= n.y && py <= n.y + n.h) return n;
      }
      return null;
    }

    /* ================= selection / hover / readout ================= */

    function setActive(id) {
      ui.active = id;
      document.body.classList.toggle('has-active', !!id);
      renderEdges();
      applyLabelHighlights();
      scheduleFrame({ lodPaint: true });
    }

    function setPathForNode(id) {
      const node = id ? byId.get(id) : null;
      ui.path = node ? freezeShortestPath(graphModel, node) : null;
      for (const [nid, g] of nodeEls) {
        const onPath = !!(ui.path && ui.path.nodes && ui.path.nodes.some((n) => freezeNodeId(n) === nid));
        g.classList.toggle('on-path', onPath);
        if (onPath) g.setAttribute('data-shortest-path-node', 'true');
        else g.removeAttribute('data-shortest-path-node');
      }
      renderPathAccent();
      applyLabelHighlights();
    }

    function selectNode(id, { fromList = false } = {}) {
      ui.selected = id;
      ui.hovered = null;
      for (const [nid, g] of nodeEls) g.classList.toggle('sel', nid === id);
      setPathForNode(id);
      setActive(id);
      updateReadout(id);
      if (fromList) {
        showToast(`Selected ${byId.get(id).name}.`);
        svg.focus({ preventScroll: true });
      }
    }

    function clearSelection() {
      ui.selected = null;
      ui.hovered = null;
      ui.path = null;
      for (const g of nodeEls.values()) {
        g.classList.remove('sel');
        g.classList.remove('on-path');
        g.removeAttribute('data-shortest-path-node');
      }
      if (pathAccent) pathAccent.setAttribute('d', '');
      setActive(null);
      updateReadout(null);
    }

    function neighborButtons(id) {
      const n = byId.get(id);
      const seen = new Set();
      const names = [];
      for (const e of n.neighbors) {
        const other = byId.get(e.from === id ? e.to : e.from);
        if (!seen.has(other.id)) { seen.add(other.id); names.push(other); }
      }
      return names.sort((a, b) => a.name.localeCompare(b.name));
    }

    function connectionLines(id) {
      const n = byId.get(id);
      return n.neighbors.map((e) => {
        const other = byId.get(e.from === id ? e.to : e.from);
        const meta = `${e.label} · ${e.tier}/${e.strength}`;
        const evidence = e.evidence ? ` — ${e.evidence}` : '';
        return { other, text: `${other.name} — ${meta}${evidence}` };
      }).sort((a, b) => a.other.name.localeCompare(b.other.name));
    }

    function updateReadout(id) {
      if (!id) {
        const source = BOARD.source;
        const note = source
          ? `${NODES.length} sticky notes \u00b7 ${EDGES.length} yarn strings` +
            (source.local ? ' \u00b7 local edits saved on this device' :
              (source.url ? ` \u00b7 snapshot of Traditionology\u2019s public RedString board` : ''))
          : `${NODES.length} subjects \u00b7 ${EDGES.length} connections`;
        readout.innerHTML =
          '<p class="ro-kicker">Board status</p>' +
          '<h2>Freese Index</h2>' +
          `<p class="ro-role">${note}</p>` +
          '<p class="ro-blurb">Cork wall, sticky notes, red yarn. Browse freely, or Edit to post notes and yarn. Links on a note appear here when selected. Share view-only copies a guest URL. Use Panels to hide chrome.</p>' +
          '<div class="ro-legend">' +
          `<span><i style="background:${TYPES.pink.color}"></i>Pink</span>` +
          `<span><i style="background:${TYPES.yellow.color}"></i>Yellow</span>` +
          `<span><i style="background:${TYPES.blue.color}"></i>Blue</span>` +
          `<span><i style="background:${TYPES.green.color}"></i>Green</span>` +
          '</div>' +
          '<p class="ro-hint">Drag to pan \u00b7 scroll to zoom out into the cork cosmos \u00b7 click a note \u00b7 <kbd>E</kbd> edit (move / add / yarn) \u00b7 <kbd>P</kbd> panels \u00b7 <kbd>F</kbd> fit \u00b7 <kbd>D</kbd> dim yarn \u00b7 <kbd>Esc</kbd> clear</p>';
        return;
      }
      const n = byId.get(id);
      if (!n) { updateReadout(null); return; }
      const type = TYPES[n.type] || TYPES.yellow;
      const links = neighborButtons(id);
      const connections = connectionLines(id);
      const affiliations = freezeConnectedAffiliations(n, graphModel);
      const counts = n.neighbors.length;
      const pathDetails = freezePathSummary(n, graphModel, ui.path);
      const attachments = Array.isArray(n.attachments) ? n.attachments.filter((a) => a && (a.url || a.label)) : [];

      readout.innerHTML =
        '<p class="ro-kicker">' + (ui.selected === id ? 'Selected subject' : 'Subject') + '</p>' +
        `<h2>${escapeHtml(n.name)}</h2>` +
        `<p class="ro-role">${escapeHtml(n.role || '')}</p>` +
        `<span class="typechip"><i style="background:${type.color}"></i>${escapeHtml(type.label)}</span>` +
        `<p class="ro-blurb">${escapeHtml(n.blurb || '')}</p>` +
        (affiliations ? `<p class="ro-affil">Affiliations: ${escapeHtml(affiliations)}</p>` : '') +
        (attachments.length
          ? '<ul class="ro-attachments" aria-label="Attachments">' +
            attachments.map((a) => {
              const label = escapeHtml(a.label || a.url || 'Link');
              const url = String(a.url || '').trim();
              if (url) return `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a></li>`;
              return `<li>${label}</li>`;
            }).join('') +
            '</ul>'
          : '') +
        '<div class="ro-meta">' +
        `<div class="cell"><b>${counts}</b><span>strings</span></div>` +
        `<div class="cell"><b>${links.length}</b><span>related</span></div>` +
        '</div>' +
        (connections.length
          ? '<ul class="ro-connections" aria-label="Direct connections">' +
            connections.slice(0, 8).map((c) => `<li>${escapeHtml(c.text)}</li>`).join('') +
            '</ul>'
          : '') +
        (links.length
          ? '<div class="ro-links" aria-label="Related subjects">' +
            links.slice(0, 9).map((l) => `<button class="ro-link" type="button" data-go="${escapeHtml(l.id)}">${escapeHtml(l.name)}</button>`).join('') +
            '</div>'
          : '') +
        '<section class="ro-path" data-freeze-path-section="true" aria-label="Path to Josh Freese">' +
        '<p class="ro-path-title">Path to Josh Freese</p>' +
        `<p class="ro-path-summary">${escapeHtml(pathDetails.summary)}</p>` +
        (pathDetails.hops.length
          ? '<ul class="ro-path-hops">' + pathDetails.hops.map((hop) => `<li>${escapeHtml(hop)}</li>`).join('') + '</ul>'
          : '') +
        '</section>' +
        (ui.editing
          ? '<div class="ro-edit-actions">' +
            '<button type="button" class="btn" data-edit="link">Link yarn</button>' +
            '<button type="button" class="btn btn-ghost" data-edit="delete-note">Delete note</button>' +
            '<button type="button" class="btn btn-ghost" data-edit="clear-yarn">Clear yarn</button>' +
            '</div>'
          : '<p class="ro-hint">Local board — edits stay on this device until you Save / Export.</p>');
      for (const b of readout.querySelectorAll('[data-go]')) {
        b.addEventListener('click', () => selectNode(b.getAttribute('data-go')));
      }
      for (const b of readout.querySelectorAll('[data-edit]')) {
        b.addEventListener('click', () => handleEditAction(b.getAttribute('data-edit'), id));
      }
    }

    /* ================= toast ================= */

    let toastTimer = null;
    function showToast(msg) {
      toast.textContent = msg;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
    }

    /* ================= pointer interactions ================= */

    function onPointerDown(e) {
      svg.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        drag.mode = null;
        return;
      }

      if (pointers.size > 2) return;

      const p = worldPoint(e.clientX, e.clientY);
      const n = hitNode(p.x, p.y);
      drag.sx = e.clientX; drag.sy = e.clientY;
      drag.moved = false;

      if (n && !ui.viewOnly && ui.editing) {
        drag.mode = 'node'; drag.id = n.id; drag.nx = n.x; drag.ny = n.y;
        nodeEls.get(n.id).classList.add('dragging');
        document.body.classList.add('interactive-drag');
      } else {
        drag.mode = 'pan';
        drag.px = e.clientX; drag.py = e.clientY;
      }
    }

    function onPointerMove(e) {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // pinch zoom
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (dist > 0 && pinch.dist > 0) {
          const r = svg.getBoundingClientRect();
          zoomAt(mx - r.left, my - r.top, dist / pinch.dist);
        }
        pinch.dist = dist; pinch.mx = mx; pinch.my = my;
        return;
      }

      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;

      if (drag.mode === 'node' && drag.id) {
        const n = byId.get(drag.id);
        n.x = drag.nx + dx / view.scale;
        n.y = drag.ny + dy / view.scale;
        n.cx = n.x + n.w / 2; n.cy = n.y + n.h / 2;
        n.x = clamp(n.x, -n.w, WORLD.w);
        n.y = clamp(n.y, -n.h, WORLD.h);
        n.cx = n.x + n.w / 2; n.cy = n.y + n.h / 2;
        nodeEls.get(n.id).setAttribute('transform', `translate(${n.x},${n.y})`);
        scheduleEdgeRedraw();
        return;
      }

      if (drag.mode === 'pan') {
        view.tx += e.clientX - drag.px;
        view.ty += e.clientY - drag.py;
        drag.px = e.clientX; drag.py = e.clientY;
        clampPan();
        applyTransform();
        view.fitted = true;
        return;
      }

      // hover (no buttons down) — touch only the previous + next node (never all 484).
      if (!drag.mode && pointers.size === 0) {
        const p = worldPoint(e.clientX, e.clientY);
        const n = hitNode(p.x, p.y);
        const id = n ? n.id : null;
        if (id !== ui.hovered) {
          if (ui.hovered) {
            const prev = nodeEls.get(ui.hovered);
            if (prev) prev.classList.remove('hovered');
          }
          if (id) {
            const next = nodeEls.get(id);
            if (next) next.classList.add('hovered');
          }
          ui.hovered = id;
          svg.style.cursor = n
            ? ((ui.editing || ui.linkFrom) ? 'pointer' : 'grab')
            : (ui.linkFrom ? 'crosshair' : 'grab');
        }
      }
    }

    function onPointerUp(e) {
      pointers.delete(e.pointerId);
      pinch = null;

      if (drag.mode === 'node' && drag.id) {
        nodeEls.get(drag.id).classList.remove('dragging');
        document.body.classList.remove('interactive-drag');
        if (!drag.moved) {
          if (ui.linkFrom) completeLink(drag.id);
          else selectNode(drag.id);
        } else {
          rebuildSpatialIndex();
          expandWorldIfNeeded();
          persistBoard(false);
          scheduleFrame({ cull: true, edges: true, lodPaint: true, labels: true });
        }
        drag.mode = null; drag.id = null;
        return;
      }

      if (drag.mode === 'pan') {
        const p = worldPoint(e.clientX, e.clientY);
        if (!drag.moved) {
          const n = hitNode(p.x, p.y);
          if (n) {
            if (ui.linkFrom) completeLink(n.id);
            else selectNode(n.id);
          } else {
            if (ui.linkFrom) {
              ui.linkFrom = null;
              document.body.classList.remove('linking');
              showToast('Yarn link cancelled.');
            }
            clearSelection();
          }
        }
        drag.mode = null;
        flushCosmosPersist();
        scheduleFrame({ transform: true, cull: true, edges: true, labels: true, lodPaint: true });
      }
    }

    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('pointercancel', onPointerUp);

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0022));
      view.fitted = true;
    }, { passive: false });

    svg.addEventListener('dblclick', (e) => {
      const p = worldPoint(e.clientX, e.clientY);
      const n = hitNode(p.x, p.y);
      if (n) selectNode(n.id);
    });

    /* keyboard: pan/zoom/shortcuts on the board */
    svg.addEventListener('keydown', (e) => {
      const step = 42 / view.scale;
      switch (e.key) {
        case 'ArrowLeft':  view.tx += step; break;
        case 'ArrowRight': view.tx -= step; break;
        case 'ArrowUp':    view.ty += step; break;
        case 'ArrowDown':  view.ty -= step; break;
        case '+': case '=': zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 1.25); break;
        case '-': case '_': zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 0.8); break;
        case 'f': case 'F': case '0': fitView(true); break;
        case 'd': case 'D': toggleDim(); break;
        case 'e': case 'E': toggleEditing(); break;
        case 'p': case 'P': toggleChrome(); break;
        case 'a': case 'A': startAddNote(); break;
        case 'Escape':
          if (ui.linkFrom) {
            ui.linkFrom = null;
            document.body.classList.remove('linking');
            showToast('Yarn link cancelled.');
          } else if (noteModal && !noteModal.hidden) {
            closeNoteModal();
          } else {
            clearSelection();
          }
          break;
        default: return;
      }
      e.preventDefault();
      view.fitted = true;
      applyTransform();
      clampPan();
    });

    /* ================= toggles + editor ================= */

    function setEditorChrome(editing) {
      if (ui.viewOnly) editing = false;
      ui.editing = editing;
      // Dragging notes is edit-mode only — leaving edit must lock the board.
      ui.interactive = editing;
      document.body.classList.toggle('editing', editing);
      document.body.classList.toggle('interactive', editing);
      if (modeBtn) modeBtn.setAttribute('aria-pressed', String(editing));
      if (modeLabel) modeLabel.textContent = editing ? 'Done editing' : 'Edit board';
      for (const el of document.querySelectorAll('.editor-only')) {
        el.hidden = !editing;
      }
      if (!editing) {
        ui.linkFrom = null;
        document.body.classList.remove('linking');
        if (drag.mode === 'node' && drag.id) {
          const g = nodeEls.get(drag.id);
          if (g) g.classList.remove('dragging');
          document.body.classList.remove('interactive-drag');
          drag.mode = null;
          drag.id = null;
        }
      }
      updateReadout(ui.selected);
    }

    function toggleEditing() {
      if (ui.viewOnly) {
        showToast('This is a view-only link — editing is off. Open the main URL to edit.');
        return;
      }
      setEditorChrome(!ui.editing);
      showToast(ui.editing
        ? 'Edit mode — drag notes, Add note, Link yarn, Reorganize.'
        : 'Browse mode — notes locked. Pan and zoom only.');
    }

    function startAddNote() {
      if (ui.viewOnly) {
        showToast('View-only link — editing disabled.');
        return;
      }
      if (!ui.editing) setEditorChrome(true);
      if (!ui.chromeVisible) {
        ui.chromeVisible = true;
        document.body.classList.remove('chrome-collapsed');
        if (chromeBtn) chromeBtn.setAttribute('aria-checked', 'true');
      }
      openNoteModal();
    }

    async function copyViewOnlyLink() {
      const shareUrl = freezeLocalShareUrl(null, { viewOnly: true, shared: true });
      const ok = await copyText(shareUrl);
      showToast(ok
        ? 'Copied view-only URL (no edit chrome; ignores this browser’s local edits).'
        : 'Could not copy — use ?view=1&shared=1 on the site URL.');
    }

    function toggleChrome() {
      ui.chromeVisible = !ui.chromeVisible;
      document.body.classList.toggle('chrome-collapsed', !ui.chromeVisible);
      if (chromeBtn) chromeBtn.setAttribute('aria-checked', String(ui.chromeVisible));
      showToast(ui.chromeVisible ? 'Panels shown.' : 'Panels hidden — board clear.');
    }

    function toggleDim() {
      ui.dim = !ui.dim;
      document.body.classList.toggle('dim', ui.dim);
      document.getElementById('btn-dim').setAttribute('aria-checked', String(ui.dim));
      scheduleFrame({ lodPaint: true });
      showToast(ui.dim ? 'Yarn dimmed.' : 'Yarn restored.');
    }

    function handleEditAction(action, id) {
      if (ui.viewOnly || !ui.editing) return;
      if (action === 'link') {
        ui.linkFrom = id;
        document.body.classList.add('linking');
        showToast('Click another note to stretch yarn.');
        return;
      }
      if (action === 'delete-note') {
        if (!window.confirm('Delete this sticky note and its yarn?')) return;
        deleteNote(id);
        return;
      }
      if (action === 'clear-yarn') {
        clearYarnFor(id);
      }
    }

    function completeLink(targetId) {
      const fromId = ui.linkFrom;
      ui.linkFrom = null;
      document.body.classList.remove('linking');
      if (!fromId || !targetId || fromId === targetId) {
        showToast('Yarn link cancelled.');
        return;
      }
      const exists = EDGES.some((e) =>
        (e.from === fromId && e.to === targetId) || (e.from === targetId && e.to === fromId)
      );
      if (exists) {
        showToast('Those notes are already linked.');
        selectNode(targetId);
        return;
      }
      const label = window.prompt('Yarn label (optional)', 'connected') || 'connected';
      const joshId = freezeJoshId();
      const touches = fromId === joshId || targetId === joshId;
      EDGES.push({
        id: newId('e'),
        from: fromId,
        to: targetId,
        label: String(label).trim() || 'connected',
        tier: touches ? 'core' : 'related',
        strength: touches ? 'high' : 'medium',
      });
      refreshBoard({ persist: true });
      selectNode(targetId);
      showToast('Yarn posted.');
    }

    function deleteNote(id) {
      const joshId = freezeJoshId();
      if (id === joshId) {
        showToast('Josh Freese is the hub — cannot delete.');
        return;
      }
      const ni = NODES.findIndex((n) => n.id === id);
      if (ni < 0) return;
      NODES.splice(ni, 1);
      for (let i = EDGES.length - 1; i >= 0; i--) {
        if (EDGES[i].from === id || EDGES[i].to === id) EDGES.splice(i, 1);
      }
      ui.selected = null;
      refreshBoard({ persist: true });
      showToast('Note deleted.');
    }

    function clearYarnFor(id) {
      let removed = 0;
      for (let i = EDGES.length - 1; i >= 0; i--) {
        if (EDGES[i].from === id || EDGES[i].to === id) {
          EDGES.splice(i, 1);
          removed += 1;
        }
      }
      refreshBoard({ persist: true });
      selectNode(id);
      showToast(removed ? `Cleared ${removed} yarn string${removed === 1 ? '' : 's'}.` : 'No yarn on this note.');
    }

    function addAttachmentRow(label, url) {
      if (!noteAttachments) return;
      const row = document.createElement('div');
      row.className = 'attach-row';
      row.innerHTML =
        `<input type="text" data-attach="label" placeholder="Label" value="${escapeHtml(label || '')}">` +
        `<input type="url" data-attach="url" placeholder="https://..." value="${escapeHtml(url || '')}">` +
        '<button type="button" class="btn btn-ghost btn-tiny" data-attach="remove">Remove</button>';
      row.querySelector('[data-attach="remove"]').addEventListener('click', () => row.remove());
      noteAttachments.appendChild(row);
    }

    function readAttachmentRows() {
      if (!noteAttachments) return [];
      return [...noteAttachments.querySelectorAll('.attach-row')].map((row) => ({
        label: row.querySelector('[data-attach="label"]').value.trim(),
        url: row.querySelector('[data-attach="url"]').value.trim(),
      })).filter((a) => a.label || a.url);
    }

    function openNoteModal() {
      if (!ui.editing || !noteModal) return;
      noteForm.reset();
      noteAttachments.textContent = '';
      addAttachmentRow('', '');
      noteModal.hidden = false;
      document.getElementById('note-name').focus();
    }

    function closeNoteModal() {
      if (!noteModal) return;
      noteModal.hidden = true;
    }

    function submitNoteForm(e) {
      e.preventDefault();
      const name = document.getElementById('note-name').value.trim();
      if (!name) return;
      const color = document.getElementById('note-color').value || 'yellow';
      const blurb = document.getElementById('note-blurb').value.trim();
      const attachments = readAttachmentRows();
      const cx = (-view.tx + svg.clientWidth / 2) / view.scale;
      const cy = (-view.ty + svg.clientHeight / 2) / view.scale;
      const node = {
        id: newId('n'),
        type: color,
        name,
        role: 'Subject on the Freese Index board',
        blurb: blurb || 'Posted in edit mode.',
        x: cx - 70,
        y: cy - 30,
        attachments,
      };
      NODES.push(node);
      closeNoteModal();
      expandWorldIfNeeded();
      refreshBoard({ persist: true });
      selectNode(node.id);
      centerNode(node.id);
      showToast(`Pinned “${name}”.`);
    }

    function reorganizeAroundJosh() {
      const joshId = freezeJoshId();
      const josh = byId.get(joshId) || NODES.find((n) => /^josh freese$/i.test(n.name));
      if (!josh) {
        showToast('Josh Freese not found — cannot reorganize.');
        return;
      }
      showToast('Reorganizing around Josh…');
      const model = freezeGraphModel(NODES, EDGES);
      const dist = new Map();
      const queue = [josh.id];
      dist.set(josh.id, 0);
      while (queue.length) {
        const cur = queue.shift();
        const d = dist.get(cur);
        const nbrs = model.adjacency.get(cur) || [];
        for (const { id: other } of nbrs) {
          if (dist.has(other)) continue;
          dist.set(other, d + 1);
          queue.push(other);
        }
      }
      const rings = new Map();
      for (const n of NODES) {
        const d = dist.has(n.id) ? dist.get(n.id) : 99;
        if (!rings.has(d)) rings.set(d, []);
        rings.get(d).push(n);
      }
      const originX = WORLD.w / 2;
      const originY = WORLD.h / 2;
      josh.x = originX - josh.w / 2;
      josh.y = originY - josh.h / 2;
      for (const [d, members] of rings) {
        if (d === 0) continue;
        const radius = 160 + d * 210;
        members.sort((a, b) => a.name.localeCompare(b.name));
        members.forEach((n, i) => {
          const angle = (Math.PI * 2 * i) / members.length - Math.PI / 2;
          n.x = originX + Math.cos(angle) * radius - n.w / 2;
          n.y = originY + Math.sin(angle) * radius - n.h / 2;
        });
      }
      // light separation pass
      for (let pass = 0; pass < 18; pass++) {
        for (let i = 0; i < NODES.length; i++) {
          for (let j = i + 1; j < NODES.length; j++) {
            const a = NODES[i], b = NODES[j];
            const dx = (a.x + a.w / 2) - (b.x + b.w / 2);
            const dy = (a.y + a.h / 2) - (b.y + b.h / 2);
            const gapX = (a.w + b.w) / 2 + 12;
            const gapY = (a.h + b.h) / 2 + 12;
            if (Math.abs(dx) < gapX && Math.abs(dy) < gapY) {
              const push = 0.35;
              const sx = dx === 0 ? (Math.random() - 0.5) : Math.sign(dx) * (gapX - Math.abs(dx)) * push;
              const sy = dy === 0 ? (Math.random() - 0.5) : Math.sign(dy) * (gapY - Math.abs(dy)) * push;
              if (a.id !== josh.id) { a.x += sx; a.y += sy; }
              if (b.id !== josh.id) { b.x -= sx; b.y -= sy; }
            }
          }
        }
      }
      for (const n of NODES) {
        n.x = clamp(n.x, 40, WORLD.w - n.w - 40);
        n.y = clamp(n.y, 40, WORLD.h - n.h - 40);
      }
      refreshBoard({ persist: true, fit: true });
      showToast('Board reorganized around Josh Freese.');
    }

    function exportBoardPng() {
      showToast('Rendering PNG…');
      // Fit export to a safe canvas budget (~4096 max edge) for ~500 notes.
      const pad = 40;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of NODES) {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.w);
        maxY = Math.max(maxY, n.y + n.h);
      }
      if (!Number.isFinite(minX)) {
        showToast('Nothing to export.');
        return;
      }
      const bw = maxX - minX + pad * 2;
      const bh = maxY - minY + pad * 2;
      const maxEdge = 4096;
      const scale = Math.min(1, maxEdge / Math.max(bw, bh));
      const outW = Math.max(1, Math.round(bw * scale));
      const outH = Math.max(1, Math.round(bh * scale));

      // Snapshot must be SVG-complete (uncull + full yarn) — far LOD uses canvas for live view only.
      for (const [, g] of nodeEls) g.classList.remove('is-culled');
      if (edgesCorePath) edgesCorePath.setAttribute('d', edgePathData(edgesByTier('core'), null));
      if (edgesStrongPath) edgesStrongPath.setAttribute('d', edgePathData(edgesByTier('strong'), null));
      edgesPath.setAttribute('d', edgePathData(edgesByTier('related'), null));

      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', String(outW));
      clone.setAttribute('height', String(outH));
      clone.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${bw} ${bh}`);
      const worldEl = clone.querySelector('#world');
      if (worldEl) worldEl.removeAttribute('transform');
      // Restore live LOD after cloning the hydrated SVG.
      flushFrame();

      const serializer = new XMLSerializer();
      const svgText = serializer.serializeToString(clone);
      const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = outW;
          canvas.height = outH;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#5c4124';
          ctx.fillRect(0, 0, outW, outH);
          ctx.drawImage(img, 0, 0, outW, outH);
          canvas.toBlob((png) => {
            URL.revokeObjectURL(url);
            if (!png) {
              showToast('PNG export failed in this browser.');
              return;
            }
            const a = document.createElement('a');
            a.href = URL.createObjectURL(png);
            a.download = 'freese-index-board.png';
            document.body.appendChild(a);
            a.click();
            a.remove();
            showToast(`Exported PNG (${outW}\u00d7${outH}).`);
          }, 'image/png');
        } catch (_) {
          URL.revokeObjectURL(url);
          showToast('PNG export failed.');
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        showToast('Could not rasterize the board SVG.');
      };
      img.src = url;
    }

    /* ================= local board snapshot / actions ================= */

    function currentSnapshot() {
      const selected = ui.selected ? byId.get(ui.selected) : null;
      return freezeBoardSnapshot(graphModel, selected, ui.path);
    }

    async function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      document.body.removeChild(area);
      return ok;
    }

    function downloadSnapshot() {
      persistBoard(true);
      const payload = JSON.stringify(currentSnapshot(), null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'freese-index-board.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    /* ================= chrome buttons ================= */

    document.getElementById('btn-back').addEventListener('click', () => {
      showToast('Back — this board has no history stack.');
    });
    document.getElementById('btn-dim').addEventListener('click', toggleDim);
    if (modeBtn) modeBtn.addEventListener('click', toggleEditing);
    const addFab = document.getElementById('btn-add-fab');
    if (addFab) addFab.addEventListener('click', startAddNote);
    if (chromeBtn) chromeBtn.addEventListener('click', toggleChrome);
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 1.3); view.fitted = true;
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 1 / 1.3); view.fitted = true;
    });
    document.getElementById('btn-fit').addEventListener('click', () => { fitView(true); view.fitted = true; });
    const addBtn = document.getElementById('btn-add-note');
    if (addBtn) addBtn.addEventListener('click', startAddNote);
    const reorgBtn = document.getElementById('btn-reorganize');
    if (reorgBtn) reorgBtn.addEventListener('click', reorganizeAroundJosh);
    const pngBtn = document.getElementById('btn-export-png');
    if (pngBtn) pngBtn.addEventListener('click', exportBoardPng);
    if (noteForm) noteForm.addEventListener('submit', submitNoteForm);
    const noteCancel = document.getElementById('note-cancel');
    if (noteCancel) noteCancel.addEventListener('click', closeNoteModal);
    const noteAttachAdd = document.getElementById('note-attach-add');
    if (noteAttachAdd) noteAttachAdd.addEventListener('click', () => addAttachmentRow('', ''));
    if (noteModal) {
      noteModal.addEventListener('click', (ev) => {
        if (ev.target === noteModal) closeNoteModal();
      });
    }

    for (const btn of document.querySelectorAll('.act')) {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-action');
        try {
          if (action === 'save') {
            downloadSnapshot();
            showToast('Saved JSON snapshot (also stored in this browser).');
            return;
          }
          if (action === 'export-png') {
            exportBoardPng();
            return;
          }
          if (action === 'copy') {
            persistBoard(true);
            const ok = await copyText(JSON.stringify(currentSnapshot(), null, 2));
            showToast(ok ? 'Copied board JSON.' : 'Could not copy — use Save instead.');
            return;
          }
          if (action === 'share') {
            const shareUrl = freezeLocalShareUrl(null, { viewOnly: true, shared: true });
            const ok = await copyText(shareUrl);
            showToast(ok
              ? 'Copied view-only share URL (?view=1&shared=1).'
              : 'Copy failed — use ?view=1&shared=1 on the address bar.');
            return;
          }
          if (action === 'report') {
            showToast('Report stays local — nothing was sent.');
            return;
          }
          if (action === 'discussion') {
            showToast('Discussion is local-only here (0 comments).');
            return;
          }
          showToast('Local action.');
        } catch (_) {
          showToast('Local action failed in this browser.');
        }
      });
    }

    /* ================= screen-reader node index ================= */

    const index = document.getElementById('node-index');

    function rebuildNodeIndex() {
      if (!index) return;
      index.textContent = '';
      for (const n of NODES.slice().sort((a, b) => a.name.localeCompare(b.name))) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.id = n.id;
        btn.textContent = `${n.name}: ${n.role || 'note'}. ${(n.neighbors || []).length} connections.`;
        btn.addEventListener('focus', () => selectNode(n.id));
        btn.addEventListener('click', () => selectNode(n.id, { fromList: true }));
        li.appendChild(btn);
        index.appendChild(li);
      }
    }

    function centerNode(idOrNode) {
      const id = typeof idOrNode === 'string' || typeof idOrNode === 'number'
        ? String(idOrNode)
        : (idOrNode && idOrNode.id);
      const n = id ? byId.get(id) : null;
      if (!n) return;
      const cw = svg.clientWidth || 0;
      const ch = svg.clientHeight || 0;
      if (!cw || !ch) return;
      view.tx = cw / 2 - n.cx * view.scale;
      view.ty = ch / 2 - n.cy * view.scale;
      clampPan();
      applyTransform();
      view.fitted = true;
    }

    function renderBoard() {
      renderEdges();
      renderLabels();
    }

    function applyHashSelection() {
      const hash = String(location.hash || '').replace(/^#/, '');
      if (!hash) return;
      const params = new URLSearchParams(hash.includes('=') ? hash : `node=${hash}`);
      const nodeId = params.get('node');
      if (nodeId && byId.has(nodeId)) selectNode(nodeId);
    }

    /* ================= boot ================= */

    if (ui.viewOnly) {
      document.body.classList.add('view-only');
      document.title = 'Freese Index · View only';
      const viewBadge = document.getElementById('view-only-badge');
      if (viewBadge) viewBadge.hidden = false;
    }
    setEditorChrome(false);
    if (chromeBtn) chromeBtn.setAttribute('aria-checked', 'true');
    // Skip per-note settle animation on large boards (hundreds of CSS animations tank phones).
    if (NODES.length <= 60) document.body.classList.add('settle-anim');
    buildNodes();
    rebuildNodeIndex();
    fitView();
    flushFrame();
    updateReadout(null);
    if (!ui.viewOnly) persistBoard(true); // keep expanded cork size in this browser
    showToast(ui.viewOnly
      ? 'View-only board — pan, deep-zoom, and search. Editing is off.'
      : 'Tip: Add note to post. Share board copies a view-only URL for friends.');

    window.__freezeIndexBoard = {
      selectNode: (id) => selectNode(typeof id === 'object' ? id.id : id),
      getSelectedNode: () => (ui.selected ? byId.get(ui.selected) || ui.selected : null),
      getPath: () => ui.path,
      centerNode,
      render: renderBoard,
      snapshot: currentSnapshot,
      setEditing: setEditorChrome,
      exportPng: exportBoardPng,
      reorganize: reorganizeAroundJosh,
    };

    freezeStartSearch(graphModel, (node) => {
      const bridge = freezeIndexBoardBridge();
      if (bridge && typeof bridge.selectNode === 'function') {
        bridge.selectNode(freezeNodeId(node));
      } else {
        selectNode(freezeNodeId(node));
      }
      centerNode(node);
    });

    // Keep search count in sync with live board size
    const searchCount = document.getElementById('freeze-search-count');
    if (searchCount) searchCount.textContent = `${NODES.length} subjects on the board`;

    applyHashSelection();

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!view.fitted) { fitView(); }
        else { clampPan(); applyTransform(); }
      }, 120);
    });
  })();
}

/* allow the graph helpers to be unit-checked under Node */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TYPES,
    NODES,
    EDGES,
    finalizeNodes,
    freezeGraphModel,
    freezeNormalizeEdgeMeta,
    freezeShortestPath,
    freezePathSummary,
    freezeSearchNodes,
    freezeNodeCoordinates,
    freezeConnectedAffiliations,
    freezeBoardSnapshot,
    freezeLocalShareUrl,
    freezeResolveNode,
    freezeDescribeHop,
    freezeHighlightPath,
  };
}

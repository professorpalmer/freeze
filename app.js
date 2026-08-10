/* ============================================================================
   Freese Index — independent mockup of a RedString-style investigation board
   ----------------------------------------------------------------------------
   · Pure client-side runtime: no network requests, no auth, no external assets.
   · Graph data is a static snapshot in board-data.js (imported offline from the
     public RedString Freese Index board via scripts/import-redstring.mjs).
   · Graph is rendered into a SINGLE inline <svg>. Edges are batched into
     tiered <path> elements (base + active + path accent), labels share one
     <g>, and each node is one <g>.
   · Pan (drag / arrows), zoom (wheel / buttons / pinch), fit-to-view,
     dim-strings toggle, node dragging when interactivity is on, hover and
     selection treatment, and a detail/status readout.
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
    nodes: model.nodes.map((node) => ({
      id: freezeNodeId(node),
      name: freezeNodeName(node),
      type: freezeNodeTypeKey(node),
      role: freezeNodeRole(node),
      blurb: freezeNodeBlurb(node),
      x: node.x,
      y: node.y,
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

function freezeLocalShareUrl(selectedId) {
  if (typeof location === 'undefined') {
    return selectedId ? `#node=${encodeURIComponent(selectedId)}` : '#board';
  }
  const url = new URL(location.href);
  url.search = '';
  url.hash = selectedId ? `node=${encodeURIComponent(selectedId)}` : 'board';
  return url.toString();
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
      count.textContent = `${model.nodes.length} subjects on the board`;
      results.setAttribute('aria-label', count.textContent);
      const empty = document.createElement('li');
      empty.className = 'freeze-search-empty';
      empty.textContent = 'Type to filter by name, role, type, or affiliation';
      results.appendChild(empty);
      return;
    }

    const found = freezeSearchNodes(model, query, 12);
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

const BOARD = freezeBoardPayload();
const NODES = Array.isArray(BOARD.nodes) ? BOARD.nodes : [];
const EDGES = Array.isArray(BOARD.edges) ? BOARD.edges : [];
const BOARD_WORLD = (BOARD.world && BOARD.world.w && BOARD.world.h)
  ? { w: BOARD.world.w, h: BOARD.world.h }
  : { w: 2000, h: 1400 };

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
    const byId = finalizeNodes();
    const graphModel = freezeGraphModel(NODES, EDGES);
    const WORLD = { w: BOARD_WORLD.w, h: BOARD_WORLD.h };

    const svg = document.getElementById('graph');
    const world = document.getElementById('world');
    const boardBg = document.getElementById('board-bg');
    const boardBgShade = document.getElementById('board-bg-shade');
    if (boardBg) {
      boardBg.setAttribute('width', String(WORLD.w));
      boardBg.setAttribute('height', String(WORLD.h));
    }
    if (boardBgShade) {
      boardBgShade.setAttribute('width', String(WORLD.w));
      boardBgShade.setAttribute('height', String(WORLD.h));
    }
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

    /* ----- view state ----- */
    const view = { tx: 0, ty: 0, scale: 1, fitted: false };
    const ui = { dim: false, interactive: false, selected: null, hovered: null, active: null, path: null };
    const drag = { mode: null, id: null, sx: 0, sy: 0, nx: 0, ny: 0, moved: false };
    const pointers = new Map(); // pointerId -> {x,y}
    let pinch = null;           // {dist, mx, my}

    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const NODE_DRAW_ORDER = { subject: 0, project: 1, band: 2, person: 3, pink: 4, yellow: 5, green: 6, blue: 7 };

    /* ================= build the static graph DOM ================= */

    const nodeEls = new Map();

    function quadAt(p0x, p0y, p1x, p1y, t) {
      return freezeQuadPoint(p0x, p0y, p1x, p1y, t);
    }

    function edgePathData(edges) {
      let d = '';
      for (const e of edges) {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) continue;
        const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
        const sag = Math.min(42, Math.hypot(b.cx - a.cx, b.cy - a.cy) * 0.09);
        d += `M${a.cx.toFixed(1)},${a.cy.toFixed(1)} Q${mx.toFixed(1)},${(my + sag).toFixed(1)} ${b.cx.toFixed(1)},${b.cy.toFixed(1)}`;
      }
      return d;
    }

    function edgesByTier(tier) {
      return EDGES.filter((e) => (e.tier || 'related') === tier);
    }

    function renderEdges() {
      if (edgesCorePath) edgesCorePath.setAttribute('d', edgePathData(edgesByTier('core')));
      if (edgesStrongPath) edgesStrongPath.setAttribute('d', edgePathData(edgesByTier('strong')));
      edgesPath.setAttribute('d', edgePathData(edgesByTier('related')));
      const activeId = ui.active;
      const active = activeId ? EDGES.filter((e) => e.from === activeId || e.to === activeId) : [];
      activePath.setAttribute('d', edgePathData(active));
      renderPathAccent();
    }

    function renderPathAccent() {
      if (!pathAccent) return;
      pathAccent.setAttribute('d', freezeHighlightPath(graphModel, ui.path || { edges: [] }));
    }

    function renderLabels() {
      labelsG.textContent = '';
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

    function buildNodes() {
      const sorted = NODES.slice().sort((a, b) => NODE_DRAW_ORDER[a.type] - NODE_DRAW_ORDER[b.type]);
      for (const n of sorted) {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'node' + (n.big ? ' big' : ''));
        g.setAttribute('data-node-id', n.id);
        g.setAttribute('data-type', n.type);
        g.setAttribute('id', n.id);
        g.setAttribute('transform', `translate(${n.x},${n.y})`);
        g.setAttribute('role', 'group');
        g.setAttribute('aria-label', `${n.name} — ${n.role}`);

        const note = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        note.setAttribute('class', 'note');
        note.setAttribute('transform', `rotate(${n.tilt} ${n.w / 2} ${n.h / 2})`);

        const shadow = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        shadow.setAttribute('class', 'paper-shadow');
        shadow.setAttribute('x', 2.5);
        shadow.setAttribute('y', 3.5);
        shadow.setAttribute('width', n.w);
        shadow.setAttribute('height', n.h);
        shadow.setAttribute('rx', 2);

        const chip = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        chip.setAttribute('class', 'chip');
        chip.setAttribute('width', n.w);
        chip.setAttribute('height', n.h);
        chip.setAttribute('rx', 2);
        chip.setAttribute('fill', n.paper);

        // Curl corner — tiny triangle fold
        const curl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        curl.setAttribute('class', 'tape');
        const cx = n.w;
        const cy = n.h;
        curl.setAttribute('d', `M${cx - 12},${cy} L${cx},${cy - 12} L${cx},${cy} Z`);
        curl.setAttribute('fill', 'rgba(0,0,0,0.06)');
        curl.setAttribute('stroke', 'none');

        const tape = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        tape.setAttribute('class', 'tape');
        tape.setAttribute('x', n.w * 0.28);
        tape.setAttribute('y', -5);
        tape.setAttribute('width', n.w * 0.44);
        tape.setAttribute('height', 12);
        tape.setAttribute('rx', 1);
        tape.setAttribute('transform', `rotate(${(n.tilt % 2 === 0 ? -3 : 4)} ${n.w / 2} 1)`);

        const pinStem = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        pinStem.setAttribute('class', 'pin-stem');
        pinStem.setAttribute('x1', n.w / 2);
        pinStem.setAttribute('y1', 2);
        pinStem.setAttribute('x2', n.w / 2);
        pinStem.setAttribute('y2', 11);

        const pin = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        pin.setAttribute('class', 'pin');
        pin.setAttribute('cx', n.w / 2);
        pin.setAttribute('cy', 7);
        pin.setAttribute('r', n.big ? 5.2 : 4.2);
        pin.setAttribute('fill', n.pin);

        const pinShine = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        pinShine.setAttribute('class', 'pin-shine');
        pinShine.setAttribute('cx', n.w / 2 - 1.4);
        pinShine.setAttribute('cy', 5.6);
        pinShine.setAttribute('r', 1.3);

        const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lbl.setAttribute('class', 'lbl');
        lbl.setAttribute('x', n.w / 2);
        lbl.setAttribute('y', n.big ? 36 : 32);
        lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('fill', n.ink);
        lbl.textContent = n.name;

        note.appendChild(shadow);
        note.appendChild(chip);
        note.appendChild(curl);
        note.appendChild(tape);
        note.appendChild(pinStem);
        note.appendChild(pin);
        note.appendChild(pinShine);
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
        nodesG.appendChild(g);
        nodeEls.set(n.id, g);
      }
    }

    /* ================= transforms ================= */

    function applyTransform() {
      world.setAttribute('transform', `translate(${view.tx},${view.ty}) scale(${view.scale})`);
      zoomPct.textContent = Math.round(view.scale * 100) + '%';
    }

    function fitView(announce) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of NODES) {
        minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
      }
      const pad = 90;
      const bw = maxX - minX + pad * 2, bh = maxY - minY + pad * 2;
      const cw = svg.clientWidth, ch = svg.clientHeight;
      view.scale = clamp(Math.min(cw / bw, ch / bh), 0.05, 1.6);
      view.tx = (cw - bw * view.scale) / 2 - (minX - pad) * view.scale;
      view.ty = (ch - bh * view.scale) / 2 - (minY - pad) * view.scale;
      applyTransform();
      if (announce) showToast('View fitted to the board.');
    }

    function clampPan() {
      const slack = 0.35;
      const cw = svg.clientWidth, ch = svg.clientHeight;
      view.tx = clamp(view.tx, cw - WORLD.w * view.scale - cw * slack, cw * slack);
      view.ty = clamp(view.ty, ch - WORLD.h * view.scale - ch * slack, ch * slack);
    }

    function zoomAt(cx, cy, factor) {
      const ns = clamp(view.scale * factor, 0.05, 4);
      const k = ns / view.scale;
      view.tx = cx - (cx - view.tx) * k;
      view.ty = cy - (cy - view.ty) * k;
      view.scale = ns;
      clampPan();
      applyTransform();
      renderLabels(); // labels track zoom so they stay readable
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
      const order = NODES.slice().sort((a, b) => NODE_DRAW_ORDER[a.type] - NODE_DRAW_ORDER[b.type]);
      for (let i = order.length - 1; i >= 0; i--) {
        const n = order[i];
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
            (source.url ? ` \u00b7 snapshot of Traditionology\u2019s public RedString board` : '')
          : `${NODES.length} subjects \u00b7 ${EDGES.length} connections`;
        readout.innerHTML =
          '<p class="ro-kicker">Board status</p>' +
          '<h2>Freese Index</h2>' +
          `<p class="ro-role">${note}</p>` +
          '<p class="ro-blurb">Cork wall, sticky notes, red yarn \u2014 Traditionology\u2019s Freese Index mania board, imported as a local snapshot. Click any note for the shortest yarn path back to Josh Freese.</p>' +
          '<div class="ro-legend">' +
          `<span><i style="background:${TYPES.pink.color}"></i>Pink</span>` +
          `<span><i style="background:${TYPES.yellow.color}"></i>Yellow</span>` +
          `<span><i style="background:${TYPES.blue.color}"></i>Blue</span>` +
          `<span><i style="background:${TYPES.green.color}"></i>Green</span>` +
          '</div>' +
          '<p class="ro-hint">Drag to pan \u00b7 scroll to zoom \u00b7 click a note for details \u00b7 <kbd>F</kbd> fit \u00b7 <kbd>D</kbd> dim yarn \u00b7 <kbd>I</kbd> interact \u00b7 <kbd>Esc</kbd> clear</p>';
        return;
      }
      const n = byId.get(id);
      const type = TYPES[n.type];
      const links = neighborButtons(id);
      const connections = connectionLines(id);
      const affiliations = freezeConnectedAffiliations(n, graphModel);
      const counts = n.neighbors.length;
      const pathDetails = freezePathSummary(n, graphModel, ui.path);

      readout.innerHTML =
        '<p class="ro-kicker">' + (ui.selected === id ? 'Selected subject' : 'Subject') + '</p>' +
        `<h2>${n.name}</h2>` +
        `<p class="ro-role">${n.role}</p>` +
        `<span class="typechip"><i style="background:${type.color}"></i>${type.label}</span>` +
        `<p class="ro-blurb">${n.blurb}</p>` +
        (affiliations ? `<p class="ro-affil">Affiliations: ${affiliations}</p>` : '') +
        '<div class="ro-meta">' +
        `<div class="cell"><b>${counts}</b><span>strings</span></div>` +
        `<div class="cell"><b>${links.length}</b><span>related</span></div>` +
        '</div>' +
        (connections.length
          ? '<ul class="ro-connections" aria-label="Direct connections">' +
            connections.slice(0, 8).map((c) => `<li>${c.text}</li>`).join('') +
            '</ul>'
          : '') +
        (links.length
          ? '<div class="ro-links" aria-label="Related subjects">' +
            links.slice(0, 9).map((l) => `<button class="ro-link" type="button" data-go="${l.id}">${l.name}</button>`).join('') +
            '</div>'
          : '') +
        '<section class="ro-path" data-freeze-path-section="true" aria-label="Path to Josh Freese">' +
        '<p class="ro-path-title">Path to Josh Freese</p>' +
        `<p class="ro-path-summary">${pathDetails.summary}</p>` +
        (pathDetails.hops.length
          ? '<ul class="ro-path-hops">' + pathDetails.hops.map((hop) => `<li>${hop}</li>`).join('') + '</ul>'
          : '') +
        '</section>' +
        '<p class="ro-hint">Local mockup detail panel \u2014 nothing is fetched or persisted remotely.</p>';
      for (const b of readout.querySelectorAll('[data-go]')) {
        b.addEventListener('click', () => selectNode(b.getAttribute('data-go')));
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

      if (n && ui.interactive && n.id !== 'freese-index') {
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
        renderEdges();
        renderLabels();
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

      // hover (no buttons down)
      if (!drag.mode && pointers.size === 0) {
        const p = worldPoint(e.clientX, e.clientY);
        const n = hitNode(p.x, p.y);
        const id = n ? n.id : null;
        if (id !== ui.hovered) {
          ui.hovered = id;
          for (const [nid, g] of nodeEls) g.classList.toggle('hovered', nid === id);
          if (!ui.selected) setActive(id);
          svg.style.cursor = n ? (ui.interactive ? 'pointer' : 'grab') : 'grab';
        }
      }
    }

    function onPointerUp(e) {
      pointers.delete(e.pointerId);
      pinch = null;

      if (drag.mode === 'node' && drag.id) {
        nodeEls.get(drag.id).classList.remove('dragging');
        if (!drag.moved) selectNode(drag.id);
        drag.mode = null; drag.id = null;
        return;
      }

      if (drag.mode === 'pan') {
        const p = worldPoint(e.clientX, e.clientY);
        if (!drag.moved) {
          const n = hitNode(p.x, p.y);
          if (n) selectNode(n.id);
          else clearSelection();
        }
        drag.mode = null;
      }
    }

    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('pointercancel', onPointerUp);

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016));
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
        case 'i': case 'I': toggleInteractive(); break;
        case 'Escape': clearSelection(); break;
        default: return;
      }
      e.preventDefault();
      view.fitted = true;
      applyTransform();
      clampPan();
    });

    /* ================= toggles ================= */

    function toggleDim() {
      ui.dim = !ui.dim;
      document.body.classList.toggle('dim', ui.dim);
      document.getElementById('btn-dim').setAttribute('aria-checked', String(ui.dim));
      showToast(ui.dim ? 'Strings dimmed.' : 'Strings restored.');
    }

    function toggleInteractive() {
      ui.interactive = !ui.interactive;
      document.body.classList.toggle('interactive', ui.interactive);
      document.getElementById('btn-interact').setAttribute('aria-checked', String(ui.interactive));
      showToast(ui.interactive ? 'Interactivity on — drag cards to rearrange.' : 'Interactivity off — cards locked in place.');
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
      showToast('Back — this mockup has no history stack (local only).');
    });
    document.getElementById('btn-dim').addEventListener('click', toggleDim);
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 1.3); view.fitted = true;
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 1 / 1.3); view.fitted = true;
    });
    document.getElementById('btn-fit').addEventListener('click', () => { fitView(true); view.fitted = true; });
    document.getElementById('btn-interact').addEventListener('click', toggleInteractive);

    for (const btn of document.querySelectorAll('.act')) {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-action');
        try {
          if (action === 'save') {
            downloadSnapshot();
            showToast('Downloaded local board JSON snapshot.');
            return;
          }
          if (action === 'copy') {
            const ok = await copyText(JSON.stringify(currentSnapshot(), null, 2));
            showToast(ok ? 'Copied local board snapshot JSON.' : 'Could not copy — snapshot still available via Save.');
            return;
          }
          if (action === 'share') {
            const shareUrl = freezeLocalShareUrl(ui.selected);
            const ok = await copyText(shareUrl);
            showToast(ok
              ? 'Copied local board URL (hash link, no network).'
              : 'Local-only board — copy the page URL from the address bar.');
            return;
          }
          if (action === 'report') {
            showToast('Report stays local — nothing was sent.');
            return;
          }
          if (action === 'discussion') {
            showToast('Discussion is local-only here (0 comments, no network).');
            return;
          }
          showToast('Local mock action.');
        } catch (_) {
          showToast('Local action failed in this browser.');
        }
      });
    }

    /* ================= screen-reader node index ================= */

    const index = document.getElementById('node-index');
    for (const n of NODES.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.id = n.id;
      btn.textContent = `${n.name}: ${n.role}. ${n.neighbors.length} connections.`;
      btn.addEventListener('focus', () => selectNode(n.id));
      btn.addEventListener('click', () => selectNode(n.id, { fromList: true }));
      li.appendChild(btn);
      index.appendChild(li);
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

    buildNodes();
    renderEdges();
    renderLabels();
    fitView();
    updateReadout(null);

    window.__freezeIndexBoard = {
      selectNode: (id) => selectNode(typeof id === 'object' ? id.id : id),
      getSelectedNode: () => (ui.selected ? byId.get(ui.selected) || ui.selected : null),
      getPath: () => ui.path,
      centerNode,
      render: renderBoard,
      snapshot: currentSnapshot,
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

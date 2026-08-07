/* ============================================================================
   Freese Index — independent mockup of a RedString-style investigation board
   ----------------------------------------------------------------------------
   · Pure client-side, no network requests, no auth, no external assets.
   · Graph is rendered into a SINGLE inline <svg>. All 33 edges are batched
     into two <path> elements (base + active), labels share one <g>, and each
     of the 24 nodes is one <g> — no DOM element per graph element.
   · Pan (drag / arrows), zoom (wheel / buttons / pinch), fit-to-view,
     dim-strings toggle, node dragging when interactivity is on, hover and
     selection treatment, and a detail/status readout.
   ========================================================================== */

'use strict';

/* ---------------------------------------------------------------------------
   Search, selection details, and shortest-path enhancement.
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

function freezeNodeAffiliation(node) {
  return freezeNodeText(node && (node.affiliation ?? node.affiliations ?? node.group ?? node.organization));
}

function freezeNodeType(node) {
  const type = freezeNodeText(node && (node.type ?? node.kind ?? node.category));
  if (type && typeof TYPES !== 'undefined' && TYPES[type] && TYPES[type].label) return TYPES[type].label;
  return type || 'Node';
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

function freezeGraphModel() {
  const nodes = freezeGraphNodes();
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
  const rawEdges = typeof EDGES !== 'undefined' && Array.isArray(EDGES) ? EDGES : [];
  rawEdges.forEach((edge) => {
    const rawSource = freezeEdgeEndpoint(edge, 'source');
    const rawTarget = freezeEdgeEndpoint(edge, 'target');
    const sourceNode = byId.get(rawSource) || byName.get(rawSource.toLowerCase());
    const targetNode = byId.get(rawTarget) || byName.get(rawTarget.toLowerCase());
    if (!sourceNode || !targetNode) return;
    const normalized = {
      source: freezeNodeId(sourceNode),
      target: freezeNodeId(targetNode),
      label: freezeEdgeLabel(edge),
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
  if (!value) return null;
  if (typeof value === 'object') {
    const id = freezeNodeId(value);
    if (model.byId.has(id)) return model.byId.get(id);
    const name = freezeNodeName(value).toLowerCase();
    return model.byName.get(name) || null;
  }
  const text = String(value);
  return model.byId.get(text) || model.byName.get(text.toLowerCase()) || null;
}

function freezeShortestPath(model, start) {
  const josh = model.nodes.find((node) => freezeNodeName(node).toLowerCase() === 'josh freese')
    || model.nodes.find((node) => /josh[-_ ]freese/i.test(freezeNodeId(node)));
  if (!start || !josh) return { target: josh, nodes: [], edges: [], disconnected: true };
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

function freezeNodeCoordinates(node, element) {
  const position = node && (node.position || node.coordinates);
  let x = node && (node.x ?? node.cx ?? node.fx ?? (position && position.x));
  let y = node && (node.y ?? node.cy ?? node.fy ?? (position && position.y));
  if ((!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) && element) {
    const match = String(element.getAttribute('transform') || '').match(/translate\\(\\s*(-?\\d+(?:\\.\\d+)?)[,\\s]+(-?\\d+(?:\\.\\d+)?)\\s*\\)/);
    if (match) {
      x = match[1];
      y = match[2];
    }
  }
  return { x: Number(x), y: Number(y) };
}

function freezeFindSvg() {
  return document.querySelector('svg');
}

function freezeFindNodeElement(svg, node) {
  if (!svg || !node) return null;
  const id = freezeNodeId(node);
  const name = freezeNodeName(node);
  const elements = svg.querySelectorAll('[data-node-id], [data-id], [data-node], [id], .node');
  for (const element of elements) {
    const values = [
      element.getAttribute('data-node-id'),
      element.getAttribute('data-id'),
      element.getAttribute('data-node'),
      element.getAttribute('id'),
      element.getAttribute('data-name'),
    ].filter(Boolean).map(String);
    if (values.includes(id) || values.includes(`node-${id}`) || values.includes(`node_${id}`) || values.includes(name)) return element;
  }
  return null;
}

function freezeFindScene(svg, nodeElement) {
  if (nodeElement) {
    let parent = nodeElement.parentElement;
    while (parent && parent !== svg) {
      if (parent.tagName && parent.tagName.toLowerCase() === 'g' && parent.hasAttribute('transform')) return parent;
      parent = parent.parentElement;
    }
    if (nodeElement.parentElement) return nodeElement.parentElement;
  }
  return svg && (svg.querySelector('g[transform]') || svg.querySelector('g') || svg);
}

function freezeClearElement(element) {
  while (element && element.firstChild) element.removeChild(element.firstChild);
}

function freezeSvgElement(name, attributes) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
}

function freezeHighlightPath(model, path) {
  const svg = freezeFindSvg();
  if (!svg) return;
  const firstElement = path.nodes.map((node) => freezeFindNodeElement(svg, node)).find(Boolean);
  const scene = freezeFindScene(svg, firstElement);
  if (!scene) return;
  let layer = scene.querySelector(':scope > [data-freeze-shortest-path]');
  if (!layer) {
    layer = freezeSvgElement('g', {
      'data-freeze-shortest-path': 'true',
      'aria-hidden': 'true',
      'pointer-events': 'none',
    });
    scene.appendChild(layer);
  }
  freezeClearElement(layer);

  const coordinates = new Map();
  path.nodes.forEach((node) => {
    const point = freezeNodeCoordinates(node, freezeFindNodeElement(svg, node));
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) coordinates.set(freezeNodeId(node), point);
  });
  path.edges.forEach((edge) => {
    const source = coordinates.get(edge.source);
    const target = coordinates.get(edge.target);
    if (!source || !target) return;
    layer.appendChild(freezeSvgElement('line', {
      class: 'freeze-shortest-path-edge',
      'data-shortest-path-edge': `${edge.source}-${edge.target}`,
      x1: source.x,
      y1: source.y,
      x2: target.x,
      y2: target.y,
      stroke: '#ffe082',
      'stroke-width': 12,
      'stroke-linecap': 'round',
      opacity: 0.95,
    }));
  });
  path.nodes.forEach((node) => {
    const point = coordinates.get(freezeNodeId(node));
    if (!point) return;
    layer.appendChild(freezeSvgElement('circle', {
      class: 'freeze-shortest-path-node',
      'data-shortest-path-node': freezeNodeId(node),
      cx: point.x,
      cy: point.y,
      r: 25,
      fill: 'none',
      stroke: '#ffe082',
      'stroke-width': 5,
      opacity: 0.98,
    }));
  });

  svg.querySelectorAll('[data-shortest-path-node="true"], [data-shortest-path-node="false"]').forEach((element) => {
    element.removeAttribute('data-shortest-path-node');
  });
  path.nodes.forEach((node) => {
    const element = freezeFindNodeElement(svg, node);
    if (element) element.setAttribute('data-shortest-path-node', 'true');
  });
}

function freezeReadoutElement() {
  const selectors = [
    '#readout', '#detail-readout', '#node-readout', '#selection-readout',
    '#node-detail', '#details', '#detail', '#status', '[data-readout]',
  ];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  const marked = Array.from(document.querySelectorAll('[id], [class]')).find((element) => {
    const marker = `${element.id || ''} ${element.className || ''}`.toLowerCase();
    return /readout|detail|selection|status/.test(marker) && element.tagName.toLowerCase() !== 'body';
  });
  return marked || null;
}

function freezeUpdateReadout(node, model) {
  if (!node) return;
  const path = freezeShortestPath(model, node);
  const existing = freezeReadoutElement();
  const host = existing || document.body;
  let extension = host.querySelector('[data-freeze-selection-details]');
  if (!extension) {
    extension = document.createElement('section');
    extension.setAttribute('data-freeze-selection-details', 'true');
    extension.setAttribute('aria-live', 'polite');
    extension.setAttribute('aria-atomic', 'true');
    extension.style.marginTop = '10px';
    extension.style.paddingTop = '10px';
    extension.style.borderTop = '1px solid rgba(255,255,255,.16)';
    host.appendChild(extension);
  }
  freezeClearElement(extension);

  const heading = document.createElement('h3');
  heading.textContent = `${freezeNodeName(node)} details`;
  heading.style.margin = '0 0 6px';
  heading.style.fontSize = '12px';
  extension.appendChild(heading);
  const summary = document.createElement('p');
  summary.style.margin = '3px 0';
  summary.textContent = `Type: ${freezeNodeType(node)} · Affiliation: ${freezeNodeAffiliation(node) || 'Not listed'}`;
  extension.appendChild(summary);
  const adjacency = model.adjacency.get(freezeNodeId(node)) || [];
  const connections = document.createElement('p');
  connections.style.margin = '3px 0';
  connections.textContent = `Direct connections: ${adjacency.length}`;
  extension.appendChild(connections);

  const connectionList = document.createElement('ul');
  connectionList.style.margin = '5px 0 8px';
  connectionList.style.paddingLeft = '18px';
  if (!adjacency.length) {
    const item = document.createElement('li');
    item.textContent = 'None';
    connectionList.appendChild(item);
  } else {
    adjacency.forEach(({ id, edge }) => {
      const item = document.createElement('li');
      item.textContent = `${freezeNodeName(model.byId.get(id))} — ${edge.label}`;
      connectionList.appendChild(item);
    });
  }
  extension.appendChild(connectionList);

  const pathText = document.createElement('p');
  pathText.style.margin = '3px 0';
  if (!path.target) {
    pathText.textContent = 'Josh Freese is not present in this graph.';
  } else if (path.disconnected) {
    pathText.textContent = `${freezeNodeName(node)} is disconnected from Josh Freese.`;
  } else {
    const names = path.nodes.map(freezeNodeName).join(' → ');
    pathText.textContent = `Path to Josh Freese: ${names} (${path.nodes.length - 1} jumps)`;
  }
  extension.appendChild(pathText);
}

function freezeRenderGraph() {
  const bridge = freezeIndexBoardBridge();
  if (bridge && typeof bridge.render === 'function') {
    try { bridge.render(); return; } catch (error) { /* fall through to legacy hooks */ }
  }
  if (typeof render === 'function') {
    try { render(); } catch (error) { /* preserve the existing renderer's behavior */ }
  } else if (typeof renderGraph === 'function') {
    try { renderGraph(); } catch (error) { /* preserve the existing renderer's behavior */ }
  }
}

function freezeExistingFocus(node) {
  const candidates = [];
  const bridge = freezeIndexBoardBridge();
  if (bridge) {
    if (typeof bridge.centerNode === 'function') candidates.push(bridge.centerNode.bind(bridge));
    if (typeof bridge.focusNode === 'function') candidates.push(bridge.focusNode.bind(bridge));
    if (typeof bridge.centerOnNode === 'function') candidates.push(bridge.centerOnNode.bind(bridge));
  }
  if (typeof focusNode === 'function') candidates.push(focusNode);
  if (typeof centerOnNode === 'function') candidates.push(centerOnNode);
  if (typeof centerNodeInView === 'function') candidates.push(centerNodeInView);
  if (typeof panToNode === 'function') candidates.push(panToNode);
  for (const focus of candidates) {
    try {
      focus(freezeNodeId(node) || node.id);
      return true;
    } catch (error) {
      try {
        focus(node);
        return true;
      } catch (ignored) {
        // Try the next existing focus helper, then use the SVG transform fallback.
      }
    }
  }
  return false;
}

function freezeCenterNode(node) {
  if (freezeExistingFocus(node)) return;
  const svg = freezeFindSvg();
  const element = freezeFindNodeElement(svg, node);
  const scene = freezeFindScene(svg, element);
  if (!svg || !element || !scene || !element.getBoundingClientRect) return;
  const svgRect = svg.getBoundingClientRect();
  const nodeRect = element.getBoundingClientRect();
  if (!svgRect.width || !svgRect.height || !nodeRect.width || !nodeRect.height) return;
  const dx = svgRect.left + svgRect.width / 2 - (nodeRect.left + nodeRect.width / 2);
  const dy = svgRect.top + svgRect.height / 2 - (nodeRect.top + nodeRect.height / 2);
  const matrix = scene.getScreenCTM && scene.getScreenCTM();
  const scaleX = matrix && Math.abs(matrix.a) > 0 ? Math.abs(matrix.a) : 1;
  const scaleY = matrix && Math.abs(matrix.d) > 0 ? Math.abs(matrix.d) : 1;
  const transform = scene.getAttribute('transform') || '';
  const match = transform.match(/translate\\(\\s*(-?\\d+(?:\\.\\d+)?)(?:[,\\s]+(-?\\d+(?:\\.\\d+)?))?\\s*\\)/);
  if (!match) return;
  const tx = Number(match[1]) + dx / scaleX;
  const ty = Number(match[2] || 0) + dy / scaleY;
  scene.setAttribute('transform', transform.replace(match[0], `translate(${tx} ${ty})`));
}

function freezeBuildSearchPanel(model, activate) {
  let panel = document.getElementById('freeze-search-panel');
  if (panel) return panel;
  panel = document.createElement('aside');
  panel.id = 'freeze-search-panel';
  panel.setAttribute('aria-label', 'Search graph');
  Object.assign(panel.style, {
    position: 'fixed',
    top: '76px',
    left: '16px',
    zIndex: '20',
    width: 'min(320px, calc(100vw - 32px))',
    boxSizing: 'border-box',
    padding: '12px',
    color: '#f5f7fb',
    background: 'rgba(17, 23, 35, .96)',
    border: '1px solid rgba(255,255,255,.2)',
    borderRadius: '10px',
    boxShadow: '0 12px 30px rgba(0,0,0,.3)',
    font: '12px/1.4 system-ui, sans-serif',
  });
  const label = document.createElement('label');
  label.htmlFor = 'freeze-search-input';
  label.textContent = 'Search people, bands, and projects';
  label.style.display = 'block';
  label.style.fontWeight = '600';
  label.style.marginBottom = '6px';
  panel.appendChild(label);
  const input = document.createElement('input');
  input.id = 'freeze-search-input';
  input.type = 'search';
  input.autocomplete = 'off';
  input.placeholder = 'Name or affiliation';
  input.setAttribute('aria-controls', 'freeze-search-results');
  input.style.width = '100%';
  input.style.boxSizing = 'border-box';
  input.style.padding = '7px 8px';
  input.style.color = '#111827';
  input.style.background = '#fff';
  input.style.border = '1px solid #b8c1d1';
  input.style.borderRadius = '6px';
  panel.appendChild(input);
  const results = document.createElement('ul');
  results.id = 'freeze-search-results';
  results.setAttribute('role', 'listbox');
  results.setAttribute('aria-live', 'polite');
  results.setAttribute('aria-label', 'Search results');
  results.style.listStyle = 'none';
  results.style.maxHeight = '240px';
  results.style.overflowY = 'auto';
  results.style.margin = '8px 0 0';
  results.style.padding = '0';
  panel.appendChild(results);
  document.body.appendChild(panel);

  const renderResults = () => {
    freezeClearElement(results);
    const query = input.value.trim().toLowerCase();
    const matches = model.nodes.filter((node) => {
      const haystack = `${freezeNodeName(node)} ${freezeNodeAffiliation(node)}`.toLowerCase();
      return !query || haystack.includes(query);
    });
    results.setAttribute('aria-label', `${matches.length} search result${matches.length === 1 ? '' : 's'}`);
    if (!matches.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No matching nodes';
      empty.style.padding = '6px 4px';
      results.appendChild(empty);
      return;
    }
    matches.forEach((node) => {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = freezeNodeName(node);
      button.setAttribute('aria-label', `${freezeNodeName(node)}${freezeNodeAffiliation(node) ? `, ${freezeNodeAffiliation(node)}` : ''}`);
      button.style.display = 'block';
      button.style.width = '100%';
      button.style.padding = '6px 4px';
      button.style.textAlign = 'left';
      button.style.color = '#f5f7fb';
      button.style.background = 'transparent';
      button.style.border = '0';
      button.style.borderRadius = '4px';
      button.style.cursor = 'pointer';
      const affiliation = freezeNodeAffiliation(node);
      button.title = affiliation ? `${freezeNodeType(node)} · ${affiliation}` : freezeNodeType(node);
      button.addEventListener('click', () => activate(node));
      item.appendChild(button);
      results.appendChild(item);
    });
  };
  input.addEventListener('input', renderResults);
  renderResults();
  return panel;
}

function freezeStartEnhancements() {
  if (document.getElementById('freeze-search-panel')) return;
  const model = freezeGraphModel();
  let selected = null;
  const readSelection = () => {
    const bridge = freezeIndexBoardBridge();
    if (bridge && typeof bridge.getSelectedNode === 'function') {
      const fromBridge = freezeResolveNode(bridge.getSelectedNode(), model);
      if (fromBridge) return fromBridge;
    }
    const candidates = [];
    if (typeof selectedNode !== 'undefined') candidates.push(selectedNode);
    if (typeof selectedNodeId !== 'undefined') candidates.push(selectedNodeId);
    if (typeof selectedId !== 'undefined') candidates.push(selectedId);
    if (typeof activeNode !== 'undefined') candidates.push(activeNode);
    if (typeof currentNode !== 'undefined') candidates.push(currentNode);
    for (const candidate of candidates) {
      const node = freezeResolveNode(candidate, model);
      if (node) return node;
    }
    return selected;
  };
  const refresh = (node) => {
    const next = freezeResolveNode(node, model) || readSelection();
    if (!next) return;
    selected = next;
    freezeUpdateReadout(next, model);
    freezeHighlightPath(model, freezeShortestPath(model, next));
  };
  const bridge = freezeIndexBoardBridge();
  let originalSelectNode = null;
  let hooked = false;
  if (bridge && typeof bridge.selectNode === 'function') {
    originalSelectNode = bridge.selectNode.bind(bridge);
    bridge.selectNode = function enhancedSelectNode(nodeOrId) {
      const result = originalSelectNode.apply(this, arguments);
      const node = freezeResolveNode(nodeOrId, model) || readSelection();
      setTimeout(() => refresh(node), 0);
      return result;
    };
    hooked = true;
  } else if (typeof selectNode === 'function') {
    originalSelectNode = selectNode;
    const enhancedSelectNode = function enhancedSelectNode(nodeOrId) {
      const result = originalSelectNode.apply(this, arguments);
      const node = freezeResolveNode(nodeOrId, model) || readSelection();
      setTimeout(() => refresh(node), 0);
      return result;
    };
    try {
      selectNode = enhancedSelectNode;
      hooked = true;
    } catch (error) {
      // A const-bound selector is still used directly by the search activation below.
    }
  }
  const activate = (node) => {
    const liveBridge = freezeIndexBoardBridge();
    if (liveBridge && typeof liveBridge.selectNode === 'function') {
      liveBridge.selectNode(freezeNodeId(node));
    } else if (hooked && typeof selectNode === 'function') {
      selectNode(freezeNodeId(node));
    } else if (originalSelectNode) {
      originalSelectNode.call(null, freezeNodeId(node));
    } else if (typeof selectNode === 'function') {
      selectNode(freezeNodeId(node));
    }
    freezeRenderGraph();
    freezeCenterNode(node);
    refresh(node);
  };
  freezeBuildSearchPanel(model, activate);
  const svg = freezeFindSvg();
  if (svg) {
    svg.addEventListener('click', (event) => {
      const target = event.target && event.target.closest ? event.target.closest('[data-node-id], [data-id], [data-node], .node') : null;
      if (!target) return;
      setTimeout(() => refresh(readSelection() || freezeResolveNode(target.getAttribute('data-node-id') || target.getAttribute('data-id'), model)), 0);
    });
  }
  refresh(readSelection() || model.nodes.find((node) => freezeNodeName(node).toLowerCase() === 'josh freese'));
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(freezeStartEnhancements, 0), { once: true });
  } else {
    setTimeout(freezeStartEnhancements, 0);
  }
}

/* ---------------------------------------------------------------------------
   Graph data — representative, illustrative, hand-authored locally.
   (Public facts about Josh Freese's career; nothing scraped from RedString.)
   Coordinates live in a 2000 x 1400 world space; chips are placed so the
   clusters read like an investigation board web.
--------------------------------------------------------------------------- */

const TYPES = {
  person:  { color: '#5fe3c9', label: 'Person' },
  band:    { color: '#b38cff', label: 'Band / group' },
  project: { color: '#ffb25e', label: 'Project / record' },
  subject: { color: '#ff5c7a', label: 'Board subject' },
};

const NODES = [
  // subject anchor
  { id: 'freese-index', type: 'subject', name: 'Freese Index', role: 'Subject of this board',
    blurb: 'A career map of Josh Freese: the drummers, bands, records, and sessions that thread through his work since the late 1980s.',
    x: 900, y: 40 },

  // projects / records
  { id: 'session', type: 'project', name: 'Session & Studio Work', role: '300+ recording credits',
    blurb: 'A first-call session drummer since the late 1980s, Freese has recorded for pop, rock, punk, and film artists across hundreds of sessions.',
    x: 700, y: 700 },
  { id: 'chinese-democracy', type: 'project', name: 'Chinese Democracy', role: 'Guns N\u2019 Roses album (2008)',
    blurb: 'Freese played drums on sessions for Guns N\u2019 Roses\u2019 long-gestating 2008 album.',
    x: 900, y: 1280 },
  { id: 'damning-well', type: 'project', name: 'The Damning Well', role: 'Industrial supergroup project',
    blurb: 'A studio project with Danny Lohner, Wes Borland, and Richard Patrick; Freese on drums.',
    x: 1490, y: 1120 },
  { id: 'tribute', type: 'project', name: 'Taylor Hawkins Tribute', role: 'Memorial concerts (2022)',
    blurb: 'Freese performed at the 2022 tribute concerts honoring Foo Fighters drummer Taylor Hawkins.',
    x: 1360, y: 90 },

  // bands / groups
  { id: 'ff', type: 'band', name: 'Foo Fighters', role: 'Drummer since 2023',
    blurb: 'Freese joined Foo Fighters on drums in 2023 following the death of Taylor Hawkins.',
    x: 1510, y: 320 },
  { id: 'apc', type: 'band', name: 'A Perfect Circle', role: 'Drummer since 2003',
    blurb: 'Freese has drummed for A Perfect Circle on studio albums and tours since 2003.',
    x: 560, y: 380 },
  { id: 'nin', type: 'band', name: 'Nine Inch Nails', role: 'Live drummer, 2005\u20132009',
    blurb: 'Freese handled live drumming duties across several Nine Inch Nails tours.',
    x: 1580, y: 800 },
  { id: 'devo', type: 'band', name: 'Devo', role: 'Drummer, 1996\u20132014',
    blurb: 'Freese drummed for new-wave icons Devo for nearly two decades.',
    x: 420, y: 900 },
  { id: 'vandals', type: 'band', name: 'The Vandals', role: 'Drummer since 1989',
    blurb: 'Freese has been The Vandals\u2019 drummer since 1989 — his longest-running band.',
    x: 190, y: 610 },
  { id: 'gnr', type: 'band', name: 'Guns N\u2019 Roses', role: 'Session drummer',
    blurb: 'Freese recorded drum parts during the Chinese Democracy session era.',
    x: 1130, y: 1150 },
  { id: 'weezer', type: 'band', name: 'Weezer', role: 'Touring drummer, 2000s',
    blurb: 'Freese drummed on Weezer touring stints in the 2000s.',
    x: 1720, y: 620 },
  { id: 'st', type: 'band', name: 'Suicidal Tendencies', role: 'Early drummer (1989)',
    blurb: 'An early stop in Freese\u2019s career: drums for crossover-thrash band Suicidal Tendencies.',
    x: 150, y: 430 },

  // people
  { id: 'grohl', type: 'person', name: 'Dave Grohl', role: 'Foo Fighters founder & frontman',
    blurb: 'Freese\u2019s bandmate in Foo Fighters; Grohl founded the band and fronts it.',
    x: 1760, y: 430 },
  { id: 'taylor', type: 'person', name: 'Taylor Hawkins', role: 'Foo Fighters drummer 1996\u20132022',
    blurb: 'Freese\u2019s predecessor on drums in Foo Fighters; honored at the 2022 tribute concerts.',
    x: 1230, y: 250 },
  { id: 'maynard', type: 'person', name: 'Maynard James Keenan', role: 'A Perfect Circle vocalist',
    blurb: 'Bandmate in A Perfect Circle; also known for Tool and Puscifer.',
    x: 300, y: 240 },
  { id: 'howerdel', type: 'person', name: 'Billy Howerdel', role: 'A Perfect Circle founder',
    blurb: 'APC\u2019s guitarist and founder; Freese\u2019s bandmate in the group.',
    x: 860, y: 200 },
  { id: 'reznor', type: 'person', name: 'Trent Reznor', role: 'Nine Inch Nails frontman',
    blurb: 'Reznor tapped Freese for Nine Inch Nails live drumming.',
    x: 1800, y: 1100 },
  { id: 'lohner', type: 'person', name: 'Danny Lohner', role: 'NIN bassist & producer',
    blurb: 'Bandmate in Nine Inch Nails and co-founder of The Damning Well with Freese.',
    x: 1780, y: 900 },
  { id: 'mothersbaugh', type: 'person', name: 'Mark Mothersbaugh', role: 'Devo co-founder',
    blurb: 'Freese\u2019s bandmate in Devo; composer and visual artist outside the band.',
    x: 660, y: 1140 },
  { id: 'warren', type: 'person', name: 'Warren Fitzgerald', role: 'The Vandals guitarist',
    blurb: 'Long-time bandmate in The Vandals.',
    x: 110, y: 930 },
  { id: 'sting', type: 'person', name: 'Sting', role: 'Solo artist',
    blurb: 'Freese was in Sting\u2019s touring band from 1997 to 2001.',
    x: 1750, y: 230 },
  { id: 'westerberg', type: 'person', name: 'Paul Westerberg', role: 'Solo artist',
    blurb: 'Freese played drums on Westerberg\u2019s solo records in the 1990s.',
    x: 120, y: 150 },

  // center of the web — drawn last so he sits on top
  { id: 'josh', type: 'person', name: 'Josh Freese', role: 'Drummer \u00b7 composer \u00b7 first-call session player',
    blurb: 'American drummer (b. 1972) whose career threads through punk, new wave, industrial, and arena rock — from The Vandals and Devo to A Perfect Circle, Nine Inch Nails, and Foo Fighters, plus 300+ studio credits.',
    x: 940, y: 655, big: true },
];

const EDGES = [
  { id: 'e01', from: 'josh', to: 'ff',       label: 'drummer \u00b7 2023\u2013' },
  { id: 'e02', from: 'josh', to: 'apc',      label: 'drummer \u00b7 2003\u2013' },
  { id: 'e03', from: 'josh', to: 'nin',      label: 'live drummer' },
  { id: 'e04', from: 'josh', to: 'devo',     label: 'drummer \u00b7 1996\u20132014' },
  { id: 'e05', from: 'josh', to: 'vandals',  label: 'drummer \u00b7 1989\u2013' },
  { id: 'e06', from: 'josh', to: 'gnr',      label: 'session drums' },
  { id: 'e07', from: 'josh', to: 'weezer',   label: 'touring \u00b7 2000s' },
  { id: 'e08', from: 'josh', to: 'st',       label: 'early drummer' },
  { id: 'e09', from: 'josh', to: 'sting',    label: 'touring band' },
  { id: 'e10', from: 'josh', to: 'session',  label: '300+ credits' },
  { id: 'e11', from: 'josh', to: 'chinese-democracy', label: 'recorded drums' },
  { id: 'e12', from: 'josh', to: 'damning-well',      label: 'member' },
  { id: 'e13', from: 'josh', to: 'tribute',  label: 'performed' },
  { id: 'e14', from: 'josh', to: 'freese-index', label: 'career map' },
  { id: 'e15', from: 'josh', to: 'grohl',    label: 'bandmate' },
  { id: 'e16', from: 'josh', to: 'taylor',   label: 'predecessor' },
  { id: 'e17', from: 'josh', to: 'maynard',  label: 'bandmate' },
  { id: 'e18', from: 'josh', to: 'howerdel', label: 'bandmate' },
  { id: 'e19', from: 'josh', to: 'reznor',   label: 'hired him' },
  { id: 'e20', from: 'josh', to: 'mothersbaugh', label: 'bandmate' },
  { id: 'e21', from: 'josh', to: 'warren',   label: 'bandmate' },
  { id: 'e22', from: 'josh', to: 'westerberg', label: 'studio drummer' },
  { id: 'e23', from: 'josh', to: 'lohner',   label: 'bandmate' },
  { id: 'e24', from: 'grohl', to: 'ff',      label: 'founder' },
  { id: 'e25', from: 'taylor', to: 'ff',     label: 'drummer \u00b7 1996\u20132022' },
  { id: 'e26', from: 'maynard', to: 'apc',   label: 'vocalist' },
  { id: 'e27', from: 'howerdel', to: 'apc',  label: 'founder' },
  { id: 'e28', from: 'reznor', to: 'nin',    label: 'frontman' },
  { id: 'e29', from: 'lohner', to: 'nin',    label: 'bassist' },
  { id: 'e30', from: 'mothersbaugh', to: 'devo', label: 'co-founder' },
  { id: 'e31', from: 'warren', to: 'vandals', label: 'guitarist' },
  { id: 'e32', from: 'grohl', to: 'tribute', label: 'organized' },
  { id: 'e33', from: 'lohner', to: 'damning-well', label: 'founder' },
];

/* chip geometry — pure function of the data (safe to run under Node) */
function finalizeNodes() {
  const byId = new Map();
  for (const n of NODES) {
    n.h = n.big ? 44 : 30;
    n.w = Math.max(96, 26 + n.name.length * 7.7 + (n.big ? 14 : 0));
    n.cx = n.x + n.w / 2;
    n.cy = n.y + n.h / 2;
    n.color = TYPES[n.type].color;
    byId.set(n.id, n);
  }
  const adj = new Map();
  for (const e of EDGES) {
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
    const WORLD = { w: 2000, h: 1400 };

    const svg = document.getElementById('graph');
    const world = document.getElementById('world');
    const nodesG = document.getElementById('nodes');
    const labelsG = document.getElementById('edge-labels');
    const edgesPath = document.getElementById('edges');
    const activePath = document.getElementById('edges-active');
    const readout = document.getElementById('readout');
    const toast = document.getElementById('toast');
    const zoomPct = document.getElementById('zoom-pct');

    /* ----- view state ----- */
    const view = { tx: 0, ty: 0, scale: 1, fitted: false };
    const ui = { dim: false, interactive: false, selected: null, hovered: null, active: null };
    const drag = { mode: null, id: null, sx: 0, sy: 0, nx: 0, ny: 0, moved: false };
    const pointers = new Map(); // pointerId -> {x,y}
    let pinch = null;           // {dist, mx, my}

    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const NODE_DRAW_ORDER = { subject: 0, project: 1, band: 2, person: 3 };

    /* ================= build the static graph DOM ================= */

    const nodeEls = new Map();

    function quadAt(p0x, p0y, p1x, p1y, t) {
      const mx = (p0x + p1x) / 2, my = (p0y + p1y) / 2;
      const sag = Math.min(26, Math.hypot(p1x - p0x, p1y - p0y) * 0.06);
      const cx = mx, cy = my + sag;
      return {
        x: (1 - t) * (1 - t) * p0x + 2 * (1 - t) * t * cx + t * t * p1x,
        y: (1 - t) * (1 - t) * p0y + 2 * (1 - t) * t * cy + t * t * p1y,
      };
    }

    function edgePathData(edges) {
      let d = '';
      for (const e of edges) {
        const a = byId.get(e.from), b = byId.get(e.to);
        const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
        const sag = Math.min(26, Math.hypot(b.cx - a.cx, b.cy - a.cy) * 0.06);
        d += `M${a.cx.toFixed(1)},${a.cy.toFixed(1)} Q${mx.toFixed(1)},${(my + sag).toFixed(1)} ${b.cx.toFixed(1)},${b.cy.toFixed(1)}`;
      }
      return d;
    }

    function renderEdges() {
      edgesPath.setAttribute('d', edgePathData(EDGES));
      const activeId = ui.active;
      const active = activeId ? EDGES.filter((e) => e.from === activeId || e.to === activeId) : [];
      activePath.setAttribute('d', edgePathData(active));
    }

    function renderLabels() {
      labelsG.textContent = '';
      const fs = 10.5 / view.scale;         // keep edge labels readable at any zoom
      const sw = 3 / view.scale;
      for (const e of EDGES) {
        const a = byId.get(e.from), b = byId.get(e.to);
        const p = quadAt(a.cx, a.cy, b.cx, b.cy, 0.5);
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('class', 'edge-label');
        t.setAttribute('x', p.x.toFixed(1));
        t.setAttribute('y', (p.y - 6 / view.scale).toFixed(1));
        t.setAttribute('font-size', fs.toFixed(2));
        t.setAttribute('stroke-width', sw.toFixed(2));
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('data-e', e.id);
        t.textContent = e.label;
        labelsG.appendChild(t);
      }
      applyLabelHighlights();
    }

    function applyLabelHighlights() {
      const activeId = ui.active;
      for (const t of labelsG.children) {
        const e = EDGES.find((x) => x.id === t.getAttribute('data-e'));
        t.classList.toggle('hl', !!e && activeId && (e.from === activeId || e.to === activeId));
      }
    }

    function buildNodes() {
      const sorted = NODES.slice().sort((a, b) => NODE_DRAW_ORDER[a.type] - NODE_DRAW_ORDER[b.type]);
      for (const n of sorted) {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'node' + (n.big ? ' big' : ''));
        g.setAttribute('data-node-id', n.id);
        g.setAttribute('id', n.id);
        g.setAttribute('transform', `translate(${n.x},${n.y})`);
        g.setAttribute('role', 'group');
        g.setAttribute('aria-label', `${n.name} — ${n.role}`);

        const chip = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        chip.setAttribute('class', 'chip');
        chip.setAttribute('width', n.w);
        chip.setAttribute('height', n.h);
        chip.setAttribute('rx', n.big ? 11 : 8);

        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('class', 'dot');
        dot.setAttribute('cx', 13);
        dot.setAttribute('cy', n.h / 2);
        dot.setAttribute('r', n.big ? 5 : 4);
        dot.setAttribute('fill', n.color);

        const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lbl.setAttribute('class', 'lbl');
        lbl.setAttribute('x', 24);
        lbl.setAttribute('y', n.big ? 21 : 19.5);
        lbl.textContent = n.name;

        g.appendChild(chip); g.appendChild(dot); g.appendChild(lbl);

        if (n.big) {
          const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          sub.setAttribute('class', 'sub');
          sub.setAttribute('x', 24);
          sub.setAttribute('y', 34);
          sub.textContent = n.role;
          g.appendChild(sub);
        }

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
      view.scale = clamp(Math.min(cw / bw, ch / bh), 0.2, 1.6);
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
      const ns = clamp(view.scale * factor, 0.2, 4);
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

    function selectNode(id, { fromList = false } = {}) {
      ui.selected = id;
      ui.hovered = null;
      for (const [nid, g] of nodeEls) g.classList.toggle('sel', nid === id);
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
      for (const g of nodeEls.values()) g.classList.remove('sel');
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

    function updateReadout(id) {
      if (!id) {
        const personCount = NODES.filter((n) => n.type === 'person').length;
        readout.innerHTML =
          '<p class="ro-kicker">Board status</p>' +
          '<h2>Freese Index</h2>' +
          `<p class="ro-role">${NODES.length} subjects \u00b7 ${EDGES.length} connections \u00b7 ${personCount} people</p>` +
          '<p class="ro-blurb">A dark investigation board mapping Josh Freese\u2019s career web. Strings are red, cards are subjects \u2014 all data here is illustrative and stored locally.</p>' +
          '<div class="ro-legend">' +
          '<span><i style="background:#ff5c7a"></i>Board subject</span>' +
          '<span><i style="background:#5fe3c9"></i>Person</span>' +
          '<span><i style="background:#b38cff"></i>Band / group</span>' +
          '<span><i style="background:#ffb25e"></i>Project / record</span>' +
          '</div>' +
          '<p class="ro-hint">Drag to pan \u00b7 scroll to zoom \u00b7 click a card for details \u00b7 <kbd>F</kbd> fit \u00b7 <kbd>D</kbd> dim \u00b7 <kbd>I</kbd> interact \u00b7 <kbd>Esc</kbd> clear</p>';
        return;
      }
      const n = byId.get(id);
      const type = TYPES[n.type];
      const links = neighborButtons(id);
      const counts = n.neighbors.length;
      readout.innerHTML =
        '<p class="ro-kicker">' + (ui.selected === id ? 'Selected subject' : 'Subject') + '</p>' +
        `<h2>${n.name}</h2>` +
        `<p class="ro-role">${n.role}</p>` +
        `<span class="typechip"><i style="background:${type.color}"></i>${type.label}</span>` +
        `<p class="ro-blurb">${n.blurb}</p>` +
        '<div class="ro-meta">' +
        `<div class="cell"><b>${counts}</b><span>strings</span></div>` +
        `<div class="cell"><b>${links.length}</b><span>related</span></div>` +
        '</div>' +
        (links.length
          ? '<div class="ro-links" aria-label="Related subjects">' +
            links.slice(0, 9).map((l) => `<button class="ro-link" type="button" data-go="${l.id}">${l.name}</button>`).join('') +
            '</div>'
          : '') +
        '<p class="ro-hint">Mockup detail panel \u2014 nothing is fetched or persisted remotely.</p>';
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
      document.getElementById('btn-interact').setAttribute('aria-pressed', String(ui.interactive));
      showToast(ui.interactive ? 'Interactivity on — drag cards to rearrange.' : 'Interactivity off — cards locked in place.');
    }

    /* ================= chrome buttons ================= */

    document.getElementById('btn-back').addEventListener('click', () => {
      showToast('Back — this mockup has no history stack (no network).');
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

    const ACTION_MSGS = {
      report: 'Report board — mock only, nothing was sent.',
      discussion: 'Discussion: 0 comments. Mock panel, no network.',
      save: 'Saved to this browser (local mock).',
      share: 'Share link copied to clipboard (mock URL).',
      copy: 'Copied to My Boards (local mock).',
    };
    for (const btn of document.querySelectorAll('.act')) {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        if (action === 'share') {
          try {
            navigator.clipboard && navigator.clipboard.writeText('https://example.invalid/freese-index-mockup');
          } catch (_) { /* local mock — ignore */ }
        }
        showToast(ACTION_MSGS[action] || 'Mock action.');
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

    /* ================= boot ================= */

    buildNodes();
    renderEdges();
    renderLabels();
    fitView();
    updateReadout(null);

    window.__freezeIndexBoard = {
      selectNode: (id) => selectNode(id),
      getSelectedNode: () => (ui.selected ? byId.get(ui.selected) || ui.selected : null),
      centerNode,
      render: renderBoard,
    };

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

/* allow the graph data to be unit-checked under Node */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TYPES, NODES, EDGES, finalizeNodes };
}

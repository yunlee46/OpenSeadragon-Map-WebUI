// SVG overlay that draws hitboxes and annotations on top of an OpenSeadragon viewer.
// All geometry is in OpenSeadragon viewport coordinates, so shapes stay put no matter
// how many images a map has or where they are placed.

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

// ---------- geometry helpers ----------

export function shapePoints(g) {
  if (g.type === 'rect') return [[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]];
  return g.points;
}

export function pointInShape(x, y, g) {
  if (g.type === 'rect') return x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h;
  let inside = false;
  const p = g.points;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function translateShape(g, dx, dy) {
  if (g.type === 'rect') return { ...g, x: g.x + dx, y: g.y + dy };
  return { ...g, points: g.points.map(([x, y]) => [x + dx, y + dy]) };
}

export function scaleShape(g, ox, oy, k) {
  if (g.type === 'rect') return { ...g, x: ox + (g.x - ox) * k, y: oy + (g.y - oy) * k, w: g.w * k, h: g.h * k };
  return { ...g, points: g.points.map(([x, y]) => [ox + (x - ox) * k, oy + (y - oy) * k]) };
}

export function shapeBounds(g) {
  const pts = shapePoints(g);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function rectFromPoints(a, b) {
  return { type: 'rect', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

// Move vertex `index` of a shape to (x, y). For rectangles the opposite corner stays fixed.
export function moveVertex(g, index, x, y) {
  if (g.type === 'rect') {
    const pts = shapePoints(g);
    const [ox, oy] = pts[(index + 2) % 4];
    return rectFromPoints({ x: ox, y: oy }, { x, y });
  }
  const points = g.points.slice();
  points[index] = [x, y];
  return { ...g, points };
}

// ---------- overlay ----------

export class ShapeOverlay {
  constructor(viewer) {
    this.viewer = viewer;
    this.shapes = [];
    this.opts = {};
    this.visible = true;
    this.opacity = new Map(); // shape id -> opacity (shapes attached to fading images)
    this.nodes = new Map();

    this.svg = el('svg', { class: 'shape-overlay' });
    this.world = el('g');        // scaled with the viewport: shapes
    this.screen = el('g');       // screen pixels: editing handles
    this.svg.append(this.world, this.screen);
    viewer.canvas.appendChild(this.svg);

    const update = () => this.updateTransform();
    for (const evt of ['animation', 'open', 'resize', 'rotate', 'flip', 'viewport-change', 'update-viewport']) {
      viewer.addHandler(evt, update);
    }
    window.addEventListener('resize', update);
  }

  get scale() {
    const vp = this.viewer.viewport;
    const a = vp.pixelFromPoint(new OpenSeadragon.Point(0, 0), true);
    const b = vp.pixelFromPoint(new OpenSeadragon.Point(1, 0), true);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  toPixel(x, y) {
    return this.viewer.viewport.pixelFromPoint(new OpenSeadragon.Point(x, y), true);
  }

  updateTransform() {
    const vp = this.viewer.viewport;
    if (!vp) return;
    const size = vp.getContainerSize();
    this.svg.setAttribute('width', size.x);
    this.svg.setAttribute('height', size.y);
    const p = this.toPixel(0, 0);
    const rot = vp.getRotation(true);
    this.world.setAttribute('transform', `translate(${p.x},${p.y}) scale(${this.scale}) rotate(${rot})`);
    this.renderScreen();
  }

  setVisible(v) {
    this.visible = v;
    this.svg.style.display = v ? '' : 'none';
  }

  // opts: { selectedId, hoverId, draft (geometry being drawn), outline (rect for selected image), handles: bool }
  render(shapes, opts = {}) {
    this.shapes = shapes;
    this.opts = opts;
    this.world.replaceChildren();
    this.nodes.clear();

    for (const s of shapes) {
      const node = this.shapeNode(s, s.id === opts.selectedId, s.id === opts.hoverId);
      this.nodes.set(s.id, node);
      this.world.appendChild(node);
    }

    if (opts.outline) {
      const o = opts.outline;
      this.world.appendChild(el('rect', { x: o.x, y: o.y, width: o.width, height: o.height, class: 'layer-outline' }));
    }
    if (opts.draft) {
      const node = this.geomNode(opts.draft.geometry, opts.draft.open);
      node.setAttribute('class', 'shape draft');
      this.world.appendChild(node);
    }
    this.updateTransform();
  }

  geomNode(g, open = false) {
    if (g.type === 'rect') return el('rect', { x: g.x, y: g.y, width: g.w, height: g.h });
    return el(open ? 'polyline' : 'polygon', { points: g.points.map((p) => p.join(',')).join(' ') });
  }

  shapeNode(s, selected, hover) {
    const node = this.geomNode(s.geometry);
    const cls = ['shape', `shape-${s.kind}`];
    if (selected) cls.push('selected');
    if (hover) cls.push('hover');
    if (s.kind === 'hitbox' && !(s.action === 'url' ? s.url : s.target_map_id)) cls.push('no-target');
    node.setAttribute('class', cls.join(' '));
    node.style.setProperty('--c', s.color || '#4da3ff');
    const o = this.opacity.get(s.id);
    if (o !== undefined && o < 1) node.style.opacity = o;
    return node;
  }

  // Set opacities without re-rendering (called every animation frame while images fade).
  setOpacities(map) {
    this.opacity = map;
    for (const [id, node] of this.nodes) {
      const o = map.get(id);
      node.style.opacity = o === undefined || o >= 1 ? '' : o;
    }
  }

  // Vertex handles for the selected shape, drawn in screen pixels so they don't grow with zoom.
  renderScreen() {
    this.screen.replaceChildren();
    const sel = this.opts.handles && this.shapes.find((s) => s.id === this.opts.selectedId);
    if (!sel) return;
    shapePoints(sel.geometry).forEach(([x, y]) => {
      const p = this.toPixel(x, y);
      this.screen.appendChild(el('rect', { x: p.x - 5, y: p.y - 5, width: 10, height: 10, class: 'handle' }));
    });
  }

  // Topmost shape containing viewport point pt.
  hitTest(pt, filter = () => true) {
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      if ((this.opacity.get(s.id) ?? 1) < 0.05) continue; // faded out with its image
      if (filter(s) && pointInShape(pt.x, pt.y, s.geometry)) return s;
    }
    return null;
  }

  // Index of the selected shape's vertex within `radius` pixels of pixel position pos.
  handleAt(pos, radius = 8) {
    const sel = this.shapes.find((s) => s.id === this.opts.selectedId);
    if (!sel) return -1;
    const pts = shapePoints(sel.geometry);
    for (let i = 0; i < pts.length; i++) {
      const p = this.toPixel(pts[i][0], pts[i][1]);
      if (Math.hypot(p.x - pos.x, p.y - pos.y) <= radius) return i;
    }
    return -1;
  }
}

// Pixel position of a DOM mouse event relative to the viewer container.
export function eventPixel(viewer, e) {
  const r = viewer.container.getBoundingClientRect();
  return new OpenSeadragon.Point(e.clientX - r.left, e.clientY - r.top);
}

export async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json', ...opts.headers } : opts.headers,
    body: opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

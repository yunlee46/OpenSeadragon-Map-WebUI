// Computes and applies image opacity for focus mode and zoom-reveal.
//
// Focus: every fade-eligible image except the focused ones drops to `focusOpacity` (eased).
// Zoom-reveal: an eligible image starts fading once it fills the screen and is fully transparent one
// zoom doubling later, uncovering what's underneath. Overlapping eligible images peel away in stacking
// order: an image only starts fading after the eligible images stacked above it have faded out.
// A layer's manual `zoom_fade` sets its own start zoom instead.

import { canFade, layerHeight, find, descendantLayers } from './tree.js';

const smooth = (t) => t * t * (3 - 2 * t);
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export class FadeController {
  // getLayers(): [{ layer, hidden, item }] in draw order, bottom first.
  constructor(viewer, getLayers) {
    this.viewer = viewer;
    this.getLayers = getLayers;
    this.types = new Map();
    this.focusIds = null;        // Set of focused layer ids, or null
    this.focusOpacity = 0.3;
    this.zoomReveal = false;
    this.focusFactor = new Map(); // layer id -> current eased focus factor
    this.schedule = new Map();    // layer id -> { start, end } zoom-reveal window
    this.raf = null;
    this.current = new Map();     // layer id -> applied opacity (for hit testing)

    viewer.addHandler('animation', () => this.apply());
    viewer.addHandler('resize', () => this.refresh());
  }

  setTypes(types) { this.types = new Map(types.map((t) => [t.id, t])); this.refresh(); }
  setFocus(ids) { this.focusIds = ids && ids.size ? ids : null; this.animate(); }
  setFocusOpacity(v) { this.focusOpacity = v; this.animate(); }
  setZoomReveal(on) { this.zoomReveal = on; this.refresh(); }

  // Recompute zoom-reveal windows (after layers move, change or the viewer resizes).
  refresh() {
    this.schedule.clear();
    const vp = this.viewer.viewport;
    if (!vp) return;
    const size = vp.getContainerSize();
    const aspect = size.y / Math.max(1, size.x);
    const done = [];
    // Top of the stack first.
    for (const { layer, hidden } of [...this.getLayers()].reverse()) {
      if (hidden || !canFade(layer, 'zoom', this.types)) continue;
      const b = { x: layer.x, y: layer.y, w: layer.width, h: layerHeight(layer) };
      let start;
      if (layer.zoom_fade) {
        start = layer.zoom_fade;
      } else {
        // OpenSeadragon zoom z shows 1/z units across; the image fills the screen once it's wider and taller than that.
        start = Math.max(1 / b.w, aspect / b.h);
        for (const above of done) if (overlaps(above.b, b)) start = Math.max(start, above.end);
      }
      const win = { start, end: start * 2, b };
      this.schedule.set(layer.id, win);
      done.push(win);
    }
    this.apply();
  }

  zoomFactor(id, zoom) {
    const w = this.schedule.get(id);
    if (!this.zoomReveal || !w) return 1;
    const t = Math.min(1, Math.max(0, Math.log2(zoom / w.start) / Math.log2(w.end / w.start)));
    return 1 - smooth(t);
  }

  focusTarget(layer) {
    if (!this.focusIds || this.focusIds.has(layer.id) || !canFade(layer, 'focus', this.types)) return 1;
    return this.focusOpacity;
  }

  // Ease focus factors toward their targets over a few frames.
  animate() {
    if (this.raf) return;
    const step = () => {
      let moving = false;
      for (const { layer } of this.getLayers()) {
        const target = this.focusTarget(layer);
        const cur = this.focusFactor.get(layer.id) ?? 1;
        const next = Math.abs(target - cur) < 0.01 ? target : cur + (target - cur) * 0.2;
        if (next !== target) moving = true;
        this.focusFactor.set(layer.id, next);
      }
      this.apply();
      this.raf = moving ? requestAnimationFrame(step) : null;
    };
    this.raf = requestAnimationFrame(step);
  }

  apply() {
    const vp = this.viewer.viewport;
    if (!vp) return;
    const zoom = vp.getZoom(true);
    for (const { layer, hidden, item } of this.getLayers()) {
      let o = 0;
      if (!hidden) {
        const focused = this.focusIds?.has(layer.id);
        o = layer.opacity * (this.focusFactor.get(layer.id) ?? 1) * (focused ? 1 : this.zoomFactor(layer.id, zoom));
      }
      this.current.set(layer.id, o);
      if (item && Math.abs(item.getOpacity() - o) > 0.001) item.setOpacity(o);
    }
    this.onApply?.();
  }

  opacityOf(id) { return this.current.get(id) ?? 1; }

  // Opacity for shapes attached to an image (or group: its most visible image).
  shapeOpacities(shapes, tree, floor = 0) {
    const out = new Map();
    for (const s of shapes) {
      if (!s.attach_id) continue;
      const node = find(tree, s.attach_id)?.node;
      if (!node) continue;
      const layers = descendantLayers(node);
      const o = layers.length ? Math.max(...layers.map((l) => this.opacityOf(l.id))) : 1;
      out.set(s.id, Math.max(floor, o));
    }
    return out;
  }
}

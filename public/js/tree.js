// Helpers for a map's image tree: groups { kind: 'group', children } and layers { kind: 'layer' }.
// Lists are in display order, top first. The top of the list is drawn on top.

export function walk(list, fn, parent = null, depth = 0, hidden = false) {
  for (const n of list) {
    const h = hidden || !!n.hidden;
    fn(n, parent, depth, h);
    if (n.children) walk(n.children, fn, n, depth + 1, h);
  }
}

export function find(list, id, parent = null) {
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n.id === id) return { node: n, list, index: i, parent };
    if (n.children) {
      const r = find(n.children, id, n);
      if (r) return r;
    }
  }
  return null;
}

export function remove(list, id) {
  const r = find(list, id);
  if (!r) return null;
  r.list.splice(r.index, 1);
  return r.node;
}

// where: 'before' | 'after' | 'inside' (top of a group) | 'root' (bottom of the top level)
export function insert(list, node, targetId, where) {
  if (where === 'root' || !targetId) { list.push(node); return; }
  const r = find(list, targetId);
  if (!r) { list.push(node); return; }
  if (where === 'inside' && r.node.children) r.node.children.unshift(node);
  else r.list.splice(where === 'after' ? r.index + 1 : r.index, 0, node);
}

// True if `id` is `node` or anywhere inside it.
export function contains(node, id) {
  if (node.id === id) return true;
  return !!node.children?.some((c) => contains(c, id));
}

// Layers in list order (top first). Each entry is the layer node; `hidden` includes hidden ancestors.
export function layersTopFirst(list) {
  const out = [];
  walk(list, (n, parent, depth, hidden) => { if (n.kind === 'layer') out.push({ layer: n, hidden }); });
  return out;
}

export function descendantLayers(node) {
  if (node.kind === 'layer') return [node];
  const out = [];
  walk(node.children, (n) => { if (n.kind === 'layer') out.push(n); });
  return out;
}

export const layerHeight = (l) => l.width * (l.px_height / l.px_width);
export const layerBounds = (l) => ({ x: l.x, y: l.y, w: l.width, h: layerHeight(l) });

export function unionBounds(layers) {
  if (!layers.length) return null;
  const xs = layers.flatMap((l) => [l.x, l.x + l.width]);
  const ys = layers.flatMap((l) => [l.y, l.y + layerHeight(l)]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export const displayName = (l) => l.name || l.image_name;

export const effectiveTypeId = (l) => l.type_override || l.image_type_id || null;

// feature: 'focus' | 'zoom'. Images without a type can fade.
export function canFade(layer, feature, typesById) {
  if (layer.fade_mode === 'always') return true;
  if (layer.fade_mode === 'never') return false;
  const t = typesById.get(effectiveTypeId(layer));
  return t ? !!t[`fade_${feature}`] : true;
}

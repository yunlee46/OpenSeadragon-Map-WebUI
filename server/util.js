const ID_RE = /^[0-9a-f]{16}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const str = (s, max) => (typeof s === 'string' ? s.slice(0, max) : '');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Express handler wrapper that forwards sync throws and rejected promises to the error handler.
const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (e) {
    next(e);
  }
};

function validGeometry(g) {
  if (!g || typeof g !== 'object') return null;
  if (g.type === 'rect') {
    const { x, y, w, h } = g;
    if (![x, y, w, h].every(finite) || w <= 0 || h <= 0) return null;
    return { type: 'rect', x, y, w, h };
  }
  if (g.type === 'polygon') {
    if (!Array.isArray(g.points) || g.points.length < 3 || g.points.length > 2000) return null;
    const points = g.points.map((p) => (Array.isArray(p) && finite(p[0]) && finite(p[1]) ? [p[0], p[1]] : null));
    if (points.includes(null)) return null;
    return { type: 'polygon', points };
  }
  return null;
}

// {x, y, w, h} in viewport coordinates, or null.
function validView(v) {
  if (!v || typeof v !== 'object') return null;
  const { x, y, w, h } = v;
  if (![x, y, w, h].every(finite) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

const dziUrl = (img) => `/tiles/${img.id}/${img.dzi_path.split('/').map(encodeURIComponent).join('/')}`;
const thumbUrl = (img) => `/tiles/${img.id}/${(img.thumb_path || 'thumb.webp').split('/').map(encodeURIComponent).join('/')}`;

module.exports = { ID_RE, COLOR_RE, URL_RE, finite, str, HttpError, wrap, validGeometry, validView, dziUrl, thumbUrl };

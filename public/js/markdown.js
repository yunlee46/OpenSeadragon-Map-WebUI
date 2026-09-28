// A small, safe Markdown subset for notes:
//   **bold**, *italic* or _italic_, `code`, [text](https://… or ?map=<id>), "- " lists, blank line = new paragraph.
// Everything is HTML-escaped first; only the tags built here are ever produced.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Links may go to web pages, e-mail, or another map in this app (?map=… / /?map=…).
function safeHref(url) {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return { href: u, external: !/^mailto:/i.test(u) };
  if (/^\/?\?map=[0-9a-f]{16}([&#].*)?$/i.test(u)) return { href: u.startsWith('/') ? u : `/${u}`, external: false };
  return null;
}

function inline(text) {
  // Pull code spans out first so their contents aren't formatted.
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (m, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    // url was escaped along with the text; undo that to validate, then escape again for the attribute.
    const raw = url.replace(/&amp;/g, '&');
    const link = safeHref(raw);
    if (!link) return label;
    const attrs = link.external ? ' target="_blank" rel="noopener noreferrer"' : ' data-internal="1"';
    return `<a href="${esc(link.href)}"${attrs}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[+i]}</code>`);
}

export function renderMarkdown(src) {
  const blocks = String(src || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}

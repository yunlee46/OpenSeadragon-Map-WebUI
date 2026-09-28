import { api } from '/js/overlay.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export const h = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k in n && k !== 'list') n[k] = v;
    else n.setAttribute(k, v);
  }
  n.append(...children.flat().filter((c) => c != null && c !== false));
  return n;
};

export const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Any 401 means the session expired.
export async function adminApi(url, opts) {
  try {
    return await api(url, opts);
  } catch (err) {
    if (err.status === 401) {
      alert('Your session has expired. Please log in again. (Unsaved editor changes are still on screen; log in in another tab to keep them.)');
    }
    throw err;
  }
}

// Upload files to the library. Resolves with the new image ids (they are tiled in the background).
export function uploadFiles(files, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/admin/images');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* keep empty */ }
      if (xhr.status >= 400) reject(new Error(data.error || 'Upload failed'));
      else resolve(data.ids || []);
    };
    xhr.onerror = () => reject(new Error('Upload failed (network error)'));
    xhr.send(form);
  });
}

export const typeLabel = (types, id) => types.find((t) => t.id === id)?.name || null;

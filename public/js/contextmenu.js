// Right-click menu with nested submenus.
// items: [{ label, onClick, danger, checked, disabled, submenu: [...] } | { separator: true }]

let open = null;

export function closeMenu() {
  open?.remove();
  open = null;
}

function build(items) {
  const ul = document.createElement('ul');
  ul.className = 'ctx-menu';
  for (const it of items) {
    const li = document.createElement('li');
    if (it.separator) {
      li.className = 'sep';
      ul.append(li);
      continue;
    }
    li.className = [it.danger && 'danger', it.disabled && 'disabled', it.submenu && 'has-sub'].filter(Boolean).join(' ');
    const check = document.createElement('span');
    check.className = 'check';
    check.textContent = it.checked ? '✓' : '';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = it.label;
    li.append(check, label);
    if (it.submenu) {
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '▸';
      li.append(arrow, build(it.submenu));
      li.addEventListener('mouseenter', () => placeSub(li));
    } else if (!it.disabled) {
      li.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        it.onClick?.();
      });
    }
    ul.append(li);
  }
  return ul;
}

// Flip submenus to the left or up when they'd run off the screen.
function placeSub(li) {
  const sub = li.querySelector(':scope > .ctx-menu');
  if (!sub) return;
  sub.classList.remove('left');
  sub.style.top = '';
  const r = sub.getBoundingClientRect();
  if (r.right > window.innerWidth - 4) sub.classList.add('left');
  if (r.bottom > window.innerHeight - 4) sub.style.top = `${window.innerHeight - 4 - r.bottom}px`;
}

export function showMenu(x, y, items) {
  closeMenu();
  const menu = build(items);
  menu.classList.add('root');
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  open = menu;
}

document.addEventListener('pointerdown', (e) => { if (open && !open.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

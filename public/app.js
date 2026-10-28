'use strict';
// ---------- tiny helpers ----------
const $app = document.getElementById('app');
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') value = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  if (value !== undefined) el.value = value; // after children, so <select> options exist
  return el;
}
const today = () => new Date().toISOString().slice(0, 10);
const initials = (n) => n.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

function toast(msg, kind = 'info') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 4500);
}

// ---------- state + API ----------
const S = { token: localStorage.getItem('token'), user: null, projectId: null, board: null, activity: [], panel: null, filters: { assignee: '', label: '', overdue: false }, es: null, dragging: false, pendingReload: false };

async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const e = new Error('Cannot reach the server. Check your connection.');
    e.errors = [];
    throw e;
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth')) logout();
    const e = new Error(data?.error || 'Request failed');
    e.status = res.status;
    e.errors = data?.errors || [];
    throw e;
  }
  return data;
}

// Show server validation errors next to the matching input (data-for="field"); anything else becomes a toast / form error.
function showErrors(root, err) {
  root.querySelectorAll('.field-error, .form-error').forEach((n) => (n.textContent = ''));
  let general = err.errors.length ? '' : err.message;
  for (const e of err.errors) {
    const slot = root.querySelector(`.field-error[data-for="${e.field}"]`);
    if (slot) slot.textContent = e.message;
    else general = general ? `${general} ${e.message}` : e.message;
  }
  const form = root.querySelector('.form-error');
  if (general) form ? (form.textContent = general) : toast(general, 'error');
}
const field = (label, input, name) => h('div', { class: 'field' }, h('label', {}, label), input, h('div', { class: 'field-error', dataset: { for: name } }));

function logout() {
  localStorage.removeItem('token');
  S.token = null; S.user = null;
  closeStream();
  location.hash = '';
  route();
}

// ---------- modal ----------
function openModal(title, ...content) {
  const close = () => backdrop.remove();
  const backdrop = h('div', { class: 'modal-backdrop', onMousedown: (e) => e.target === backdrop && close() },
    h('div', { class: 'modal', role: 'dialog', 'aria-label': title }, h('h2', {}, title), ...content));
  document.body.append(backdrop);
  return { close, el: backdrop };
}
function textModal({ title, label, value = '', submit, onSubmit }) {
  const input = h('input', { name: 'name', value, maxlength: 80, autofocus: true });
  const form = h('form', { novalidate: true }, field(label, input, 'name'), h('div', { class: 'form-error' }),
    h('div', { class: 'actions' }, h('button', { type: 'button', onClick: () => m.close() }, 'Cancel'), h('button', { class: 'primary' }, submit)));
  const m = openModal(title, form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await onSubmit(input.value); m.close(); } catch (err) { showErrors(form, err); }
  });
  setTimeout(() => input.focus(), 0);
}

// ---------- routing ----------
function route() {
  closeStream();
  const m = location.hash.match(/^#\/p\/(\d+)$/);
  if (!S.token) return renderAuth('login');
  if (m) return renderBoard(Number(m[1]));
  return renderProjects();
}
window.addEventListener('hashchange', route);

// ---------- auth ----------
function renderAuth(mode) {
  const reg = mode === 'register';
  const form = h('form', { novalidate: true },
    reg && field('Name', h('input', { name: 'name', autocomplete: 'name' }), 'name'),
    field('Email', h('input', { name: 'email', type: 'email', autocomplete: 'email' }), 'email'),
    field('Password', h('input', { name: 'password', type: 'password', autocomplete: reg ? 'new-password' : 'current-password' }), 'password'),
    h('div', { class: 'form-error' }),
    h('button', { class: 'primary', style: 'width:100%' }, reg ? 'Create account' : 'Sign in'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    try {
      const r = await api('POST', reg ? '/auth/register' : '/auth/login', f);
      S.token = r.token; S.user = r.user; localStorage.setItem('token', r.token);
      location.hash = ''; route();
    } catch (err) { showErrors(form, err); }
  });
  $app.replaceChildren(h('div', { class: 'page' }, h('h1', {}, 'Kanban'),
    h('div', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, reg ? 'Create your account' : 'Sign in'), form,
      h('p', { class: 'muted' }, reg ? 'Have an account? ' : 'New here? ',
        h('a', { href: '#', onClick: (e) => { e.preventDefault(); renderAuth(reg ? 'login' : 'register'); } }, reg ? 'Sign in' : 'Create an account')),
      !reg && h('p', { class: 'muted' }, 'Demo: asha@demo.com / password123'))));
}

// ---------- project list ----------
async function renderProjects() {
  try {
    if (!S.user) S.user = (await api('GET', '/me')).user;
    const { projects } = await api('GET', '/projects');
    const form = h('form', { novalidate: true, class: 'row' }, h('div', {}, h('input', { name: 'name', placeholder: 'New project name', maxlength: 80 }), h('div', { class: 'field-error', dataset: { for: 'name' } })), h('button', { class: 'primary', style: 'flex:0 0 auto' }, 'Create'), h('div', { class: 'form-error' }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { const r = await api('POST', '/projects', { name: form.elements.name.value }); location.hash = `#/p/${r.project.id}`; } catch (err) { showErrors(form, err); }
    });
    $app.replaceChildren(
      h('div', { class: 'topbar' }, h('h1', {}, 'Your projects'), h('span', { class: 'muted' }, S.user.name), h('button', { onClick: logout }, 'Sign out')),
      h('div', { class: 'page' },
        h('div', { class: 'panel' }, form),
        projects.length ? projects.map((p) => h('a', { class: 'project-link', href: `#/p/${p.id}` }, h('span', {}, p.name), h('span', { class: 'badge' }, p.role))) : h('p', { class: 'muted' }, 'No projects yet. Create one above.')));
  } catch (err) { toast(err.message, 'error'); }
}

// ---------- board ----------
function closeStream() { S.es?.close(); S.es = null; }

async function renderBoard(id) {
  S.projectId = id; S.panel = null; S.board = null;
  $app.replaceChildren(h('div', { class: 'page muted' }, 'Loading board…'));
  try {
    if (!S.user) S.user = (await api('GET', '/me')).user;
    await reload();
    S.es = new EventSource(`/api/projects/${id}/events?token=${encodeURIComponent(S.token)}`);
    S.es.onmessage = () => scheduleReload();
  } catch (err) {
    $app.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'panel' }, h('p', {}, err.status === 404 ? 'This project does not exist, or you are not a member.' : err.message), h('a', { href: '#' }, 'Back to projects'))));
  }
}

let reloadTimer;
function scheduleReload() {
  if (S.dragging) { S.pendingReload = true; return; }
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => reload().catch(() => {}), 120);
}
async function reload() {
  const id = S.projectId;
  const board = await api('GET', `/projects/${id}`);
  if (S.panel === 'activity') S.activity = (await api('GET', `/projects/${id}/activity`)).activity;
  if (id !== S.projectId) return;
  S.board = board;
  draw();
}

function visible(c) {
  const f = S.filters;
  if (f.assignee === 'none' ? c.assigneeId : f.assignee && String(c.assigneeId) !== f.assignee) return false;
  if (f.label && !c.labelIds.includes(Number(f.label))) return false;
  if (f.overdue && !(c.dueDate && c.dueDate < today())) return false;
  return true;
}

function draw() {
  const { board } = S;
  const owner = board.role === 'owner';
  const prevScroll = $app.querySelector('.board')?.scrollLeft ?? 0;
  const member = (id) => board.members.find((m) => m.id === id);
  const label = (id) => board.labels.find((l) => l.id === id);

  const filters = h('div', { class: 'filters' },
    h('select', { 'aria-label': 'Filter by assignee', value: S.filters.assignee, onChange: (e) => { S.filters.assignee = e.target.value; draw(); } },
      h('option', { value: '' }, 'All assignees'), h('option', { value: 'none' }, 'Unassigned'), board.members.map((m) => h('option', { value: m.id }, m.name))),
    h('select', { 'aria-label': 'Filter by label', value: S.filters.label, onChange: (e) => { S.filters.label = e.target.value; draw(); } },
      h('option', { value: '' }, 'All labels'), board.labels.map((l) => h('option', { value: l.id }, l.name))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.filters.overdue, onChange: (e) => { S.filters.overdue = e.target.checked; draw(); } }), 'Overdue only'));

  const cardEl = (c) => h('div', { class: `card${visible(c) ? '' : ' hidden'}`, dataset: { id: c.id }, tabindex: 0, onClick: () => openCard(c.id) },
    c.labelIds.length > 0 && h('div', { class: 'chips' }, c.labelIds.map((id) => label(id) && h('span', { class: 'chip', style: `background:${label(id).color}` }, label(id).name))),
    h('div', { class: 'title' }, c.title),
    h('div', { class: 'meta' },
      c.dueDate && h('span', { class: `due${c.dueDate < today() ? ' overdue' : ''}` }, '📅 ' + c.dueDate),
      c.commentCount > 0 && h('span', {}, '💬 ' + c.commentCount),
      c.assigneeId && member(c.assigneeId) && h('span', { class: 'avatar', title: member(c.assigneeId).name }, initials(member(c.assigneeId).name))));

  const columnEl = (col) => {
    const cards = board.cards.filter((c) => c.columnId === col.id);
    const addForm = h('form', { class: 'add-card', novalidate: true }, h('input', { name: 'title', placeholder: 'Add a card', 'aria-label': `Add card to ${col.name}`, maxlength: 200 }), h('button', {}, 'Add'));
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('POST', `/projects/${S.projectId}/cards`, { columnId: col.id, title: addForm.elements.title.value }); await reload(); } catch (err) { showErrors(addForm, err); toast(err.errors[0]?.message || err.message, 'error'); }
    });
    return h('section', { class: 'column', dataset: { id: col.id } },
      h('header', { class: 'col-head' },
        owner && h('span', { class: 'col-handle', title: 'Drag to reorder column' }, '⠿'),
        h('h2', { class: 'col-title' }, col.name), h('span', { class: 'count' }, cards.length),
        owner && h('button', { class: 'icon', title: 'Rename column', 'aria-label': 'Rename column', onClick: () => textModal({ title: 'Rename column', label: 'Column name', value: col.name, submit: 'Save', onSubmit: (v) => api('PATCH', `/columns/${col.id}`, { name: v }).then(reload) }) }, '✎'),
        owner && h('button', { class: 'icon', title: 'Delete column', 'aria-label': 'Delete column', onClick: async () => { if (confirm(`Delete column "${col.name}"?`)) { try { await api('DELETE', `/columns/${col.id}`); await reload(); } catch (e) { toast(e.message, 'error'); } } } }, '✕')),
      h('div', { class: 'cards', dataset: { col: col.id } }, cards.map(cardEl)),
      addForm);
  };

  const boardEl = h('div', { class: 'board' }, board.columns.map(columnEl),
    owner && h('div', { class: 'add-column' }, h('button', { style: 'width:100%', onClick: () => textModal({ title: 'Add column', label: 'Column name', submit: 'Add', onSubmit: (v) => api('POST', `/projects/${S.projectId}/columns`, { name: v }).then(reload) }) }, '+ Add column')));

  const activityEl = S.panel === 'activity' && h('aside', { class: 'activity' },
    h('div', { class: 'row', style: 'align-items:center' }, h('h2', { style: 'margin:0;font-size:16px' }, 'Activity'), h('button', { style: 'flex:0 0 auto', onClick: () => { S.panel = null; draw(); } }, 'Close')),
    h('ul', {}, S.activity.map((a) => h('li', {}, a.message, h('time', {}, new Date(a.createdAt.replace(' ', 'T') + 'Z').toLocaleString())))));

  $app.replaceChildren(h('div', { class: 'app-board' },
    h('div', { class: 'topbar' },
      h('a', { href: '#', 'aria-label': 'Back to projects' }, '← Projects'), h('h1', {}, board.project.name),
      h('button', { onClick: openMembers }, `Members (${board.members.length})`),
      h('button', { onClick: async () => { S.panel = S.panel ? null : 'activity'; if (S.panel) S.activity = (await api('GET', `/projects/${S.projectId}/activity`)).activity; draw(); } }, 'Activity')),
    filters, h('div', { class: 'workspace' }, boardEl, activityEl)));

  boardEl.scrollLeft = prevScroll;
  initDnd(boardEl, owner);
}

// ---------- drag and drop (SortableJS: mouse + touch; long-press on touch so scrolling still works) ----------
function initDnd(boardEl, owner) {
  const common = { animation: 150, delay: 180, delayOnTouchOnly: true, touchStartThreshold: 6, ghostClass: 'sortable-ghost', onStart: () => { S.dragging = true; } };
  boardEl.querySelectorAll('.cards').forEach((list) => {
    new Sortable(list, {
      ...common, group: 'cards',
      onEnd: async (evt) => {
        S.dragging = false;
        const el = evt.item, prev = el.previousElementSibling, next = el.nextElementSibling;
        if (evt.from !== evt.to || evt.oldIndex !== evt.newIndex) {
          try {
            await api('PATCH', `/cards/${el.dataset.id}/move`, { columnId: Number(evt.to.dataset.col), beforeId: prev ? Number(prev.dataset.id) : null, afterId: next ? Number(next.dataset.id) : null });
          } catch (err) { toast(err.message, 'error'); }
        }
        S.pendingReload = false;
        await reload().catch(() => {});
      },
    });
  });
  if (owner) {
    new Sortable(boardEl, {
      ...common, draggable: '.column', handle: '.col-handle', delay: 0,
      onEnd: async (evt) => {
        S.dragging = false;
        const el = evt.item, prev = el.previousElementSibling, next = el.nextElementSibling;
        if (evt.oldIndex !== evt.newIndex) {
          try {
            await api('PATCH', `/columns/${el.dataset.id}/move`, { beforeId: prev?.classList.contains('column') ? Number(prev.dataset.id) : null, afterId: next?.classList.contains('column') ? Number(next.dataset.id) : null });
          } catch (err) { toast(err.message, 'error'); }
        }
        S.pendingReload = false;
        await reload().catch(() => {});
      },
    });
  }
}

// ---------- members ----------
function openMembers() {
  const { board } = S, owner = board.role === 'owner';
  const list = h('div', {}, board.members.map((m) => h('div', { class: 'member-row' },
    h('span', {}, `${m.name} `, h('span', { class: 'muted' }, m.email)), h('span', {}, h('span', { class: 'badge' }, m.role), ' ',
      owner && m.role !== 'owner' && h('button', { class: 'danger', onClick: async () => { if (confirm(`Remove ${m.name}?`)) { try { await api('DELETE', `/projects/${S.projectId}/members/${m.id}`); modal.close(); await reload(); } catch (e) { toast(e.message, 'error'); } } } }, 'Remove')))));
  const invite = owner && h('form', { novalidate: true }, h('h3', {}, 'Invite a member'), field('Email of a registered user', h('input', { name: 'email', type: 'email' }), 'email'), h('div', { class: 'form-error' }), h('button', { class: 'primary' }, 'Invite'));
  invite && invite.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', `/projects/${S.projectId}/members`, { email: invite.elements.email.value }); modal.close(); await reload(); toast('Member added'); } catch (err) { showErrors(invite, err); }
  });
  const modal = openModal('Members', list, invite, h('div', { class: 'actions' }, h('button', { onClick: () => modal.close() }, 'Close')));
}

// ---------- card modal (edit, labels, comments) ----------
async function openCard(id) {
  const { board } = S;
  const c = board.cards.find((x) => x.id === id);
  if (!c) return;
  const form = h('form', { novalidate: true },
    field('Title', h('input', { name: 'title', value: c.title, maxlength: 200 }), 'title'),
    field('Description', h('textarea', { name: 'description', value: c.description, maxlength: 5000 }), 'description'),
    h('div', { class: 'row' },
      field('Assignee', h('select', { name: 'assigneeId', value: c.assigneeId ?? '' }, h('option', { value: '' }, 'Unassigned'), board.members.map((m) => h('option', { value: m.id }, m.name))), 'assigneeId'),
      field('Due date', h('input', { name: 'dueDate', type: 'date', value: c.dueDate ?? '' }), 'dueDate')),
    field('Labels', h('div', { class: 'check-list' }, board.labels.map((l) => h('label', {}, h('input', { type: 'checkbox', name: 'label', value: l.id, checked: c.labelIds.includes(l.id) }), h('span', { class: 'chip', style: `background:${l.color}` }, l.name)))), 'labelIds'),
    h('div', { class: 'form-error' }),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'danger', onClick: async () => { if (confirm('Delete this card?')) { try { await api('DELETE', `/cards/${id}`); modal.close(); await reload(); } catch (e) { toast(e.message, 'error'); } } } }, 'Delete'),
      h('button', { type: 'button', onClick: () => modal.close() }, 'Cancel'), h('button', { class: 'primary' }, 'Save')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', `/cards/${id}`, {
        title: form.elements.title.value, description: form.elements.description.value,
        assigneeId: form.elements.assigneeId.value ? Number(form.elements.assigneeId.value) : null,
        dueDate: form.elements.dueDate.value || null,
        labelIds: [...form.querySelectorAll('input[name=label]:checked')].map((i) => Number(i.value)),
      });
      modal.close(); await reload();
    } catch (err) { showErrors(form, err); }
  });

  // quick "new label" (any member)
  const labelForm = h('form', { class: 'row', novalidate: true, style: 'align-items:end;margin-bottom:12px' },
    field('New label', h('input', { name: 'name', placeholder: 'Label name', maxlength: 30 }), 'name'), h('div', { class: 'field', style: 'flex:0 0 56px' }, h('label', {}, 'Colour'), h('input', { name: 'color', type: 'color', value: '#0891b2' })), h('div', { class: 'field', style: 'flex:0 0 auto' }, h('button', {}, 'Add label')));
  labelForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', `/projects/${S.projectId}/labels`, { name: labelForm.elements.name.value, color: labelForm.elements.color.value }); modal.close(); await reload(); openCard(id); } catch (err) { showErrors(labelForm, err); }
  });

  const commentsBox = h('div', {}, h('p', { class: 'muted' }, 'Loading comments…'));
  const commentForm = h('form', { novalidate: true }, field('Add a comment', h('textarea', { name: 'body', maxlength: 2000, style: 'min-height:60px' }), 'body'), h('div', { class: 'form-error' }), h('button', { class: 'primary' }, 'Comment'));
  const loadComments = async () => {
    try {
      const { comments } = await api('GET', `/cards/${id}/comments`);
      commentsBox.replaceChildren(...(comments.length ? comments.map((m) => h('div', { class: 'comment' }, h('b', {}, m.authorName), ' ', h('span', { class: 'muted' }, new Date(m.createdAt.replace(' ', 'T') + 'Z').toLocaleString()), h('div', {}, m.body))) : [h('p', { class: 'muted' }, 'No comments yet.')]));
    } catch (err) { commentsBox.replaceChildren(h('p', { class: 'form-error' }, err.message)); }
  };
  commentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', `/cards/${id}/comments`, { body: commentForm.elements.body.value }); commentForm.elements.body.value = ''; showErrors(commentForm, { errors: [], message: '' }); await loadComments(); await reload(); } catch (err) { showErrors(commentForm, err); }
  });

  const modal = openModal('Card', form, labelForm, h('h3', {}, 'Comments'), commentsBox, commentForm);
  loadComments();
}

route();

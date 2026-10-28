import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

let server, base, db;
before(async () => {
  db = openDb(':memory:');
  server = http.createServer(createApp({ db, jwtSecret: 'test-secret' }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  await setupFixture();
});
after(() => server.close());

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const register = async (email, name) => (await api('POST', '/api/auth/register', { body: { email, name, password: 'password123' } })).body.token;

// Shared fixture: owner "Asha" with a member "Ravi" and an outsider "Eve".
const ctx = {};
async function setupFixture() {
  ctx.asha = await register('asha@t.com', 'Asha');
  ctx.ravi = await register('ravi@t.com', 'Ravi');
  ctx.eve = await register('eve@t.com', 'Eve');
  ctx.project = (await api('POST', '/api/projects', { token: ctx.asha, body: { name: 'Demo' } })).body.project;
  await api('POST', `/api/projects/${ctx.project.id}/members`, { token: ctx.asha, body: { email: 'ravi@t.com' } });
  const board = (await api('GET', `/api/projects/${ctx.project.id}`, { token: ctx.asha })).body;
  [ctx.todo, ctx.doing, ctx.done] = board.columns;
  ctx.raviId = board.members.find((m) => m.email === 'ravi@t.com').id;
}

const newCard = async (title, columnId) =>
  (await api('POST', `/api/projects/${ctx.project.id}/cards`, { token: ctx.asha, body: { columnId, title } })).body.id;
const order = async (columnId) =>
  (await api('GET', `/api/projects/${ctx.project.id}`, { token: ctx.asha })).body.cards.filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position).map((c) => c.title);

test('moving a card between cards, to the top, to the end and into an empty column keeps the right order', async () => {
  const a = await newCard('A', ctx.todo.id), b = await newCard('B', ctx.todo.id), c = await newCard('C', ctx.todo.id);
  const mv = (id, body) => api('PATCH', `/api/cards/${id}/move`, { token: ctx.asha, body });
  await mv(c, { columnId: ctx.todo.id, beforeId: a, afterId: b }); // between A and B
  assert.deepEqual(await order(ctx.todo.id), ['A', 'C', 'B']);
  await mv(b, { columnId: ctx.todo.id, afterId: a }); // to the top
  assert.deepEqual(await order(ctx.todo.id), ['B', 'A', 'C']);
  await mv(b, { columnId: ctx.todo.id, beforeId: c }); // to the end
  assert.deepEqual(await order(ctx.todo.id), ['A', 'C', 'B']);
  const r = await mv(a, { columnId: ctx.doing.id }); // into an empty column
  assert.equal(r.status, 200);
  assert.deepEqual(await order(ctx.doing.id), ['A']);
});

test('a move rewrites only the moved card', async () => {
  const x = await newCard('X', ctx.done.id), y = await newCard('Y', ctx.done.id), z = await newCard('Z', ctx.done.id);
  const before = db.prepare('SELECT id, position FROM cards WHERE column_id = ?').all(ctx.done.id);
  await api('PATCH', `/api/cards/${z}/move`, { token: ctx.asha, body: { columnId: ctx.done.id, beforeId: x, afterId: y } });
  const after = db.prepare('SELECT id, position FROM cards WHERE column_id = ?').all(ctx.done.id);
  const changed = after.filter((row) => before.find((r) => r.id === row.id).position !== row.position);
  assert.deepEqual(changed.map((r) => r.id), [z]);
});

test('repeated inserts into the same gap trigger a rebalance that preserves order', async () => {
  const col = (await api('POST', `/api/projects/${ctx.project.id}/columns`, { token: ctx.asha, body: { name: 'Stress' } })).body.column;
  const first = await newCard('first', col.id), last = await newCard('last', col.id);
  let upper = last, rebalanced = false;
  const expected = ['first'];
  const ids = [];
  for (let i = 0; i < 40; i++) {
    const id = await newCard(`n${i}`, col.id); // appended at end, then moved right below `first`
    const r = await api('PATCH', `/api/cards/${id}/move`, { token: ctx.asha, body: { columnId: col.id, beforeId: first, afterId: upper } });
    rebalanced ||= r.body.rebalanced;
    upper = id; ids.push(`n${i}`);
  }
  assert.equal(rebalanced, true);
  const titles = await order(col.id);
  assert.deepEqual(titles, ['first', ...ids.reverse(), 'last']);
  assert.ok(expected.length);
});

test('non-members get 404 on project, card, column and comment routes', async () => {
  const card = await newCard('Secret', ctx.todo.id);
  const eve = (method, path, body) => api(method, path, { token: ctx.eve, body });
  assert.equal((await eve('GET', `/api/projects/${ctx.project.id}`)).status, 404);
  assert.equal((await eve('GET', `/api/projects/${ctx.project.id}/activity`)).status, 404);
  assert.equal((await eve('PATCH', `/api/cards/${card}`, { title: 'hacked' })).status, 404);
  assert.equal((await eve('PATCH', `/api/cards/${card}/move`, { columnId: ctx.doing.id })).status, 404);
  assert.equal((await eve('GET', `/api/cards/${card}/comments`)).status, 404);
  assert.equal((await eve('POST', `/api/cards/${card}/comments`, { body: 'hi' })).status, 404);
  assert.equal((await eve('PATCH', `/api/columns/${ctx.todo.id}`, { name: 'x' })).status, 404);
  assert.equal((await eve('POST', `/api/projects/${ctx.project.id}/cards`, { columnId: ctx.todo.id, title: 'x' })).status, 404);
  assert.equal((await api('GET', `/api/projects/${ctx.project.id}`)).status, 401); // no token at all
  assert.equal((await api('GET', '/api/projects', { token: ctx.eve })).body.projects.length, 0);
});

test('a plain member cannot manage columns or members, but the owner can', async () => {
  const p = ctx.project.id;
  assert.equal((await api('POST', `/api/projects/${p}/columns`, { token: ctx.ravi, body: { name: 'Nope' } })).status, 403);
  assert.equal((await api('PATCH', `/api/columns/${ctx.todo.id}`, { token: ctx.ravi, body: { name: 'Nope' } })).status, 403);
  assert.equal((await api('PATCH', `/api/columns/${ctx.todo.id}/move`, { token: ctx.ravi, body: { afterId: ctx.doing.id } })).status, 403);
  assert.equal((await api('POST', `/api/projects/${p}/members`, { token: ctx.ravi, body: { email: 'eve@t.com' } })).status, 403);
  assert.equal((await api('PATCH', `/api/columns/${ctx.todo.id}`, { token: ctx.asha, body: { name: 'Backlog' } })).status, 200);
  assert.equal((await api('PATCH', `/api/columns/${ctx.todo.id}`, { token: ctx.asha, body: { name: 'To do' } })).status, 200);
  // members CAN work with cards
  const card = await newCard('Member card', ctx.todo.id);
  assert.equal((await api('PATCH', `/api/cards/${card}`, { token: ctx.ravi, body: { title: 'Edited by Ravi' } })).status, 200);
});

test('invalid input returns 400 with per-field messages', async () => {
  const r = await api('POST', `/api/projects/${ctx.project.id}/cards`, { token: ctx.asha, body: { columnId: ctx.todo.id, title: '   ', dueDate: '2026-13-45' } });
  assert.equal(r.status, 400);
  const fields = r.body.errors.map((e) => e.field).sort();
  assert.deepEqual(fields, ['dueDate', 'title']);
  const reg = await api('POST', '/api/auth/register', { body: { email: 'nope', name: '', password: 'short' } });
  assert.equal(reg.status, 400);
  assert.equal(reg.body.errors.length, 3);
});

test('assignee must be a project member and the target column must be in the same project', async () => {
  const card = await newCard('Assign me', ctx.todo.id);
  const eveId = db.prepare("SELECT id FROM users WHERE email = 'eve@t.com'").get().id;
  const bad = await api('PATCH', `/api/cards/${card}`, { token: ctx.asha, body: { assigneeId: eveId } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errors[0].field, 'assigneeId');
  assert.equal((await api('PATCH', `/api/cards/${card}`, { token: ctx.asha, body: { assigneeId: ctx.raviId } })).status, 200);
  // a column from another project is rejected
  const other = (await api('POST', '/api/projects', { token: ctx.eve, body: { name: 'Eve project' } })).body.project;
  const otherCol = (await api('GET', `/api/projects/${other.id}`, { token: ctx.eve })).body.columns[0];
  const move = await api('PATCH', `/api/cards/${card}/move`, { token: ctx.asha, body: { columnId: otherCol.id } });
  assert.equal(move.status, 400);
});

test('moving a card writes a readable activity entry with from/to columns', async () => {
  const card = await newCard('Login page', ctx.todo.id);
  await api('PATCH', `/api/cards/${card}/move`, { token: ctx.asha, body: { columnId: ctx.doing.id } });
  const { activity } = (await api('GET', `/api/projects/${ctx.project.id}/activity`, { token: ctx.ravi })).body;
  assert.equal(activity[0].message, 'Asha moved "Login page" from To do to In progress');
});

test('comments are saved with author and listed in order', async () => {
  const card = await newCard('Commented', ctx.todo.id);
  await api('POST', `/api/cards/${card}/comments`, { token: ctx.ravi, body: { body: 'First!' } });
  await api('POST', `/api/cards/${card}/comments`, { token: ctx.asha, body: { body: 'Second' } });
  const { comments } = (await api('GET', `/api/cards/${card}/comments`, { token: ctx.asha })).body;
  assert.deepEqual(comments.map((c) => [c.authorName, c.body]), [['Ravi', 'First!'], ['Asha', 'Second']]);
  assert.equal((await api('POST', `/api/cards/${card}/comments`, { token: ctx.asha, body: { body: '' } })).status, 400);
});

test('columns can be reordered and order survives a reload', async () => {
  const p = ctx.project.id;
  const cols = (await api('GET', `/api/projects/${p}`, { token: ctx.asha })).body.columns.map((c) => c.id);
  const [first, , last] = [cols[0], cols[1], cols[cols.length - 1]];
  assert.equal((await api('PATCH', `/api/columns/${first}/move`, { token: ctx.asha, body: { beforeId: last } })).status, 200);
  const reloaded = (await api('GET', `/api/projects/${p}`, { token: ctx.asha })).body.columns.map((c) => c.id);
  assert.equal(reloaded[reloaded.length - 1], first);
});

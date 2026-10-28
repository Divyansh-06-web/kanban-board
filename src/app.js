import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { positionBetween, gapTooSmall, rebalance } from './positions.js';
import { subscribe, publish } from './events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class HttpError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}
const NOT_FOUND = () => new HttpError(404, 'Not found');

// ---------- validation (every body/query goes through zod) ----------
const idNum = z.number().int().positive();
const nullableId = idNum.nullable().optional();
const dueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'That is not a real date')
  .nullable();
const name = (label, max) =>
  z.string({ required_error: `${label} is required` }).trim().min(1, `${label} is required`).max(max, `${label} must be at most ${max} characters`);

const schemas = {
  register: z.object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    name: name('Name', 60),
    password: z.string({ required_error: 'Password is required' }).min(8, 'Password must be at least 8 characters').max(200),
  }),
  login: z.object({ email: z.string().trim().toLowerCase().min(1, 'Email is required'), password: z.string().min(1, 'Password is required') }),
  project: z.object({ name: name('Project name', 80) }),
  member: z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email address') }),
  column: z.object({ name: name('Column name', 40) }),
  move: z.object({ beforeId: nullableId, afterId: nullableId }),
  cardMove: z.object({ columnId: idNum, beforeId: nullableId, afterId: nullableId }),
  cardCreate: z.object({
    columnId: idNum,
    title: name('Title', 200),
    description: z.string().max(5000, 'Description must be at most 5000 characters').default(''),
    assigneeId: nullableId,
    dueDate: dueDate.optional(),
    labelIds: z.array(idNum).max(20).default([]),
  }),
  cardUpdate: z.object({
    title: name('Title', 200).optional(),
    description: z.string().max(5000, 'Description must be at most 5000 characters').optional(),
    assigneeId: nullableId,
    dueDate: dueDate.optional(),
    labelIds: z.array(idNum).max(20).optional(),
  }),
  label: z.object({ name: name('Label name', 30), color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must look like #1a2b3c') }),
  comment: z.object({ body: name('Comment', 2000) }),
  activityQuery: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
};

function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw new HttpError(
      400,
      'Please fix the highlighted fields',
      r.error.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message })),
    );
  }
  return r.data;
}
const fieldError = (field, message) => new HttpError(400, 'Please fix the highlighted fields', [{ field, message }]);
const pid = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw NOT_FOUND();
  return n;
};

export function createApp({ db, jwtSecret }) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  // ---------- authorization helpers (server-side, on EVERY project-scoped request) ----------
  const roleOf = (projectId, userId) =>
    db.prepare('SELECT role FROM memberships WHERE project_id = ? AND user_id = ?').get(projectId, userId)?.role ?? null;

  // Non-members get 404 (not 403) so project/card ids can't be probed.
  function requireProject(projectId, user, { owner = false } = {}) {
    const role = roleOf(projectId, user.id);
    if (!role) throw NOT_FOUND();
    if (owner && role !== 'owner') throw new HttpError(403, 'Only the project owner can do this');
    return role;
  }
  // For routes keyed by card/column id: load the row, derive its project, then check membership.
  function loadCard(req, opts) {
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(pid(req.params.id));
    if (!card) throw NOT_FOUND();
    requireProject(card.project_id, req.user, opts);
    return card;
  }
  function loadColumn(req, opts) {
    const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(pid(req.params.id));
    if (!col) throw NOT_FOUND();
    requireProject(col.project_id, req.user, opts);
    return col;
  }
  const columnName = (id) => db.prepare('SELECT name FROM columns WHERE id = ?').get(id)?.name ?? '?';
  const userName = (id) => db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name ?? 'someone';

  function log(projectId, user, type, cardId, message) {
    db.prepare('INSERT INTO activity (project_id, actor_id, type, card_id, message) VALUES (?,?,?,?,?)').run(
      projectId, user.id, type, cardId, `${user.name} ${message}`,
    );
  }
  const done = (projectId) => publish(projectId);

  function checkAssignee(projectId, assigneeId) {
    if (assigneeId != null && !roleOf(projectId, assigneeId)) throw fieldError('assigneeId', 'Assignee must be a member of this project');
  }
  function checkLabels(projectId, labelIds) {
    for (const id of labelIds ?? []) {
      if (!db.prepare('SELECT 1 FROM labels WHERE id = ? AND project_id = ?').get(id, projectId)) throw fieldError('labelIds', 'Unknown label');
    }
  }
  function setLabels(cardId, labelIds) {
    db.prepare('DELETE FROM card_labels WHERE card_id = ?').run(cardId);
    const ins = db.prepare('INSERT OR IGNORE INTO card_labels (card_id, label_id) VALUES (?,?)');
    for (const l of labelIds) ins.run(cardId, l);
  }

  // Compute the new fractional position for `movingId` dropped between beforeId (above) and afterId (below).
  // Only the moved row is written. `table`/`scopeCol` are constants from this file, never user input.
  function movePosition(table, scopeCol, scopeId, movingId, beforeId, afterId) {
    const fetch = (nid, field) => {
      if (nid == null) return null;
      const r = db.prepare(`SELECT id, position, ${scopeCol} AS scope FROM ${table} WHERE id = ?`).get(nid);
      if (!r || r.scope !== scopeId || r.id === movingId) throw fieldError(field, 'Neighbour is not in the target list');
      return r.position;
    };
    let prev = fetch(beforeId, 'beforeId');
    let next = fetch(afterId, 'afterId');
    const others = `FROM ${table} WHERE ${scopeCol} = ? AND id != ?`;
    if (prev != null && next == null) {
      next = db.prepare(`SELECT MIN(position) AS p ${others} AND position > ?`).get(scopeId, movingId, prev).p;
    } else if (prev == null && next != null) {
      prev = db.prepare(`SELECT MAX(position) AS p ${others} AND position < ?`).get(scopeId, movingId, next).p;
    } else if (prev == null && next == null) {
      prev = db.prepare(`SELECT MAX(position) AS p ${others}`).get(scopeId, movingId).p; // append to end
    }
    if (prev != null && next != null && prev >= next) throw new HttpError(409, 'The board changed, please refresh');
    const position = positionBetween(prev, next);
    db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).run(position, movingId);
    let rebalanced = false;
    if (gapTooSmall(prev, next)) {
      rebalance(db, table, scopeCol, scopeId);
      rebalanced = true;
    }
    return { position, rebalanced };
  }

  // ---------- auth ----------
  const sign = (u) => jwt.sign({ sub: u.id }, jwtSecret, { expiresIn: '7d' });
  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name });

  app.post('/api/auth/register', (req, res) => {
    const body = parse(schemas.register, req.body);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(body.email)) throw new HttpError(409, 'Please fix the highlighted fields', [{ field: 'email', message: 'An account with this email already exists' }]);
    const info = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)').run(body.email, body.name, bcrypt.hashSync(body.password, 10));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ token: sign(user), user: publicUser(user) });
  });

  app.post('/api/auth/login', (req, res) => {
    const body = parse(schemas.login, req.body);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email);
    if (!user || !bcrypt.compareSync(body.password, user.password_hash)) throw new HttpError(401, 'Invalid email or password');
    res.json({ token: sign(user), user: publicUser(user) });
  });

  // Everything below requires a valid token. (EventSource can't set headers, so /events also accepts ?token=.)
  app.use('/api', (req, _res, next) => {
    const header = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    const token = header ?? (req.path.endsWith('/events') ? req.query.token : null);
    try {
      const payload = jwt.verify(String(token), jwtSecret);
      const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(payload.sub);
      if (!user) throw new Error('no user');
      req.user = user;
      next();
    } catch {
      next(new HttpError(401, 'Please sign in'));
    }
  });

  app.get('/api/me', (req, res) => res.json({ user: req.user }));

  // ---------- projects & members ----------
  app.get('/api/projects', (req, res) => {
    const rows = db
      .prepare(`SELECT p.id, p.name, m.role FROM projects p JOIN memberships m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.id`)
      .all(req.user.id);
    res.json({ projects: rows });
  });

  app.post('/api/projects', (req, res) => {
    const { name: pname } = parse(schemas.project, req.body);
    const project = db.transaction(() => {
      const id = db.prepare('INSERT INTO projects (name, owner_id) VALUES (?,?)').run(pname, req.user.id).lastInsertRowid;
      db.prepare("INSERT INTO memberships (project_id, user_id, role) VALUES (?,?,'owner')").run(id, req.user.id);
      ['To do', 'In progress', 'Done'].forEach((n, i) => db.prepare('INSERT INTO columns (project_id, name, position) VALUES (?,?,?)').run(id, n, i + 1));
      log(id, req.user, 'project_created', null, `created the project "${pname}"`);
      return { id: Number(id), name: pname, role: 'owner' };
    })();
    res.status(201).json({ project });
  });

  app.get('/api/projects/:pid', (req, res) => {
    const projectId = pid(req.params.pid);
    const role = requireProject(projectId, req.user);
    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
    const members = db
      .prepare('SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name')
      .all(projectId);
    const columns = db.prepare('SELECT id, name, position FROM columns WHERE project_id = ? ORDER BY position').all(projectId);
    const labels = db.prepare('SELECT id, name, color FROM labels WHERE project_id = ? ORDER BY id').all(projectId);
    const labelRows = db
      .prepare('SELECT cl.card_id, cl.label_id FROM card_labels cl JOIN cards c ON c.id = cl.card_id WHERE c.project_id = ?')
      .all(projectId);
    const labelsByCard = {};
    for (const r of labelRows) (labelsByCard[r.card_id] ??= []).push(r.label_id);
    const cards = db
      .prepare(
        `SELECT c.id, c.column_id AS columnId, c.title, c.description, c.assignee_id AS assigneeId, c.due_date AS dueDate, c.position,
                (SELECT COUNT(*) FROM comments m WHERE m.card_id = c.id) AS commentCount
         FROM cards c WHERE c.project_id = ? ORDER BY c.column_id, c.position, c.id`,
      )
      .all(projectId)
      .map((c) => ({ ...c, labelIds: labelsByCard[c.id] ?? [] }));
    res.json({ project, role, members, columns, labels, cards });
  });

  app.post('/api/projects/:pid/members', (req, res) => {
    const projectId = pid(req.params.pid);
    requireProject(projectId, req.user, { owner: true });
    const { email } = parse(schemas.member, req.body);
    const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
    if (!user) throw fieldError('email', 'No account with this email yet. Ask them to register first.');
    if (roleOf(projectId, user.id)) throw new HttpError(409, 'Please fix the highlighted fields', [{ field: 'email', message: 'Already a member of this project' }]);
    db.prepare("INSERT INTO memberships (project_id, user_id, role) VALUES (?,?,'member')").run(projectId, user.id);
    log(projectId, req.user, 'member_added', null, `added ${user.name} to the project`);
    done(projectId);
    res.status(201).json({ member: { ...user, role: 'member' } });
  });

  app.delete('/api/projects/:pid/members/:uid', (req, res) => {
    const projectId = pid(req.params.pid);
    requireProject(projectId, req.user, { owner: true });
    const uid = pid(req.params.uid);
    if (roleOf(projectId, uid) == null) throw NOT_FOUND();
    if (uid === req.user.id) throw new HttpError(400, 'The owner cannot be removed from their own project');
    db.transaction(() => {
      db.prepare('UPDATE cards SET assignee_id = NULL WHERE project_id = ? AND assignee_id = ?').run(projectId, uid);
      db.prepare('DELETE FROM memberships WHERE project_id = ? AND user_id = ?').run(projectId, uid);
      log(projectId, req.user, 'member_removed', null, `removed ${userName(uid)} from the project`);
    })();
    done(projectId);
    res.status(204).end();
  });

  // ---------- columns (owner only) ----------
  app.post('/api/projects/:pid/columns', (req, res) => {
    const projectId = pid(req.params.pid);
    requireProject(projectId, req.user, { owner: true });
    const { name: cname } = parse(schemas.column, req.body);
    const last = db.prepare('SELECT MAX(position) AS p FROM columns WHERE project_id = ?').get(projectId).p;
    const id = db.prepare('INSERT INTO columns (project_id, name, position) VALUES (?,?,?)').run(projectId, cname, positionBetween(last, null)).lastInsertRowid;
    log(projectId, req.user, 'column_added', null, `added the column "${cname}"`);
    done(projectId);
    res.status(201).json({ column: db.prepare('SELECT id, name, position FROM columns WHERE id = ?').get(id) });
  });

  app.patch('/api/columns/:id', (req, res) => {
    const col = loadColumn(req, { owner: true });
    const { name: cname } = parse(schemas.column, req.body);
    db.prepare('UPDATE columns SET name = ? WHERE id = ?').run(cname, col.id);
    log(col.project_id, req.user, 'column_renamed', null, `renamed the column "${col.name}" to "${cname}"`);
    done(col.project_id);
    res.json({ column: { id: col.id, name: cname, position: col.position } });
  });

  app.patch('/api/columns/:id/move', (req, res) => {
    const col = loadColumn(req, { owner: true });
    const { beforeId = null, afterId = null } = parse(schemas.move, req.body);
    const result = db.transaction(() => movePosition('columns', 'project_id', col.project_id, col.id, beforeId, afterId))();
    done(col.project_id);
    res.json(result);
  });

  app.delete('/api/columns/:id', (req, res) => {
    const col = loadColumn(req, { owner: true });
    if (db.prepare('SELECT 1 FROM cards WHERE column_id = ?').get(col.id)) throw new HttpError(409, 'Move or delete the cards in this column first');
    db.prepare('DELETE FROM columns WHERE id = ?').run(col.id);
    log(col.project_id, req.user, 'column_deleted', null, `deleted the column "${col.name}"`);
    done(col.project_id);
    res.status(204).end();
  });

  // ---------- labels ----------
  app.post('/api/projects/:pid/labels', (req, res) => {
    const projectId = pid(req.params.pid);
    requireProject(projectId, req.user);
    const body = parse(schemas.label, req.body);
    const id = db.prepare('INSERT INTO labels (project_id, name, color) VALUES (?,?,?)').run(projectId, body.name, body.color).lastInsertRowid;
    done(projectId);
    res.status(201).json({ label: { id: Number(id), ...body } });
  });

  // ---------- cards ----------
  app.post('/api/projects/:pid/cards', (req, res) => {
    const projectId = pid(req.params.pid);
    requireProject(projectId, req.user);
    const body = parse(schemas.cardCreate, req.body);
    const col = db.prepare('SELECT * FROM columns WHERE id = ? AND project_id = ?').get(body.columnId, projectId);
    if (!col) throw fieldError('columnId', 'Column does not belong to this project');
    checkAssignee(projectId, body.assigneeId);
    checkLabels(projectId, body.labelIds);
    const id = db.transaction(() => {
      const last = db.prepare('SELECT MAX(position) AS p FROM cards WHERE column_id = ?').get(col.id).p;
      const cid = db
        .prepare('INSERT INTO cards (project_id, column_id, title, description, assignee_id, due_date, position) VALUES (?,?,?,?,?,?,?)')
        .run(projectId, col.id, body.title, body.description, body.assigneeId ?? null, body.dueDate ?? null, positionBetween(last, null)).lastInsertRowid;
      setLabels(cid, body.labelIds);
      log(projectId, req.user, 'card_created', Number(cid), `created "${body.title}" in ${col.name}`);
      return Number(cid);
    })();
    done(projectId);
    res.status(201).json({ id });
  });

  app.patch('/api/cards/:id', (req, res) => {
    const card = loadCard(req);
    const body = parse(schemas.cardUpdate, req.body);
    if (body.assigneeId !== undefined) checkAssignee(card.project_id, body.assigneeId);
    if (body.labelIds) checkLabels(card.project_id, body.labelIds);
    db.transaction(() => {
      const next = {
        title: body.title ?? card.title,
        description: body.description ?? card.description,
        assignee_id: body.assigneeId === undefined ? card.assignee_id : body.assigneeId,
        due_date: body.dueDate === undefined ? card.due_date : body.dueDate,
      };
      db.prepare('UPDATE cards SET title = ?, description = ?, assignee_id = ?, due_date = ? WHERE id = ?').run(next.title, next.description, next.assignee_id, next.due_date, card.id);
      if (body.labelIds) setLabels(card.id, body.labelIds);
      if (body.assigneeId !== undefined && next.assignee_id !== card.assignee_id) {
        log(card.project_id, req.user, 'card_assigned', card.id, next.assignee_id ? `assigned "${next.title}" to ${userName(next.assignee_id)}` : `unassigned "${next.title}"`);
      }
      if ((body.title && body.title !== card.title) || (body.description !== undefined && body.description !== card.description) || (body.dueDate !== undefined && body.dueDate !== card.due_date) || body.labelIds) {
        log(card.project_id, req.user, 'card_updated', card.id, `updated "${next.title}"`);
      }
    })();
    done(card.project_id);
    res.json({ ok: true });
  });

  app.delete('/api/cards/:id', (req, res) => {
    const card = loadCard(req);
    db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
    log(card.project_id, req.user, 'card_deleted', null, `deleted "${card.title}"`);
    done(card.project_id);
    res.status(204).end();
  });

  app.patch('/api/cards/:id/move', (req, res) => {
    const card = loadCard(req);
    const { columnId, beforeId = null, afterId = null } = parse(schemas.cardMove, req.body);
    const target = db.prepare('SELECT * FROM columns WHERE id = ? AND project_id = ?').get(columnId, card.project_id);
    if (!target) throw fieldError('columnId', 'Column does not belong to this project');
    const result = db.transaction(() => {
      const r = movePosition('cards', 'column_id', target.id, card.id, beforeId, afterId);
      db.prepare('UPDATE cards SET column_id = ? WHERE id = ?').run(target.id, card.id);
      if (target.id !== card.column_id) {
        log(card.project_id, req.user, 'card_moved', card.id, `moved "${card.title}" from ${columnName(card.column_id)} to ${target.name}`);
      }
      return r;
    })();
    done(card.project_id);
    res.json(result);
  });

  // ---------- comments ----------
  app.get('/api/cards/:id/comments', (req, res) => {
    const card = loadCard(req);
    const comments = db
      .prepare('SELECT c.id, c.body, c.created_at AS createdAt, u.id AS authorId, u.name AS authorName FROM comments c JOIN users u ON u.id = c.author_id WHERE c.card_id = ? ORDER BY c.id')
      .all(card.id);
    res.json({ comments });
  });

  app.post('/api/cards/:id/comments', (req, res) => {
    const card = loadCard(req);
    const { body } = parse(schemas.comment, req.body);
    const id = db.prepare('INSERT INTO comments (card_id, project_id, author_id, body) VALUES (?,?,?,?)').run(card.id, card.project_id, req.user.id, body).lastInsertRowid;
    log(card.project_id, req.user, 'comment_added', card.id, `commented on "${card.title}"`);
    done(card.project_id);
    res.status(201).json({ id: Number(id) });
  });

  // ---------- activity & live updates ----------
  app.get('/api/projects/:pid/activity', (req, res) => {
    const projectId = pid(req.params.pid);
    requireProject(projectId, req.user);
    const { limit } = parse(schemas.activityQuery, req.query);
    const activity = db
      .prepare('SELECT id, type, card_id AS cardId, message, created_at AS createdAt FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT ?')
      .all(projectId, limit);
    res.json({ activity });
  });

  app.get('/api/projects/:pid/events', (req, res) => {
    const projectId = pid(req.params.pid);
    requireProject(projectId, req.user);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(': connected\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    res.on('close', () => clearInterval(ping));
    subscribe(projectId, res);
  });

  // ---------- static frontend + errors ----------
  app.use('/api', (_req, _res, next) => next(NOT_FOUND()));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, errors: err.errors });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side' });
  });

  return app;
}

import 'dotenv/config';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { openDb } from './db.js';

const file = process.env.DATABASE_PATH || './data/kanban.db';
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
const db = openDb(file);

const hash = bcrypt.hashSync('password123', 10);
const user = (email, name) => db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)').run(email, name, hash).lastInsertRowid;
const asha = user('asha@demo.com', 'Asha');
const ravi = user('ravi@demo.com', 'Ravi');
const meera = user('meera@demo.com', 'Meera');
const sam = user('sam@demo.com', 'Sam'); // not in any project: use to try "invite member"

const project = (name, owner, members) => {
  const id = db.prepare('INSERT INTO projects (name, owner_id) VALUES (?,?)').run(name, owner).lastInsertRowid;
  db.prepare("INSERT INTO memberships VALUES (?,?,'owner')").run(id, owner);
  for (const m of members) db.prepare("INSERT INTO memberships VALUES (?,?,'member')").run(id, m);
  return id;
};
const column = (p, name, pos) => db.prepare('INSERT INTO columns (project_id, name, position) VALUES (?,?,?)').run(p, name, pos).lastInsertRowid;
const label = (p, name, color) => db.prepare('INSERT INTO labels (project_id, name, color) VALUES (?,?,?)').run(p, name, color).lastInsertRowid;
const card = (p, c, pos, title, o = {}) => {
  const id = db
    .prepare('INSERT INTO cards (project_id, column_id, title, description, assignee_id, due_date, position) VALUES (?,?,?,?,?,?,?)')
    .run(p, c, title, o.description ?? '', o.assignee ?? null, o.due ?? null, pos).lastInsertRowid;
  for (const l of o.labels ?? []) db.prepare('INSERT INTO card_labels VALUES (?,?)').run(id, l);
  return id;
};
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const act = (p, actor, msg, cardId = null) => db.prepare('INSERT INTO activity (project_id, actor_id, type, card_id, message) VALUES (?,?,?,?,?)').run(p, actor, 'seed', cardId, msg);

const web = project('Website Launch', asha, [ravi, meera]);
const todo = column(web, 'To do', 1), doing = column(web, 'In progress', 2), review = column(web, 'Review', 3), shipped = column(web, 'Done', 4);
const bug = label(web, 'Bug', '#dc2626'), feature = label(web, 'Feature', '#2563eb'), design = label(web, 'Design', '#9333ea');
card(web, todo, 1, 'Write privacy policy', { assignee: meera, due: day(5), labels: [feature] });
card(web, todo, 2, 'Fix broken footer links', { assignee: ravi, due: day(-2), labels: [bug] });
card(web, todo, 3, 'Set up analytics', { labels: [feature] });
const login = card(web, doing, 1, 'Login page', { assignee: asha, due: day(1), description: 'Email + password, show clear error messages.', labels: [feature, design] });
card(web, doing, 2, 'Mobile navigation menu', { assignee: ravi, due: day(3), labels: [design] });
card(web, review, 1, 'Pricing page copy', { assignee: meera, labels: [design] });
card(web, shipped, 1, 'Choose a domain name', { assignee: asha });
card(web, shipped, 2, 'Logo and colour palette', { assignee: meera, labels: [design] });
db.prepare('INSERT INTO comments (card_id, project_id, author_id, body) VALUES (?,?,?,?)').run(login, web, ravi, 'Should we add "forgot password" in this sprint?');
db.prepare('INSERT INTO comments (card_id, project_id, author_id, body) VALUES (?,?,?,?)').run(login, web, asha, 'Next sprint. Keep it simple for now.');
act(web, asha, 'Asha created the project "Website Launch"');
act(web, asha, 'Asha moved "Login page" from To do to In progress', login);
act(web, ravi, 'Ravi commented on "Login page"', login);

// A second project that Meera and Sam are NOT in: log in as Meera to confirm it never shows up.
const secret = project('Ravi private roadmap', ravi, [asha]);
const sc = column(secret, 'Ideas', 1);
card(secret, sc, 1, 'Secret idea', {});
act(secret, ravi, 'Ravi created the project "Ravi private roadmap"');

console.log('Seeded. Demo logins (password for all: password123): asha@demo.com (owner), ravi@demo.com, meera@demo.com, sam@demo.com');

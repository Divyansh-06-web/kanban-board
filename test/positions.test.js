import test from 'node:test';
import assert from 'node:assert/strict';
import { positionBetween, gapTooSmall } from '../src/positions.js';
import { openDb } from '../src/db.js';
import { rebalance } from '../src/positions.js';

test('position between two neighbours is the midpoint', () => {
  assert.equal(positionBetween(1, 2), 1.5);
  assert.equal(positionBetween(1, 1.5), 1.25);
});

test('position at the edges and in an empty list', () => {
  assert.equal(positionBetween(null, null), 1);
  assert.equal(positionBetween(null, 3), 2); // top
  assert.equal(positionBetween(3, null), 4); // bottom
});

test('gapTooSmall flags collapsed gaps only', () => {
  assert.equal(gapTooSmall(1, 1 + 1e-9), true);
  assert.equal(gapTooSmall(1, 2), false);
  assert.equal(gapTooSmall(null, 2), false);
});

test('rebalance renumbers one column 1..n and keeps the order', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (email,name,password_hash) VALUES ('a@a.com','A','x')").run();
  db.prepare("INSERT INTO projects (name,owner_id) VALUES ('P',1)").run();
  db.prepare("INSERT INTO columns (project_id,name,position) VALUES (1,'C1',1),(1,'C2',2)").run();
  const ins = db.prepare('INSERT INTO cards (project_id,column_id,title,position) VALUES (1,?,?,?)');
  ins.run(1, 'a', 1); ins.run(1, 'b', 1.0000000001); ins.run(1, 'c', 1.0000000002); ins.run(2, 'other', 7.5);
  rebalance(db, 'cards', 'column_id', 1);
  const col1 = db.prepare('SELECT title, position FROM cards WHERE column_id = 1 ORDER BY position').all().map((r) => ({ ...r }));
  assert.deepEqual(col1, [{ title: 'a', position: 1 }, { title: 'b', position: 2 }, { title: 'c', position: 3 }]);
  assert.equal(db.prepare("SELECT position FROM cards WHERE title = 'other'").get().position, 7.5); // other column untouched
});

// Fractional ordering. Each row has a REAL `position`; a move only rewrites the moved row.
// prev/next are the positions of the neighbours the item is dropped between (null = edge).
export const MIN_GAP = 1e-6;

export function positionBetween(prev, next) {
  if (prev == null && next == null) return 1;
  if (prev == null) return next - 1;
  if (next == null) return prev + 1;
  return (prev + next) / 2;
}

// True when two neighbours are so close that further midpoints would lose precision.
export function gapTooSmall(prev, next) {
  return prev != null && next != null && next - prev < MIN_GAP;
}

// Renumber one list 1..n in its current order. Only called when a gap collapses (rare),
// and only touches the one column/board that needs it.
export function rebalance(db, table, scopeColumn, scopeId) {
  const rows = db.prepare(`SELECT id FROM ${table} WHERE ${scopeColumn} = ? ORDER BY position, id`).all(scopeId);
  const upd = db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`);
  rows.forEach((r, i) => upd.run(i + 1, r.id));
}

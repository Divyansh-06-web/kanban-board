// Tiny in-memory pub/sub for Server-Sent Events, one channel per project.
const channels = new Map();

export function subscribe(projectId, res) {
  if (!channels.has(projectId)) channels.set(projectId, new Set());
  channels.get(projectId).add(res);
  res.on('close', () => channels.get(projectId)?.delete(res));
}

export function publish(projectId, event = 'changed') {
  for (const res of channels.get(projectId) ?? []) res.write(`data: ${event}\n\n`);
}

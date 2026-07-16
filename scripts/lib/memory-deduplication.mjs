const encoder = new TextEncoder();

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function contentHash(content) {
  return sha256Hex(content);
}

export function scopeKey(row) {
  return sha256Hex(JSON.stringify([row.user_id, row.agent_id]));
}

export function duplicateMappings(rows) {
  const groups = new Map();

  for (const row of rows) {
    if (row.deleted_at !== null) continue;
    const key = JSON.stringify([
      row.user_id,
      row.agent_id,
      row.content_hash,
      row.content,
    ]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  return [...groups.values()].flatMap((group) => {
    group.sort((left, right) => (
      Number(left.created_at) - Number(right.created_at)
      || compareAscending(String(left.id), String(right.id))
    ));
    return group.slice(1).map((row) => ({
      canonicalId: group[0].id,
      loserId: row.id,
    }));
  });
}

function compareAscending(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export async function pendingHashUpdates(rows) {
  const updates = [];
  for (const row of rows) {
    const digest = await contentHash(row.content);
    if (row.content_hash !== digest) {
      updates.push({ id: row.id, contentHash: digest });
    }
  }
  return updates;
}

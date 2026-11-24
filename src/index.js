import { mcp } from './mcp.js';
import { SETTINGS, readSettings } from './settings.js';
import { autoTag, ensureTags, listTags, tagsApi } from './tags.js';
import { cleanTags, cleanText, parseTags } from './text.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const ID = /^[A-Za-z0-9_-]{1,40}$/;

// Which of these task ids are already in the database.
async function existingIds(env, ids) {
  const out = new Set();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT id FROM tasks WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const r of results) out.add(r.id);
  }
  return out;
}
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

// Turns one task from the request into the bound values for UPSERT, or null if it is unusable.
function toRow(t, now) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !ID.test(t.id)) return null;
  const text = cleanText(t.text);
  const x = num(t.x, 0, 1), y = num(t.y, 0, 1);
  if (!text || x === null || y === null) return null;
  const done = t.done === true;
  return [
    t.id, text, x, y,
    num(t.tilt, -4, 4) ?? 0,
    done ? 1 : 0,
    num(t.created_at, 0, 9e15) ?? now,
    done ? (num(t.done_at, 0, 9e15) ?? now) : null,
    now,
    t.archived === true ? now : null,
    num(t.sort, -9e15, 9e15),
    Array.isArray(t.tags) ? JSON.stringify(cleanTags(t.tags)) : null,
  ];
}

// created_at never changes after the first write; archived_at keeps its first value while a task stays archived.
// A write without sort or tags (from a page open since before tasks had them) keeps what is already saved.
const UPSERT = `
  INSERT INTO tasks (id, text, x, y, tilt, done, created_at, done_at, updated_at, archived_at, sort, tags)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
  ON CONFLICT(id) DO UPDATE SET
    text = excluded.text, x = excluded.x, y = excluded.y, tilt = excluded.tilt,
    sort = COALESCE(excluded.sort, tasks.sort), tags = COALESCE(excluded.tags, tasks.tags),
    done = excluded.done, done_at = excluded.done_at, updated_at = excluded.updated_at,
    archived_at = CASE WHEN excluded.archived_at IS NULL THEN NULL
                       ELSE COALESCE(tasks.archived_at, excluded.archived_at) END`;

async function settings(request, env) {
  if (request.method === 'GET') return json({ settings: await readSettings(env) });

  if (request.method === 'PUT') {
    if (!(request.headers.get('content-type') || '').includes('application/json')) {
      return json({ error: 'unsupported_media_type' }, 415);
    }
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const given = body?.settings;
    if (!given || typeof given !== 'object') return json({ error: 'bad_request' }, 400);

    const now = Date.now();
    const rows = Object.entries(given).filter(([k, v]) => k in SETTINGS && SETTINGS[k].includes(v));
    if (rows.length) {
      await env.DB.batch(rows.map(([k, v]) => env.DB.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).bind(k, JSON.stringify(v), now)));
    }
    return json({ ok: true, saved: rows.length });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // Cloudflare Access guards the whole domain; the MCP endpoint is let through it on purpose (see README).
    if (pathname === '/mcp') return mcp(request, env);
    if (!['/api/tasks', '/api/settings', '/api/tags'].includes(pathname)) return json({ error: 'not_found' }, 404);

    if (pathname === '/api/settings') return settings(request, env);
    if (pathname === '/api/tags') return tagsApi(request, env, json);

    if (request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT id, text, x, y, tilt, done, created_at, done_at, sort, tags FROM tasks WHERE archived_at IS NULL ORDER BY COALESCE(sort, created_at)',
      ).all();
      const tasks = results.map(r => ({ ...r, done: r.done === 1, tags: parseTags(r.tags) }));
      // Tags written before the tags table existed, or by another route, get their row (and colour) here.
      await ensureTags(env, tasks.flatMap(t => t.tags));
      return json({ tasks, tags: await listTags(env) });
    }

    if (request.method === 'PUT') {
      if (!(request.headers.get('content-type') || '').includes('application/json')) {
        return json({ error: 'unsupported_media_type' }, 415);
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
      const list = Array.isArray(body?.tasks) ? body.tasks : null;
      if (!list || list.length > 200) return json({ error: 'bad_request' }, 400);

      const now = Date.now();
      const rows = list.map(t => toRow(t, now)).filter(Boolean);
      const labeled = {};
      if (rows.length) {
        // A task seen for the first time, on the page and written without a tag, is tagged by the model
        // before it is saved. The answer carries the tags so the page can show them straight away.
        if ((await readSettings(env)).auto_tag) {
          const bare = rows.filter(r => r[9] === null && r[11] === '[]');
          const known = await existingIds(env, bare.map(r => r[0]));
          const fresh = bare.filter(r => !known.has(r[0]));
          const tags = await autoTag(env, fresh.map(r => r[1]));
          fresh.forEach((r, i) => { if (tags[i].length) { r[11] = JSON.stringify(tags[i]); labeled[r[0]] = tags[i]; } });
        }
        await env.DB.batch(rows.map(r => env.DB.prepare(UPSERT).bind(...r)));
        await ensureTags(env, rows.flatMap(r => (r[11] ? JSON.parse(r[11]) : [])));
      }
      return json({ ok: true, saved: rows.length, labeled, tags: await listTags(env) });
    }

    return json({ error: 'method_not_allowed' }, 405);
  },
};

import { createRemoteJWKSet, jwtVerify } from 'jose';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

let jwks, jwksIssuer;

// Cloudflare Access sits in front of this Worker and signs every request it lets through.
// Checking that signature here keeps the API closed even if Access is switched off by mistake.
// Returns a Response when the request must be refused, null when it may proceed.
async function denied(request, env) {
  const { hostname } = new URL(request.url);
  if (env.ACCESS_BYPASS === 'local' && (hostname === 'localhost' || hostname === '127.0.0.1')) return null;

  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
  if (!team || !aud) return json({ error: 'access_not_configured' }, 503);

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return json({ error: 'unauthorized' }, 401);

  const issuer = `https://${team}`;
  if (jwksIssuer !== issuer) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksIssuer = issuer;
  }
  try {
    await jwtVerify(token, jwks, { issuer, audience: aud });
    return null;
  } catch {
    return json({ error: 'unauthorized' }, 401);
  }
}

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

// Turns one task from the request into the bound values for UPSERT, or null if it is unusable.
function toRow(t, now) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !ID.test(t.id)) return null;
  const text = typeof t.text === 'string' ? t.text.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
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
  ];
}

// created_at never changes after the first write; archived_at keeps its first value while a task stays archived.
const UPSERT = `
  INSERT INTO tasks (id, text, x, y, tilt, done, created_at, done_at, updated_at, archived_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  ON CONFLICT(id) DO UPDATE SET
    text = excluded.text, x = excluded.x, y = excluded.y, tilt = excluded.tilt,
    done = excluded.done, done_at = excluded.done_at, updated_at = excluded.updated_at,
    archived_at = CASE WHEN excluded.archived_at IS NULL THEN NULL
                       ELSE COALESCE(tasks.archived_at, excluded.archived_at) END`;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== '/api/tasks') return json({ error: 'not_found' }, 404);

    const refusal = await denied(request, env);
    if (refusal) return refusal;

    if (request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT id, text, x, y, tilt, done, created_at, done_at FROM tasks WHERE archived_at IS NULL ORDER BY created_at',
      ).all();
      return json({ tasks: results.map(r => ({ ...r, done: r.done === 1 })) });
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
      if (rows.length) await env.DB.batch(rows.map(r => env.DB.prepare(UPSERT).bind(...r)));
      return json({ ok: true, saved: rows.length });
    }

    return json({ error: 'method_not_allowed' }, 405);
  },
};

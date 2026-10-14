import { cleanTags, parseTags } from './text.js';

const COLORS = 8;
const MODEL = '@cf/cloudflare/clef-flash';
const SURE = 0.7;     // how likely a tag must be before the auto-tagger adds it
const LEAN = 0.5;     // when no tag is that likely, the best one still goes on if it is at least this likely
const MOST = 3;       // tags the auto-tagger adds to one task at most

export async function listTags(env) {
  const { results } = await env.DB.prepare('SELECT name, color, description FROM tags ORDER BY created_at, name').all();
  return results;
}

// Every tag name gets a row the first time it is seen, with whichever colour the fewest tags have.
export async function ensureTags(env, names) {
  const want = [...new Set(names)];
  if (!want.length) return;
  const known = await listTags(env), have = new Set(known.map(t => t.name));
  const fresh = want.filter(n => !have.has(n));
  if (!fresh.length) return;
  const used = Array(COLORS).fill(0);
  for (const t of known) used[t.color % COLORS]++;
  const now = Date.now();
  await env.DB.batch(fresh.map(name => {
    const color = used.indexOf(Math.min(...used));
    used[color]++;
    return env.DB.prepare("INSERT OR IGNORE INTO tags (name, color, description, created_at, updated_at) VALUES (?1, ?2, '', ?3, ?3)")
      .bind(name, color, now);
  }));
}

// Asks Clef-flash, for each text, one yes/no question per tag, and keeps the tags it is sure of.
// Returns one list of tags per text; a failed call just leaves that task untagged.
export async function autoTag(env, texts) {
  if (!env.AI || !texts.length) return texts.map(() => []);
  const tags = (await listTags(env)).slice(0, 64);
  if (!tags.length) return texts.map(() => []);
  const questions = {};
  tags.forEach((t, i) => {
    questions['t' + i] = {
      type: 'noul',
      instructions: `Does this to-do item belong under the tag "${t.name}"?` + (t.description ? ` The tag is for: ${t.description}` : ''),
    };
  });
  return Promise.all(texts.map(async text => {
    try {
      const out = await env.AI.run(MODEL, { model: 'clef-flash', state: `To-do item: ${text}`, questions });
      // A noul answer is { type: 'noul', noul: <probability> }; REST callers get it wrapped in { result }.
      const answers = out?.answers ?? out?.result?.answers ?? {};
      const yes = a => (typeof a === 'number' ? a : Number(a?.noul ?? a?.probability) || 0);
      const scores = tags.map((t, i) => [t.name, yes(answers['t' + i])]);
      // Shows up in `wrangler tail`, for tuning descriptions; the task text stays out of the logs.
      console.log('auto-tag scores', JSON.stringify(Object.fromEntries(scores.map(([n, p]) => [n, +p.toFixed(3)]))),
        Object.keys(answers).length ? '' : 'raw: ' + JSON.stringify(out).slice(0, 500));
      // Scores run lower for text that is not English (a Persian task scored 0.57 where its English twin
      // scored 0.86), so a clear best guess is kept rather than leaving the task untagged.
      const ranked = scores.sort((a, b) => b[1] - a[1]);
      const sure = ranked.filter(([, p]) => p >= SURE);
      return (sure.length ? sure : ranked.slice(0, 1).filter(([, p]) => p >= LEAN)).slice(0, MOST).map(([name]) => name);
    } catch (e) {
      console.error('auto-tag failed:', e?.message || e);
      return [];
    }
  }));
}

// Renames a tag on every task that has it, archived ones too, and merges it into the new name's row if that exists.
async function renameTag(env, from, to) {
  const now = Date.now();
  const { results } = await env.DB.prepare('SELECT id, tags FROM tasks WHERE tags LIKE ?1').bind(`%"${from}"%`).all();
  const writes = [];
  for (const r of results) {
    const tags = parseTags(r.tags);
    if (!tags.includes(from)) continue;
    writes.push(env.DB.prepare('UPDATE tasks SET tags = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(JSON.stringify(cleanTags(tags.map(g => (g === from ? to : g)))), now, r.id));
  }
  const taken = await env.DB.prepare('SELECT 1 FROM tags WHERE name = ?1').bind(to).first();
  writes.push(taken
    ? env.DB.prepare('DELETE FROM tags WHERE name = ?1').bind(from)
    : env.DB.prepare('UPDATE tags SET name = ?1, updated_at = ?2 WHERE name = ?3').bind(to, now, from));
  await env.DB.batch(writes);
}

// Deleting a tag takes it off the tasks on the page. Archived tasks keep it, as a record of what they were.
async function deleteTag(env, name) {
  const now = Date.now();
  const { results } = await env.DB.prepare('SELECT id, tags FROM tasks WHERE archived_at IS NULL AND tags LIKE ?1').bind(`%"${name}"%`).all();
  const writes = results.filter(r => parseTags(r.tags).includes(name)).map(r =>
    env.DB.prepare('UPDATE tasks SET tags = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(JSON.stringify(parseTags(r.tags).filter(g => g !== name)), now, r.id));
  writes.push(env.DB.prepare('DELETE FROM tags WHERE name = ?1').bind(name));
  await env.DB.batch(writes);
}

// /api/tags. GET lists the tags; PUT creates or changes them ({ tags: [{ name, rename?, color?, description? }] });
// DELETE ?name= deletes one.
export async function tagsApi(request, env, json) {
  if (request.method === 'GET') return json({ tags: await listTags(env) });

  if (request.method === 'DELETE') {
    const [name] = cleanTags([new URL(request.url).searchParams.get('name') || '']);
    if (!name) return json({ error: 'bad_request' }, 400);
    await deleteTag(env, name);
    return json({ ok: true, tags: await listTags(env) });
  }

  if (request.method === 'PUT') {
    if (!(request.headers.get('content-type') || '').includes('application/json')) {
      return json({ error: 'unsupported_media_type' }, 415);
    }
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const list = Array.isArray(body?.tags) ? body.tags.slice(0, 64) : null;
    if (!list) return json({ error: 'bad_request' }, 400);
    for (const t of list) {
      let [name] = cleanTags([t?.name]);
      if (!name) continue;
      await ensureTags(env, [name]);
      const [to] = cleanTags([t.rename]);
      if (to && to !== name) { await renameTag(env, name, to); name = to; }
      const color = Number.isInteger(t.color) && t.color >= 0 && t.color < COLORS ? t.color : null;
      const description = typeof t.description === 'string' ? t.description.replace(/\s+/g, ' ').trim().slice(0, 200) : null;
      if (color !== null || description !== null) {
        await env.DB.prepare('UPDATE tags SET color = COALESCE(?1, color), description = COALESCE(?2, description), updated_at = ?3 WHERE name = ?4')
          .bind(color, description, Date.now(), name).run();
      }
    }
    return json({ ok: true, tags: await listTags(env) });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

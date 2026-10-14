import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { readSettings } from './settings.js';
import { autoTag, ensureTags } from './tags.js';
import { cleanTags, cleanText, parseTags, splitTags } from './text.js';

const MAX_ON_PAGE = 200;

const say = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const oops = text => ({ content: [{ type: 'text', text }], isError: true });
const missing = id => oops(`No task with id "${id}" is on the page. Call list_tasks for the current ids.`);

const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).describe('Task id, as returned by list_tasks.');
const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function build(env) {
  const server = new McpServer({ name: 'scatter-pad', version: '1.0.0' });
  const onPage = () => env.DB.prepare('SELECT id, text, done, tags, COALESCE(sort, created_at) AS sort FROM tasks WHERE archived_at IS NULL ORDER BY sort').all();
  // Changes one task that is still on the page. Returns false when there is no such task.
  const change = async (set, ...values) => {
    const { meta } = await env.DB.prepare(`UPDATE tasks SET ${set}, updated_at = ?1 WHERE id = ?2 AND archived_at IS NULL`)
      .bind(Date.now(), ...values).run();
    return meta.changes > 0;
  };

  server.registerTool('list_tasks', {
    title: 'List tasks',
    description: 'Every task on the to-do pad, in the order it shows them, including the ones already crossed off.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const { results } = await onPage();
    return say({ tasks: results.map(r => ({ id: r.id, text: r.text, done: r.done === 1, tags: parseTags(r.tags) })) });
  });

  server.registerTool('add_tasks', {
    title: 'Add tasks',
    description: 'Write new tasks at the end of the pad. Each is a two-to-five-word summary, at most 80 characters. '
      + 'Words starting with # become tags instead of text: "send invoice #work".',
    inputSchema: { texts: z.array(z.string()).min(1).max(20).describe('One short summary per task, with any #tags.') },
    annotations: { destructiveHint: false },
  }, async ({ texts }) => {
    const wanted = texts.map(splitTags).filter(w => w.text);
    if (!wanted.length) return oops('Every task was empty.');
    const { results } = await onPage();
    if (results.length + wanted.length > MAX_ON_PAGE) {
      return oops(`The pad holds ${MAX_ON_PAGE} tasks and has ${results.length}. Remove some first.`);
    }
    // The page lays tasks out in rows by sort; x and y are only where it last drew them.
    if ((await readSettings(env)).auto_tag) {
      const bare = wanted.filter(w => !w.tags.length), tags = await autoTag(env, bare.map(w => w.text));
      bare.forEach((w, i) => { w.tags = tags[i]; });
    }
    await ensureTags(env, wanted.flatMap(w => w.tags));
    const now = Date.now(), last = Math.max(now, ...results.map(r => r.sort + 1));
    const added = wanted.map(({ text, tags }, i) => ({
      id: newId(), text, tags, tilt: +(Math.random() * 5 - 2.5).toFixed(1), created_at: now + i, sort: last + i,
    }));
    const insert = env.DB.prepare(
      'INSERT INTO tasks (id, text, x, y, tilt, done, created_at, updated_at, sort, tags) VALUES (?1, ?2, 0.5, 0.5, ?3, 0, ?4, ?5, ?6, ?7)',
    );
    await env.DB.batch(added.map(t => insert.bind(t.id, t.text, t.tilt, t.created_at, now, t.sort, JSON.stringify(t.tags))));
    return say({ added: added.map(t => ({ id: t.id, text: t.text, done: false, tags: t.tags })) });
  });

  server.registerTool('set_done', {
    title: 'Cross off or un-cross a task',
    description: 'Cross a task off when it is finished, or un-cross it. A crossed-off task stays on the pad.',
    inputSchema: { id, done: z.boolean().describe('true to cross it off, false to un-cross it.') },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async ({ id, done }) => {
    const found = done
      ? await change('done = 1, done_at = COALESCE(done_at, ?1)', id)
      : await change('done = 0, done_at = NULL', id);
    return found ? say({ id, done }) : missing(id);
  });

  server.registerTool('edit_task', {
    title: 'Edit a task',
    description: 'Replace the text of a task. Keep it to a two-to-five-word summary, at most 80 characters. '
      + 'Any #tags in it are added to the task\'s tags; use set_tags to remove one.',
    inputSchema: { id, text: z.string().describe('The new summary.') },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async ({ id, text }) => {
    const { text: clean, tags } = splitTags(text);
    if (!clean) return oops('The new text was empty. Use remove_task to take a task off the pad.');
    if (!tags.length) return (await change('text = ?3', id, clean)) ? say({ id, text: clean }) : missing(id);
    const row = await env.DB.prepare('SELECT tags FROM tasks WHERE id = ?1 AND archived_at IS NULL').bind(id).first();
    if (!row) return missing(id);
    const all = cleanTags([...parseTags(row.tags), ...tags]);
    await ensureTags(env, all);
    return (await change('text = ?3, tags = ?4', id, clean, JSON.stringify(all))) ? say({ id, text: clean, tags: all }) : missing(id);
  });

  server.registerTool('set_tags', {
    title: 'Set the tags of a task',
    description: 'Replace all the tags of a task. A tag is one word (letters, digits, - or _), at most five per task; [] removes them all.',
    inputSchema: { id, tags: z.array(z.string()).max(5).describe('The tags, with or without the #.') },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async ({ id, tags }) => {
    const clean = cleanTags(tags);
    if (!(await change('tags = ?3', id, JSON.stringify(clean)))) return missing(id);
    await ensureTags(env, clean);
    return say({ id, tags: clean });
  });

  server.registerTool('remove_task', {
    title: 'Remove a task',
    description: 'Take a task off the pad. It is archived, not deleted, but it cannot be brought back from here.',
    inputSchema: { id },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ id }) => ((await change('archived_at = ?1', id)) ? say({ id, removed: true }) : missing(id)));

  return server;
}

// Streamable HTTP without sessions: every POST is answered on its own, as plain JSON.
export async function mcp(request, env) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }
  if (Number(request.headers.get('content-length')) > 65536) return new Response(null, { status: 413 });

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await build(env).connect(transport);
  return transport.handleRequest(request);
}

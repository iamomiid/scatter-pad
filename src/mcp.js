import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { cleanText } from './text.js';

const MAX_ON_PAGE = 200;

const say = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const oops = text => ({ content: [{ type: 'text', text }], isError: true });
const missing = id => oops(`No task with id "${id}" is on the page. Call list_tasks for the current ids.`);

const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).describe('Task id, as returned by list_tasks.');
const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// The Worker cannot know how large a task is drawn, so it only keeps centres apart: of a handful of random
// spots, take the one farthest from every task already there. A task is much wider than it is tall, so
// vertical distance counts for more. "Tidy up" on the page settles whatever still overlaps.
function freeSpot(taken) {
  let best, bestGap = -1;
  for (let i = 0; i < 40; i++) {
    const x = 0.14 + Math.random() * 0.72, y = 0.1 + Math.random() * 0.8;
    let gap = Infinity;
    for (const t of taken) gap = Math.min(gap, Math.hypot(x - t.x, (y - t.y) * 3));
    if (gap > bestGap) { best = { x, y }; bestGap = gap; }
  }
  return best;
}

function build(env) {
  const server = new McpServer({ name: 'scatter-pad', version: '1.0.0' });
  const onPage = () => env.DB.prepare('SELECT id, text, x, y, done FROM tasks WHERE archived_at IS NULL ORDER BY created_at').all();
  // Changes one task that is still on the page. Returns false when there is no such task.
  const change = async (set, ...values) => {
    const { meta } = await env.DB.prepare(`UPDATE tasks SET ${set}, updated_at = ?1 WHERE id = ?2 AND archived_at IS NULL`)
      .bind(Date.now(), ...values).run();
    return meta.changes > 0;
  };

  server.registerTool('list_tasks', {
    title: 'List tasks',
    description: 'Every task on the to-do pad, oldest first, including the ones already crossed off.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const { results } = await onPage();
    return say({ tasks: results.map(r => ({ id: r.id, text: r.text, done: r.done === 1 })) });
  });

  server.registerTool('add_tasks', {
    title: 'Add tasks',
    description: 'Write new tasks on the pad. Each is a two-to-five-word summary, at most 80 characters; the pad picks where it goes.',
    inputSchema: { texts: z.array(z.string()).min(1).max(20).describe('One short summary per task.') },
    annotations: { destructiveHint: false },
  }, async ({ texts }) => {
    const wanted = texts.map(cleanText).filter(Boolean);
    if (!wanted.length) return oops('Every task was empty.');
    const { results } = await onPage();
    if (results.length + wanted.length > MAX_ON_PAGE) {
      return oops(`The pad holds ${MAX_ON_PAGE} tasks and has ${results.length}. Remove some first.`);
    }
    const taken = results.map(r => ({ x: r.x, y: r.y })), now = Date.now();
    const added = wanted.map((text, i) => {
      const spot = freeSpot(taken);
      taken.push(spot);
      return { id: newId(), text, ...spot, tilt: +(Math.random() * 5 - 2.5).toFixed(1), created_at: now + i };
    });
    const insert = env.DB.prepare(
      'INSERT INTO tasks (id, text, x, y, tilt, done, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)',
    );
    await env.DB.batch(added.map(t => insert.bind(t.id, t.text, t.x, t.y, t.tilt, t.created_at, now)));
    return say({ added: added.map(t => ({ id: t.id, text: t.text, done: false })) });
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
    description: 'Replace the text of a task. Keep it to a two-to-five-word summary, at most 80 characters.',
    inputSchema: { id, text: z.string().describe('The new summary.') },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async ({ id, text }) => {
    const clean = cleanText(text);
    if (!clean) return oops('The new text was empty. Use remove_task to take a task off the pad.');
    return (await change('text = ?3', id, clean)) ? say({ id, text: clean }) : missing(id);
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

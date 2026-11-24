# Scatter Pad

A one-screen to-do pad. Write a two-to-five-word task, click it to cross it off, drag it around. Tasks glide to make room as the page changes, in one of two layouts you pick in Settings:

- **Loose rows**: slightly tilted rows in the order you wrote them. Dragging reorders.
- **Soft spread**: scattered across the page and nudged apart so it stays evenly filled. A task stays where you write or drop it, and the others move out of its way.
 The page fills the window and never scrolls; the handwriting shrinks as the page fills up.

Persian tasks are set in Vazirmatn and run right to left. Latin tasks use a handwritten face. Both can sit on the same page.

## Using it

| Action | How |
|---|---|
| Write a task | Click an empty spot, or just start typing. In loose rows it goes at the end; in soft spread, where you clicked. Enter keeps it, Esc drops it. |
| Tag | Type `#tag` anywhere in the task (Tab takes the suggested tag), or hover and use the tag button to pick or create tags. Each tag shows as a coloured dot before the task; up to five per task. |
| Tag settings | In Settings: rename a tag, give it a colour and a description, add or delete tags. |
| Auto-tag | In Settings. A task you write without a tag gets up to three from Cloudflare's [Clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/) decision model, which reads each tag's name and description. |
| Filter | Click a tag at the top to show only its tasks; the rest dim, or disappear if Settings says to hide them. Hidden in soft spread, the tasks left gather in a loose cluster near the middle for as long as the filter is on; clearing it puts every task back where it was. New tasks get that tag. Click it again, or press Esc, to show everything. |
| Cross off / un-cross | Click the task. |
| Move | Drag the task. In loose rows the others shift to show where it will land. |
| Edit | Double-click, or hover and use the pencil. F2 when focused. |
| Remove | Hover and use the ×, or Delete when focused. |
| Sweep crossed off | Takes every crossed-off task off the page. |
| Undo | The Undo button on the toast, or Cmd/Ctrl+Z, for a few seconds after remove or sweep. |
| Layout | In Settings: loose rows or soft spread. |
| Auto sweep | In Settings. Takes each task off the page 5, 10 or 30 seconds, or 1, 5 or 15 minutes, after it was crossed off. Undo on the toast brings it back, and it then stays until it is crossed off again. |

Each tag gets its own colour when it is first used (whichever colour the fewest tags have), and you can change it in Settings. The tag filter is kept per device.

Auto-tag asks Clef-flash one yes/no question per tag ("does this to-do belong under work? The tag is for: …") and adds the tags it is at least 70% sure of. Good descriptions matter more than good names. It only runs for new tasks without a tag, so typing `#tag` or filtering by a tag always wins. It costs Workers AI input tokens (Clef-flash bills no output) and needs the `ai` binding in `wrangler.jsonc`.

## Stack

- `public/index.html`: the whole front end, one file, no build step.
- `src/index.js`: a Cloudflare Worker. `/api/tasks` serves the page (`GET` lists it, `PUT` saves a batch of tasks). `/api/settings` holds the layout and auto sweep settings.
- `src/mcp.js`: `/mcp`, the same list as tools for an AI assistant.
- `src/tags.js`: `/api/tags`, tag colours and descriptions, and auto-tagging with Clef-flash.
- `migrations/`: the D1 schema, a `tasks` table and a `settings` table.
- Cloudflare Access in front of everything for sign-in.

## Data

One row per task: `id`, `text`, `x`, `y`, `tilt`, `done`, `created_at`, `done_at`, `updated_at`, `archived_at`, `sort`, `tags` (a JSON array of lower-case words, without the `#`). A second table, `tags`, holds each tag's `color` and `description`. Loose rows orders tasks by `sort` (or `created_at` when it is empty) and works out where each one goes. Soft spread places them at `x` and `y`, and saves new values whenever it moves them.

Nothing is ever deleted. Removing or sweeping a task sets `archived_at`, and the page only shows rows where it is `NULL`. There is no `DELETE` endpoint. To look at everything you have finished:

```bash
npx wrangler d1 execute scatter-pad --remote --command "SELECT text, done, datetime(archived_at/1000, 'unixepoch') AS archived FROM tasks ORDER BY created_at"
```

The browser also keeps a copy in local storage, so the page paints instantly and changes made offline are sent when the connection returns.

## Sign-in

Cloudflare Access is the only thing keeping the list private: the Worker itself does no sign-in check. In the Cloudflare Zero Trust dashboard, add a **self-hosted** Access application for the domain the Worker is served on, with an Allow policy that includes only your own email address. A **Bypass** policy for trusted IPs (home, office, VPN) works too.

Because Access is the only guard, keep `workers_dev` and `preview_urls` off in `wrangler.jsonc`: Access does not cover those URLs, so the list would be open on them.

## MCP

`/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server over Streamable HTTP, so an assistant can read and change the pad. The page picks the changes up within 30 seconds, or as soon as its tab is focused.

| Tool | What it does |
|---|---|
| `list_tasks` | Everything on the page, with ids. |
| `add_tasks` | Writes up to 20 new tasks at the end of the page. `#words` in a text become its tags. |
| `set_done` | Crosses a task off, or un-crosses it. |
| `edit_task` | Replaces a task's text; `#words` in it are added as tags. |
| `set_tags` | Replaces a task's tags. |
| `remove_task` | Takes a task off the page (archived, like everything else). |

**This endpoint has no sign-in.** Anyone who knows the URL can read and rewrite the list.

Access still stands in front of the whole domain, so `/mcp` has to be let through: add a second self-hosted Access application for `<your-domain>/mcp` with a single policy, action **Bypass**, include **Everyone**. The more specific path wins over the application that covers the domain.

Then point a client at it:

```bash
claude mcp add --transport http scatter-pad https://<your-domain>/mcp
```

In claude.ai, add it as a custom connector with the same URL.

## Configuration

Deployment details stay out of the repo. `wrangler.jsonc` is gitignored; start it from the example and fill in your own values:

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

```bash
npx wrangler d1 create scatter-pad
```

Put the database id that command prints into `wrangler.jsonc`. To serve on your own domain, uncomment the `routes` block there.

## Local development

```bash
npm install
```

```bash
npm run db:local
```

```bash
npm run dev
```

## Deploying

```bash
npm run db:remote
```

```bash
npm run deploy
```

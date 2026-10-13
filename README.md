# Scatter Pad

A one-screen to-do pad. Write a two-to-five-word task anywhere on the page, click it to cross it off, drag it to move it. The page fills the window and never scrolls; the handwriting shrinks as the page fills up.

Persian tasks are set in Vazirmatn and run right to left. Latin tasks use a handwritten face. Both can sit on the same page.

## Using it

| Action | How |
|---|---|
| Write a task | Click an empty spot, or just start typing. Enter keeps it, Esc drops it. |
| Cross off / un-cross | Click the task. |
| Move | Drag the task. |
| Edit | Double-click, or hover and use the pencil. F2 when focused. |
| Remove | Hover and use the ×, or Delete when focused. |
| Sweep crossed off | Takes every crossed-off task off the page. |
| Tidy up | Re-scatters tasks so nothing overlaps. |
| Undo | The Undo button on the toast, or Cmd/Ctrl+Z, for a few seconds after remove, sweep or tidy. |

## Stack

- `public/index.html`: the whole front end, one file, no build step.
- `src/index.js`: a Cloudflare Worker with one endpoint, `/api/tasks` (`GET` lists the page, `PUT` saves a batch of tasks).
- `migrations/`: the D1 schema, one `tasks` table.
- Cloudflare Access in front of everything for sign-in.

## Data

One row per task: `id`, `text`, `x`, `y`, `tilt`, `done`, `created_at`, `done_at`, `updated_at`, `archived_at`.

Nothing is ever deleted. Removing or sweeping a task sets `archived_at`, and the page only shows rows where it is `NULL`. There is no `DELETE` endpoint. To look at everything you have finished:

```bash
npx wrangler d1 execute scatter-pad --remote --command "SELECT text, done, datetime(archived_at/1000, 'unixepoch') AS archived FROM tasks ORDER BY created_at"
```

The browser also keeps a copy in local storage, so the page paints instantly and changes made offline are sent when the connection returns.

## Sign-in

The API refuses every request until Cloudflare Access is configured. It checks the signed token Access adds to each request, so the list stays private even if Access is later switched off by mistake.

1. In the Cloudflare Zero Trust dashboard, add a **self-hosted** Access application for the domain the Worker is served on, with an Allow policy that includes only your own email address.
2. Copy two values: the application's audience tag (`aud`) and your team domain (`<team>.cloudflareaccess.com`).
3. Store them on the Worker:

```bash
npx wrangler secret put ACCESS_AUD
```

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN
```

`ACCESS_TEAM_DOMAIN` is the bare host name, without `https://`.

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
echo "ACCESS_BYPASS=local" > .dev.vars
```

```bash
npm run db:local
```

```bash
npm run dev
```

`ACCESS_BYPASS=local` skips the Access check, and only for requests to `localhost` or `127.0.0.1`.

## Deploying

```bash
npm run db:remote
```

```bash
npm run deploy
```

// Page preferences, kept in the settings table as JSON.
// auto_sweep: seconds after a task is crossed off before the page takes it off; 0 is off.
// layout: loose rows in order, or a soft spread across the page.
// auto_tag: new tasks written without a tag get tags from the model.
// filter_mode: while a tag filter is on, the other tasks are dimmed or hidden.
const SWEEP_CHOICES = [0, 5, 10, 30, 60, 300, 900];
export const SETTINGS = { auto_sweep: SWEEP_CHOICES, layout: ['rows', 'spread'], auto_tag: [false, true], filter_mode: ['dim', 'hide'] };
const DEFAULTS = { auto_sweep: 0, layout: 'rows', auto_tag: false, filter_mode: 'dim' };

export async function readSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULTS };
  for (const r of results) {
    if (!(r.key in SETTINGS)) continue;
    try {
      const v = JSON.parse(r.value);
      if (SETTINGS[r.key].includes(v)) out[r.key] = v;
    } catch {}
  }
  return out;
}

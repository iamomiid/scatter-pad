// A task is one short line: runs of whitespace collapse to a space, and it is cut at 80 characters.
export const cleanText = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 80) : '');

// A tag is one word of letters, digits, - or _, stored lower case without the #. A task has at most five.
// The page keeps its own copy of these rules (public/index.html, cleanTags and splitTags).
const TAG = /^[\p{L}\p{N}_-]{1,24}$/u;
export function cleanTags(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v) {
    const t = typeof x === 'string' ? x.replace(/^#/, '').toLowerCase() : '';
    if (TAG.test(t) && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 5);
}
export function parseTags(json) {
  try { return cleanTags(JSON.parse(json)) ?? []; } catch { return []; }
}
// Pulls "#tag" words out of typed text: "send email #work" gives { text: 'send email', tags: ['work'] }.
export function splitTags(s) {
  const tags = [];
  const text = String(s ?? '').replace(/(^|\s)#([\p{L}\p{N}_-]+)/gu, (_, space, tag) => { tags.push(tag); return space; });
  return { text: cleanText(text), tags: cleanTags(tags) };
}

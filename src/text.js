// A task is one short line: runs of whitespace collapse to a space, and it is cut at 80 characters.
export const cleanText = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 80) : '');

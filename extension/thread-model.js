/*
 * thread-model.js
 *
 * Pure rules for a thread: how long a segment may be, whether it is valid,
 * and how threads are identified. No browser APIs, so Node can test it.
 */

export const MAX_CHARS = 500;

/* Threads counts code points, not UTF-16 units, so an emoji is one character. */
export function countChars(text) {
  return Array.from(text || "").length;
}

export function validateSegment(text) {
  const n = countChars(text);
  if (!String(text || "").trim()) return { ok: false, error: "Segment is empty" };
  if (n > MAX_CHARS) return { ok: false, error: `Segment is ${n} characters, limit is ${MAX_CHARS}` };
  return { ok: true, error: null };
}

export function validateThread(thread) {
  const errors = [];
  (thread.segments || []).forEach((seg, index) => {
    const check = validateSegment(seg.text);
    if (!check.ok) errors.push({ index, error: check.error });
  });
  return { ok: errors.length === 0, errors };
}

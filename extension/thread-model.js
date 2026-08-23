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

export function nextThreadId(lastId) {
  const n = lastId ? parseInt(String(lastId).replace(/^TP-/, ""), 10) + 1 : 1;
  return "TP-" + String(n).padStart(3, "0");
}

export function createThread(id) {
  const now = Date.now();
  return {
    id,
    topic: "",
    status: "draft",
    scheduledAt: null,
    postedAt: null,
    postUrl: null,
    createdAt: now,
    updatedAt: now,
    segments: [{ text: "", postedAt: null, postUrl: null }]
  };
}

/* Break long text into postable chunks, preferring whitespace so words survive. */
export function splitText(text, max = MAX_CHARS) {
  const chars = Array.from(text || "");
  if (chars.length <= max) return [text || ""];

  const out = [];
  let rest = chars;
  while (rest.length > max) {
    let cut = -1;
    for (let i = max; i > 0; i--) {
      if (/\s/.test(rest[i])) { cut = i; break; }
    }
    if (cut <= 0) cut = max;              // one long word: break it
    out.push(rest.slice(0, cut).join("").trim());
    rest = rest.slice(cut);
    while (rest.length && /\s/.test(rest[0])) rest = rest.slice(1);
  }
  if (rest.length) out.push(rest.join(""));
  return out;
}

/* Import never deletes: incoming ids replace, unknown ids append. */
export function mergeThreads(existing, incoming) {
  const byId = new Map(existing.map((t) => [t.id, t]));
  incoming.forEach((t) => byId.set(t.id, t));
  return Array.from(byId.values());
}

export function dueThreads(threads, nowMs) {
  return threads.filter(
    (t) => t.status === "ready" && typeof t.scheduledAt === "number" && t.scheduledAt <= nowMs
  );
}

/* Reuse a thread: keep the writing, drop every trace of the run that posted it. */
export function resetThread(thread) {
  return {
    ...thread,
    status: "draft",
    postedAt: null,
    postUrl: null,
    updatedAt: Date.now(),
    segments: thread.segments.map((s) => ({ text: s.text, postedAt: null, postUrl: null }))
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { MAX_CHARS, countChars, validateSegment, validateThread } from "../extension/thread-model.js";

test("MAX_CHARS is the Threads limit", () => {
  assert.equal(MAX_CHARS, 500);
});

test("countChars counts a plain emoji once, not twice", () => {
  assert.equal(countChars("abc"), 3);
  // "🔥" is one code point but two UTF-16 units, so .length would say 2.
  assert.equal(countChars("🔥"), 1);
  assert.equal(countChars(""), 0);
});

test("countChars counts a keycap sequence by its parts", () => {
  // "1️⃣" is three code points: the digit, a variation selector and the
  // combining keycap. Grapheme clustering would call it one character, but
  // counting the parts errs high, and warning early beats writing a post the
  // platform then rejects.
  assert.equal(countChars("1️⃣ hi"), 6);
});

test("validateSegment rejects empty text", () => {
  assert.deepEqual(validateSegment("   "), { ok: false, error: "Segment is empty" });
});

test("validateSegment rejects text over the limit", () => {
  const long = "a".repeat(501);
  assert.equal(validateSegment(long).ok, false);
  assert.match(validateSegment(long).error, /501/);
});

test("validateSegment accepts text at exactly the limit", () => {
  assert.deepEqual(validateSegment("a".repeat(500)), { ok: true, error: null });
});

test("validateThread reports the index of every bad segment", () => {
  const thread = { segments: [{ text: "fine" }, { text: "" }, { text: "b".repeat(600) }] };
  const result = validateThread(thread);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.index), [1, 2]);
});

test("validateThread passes a good thread", () => {
  assert.deepEqual(validateThread({ segments: [{ text: "ok" }] }), { ok: true, errors: [] });
});

import { nextThreadId, createThread, splitText, mergeThreads, dueThreads } from "../extension/thread-model.js";

test("nextThreadId pads to three digits and increments", () => {
  assert.equal(nextThreadId(null), "TP-001");
  assert.equal(nextThreadId("TP-001"), "TP-002");
  assert.equal(nextThreadId("TP-009"), "TP-010");
  assert.equal(nextThreadId("TP-999"), "TP-1000");
});

test("createThread starts as a draft with one empty segment", () => {
  const t = createThread("TP-007");
  assert.equal(t.id, "TP-007");
  assert.equal(t.status, "draft");
  assert.equal(t.segments.length, 1);
  assert.equal(t.segments[0].text, "");
  assert.equal(t.postUrl, null);
});

test("splitText returns one chunk when text fits", () => {
  assert.deepEqual(splitText("short", 500), ["short"]);
});

test("splitText breaks on whitespace, never mid-word", () => {
  assert.deepEqual(splitText("aaa bbb ccc", 7), ["aaa bbb", "ccc"]);
});

test("splitText hard-breaks a word longer than the limit", () => {
  assert.deepEqual(splitText("abcdefgh", 3), ["abc", "def", "gh"]);
});

test("mergeThreads overwrites matching ids and inserts unknown ones", () => {
  const existing = [{ id: "TP-001", topic: "old" }, { id: "TP-002", topic: "keep" }];
  const incoming = [{ id: "TP-001", topic: "new" }, { id: "TP-003", topic: "fresh" }];
  const merged = mergeThreads(existing, incoming);
  assert.equal(merged.length, 3);
  assert.equal(merged.find((t) => t.id === "TP-001").topic, "new");
  assert.equal(merged.find((t) => t.id === "TP-002").topic, "keep");
  assert.equal(merged.find((t) => t.id === "TP-003").topic, "fresh");
});

test("dueThreads returns ready threads whose time has passed", () => {
  const threads = [
    { id: "TP-001", status: "ready", scheduledAt: 100 },
    { id: "TP-002", status: "ready", scheduledAt: 900 },
    { id: "TP-003", status: "ready", scheduledAt: null },
    { id: "TP-004", status: "posted", scheduledAt: 100 },
    { id: "TP-005", status: "draft", scheduledAt: 100 }
  ];
  assert.deepEqual(dueThreads(threads, 500).map((t) => t.id), ["TP-001"]);
});

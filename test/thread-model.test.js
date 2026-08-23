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

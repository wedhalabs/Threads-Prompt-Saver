import test from "node:test";
import assert from "node:assert/strict";
import { CSV_HEADER, BOM, escapeField, serializeThreads } from "../extension/csv.js";

test("header matches the agreed column order", () => {
  assert.deepEqual(CSV_HEADER, [
    "thread_id", "topic", "status", "scheduled_at", "posted_at", "post_url", "seq", "text"
  ]);
});

test("escapeField leaves plain text alone", () => {
  assert.equal(escapeField("hello"), "hello");
});

test("escapeField quotes commas, quotes and newlines", () => {
  assert.equal(escapeField("a,b"), '"a,b"');
  assert.equal(escapeField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeField("line1\nline2"), '"line1\nline2"');
});

test("escapeField renders null and undefined as empty", () => {
  assert.equal(escapeField(null), "");
  assert.equal(escapeField(undefined), "");
});

test("serializeThreads writes one row per segment with a BOM", () => {
  const threads = [{
    id: "TP-001", topic: "Tips", status: "ready",
    scheduledAt: Date.UTC(2026, 7, 18, 9, 0, 0), postedAt: null, postUrl: null,
    segments: [{ text: "parent 🔥" }, { text: "reply, with comma" }]
  }];
  const csv = serializeThreads(threads);
  assert.ok(csv.startsWith(BOM), "starts with BOM");

  const lines = csv.slice(BOM.length).split("\n");
  assert.equal(lines[0], CSV_HEADER.join(","));
  assert.equal(lines[1], "TP-001,Tips,ready,2026-08-18T09:00:00.000Z,,,0,parent 🔥");
  assert.equal(lines[2], 'TP-001,Tips,ready,2026-08-18T09:00:00.000Z,,,1,"reply, with comma"');
});

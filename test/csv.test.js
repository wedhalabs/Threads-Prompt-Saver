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

import { parseThreads } from "../extension/csv.js";

const NL = String.fromCharCode(10);

test("parseThreads survives a round trip with nasty text", () => {
  const threads = [{
    id: "TP-001", topic: "Tips, and tricks", status: "ready",
    scheduledAt: Date.UTC(2026, 7, 18, 9, 0, 0), postedAt: null, postUrl: null,
    segments: [
      { text: 'He said "no"' + NL + "Then left. 🔥" },
      { text: "plain reply" }
    ]
  }];
  const back = parseThreads(serializeThreads(threads));
  assert.deepEqual(back.errors, []);
  assert.equal(back.threads.length, 1);
  assert.equal(back.threads[0].topic, "Tips, and tricks");
  assert.equal(back.threads[0].scheduledAt, Date.UTC(2026, 7, 18, 9, 0, 0));
  assert.equal(back.threads[0].segments[0].text, 'He said "no"' + NL + "Then left. 🔥");
  assert.equal(back.threads[0].segments[1].text, "plain reply");
});

test("parseThreads orders segments by seq regardless of row order", () => {
  const csv = BOM + CSV_HEADER.join(",") + NL +
    "TP-001,T,draft,,,,1,second" + NL +
    "TP-001,T,draft,,,,0,first";
  const { threads } = parseThreads(csv);
  assert.deepEqual(threads[0].segments.map((s) => s.text), ["first", "second"]);
});

test("parseThreads takes thread fields from the lowest seq row", () => {
  const csv = BOM + CSV_HEADER.join(",") + NL +
    "TP-001,right,ready,,,,0,a" + NL +
    "TP-001,wrong,draft,,,,1,b";
  const { threads } = parseThreads(csv);
  assert.equal(threads[0].topic, "right");
  assert.equal(threads[0].status, "ready");
});

test("parseThreads reports a wrong header and returns nothing", () => {
  const { threads, errors } = parseThreads("a,b,c" + NL + "1,2,3");
  assert.deepEqual(threads, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /header/i);
});

test("parseThreads collects every bad row and imports nothing", () => {
  const csv = BOM + CSV_HEADER.join(",") + NL +
    "TP-001,T,draft,,,,0,fine" + NL +
    "TP-002,T,nonsense,,,,0,bad status" + NL +
    "TP-003,T,draft,,,,x,bad seq";
  const { threads, errors } = parseThreads(csv);
  assert.deepEqual(threads, []);
  assert.equal(errors.length, 2);
  assert.deepEqual(errors.map((e) => e.line), [3, 4]);
});

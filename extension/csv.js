/*
 * csv.js
 *
 * Turns the library into a spreadsheet and back. One row per segment, so no
 * field ever holds a nested list. RFC 4180 quoting; UTF-8 BOM so Excel reads
 * emoji correctly. No browser APIs, so Node can test it.
 */

export const CSV_HEADER = [
  "thread_id", "topic", "status", "scheduled_at", "posted_at", "post_url", "seq", "text"
];

export const BOM = "﻿";

export function escapeField(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function isoOrEmpty(ms) {
  return typeof ms === "number" ? new Date(ms).toISOString() : "";
}

export function serializeThreads(threads) {
  const rows = [CSV_HEADER.join(",")];
  threads.forEach((t) => {
    t.segments.forEach((seg, seq) => {
      rows.push([
        t.id, t.topic, t.status,
        isoOrEmpty(t.scheduledAt), isoOrEmpty(t.postedAt), t.postUrl,
        seq, seg.text
      ].map(escapeField).join(","));
    });
  });
  return BOM + rows.join("\n");
}

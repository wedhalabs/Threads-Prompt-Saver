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

const STATUSES = ["draft", "ready", "posted"];

/* Split one CSV line, honouring quotes. Returns null if quoting is broken. */
function splitRow(line) {
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(field); field = "";
    } else field += c;
  }
  if (quoted) return null;
  out.push(field);
  return out;
}

/* A quoted field may contain newlines, so a physical line is not always a row.
 * Rejoin until the quotes balance. */
function logicalLines(text) {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  const lines = [];
  let buffer = "";
  raw.forEach((piece) => {
    buffer = buffer ? buffer + "\n" + piece : piece;
    const quotes = (buffer.match(/"/g) || []).length;
    if (quotes % 2 === 0) { lines.push(buffer); buffer = ""; }
  });
  if (buffer) lines.push(buffer);
  return lines;
}

function msOrNull(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function parseThreads(text) {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const lines = logicalLines(body).filter((l, i) => i === 0 || l.trim() !== "");
  const errors = [];

  const header = splitRow(lines[0] || "");
  if (!header || header.join(",") !== CSV_HEADER.join(",")) {
    return { threads: [], errors: [{ line: 1, error: "Unexpected header row" }] };
  }

  const byId = new Map();
  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    const cells = splitRow(lines[i]);
    if (!cells || cells.length !== CSV_HEADER.length) {
      errors.push({ line: lineNo, error: `Expected ${CSV_HEADER.length} columns` });
      continue;
    }
    const [id, topic, status, scheduled, posted, url, seqRaw, textValue] = cells;
    if (!id) { errors.push({ line: lineNo, error: "Missing thread_id" }); continue; }
    if (!STATUSES.includes(status)) {
      errors.push({ line: lineNo, error: `Unknown status "${status}"` }); continue;
    }
    const seq = Number(seqRaw);
    if (!Number.isInteger(seq) || seq < 0) {
      errors.push({ line: lineNo, error: `Bad seq "${seqRaw}"` }); continue;
    }

    if (!byId.has(id)) byId.set(id, { id, rows: [] });
    byId.get(id).rows.push({
      seq, text: textValue,
      topic, status, scheduledAt: msOrNull(scheduled),
      postedAt: msOrNull(posted), postUrl: url || null
    });
  }

  if (errors.length) return { threads: [], errors };

  const now = Date.now();
  const threads = Array.from(byId.values()).map((entry) => {
    entry.rows.sort((a, b) => a.seq - b.seq);
    // Thread-level fields repeat on every row; the first segment's row wins.
    const head = entry.rows[0];
    return {
      id: entry.id,
      topic: head.topic,
      status: head.status,
      scheduledAt: head.scheduledAt,
      postedAt: head.postedAt,
      postUrl: head.postUrl,
      createdAt: now,
      updatedAt: now,
      segments: entry.rows.map((r) => ({ text: r.text, postedAt: null, postUrl: null }))
    };
  });

  return { threads, errors: [] };
}

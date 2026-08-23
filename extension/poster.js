/*
 * poster.js
 *
 * Renders the thread library and its editor. Owns the publish session, so a
 * sleeping service worker cannot lose the author's place in a chain.
 */

import {
  getAllThreads, putThread, deleteThread, getMeta, setMeta, setCsvDir, writeCsvMirror,
} from "./poster-store.js";
import {
  createThread, nextThreadId, countChars, MAX_CHARS, validateThread, resetThread,
  dueThreads, mergeThreads,
} from "./thread-model.js";
import { parseThreads, serializeThreads } from "./csv.js";

let threads = [];
let selectedId = null;
let filter = "all";
let query = "";

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function visible() {
  return threads
    .filter((t) => filter === "all" || t.status === filter)
    .filter((t) => {
      if (!query) return true;
      const hay = (t.topic + " " + t.segments.map((s) => s.text).join(" ")).toLowerCase();
      return hay.includes(query.toLowerCase());
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function renderStats() {
  const segs = threads.reduce((n, t) => n + t.segments.length, 0);
  $(".stats").innerHTML =
    `<div class="stat"><b>${threads.length}</b><span>threads</span></div>` +
    `<div class="stat"><b>${segs}</b><span>segments</span></div>` +
    `<div class="stat ready"><b>${threads.filter((t) => t.status === "ready").length}</b><span>ready</span></div>` +
    `<div class="stat posted"><b>${threads.filter((t) => t.status === "posted").length}</b><span>posted</span></div>`;
}

function renderList() {
  const rows = visible();
  $(".list").innerHTML = rows.length
    ? rows.map((t) => {
        const shown = t.segments.slice(0, 3);
        const chain = shown.map((s, i) => {
          const line = i < shown.length - 1 ? '<div class="thread-line"></div>' : "";
          return `<div class="link"><div class="rail"><div class="node"></div>${line}</div>` +
                 `<div class="link-text">${escapeHtml(s.text || "Empty")}</div></div>`;
        }).join("");
        const more = t.segments.length > 3
          ? `<div class="more">+${t.segments.length - 3} more replies</div>` : "";
        const link = t.postUrl
          ? `<a href="${escapeHtml(t.postUrl)}" target="_blank" rel="noreferrer">View on Threads &#8599;</a>` : "";
        const when = t.scheduledAt ? new Date(t.scheduledAt).toLocaleString() : "";
        return `<button class="card" data-id="${t.id}" ${t.id === selectedId ? 'aria-selected="true"' : ""}>
            <div class="card-top">
              <span class="topic">${escapeHtml(t.topic || t.id)}</span>
              <span class="pill ${t.status}">${t.status}</span>
            </div>
            <div class="card-title">${escapeHtml(t.segments[0].text.slice(0, 80) || "Untitled")}</div>
            <div class="chain ${t.status === "posted" ? "posted-chain" : ""}">${chain}</div>
            ${more}
            <div class="card-foot"><span>${when}</span>${link}</div>
          </button>`;
      }).join("")
    : `<p style="color:var(--faint);padding:20px;text-align:center">No threads yet.</p>`;

  $(".list").querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", () => { selectedId = card.dataset.id; render(); });
  });
}

function meterClass(n) {
  return n > MAX_CHARS ? "over" : n > 400 ? "near" : "";
}

function renderEditor() {
  const t = threads.find((x) => x.id === selectedId);
  const head = $(".editor-head");
  const segs = $(".segments");
  const foot = $(".editor-foot");

  if (!t) {
    head.style.display = segs.style.display = foot.style.display = "none";
    return;
  }
  head.style.display = "flex";
  segs.style.display = "";
  foot.style.display = "flex";

  head.querySelector(".topic-in").value = t.topic;
  head.querySelector(".pill").className = "pill " + t.status;
  head.querySelector(".pill").textContent = t.status;

  segs.innerHTML = t.segments.map((s, i) => {
    const n = countChars(s.text);
    const pct = Math.min(100, (n / MAX_CHARS) * 100);
    const label = i === 0 ? "Parent post" : `Reply ${i}`;
    const remove = i === 0 ? "" : `<button class="rm" data-rm="${i}">Remove</button>`;
    const line = i < t.segments.length - 1 ? '<div class="seg-line"></div>' : "";
    return `<div class="seg ${i === 0 ? "parent" : ""}">
        <div class="seg-rail"><div class="seg-badge">${i + 1}</div>${line}</div>
        <div class="seg-body">
          <div class="seg-label">${label} ${remove}</div>
          <textarea data-seg="${i}">${escapeHtml(s.text)}</textarea>
          <div class="meter-row">
            <div class="meter ${meterClass(n)}"><i style="width:${pct}%"></i></div>
            <div class="count ${meterClass(n)}">${n} / ${MAX_CHARS}</div>
          </div>
        </div>
      </div>`;
  }).join("") + `<button class="add-reply">+ Add reply</button>`;

  segs.querySelectorAll("textarea").forEach((ta) => {
    ta.addEventListener("input", async () => {
      t.segments[Number(ta.dataset.seg)].text = ta.value;
      const n = countChars(ta.value);
      const row = ta.parentElement.querySelector(".meter-row");
      row.querySelector("i").style.width = Math.min(100, (n / MAX_CHARS) * 100) + "%";
      row.querySelector(".meter").className = "meter " + meterClass(n);
      row.querySelector(".count").className = "count " + meterClass(n);
      row.querySelector(".count").textContent = `${n} / ${MAX_CHARS}`;
      await save(t);
      renderStats();
    });
  });
  segs.querySelectorAll("[data-rm]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      t.segments.splice(Number(btn.dataset.rm), 1);
      await save(t); render();
    });
  });
  segs.querySelector(".add-reply").addEventListener("click", async () => {
    t.segments.push({ text: "", postedAt: null, postUrl: null });
    await save(t); render();
  });

  const when = foot.querySelector('input[type="datetime-local"]');
  when.value = t.scheduledAt
    ? new Date(t.scheduledAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : "";
}

async function save(thread) {
  await putThread(thread);
  const mirror = await writeCsvMirror();
  // A missing folder is not an error worth shouting about on every keystroke;
  // a folder that exists and refuses to be written is.
  banner(mirror.ok || /No folder chosen/.test(mirror.error || "")
    ? "" : "CSV mirror not written: " + mirror.error);
}

function banner(message) {
  let el = document.getElementById("tps-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "tps-banner";
    el.style.cssText = "padding:8px 18px;background:#7d2f2f22;color:#ff9b9b;" +
      "font-size:12.5px;border-bottom:1px solid #7d2f2f;cursor:pointer";
    el.addEventListener("click", () => ensureCsvDir().catch(() => {}));
    document.querySelector(".topbar").after(el);
  }
  el.textContent = message;
  el.style.display = message ? "block" : "none";
}

function render() { renderStats(); renderList(); renderEditor(); }

async function boot() {
  threads = await getAllThreads();
  const wanted = new URLSearchParams(location.search).get("thread");
  selectedId = wanted || (threads[0] && threads[0].id) || null;

  $(".btn.primary").addEventListener("click", async () => {
    const last = await getMeta("nextId");
    const id = nextThreadId(last);
    await setMeta("nextId", id);
    const t = createThread(id);
    threads.push(t);
    selectedId = id;
    await save(t); render();
  });

  $(".search input").addEventListener("input", (e) => { query = e.target.value; renderList(); });

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
      chip.setAttribute("aria-pressed", "true");
      filter = chip.textContent.trim().toLowerCase();
      renderList();
    });
  });

  $(".editor-head .topic-in").addEventListener("input", async (e) => {
    const t = threads.find((x) => x.id === selectedId);
    if (!t) return;
    t.topic = e.target.value;
    await save(t); renderList();
  });

  $(".editor-foot input[type=datetime-local]").addEventListener("change", async (e) => {
    const t = threads.find((x) => x.id === selectedId);
    if (!t) return;
    t.scheduledAt = e.target.value ? new Date(e.target.value).getTime() : null;
    await chrome.alarms.clear(t.id);
    if (t.scheduledAt) await chrome.alarms.create(t.id, { when: t.scheduledAt });
    await save(t); renderList();
  });

  // Delete is the second ghost button in the editor header.
  const headButtons = document.querySelectorAll(".editor-head .btn.ghost");
  headButtons[0].textContent = "Reuse";
  headButtons[0].addEventListener("click", async () => {
    const t = threads.find((x) => x.id === selectedId);
    if (!t || t.status !== "posted") { banner("Only a posted thread can be reused."); return; }
    const fresh = resetThread(t);
    threads[threads.indexOf(t)] = fresh;
    await save(fresh); render();
  });
  headButtons[1].addEventListener("click", async () => {
    const t = threads.find((x) => x.id === selectedId);
    if (!t) return;
    await deleteThread(t.id);
    threads = threads.filter((x) => x.id !== t.id);
    selectedId = (threads[0] && threads[0].id) || null;
    await writeCsvMirror();
    render();
  });

  render();
  markOverdue();
}

/* An alarm cannot fire while the browser is shut, so sweep on load. */
function markOverdue() {
  const overdue = dueThreads(threads, Date.now());
  if (overdue.length) {
    banner(`${overdue.length} thread(s) passed their reminder: ` +
           overdue.map((t) => t.id).join(", "));
  }
}

async function ensureCsvDir() {
  const dir = await window.showDirectoryPicker({ mode: "readwrite" });
  await setCsvDir(dir);
  const result = await writeCsvMirror();
  banner(result.ok ? "" : "CSV mirror not written: " + result.error);
}

boot();

/* ---- publish session ---------------------------------------------------- */

/* Mirrors meta.session in memory so the tab's "any work for me?" message can
 * be answered synchronously. IndexedDB stays the durable copy. */
let sessionCache = null;
let pendingSegment = null;

function armSegment() {
  if (!sessionCache) { pendingSegment = null; return; }
  const thread = threads.find((t) => t.id === sessionCache.threadId);
  pendingSegment = thread ? thread.segments[sessionCache.index].text : null;
}

async function setSession(session) {
  sessionCache = session;
  await setMeta("session", session);
  armSegment();
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg && msg.type === "tps-ready") {
    respond({ text: pendingSegment });
    return true;
  }
  if (msg && msg.type === "tps-posted-relay") advanceSession(msg.url);
});

async function startSession(thread) {
  const check = validateThread(thread);
  if (!check.ok) {
    banner(`Fix ${check.errors.length} segment(s) before publishing.`);
    return;
  }
  if (thread.status === "draft") { thread.status = "ready"; await save(thread); }

  await setSession({ threadId: thread.id, index: 0 });
  document.body.classList.add("publishing");
  renderSession();
  await chrome.tabs.create({ url: "https://www.threads.com/" });
}

async function advanceSession(url) {
  const session = sessionCache;
  if (!session) return;
  const thread = threads.find((t) => t.id === session.threadId);
  if (!thread) return;

  thread.segments[session.index].postUrl = url || null;
  thread.segments[session.index].postedAt = Date.now();
  if (session.index === 0) thread.postUrl = url || null;

  const next = session.index + 1;
  if (next >= thread.segments.length) {
    thread.status = "posted";
    thread.postedAt = Date.now();
    await save(thread);
    await setSession(null);
    document.body.classList.remove("publishing");
    render();
    return;
  }
  await save(thread);
  await setSession({ ...session, index: next });
  renderSession();
}

function renderSession() {
  const session = sessionCache;
  if (!session) return;
  const thread = threads.find((t) => t.id === session.threadId);
  if (!thread) return;

  const head = document.querySelector(".session-head");
  head.querySelector("b").textContent = `Publishing "${thread.topic || thread.id}"`;
  head.querySelector(".progress").innerHTML = thread.segments.map((s, i) =>
    `<div class="pdot ${i < session.index ? "done" : i === session.index ? "now" : ""}"></div>`
  ).join("");

  const inner = document.querySelector(".session-inner");
  inner.querySelector(".step-of").textContent =
    `Step ${session.index + 1} of ${thread.segments.length} · ` +
    (session.index === 0 ? "Parent post" : "Reply " + session.index);
  inner.querySelector(".preview").textContent = thread.segments[session.index].text;
}

async function resumeSession() {
  const session = await getMeta("session");
  if (!session) return;
  sessionCache = session;
  armSegment();
  document.body.classList.add("publishing");
  renderSession();
}

document.querySelector(".editor-foot .btn.primary").addEventListener("click", () => {
  const t = threads.find((x) => x.id === selectedId);
  if (t) startSession(t);
});

/* "I posted it" carries the pasted URL when detection missed it. */
document.querySelector(".session-actions .btn:last-child").addEventListener("click", () => {
  const pasted = document.querySelector(".fallback input").value.trim();
  advanceSession(pasted || null);
});

document.querySelector(".session-head .btn.ghost").addEventListener("click", () => {
  document.body.classList.remove("publishing");
});

resumeSession();

/* ---- CSV import and export ---------------------------------------------- *
 * Import is how a batch of ideas written elsewhere becomes threads here: a
 * spreadsheet of topics and text, one row per segment.
 * ------------------------------------------------------------------------- */

const [importBtn, exportBtn] = document.querySelectorAll(".topbar .btn.ghost");

importBtn.addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,text/csv";
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;

    const { threads: incoming, errors } = parseThreads(await file.text());
    if (errors.length) {
      // Nothing is imported when anything is wrong: a partial import leaves the
      // author guessing which half landed.
      banner(`Import cancelled. ${errors.length} bad row(s): ` +
             errors.slice(0, 3).map((e) => `line ${e.line} — ${e.error}`).join("; "));
      return;
    }

    threads = mergeThreads(threads, incoming);
    for (const t of threads) await putThread(t);
    await writeCsvMirror();
    banner("");
    render();
  });
  input.click();
});

/* A download rather than the folder mirror: export answers "give me the file
 * now", which should not depend on a folder having been chosen. */
exportBtn.addEventListener("click", () => {
  const blob = new Blob([serializeThreads(threads)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "threads-content.csv";
  a.click();
  URL.revokeObjectURL(url);
});

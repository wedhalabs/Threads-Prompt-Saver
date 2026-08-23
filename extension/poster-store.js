/*
 * poster-store.js
 *
 * The thread library lives here. IndexedDB holds the truth; a CSV mirror in
 * the author's folder is a convenience rewritten after every change.
 *
 * Deliberately a separate database from the saver's "threads-prompt-saver":
 * bumping that one's version would force every existing caller to move in
 * lockstep, and a straggler at version 1 throws VersionError.
 */

import { serializeThreads } from "./csv.js";

const DB = "tps-poster";
const THREADS = "threads";
const META = "meta";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(THREADS)) {
        const store = db.createObjectStore(THREADS, { keyPath: "id" });
        store.createIndex("status", "status");
        store.createIndex("scheduledAt", "scheduledAt");
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(storeName, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
  }));
}

export function getAllThreads() {
  return run(THREADS, "readonly", (s) => s.getAll()).then((rows) => rows || []);
}

export function getThread(id) {
  return run(THREADS, "readonly", (s) => s.get(id)).then((row) => row || null);
}

export async function putThread(thread) {
  thread.updatedAt = Date.now();
  await run(THREADS, "readwrite", (s) => s.put(thread));
}

export function deleteThread(id) {
  return run(THREADS, "readwrite", (s) => s.delete(id));
}

export function getMeta(key) {
  return run(META, "readonly", (s) => s.get(key));
}

export function setMeta(key, value) {
  return run(META, "readwrite", (s) => s.put(value, key));
}

export function setCsvDir(handle) {
  return setMeta("csvDir", handle);
}

/* Rewrite the whole file. The library is small, so this costs less than
 * tracking deltas — and a partial file is worse than a slow one. */
export async function writeCsvMirror() {
  try {
    const dir = await getMeta("csvDir");
    if (!dir) return { ok: false, error: "No folder chosen for the CSV mirror" };

    const permission = await dir.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      const asked = await dir.requestPermission({ mode: "readwrite" });
      if (asked !== "granted") return { ok: false, error: "Folder permission was refused" };
    }

    const threads = await getAllThreads();
    const handle = await dir.getFileHandle("threads-content.csv", { create: true });
    const writable = await handle.createWritable();
    await writable.write(serializeThreads(threads));
    await writable.close();
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

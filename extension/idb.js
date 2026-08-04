/*
 * idb.js
 *
 * Stores the folder you picked. A FileSystemDirectoryHandle can't go in
 * chrome.storage (it isn't JSON), but IndexedDB keeps it intact, so the choice
 * survives restarts — Chrome still re-checks write permission each session.
 *
 * Loaded by both the options page and the offscreen document.
 */

const TPS_DB = "threads-prompt-saver";
const TPS_STORE = "handles";
const TPS_KEY = "saveDir";
/* post code -> folder name, so re-saving a post always lands in the folder it
 * already has, even if a later version of the extension would name it
 * differently. */
const TPS_FOLDERS_KEY = "postFolders";

function tpsOpenDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TPS_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(TPS_STORE)) {
        req.result.createObjectStore(TPS_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tpsSetDirHandle(handle) {
  const db = await tpsOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TPS_STORE, "readwrite");
    tx.objectStore(TPS_STORE).put(handle, TPS_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function tpsGetDirHandle() {
  const db = await tpsOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TPS_STORE, "readonly");
    const req = tx.objectStore(TPS_STORE).get(TPS_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function tpsGetPostFolders() {
  const db = await tpsOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TPS_STORE, "readonly");
    const req = tx.objectStore(TPS_STORE).get(TPS_FOLDERS_KEY);
    req.onsuccess = () => resolve(req.result || {});
    req.onerror = () => reject(req.error);
  });
}

async function tpsSetPostFolders(map) {
  const db = await tpsOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TPS_STORE, "readwrite");
    tx.objectStore(TPS_STORE).put(map, TPS_FOLDERS_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function tpsClearDirHandle() {
  const db = await tpsOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TPS_STORE, "readwrite");
    tx.objectStore(TPS_STORE).delete(TPS_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

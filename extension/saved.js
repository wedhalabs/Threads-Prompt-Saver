/*
 * saved.js
 *
 * Shows what a save actually produced: the images, the video, and prompt.txt,
 * read back through the same directory handle that wrote them.
 *
 * This exists because Chrome never reveals where a chosen folder is and no
 * extension can open one in the file manager. Rather than send the user off to
 * find the folder themselves, the extension shows them the contents.
 *
 * An extension page, not an injection into Threads: downloads and object URLs
 * work here without a site's content security policy interfering.
 */

const $ = (id) => document.getElementById(id);
const PARAMS = new URLSearchParams(location.search);
const FOLDER = PARAMS.get("folder") || "";
const AUTHOR = PARAMS.get("author") || "";

const IMAGE_RE = /\.(jpg|jpeg|png|webp|gif)$/i;
const VIDEO_RE = /\.(mp4|webm|mov)$/i;

function say(text) {
  $("status").textContent = text;
  setTimeout(() => { $("status").textContent = ""; }, 2500);
}

function showOnly(message) {
  $("empty").textContent = message;
  $("empty").style.display = "block";
}

function tileFor(name, url, kind) {
  const tile = document.createElement("div");
  tile.className = "tile";

  const media = document.createElement(kind === "video" ? "video" : "img");
  media.src = url;
  if (kind === "video") media.controls = true;
  else media.alt = name;
  tile.appendChild(media);

  const row = document.createElement("div");
  row.className = "row";

  const label = document.createElement("span");
  label.className = "name";
  label.textContent = name;
  row.appendChild(label);

  // A real download rather than a drag: dragging out of a page often carries a
  // reference instead of the bytes, which is no use in another app.
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.textContent = "Save";
  row.appendChild(link);

  tile.appendChild(row);
  return tile;
}

async function render(dir) {
  const images = [];
  let promptText = null;

  for await (const [name, entry] of dir.entries()) {
    if (entry.kind !== "file") continue;
    if (name.toLowerCase() === "prompt.txt") {
      promptText = await (await entry.getFile()).text();
      continue;
    }
    if (IMAGE_RE.test(name)) images.push({ name, entry, kind: "image" });
    else if (VIDEO_RE.test(name)) images.push({ name, entry, kind: "video" });
  }

  // image2 before image10, which a plain string sort gets wrong.
  images.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  );

  if (images.length) {
    const grid = $("grid");
    for (const item of images) {
      const file = await item.entry.getFile();
      grid.appendChild(tileFor(item.name, URL.createObjectURL(file), item.kind));
    }
    $("mediaBox").style.display = "";
  }

  if (promptText !== null) {
    // The BOM keeps editors from mangling the text, but it should not show here.
    $("promptText").textContent = promptText.replace(/^﻿/, "");
    $("promptBox").style.display = "";
    $("copyPrompt").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("promptText").textContent);
        say("Copied.");
      } catch (e) {
        say("Chrome refused the clipboard — select the text instead.");
      }
    });
  }

  if (!images.length && promptText === null) {
    showOnly("That folder is empty, or its files were renamed after the save.");
  }
}

/* The on-disk location, if the user has told the options page where the save
 * folder lives. Shown here rather than on the save toast: there is room for a
 * long path on a page, and this is where someone looks when they want it. */
async function showPath() {
  try {
    const root = await tpsGetFolderPath();
    const { joinFolderPath, toFileUrl } = await import("./path-util.js");
    // Posts saved before authors were introduced sit at the root, so only add
    // the author level when this post actually has one.
    const parent = AUTHOR ? joinFolderPath(root, AUTHOR) : root;
    const full = joinFolderPath(parent, FOLDER);
    if (!full) return;

    $("folderName").textContent = full;
    offerToOpen(toFileUrl(full));
  } catch (e) {
    /* no path configured: the folder name alone stands */
  }
}

/* Chrome's own directory listing, not the file manager — no extension can open
 * that. It needs "Allow access to file URLs", which is off by default, so ask
 * Chrome first: a button that silently does nothing is worse than no button. */
function offerToOpen(url) {
  if (!url) return;
  $("openRow").style.display = "";

  chrome.extension.isAllowedFileSchemeAccess((allowed) => {
    if (!allowed) {
      $("openFolder").disabled = true;
      $("openHint").textContent =
        'Turn on "Allow access to file URLs" for this extension at chrome://extensions to enable this.';
      return;
    }
    $("openHint").textContent = "Opens Chrome's file listing for this folder.";
    $("openFolder").addEventListener("click", () => chrome.tabs.create({ url }));
  });
}

async function load() {
  $("folderName").textContent = (AUTHOR ? AUTHOR + " / " : "") + (FOLDER || "No folder given");
  showPath();
  if (!FOLDER) {
    showOnly("This page needs a folder name. Open it from a saved post.");
    return;
  }

  let root;
  try {
    root = await tpsGetDirHandle();
  } catch (e) {
    root = null;
  }
  if (!root) {
    showOnly("No save folder is chosen. Pick one in the extension's options.");
    return;
  }

  // Reading needs permission too, and Chrome drops it every restart. Asking
  // requires a click, so offer a button rather than failing silently.
  if ((await root.queryPermission({ mode: "read" })) !== "granted") {
    $("needsPermission").style.display = "block";
    $("allow").addEventListener("click", async () => {
      if ((await root.requestPermission({ mode: "readwrite" })) === "granted") {
        $("needsPermission").style.display = "none";
        load();
      }
    });
    return;
  }

  /* Posts are filed under their author now. Anything saved before that change
   * still sits at the root, so try the author's folder first and fall back —
   * an older post must not read as missing. */
  let dir = null;
  if (AUTHOR) {
    try {
      const authorDir = await root.getDirectoryHandle(AUTHOR, { create: false });
      dir = await authorDir.getDirectoryHandle(FOLDER, { create: false });
    } catch (e) {
      dir = null;
    }
  }
  if (!dir) {
    try {
      dir = await root.getDirectoryHandle(FOLDER, { create: false });
    } catch (e) {
      showOnly(`No folder named "${FOLDER}" is in your save folder any more.`);
      return;
    }
  }

  try {
    await render(dir);
  } catch (e) {
    showOnly("Could not read that folder: " + ((e && e.message) || e));
  }
}

load();

/*
 * offscreen.js
 *
 * Writes a post's media into the folder chosen with the Browse button, using
 * the File System Access API. Runs in an offscreen document because that API
 * needs a document context — service workers don't have one.
 *
 * Reports a reason rather than throwing when it can't proceed, so the
 * background worker can fall back to Chrome's download folder.
 */

function sanitizeSegment(name, fallback, maxLen = 80) {
  const cleaned = (name || "")
    .replace(/[<>:"/\\|?* -]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, maxLen)
    .replace(/[._]+$/, "");
  return cleaned || fallback;
}

function extensionFor(kind, url, contentType) {
  const byType = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  }[(contentType || "").split(";")[0].trim().toLowerCase()];
  if (byType) return byType;
  const m = /\.(jpg|jpeg|png|webp|gif|mp4|mov|webm)(?:$|[?&])/i.exec(url || "");
  if (m) return m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
  return kind === "video" ? "mp4" : "jpg";
}

function promptText(post) {
  const lines = [
    "PROMPT",
    `Source: ${post.url || ""}`,
    `Author: @${post.author || ""}`,
    "Saved automatically by the Threads Prompt Saver.",
    "",
  ];
  // The post's own words come first: they say what the prompt is for, which
  // reads better ahead of a prompt that can run to thousands of characters.
  const parts = post.parts || [];
  if (parts.length) {
    lines.push("=".repeat(70), "POST TEXT", "=".repeat(70));
    for (const part of parts) {
      const caption = (part.caption || "").trim();
      if (caption) lines.push(caption, "");
    }
  }
  const snippet = (post.snippet || "").trim();
  if (snippet) lines.push("=".repeat(70), "MASTER PROMPT", "=".repeat(70), snippet, "");
  if (!snippet && !parts.length) lines.push("[no caption or prompt text on this post]");
  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

const OURS_RE = /^(?:image|video)\d+\.[A-Za-z0-9]+$|^prompt\.txt$/i;

async function getFolder(root, name) {
  try {
    return await root.getDirectoryHandle(name, { create: false });
  } catch (e) {
    return null;
  }
}

/* Which post a folder already holds, read back from prompt.txt's Source line.
 * Returns "" when that can't be determined. */
async function folderPostCode(dir) {
  try {
    const file = await (await dir.getFileHandle("prompt.txt", { create: false })).getFile();
    const head = (await file.slice(0, 600).text()).split("\n");
    for (const line of head) {
      if (line.startsWith("Source:")) {
        const m = /\/post\/([A-Za-z0-9_-]+)/.exec(line);
        return m ? m[1] : "";
      }
      if (!line.trim()) break;
    }
  } catch (e) {
    /* no prompt.txt, or unreadable */
  }
  return "";
}

/* One folder per post, for good.
 *
 * A post is remembered by its id, so re-saving always reuses the folder it
 * already has — even when a newer version of the extension would derive a
 * different name from its prompt. A folder left by an earlier save is adopted
 * by reading the post id back out of its prompt.txt, so upgrading doesn't
 * strand a duplicate. Only a genuinely different post gets a new folder. */
async function resolveFolderName(root, post) {
  const code = post.code || "";
  let folders = {};
  try {
    folders = await tpsGetPostFolders();
  } catch (e) {
    /* treated as empty */
  }

  const remember = async (name) => {
    if (!code) return name;
    folders[code] = name;
    await tpsSetPostFolders(folders).catch(() => {});
    return name;
  };

  const remembered = code && folders[code];
  if (remembered && (await getFolder(root, remembered))) return remembered;

  const base = sanitizeSegment(post.title, sanitizeSegment(code, "threads_post"));
  const existing = await getFolder(root, base);
  if (!existing) return remember(base);

  // Something is already there: adopt it if it holds this same post, which
  // also covers folders written before ids were tracked.
  const owner = await folderPostCode(existing);
  if (!owner || owner === code) return remember(base);

  // A different post genuinely owns that name, so keep them apart.
  const suffixed = `${base}_${sanitizeSegment(code, "post")}`;
  return remember(suffixed);
}

async function writeFile(dir, name, data) {
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function savePost(post) {
  let handle;
  try {
    handle = await tpsGetDirHandle();
  } catch (e) {
    return { ok: false, reason: "no-folder" };
  }
  if (!handle) return { ok: false, reason: "no-folder" };

  // Permission can't be requested here: that needs a user gesture, which an
  // offscreen document doesn't have. The options page re-grants it.
  let permission;
  try {
    permission = await handle.queryPermission({ mode: "readwrite" });
  } catch (e) {
    return { ok: false, reason: "no-permission" };
  }
  if (permission !== "granted") return { ok: false, reason: "no-permission" };

  let folderName;
  let dir;
  try {
    folderName = await resolveFolderName(handle, post);
    dir = await handle.getDirectoryHandle(folderName, { create: true });
  } catch (e) {
    return { ok: false, reason: "write-failed", detail: String(e && e.message) };
  }

  // Replace whatever a previous save of this post left behind. Names are
  // collected first: removing entries while iterating is unreliable.
  try {
    const stale = [];
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === "file" && OURS_RE.test(name)) stale.push(name);
    }
    for (const name of stale) {
      await dir.removeEntry(name).catch(() => {});
    }
  } catch (e) {
    /* listing is best-effort; overwriting still works */
  }

  let images = 0;
  let videos = 0;
  const failures = [];

  for (const item of post.media || []) {
    if (!item || !item.url) continue;
    const kind = item.kind === "video" ? "video" : "image";
    const n = kind === "video" ? videos + 1 : images + 1;
    try {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const blob = await res.blob();
      const name = `${kind}${n}.${extensionFor(kind, item.url, blob.type)}`;
      await writeFile(dir, name, blob);
      if (kind === "video") videos++;
      else images++;
    } catch (e) {
      failures.push(`${kind}${n}: ${(e && e.message) || e}`);
    }
  }

  try {
    await writeFile(dir, "prompt.txt", new Blob([promptText(post)], { type: "text/plain" }));
  } catch (e) {
    failures.push("prompt.txt: " + ((e && e.message) || e));
  }

  const saved = images + videos;
  if (!saved && failures.length) {
    return { ok: false, reason: "write-failed", detail: failures.slice(0, 2).join("; ") };
  }

  return {
    ok: true,
    saved,
    images,
    videos,
    folder: `${handle.name}/${folderName}`,
    failed: failures,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen" || msg.type !== "save") return;
  savePost(msg.post)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, reason: "write-failed", detail: String(e && e.message) }));
  return true;
});

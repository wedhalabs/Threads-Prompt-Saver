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

/* ---- optional prompt reconstruction ------------------------------------- *
 * Some posts publish the prompt behind them; those are captured verbatim. For
 * the ones that don't, the author's real prompt is simply not on the page and
 * cannot be recovered — so if the user has configured a vision model, each
 * image is described back into a prompt that would produce something similar.
 * That is a reconstruction, and prompt.txt says so.
 * ------------------------------------------------------------------------- */

const RECONSTRUCT_SYSTEM =
  "You look at a single image and write ONE prompt (4-7 sentences) that could be fed to an " +
  "image generator to produce a similar image: subject, composition, typography, colour " +
  "palette, lighting and overall style. Output only the prompt text — no preamble, no " +
  "markdown, no quotes.";

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function reconstructPrompt(blob, config) {
  const dataUrl = await blobToDataUrl(blob);
  const res = await fetch(config.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 2000,
      messages: [
        { role: "system", content: RECONSTRUCT_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: "Write the image-generation prompt for this image." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  return (text || "").trim();
}

async function reconstructAll(files, config) {
  const out = [];
  for (const file of files) {
    if (file.kind !== "image") continue;
    try {
      const text = await reconstructPrompt(file.blob, config);
      // Record an empty answer rather than dropping it: a silent skip is
      // indistinguishable from the feature being switched off.
      out.push({ name: file.name, text: text || "[the model returned nothing]" });
    } catch (e) {
      out.push({ name: file.name, text: `[could not reconstruct: ${(e && e.message) || e}]` });
    }
  }
  return out;
}

function promptText(post, reconstructed, visionNote) {
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

  if (reconstructed && reconstructed.length) {
    lines.push(
      "=".repeat(70),
      "RECONSTRUCTED PROMPTS",
      "=".repeat(70),
      "The author did not publish a prompt for this post. These were written by",
      "a vision model looking at each saved image — they describe how to produce",
      "a similar image, and are NOT the prompt the author actually used.",
      ""
    );
    for (const item of reconstructed) {
      lines.push("-".repeat(70), item.name, "-".repeat(70), item.text, "");
    }
  }

  if (visionNote) {
    lines.push("=".repeat(70), "NOTE", "=".repeat(70), visionNote, "");
  }

  if (!snippet && !parts.length && !(reconstructed && reconstructed.length)) {
    lines.push("[no caption or prompt text on this post]");
  }
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
 * different name from its prompt.
 *
 * Returns { name, owned }. `owned` says whether this folder is provably the
 * extension's own; only then may its old files be pruned. That matters because
 * the folder name comes from the post's text, which anyone on Threads can
 * choose: a post titled "Screenshots" must never be able to claim — and then
 * delete inside — a folder of that name the user created themselves. An
 * existing folder is adopted only when its prompt.txt names this same post. */
async function resolveFolderName(root, post) {
  const code = post.code || "";
  let folders = {};
  try {
    folders = await tpsGetPostFolders();
  } catch (e) {
    /* treated as empty */
  }

  const remember = async (name, owned) => {
    if (code) {
      folders[code] = name;
      await tpsSetPostFolders(folders).catch(() => {});
    }
    return { name, owned };
  };

  const remembered = code && folders[code];
  if (remembered && (await getFolder(root, remembered))) {
    return { name: remembered, owned: true };
  }

  const base = sanitizeSegment(post.title, sanitizeSegment(code, "threads_post"));
  const existing = await getFolder(root, base);
  // Nothing there yet, so the extension is about to create it.
  if (!existing) return remember(base, true);

  // Something is already there. Only a prompt.txt naming this exact post
  // proves it is ours; anything else — no prompt.txt, unreadable, or a
  // different post — is somebody else's folder.
  const owner = await folderPostCode(existing);
  if (owner && owner === code) return remember(base, true);

  // Not ours: use a distinct name rather than writing into it.
  const suffixed = `${base}_${sanitizeSegment(code, "post")}`;
  const suffixedExisting = await getFolder(root, suffixed);
  if (!suffixedExisting) return remember(suffixed, true);
  const suffixedOwner = await folderPostCode(suffixedExisting);
  return remember(suffixed, suffixedOwner === code);
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

  // Download everything before touching the disk. Pruning a previous save
  // first would mean a failed re-save leaves the user with less than they
  // started with, while reporting only that the save failed.
  const failures = [];
  const fetched = [];
  let images = 0;
  let videos = 0;

  for (const item of post.media || []) {
    if (!item || !item.url) continue;
    const kind = item.kind === "video" ? "video" : "image";
    // Numbered per position, not per success, so one failed download can't
    // renumber the rest on top of a previous save's files.
    const n = kind === "video" ? ++videos : ++images;
    try {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const blob = await res.blob();
      fetched.push({
        kind,
        name: `${kind}${n}.${extensionFor(kind, item.url, blob.type)}`,
        blob,
      });
    } catch (e) {
      failures.push(`${kind}${n}: ${(e && e.message) || e}`);
    }
  }

  if (!fetched.length) {
    if ((post.media || []).length) {
      // The post had media, but every download failed — a real failure.
      return {
        ok: false,
        reason: "write-failed",
        detail: failures.length
          ? failures.slice(0, 2).join("; ")
          : "nothing could be downloaded",
      };
    }
    // No media on the post at all: fine, as long as there's prompt text to
    // save instead. Otherwise there is truly nothing to write.
    const hasText =
      !!(post.snippet || "").trim() ||
      (post.parts || []).some((p) => (p.caption || "").trim());
    if (!hasText) {
      return { ok: false, reason: "write-failed", detail: "nothing to save on this post" };
    }
  }

  let folderName;
  let owned;
  let dir;
  try {
    ({ name: folderName, owned } = await resolveFolderName(handle, post));
    dir = await handle.getDirectoryHandle(folderName, { create: true });
  } catch (e) {
    return { ok: false, reason: "write-failed", detail: String(e && e.message) };
  }

  // Prune what a previous save of this post left behind — but only in a folder
  // this extension provably owns, never one that merely shares its name. Names
  // are collected first: removing entries while iterating is unreliable.
  if (owned) {
    try {
      const stale = [];
      for await (const [name, entry] of dir.entries()) {
        if (entry.kind === "file" && OURS_RE.test(name)) stale.push(name);
      }
      for (const name of stale) {
        await dir.removeEntry(name).catch(() => {});
      }
    } catch (e) {
      /* listing is best-effort; writing still overwrites */
    }
  }

  const written = [];
  for (const file of fetched) {
    try {
      await writeFile(dir, file.name, file.blob);
      written.push(file);
    } catch (e) {
      failures.push(`${file.name}: ${(e && e.message) || e}`);
    }
  }

  // Only when the post published no prompt of its own — there is nothing to
  // reconstruct otherwise, and every call costs the user money.
  let reconstructed = [];
  let visionNote = "";
  if (!(post.snippet || "").trim()) {
    let apiConfig = null;
    try {
      apiConfig = await tpsGetApiConfig();
    } catch (e) {
      /* no config stored */
    }
    if (apiConfig && apiConfig.baseUrl && apiConfig.apiKey && apiConfig.model) {
      reconstructed = await reconstructAll(written, apiConfig);
    } else if (written.some((f) => f.kind === "image")) {
      // Without this line a promptless post looks identical whether the
      // feature is off or broken, which is a miserable thing to debug.
      visionNote =
        "This post published no prompt, and no vision model is configured, so " +
        "nothing was read from the images. Set one in the extension's options.";
    }
  }

  let promptWritten = true;
  try {
    await writeFile(
      dir,
      "prompt.txt",
      new Blob([promptText(post, reconstructed, visionNote)], { type: "text/plain" })
    );
  } catch (e) {
    promptWritten = false;
    failures.push("prompt.txt: " + ((e && e.message) || e));
  }

  images = written.filter((f) => f.kind === "image").length;
  videos = written.filter((f) => f.kind === "video").length;
  const saved = images + videos;
  if (!saved && !promptWritten) {
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

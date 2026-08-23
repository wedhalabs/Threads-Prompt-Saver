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

/* ---- reading prompts printed on images ---------------------------------- *
 * Most posts publish their prompt as text, in the post or in a follow-up
 * reply, and that text is saved exactly as written without any model involved.
 *
 * Some publish it as a picture instead: a slide with the prompt printed on it.
 * Those words are the author's own but are pixels, so a configured vision
 * model copies them out verbatim.
 *
 * It only ever copies. An image with no prompt written on it yields nothing —
 * describing the picture back as an invented prompt is not wanted, and would
 * fill the file with words the author never wrote.
 * ------------------------------------------------------------------------- */

const VISION_SYSTEM =
  "You are given a single image. Your only job is to copy out prompt text that " +
  "is WRITTEN ON it — a slide, screenshot or infographic showing a prompt.\n" +
  "If such text is present, transcribe it EXACTLY as written. Preserve wording, " +
  "line breaks and punctuation. Do not summarise, translate, correct or improve " +
  "it. Ignore surrounding labels such as a heading that only reads \"Prompt:\".\n" +
  "If no prompt is written on the image, say so. Never invent a prompt, and never " +
  "describe the picture — a description is not wanted and will be discarded.\n" +
  "Reply with JSON only, no markdown fence: " +
  '{"kind":"transcribed","text":"..."} or {"kind":"none","text":""}';

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/* Threads serves WebP, which plenty of endpoints quietly ignore rather than
 * reject — the request succeeds and the model answers as though no image came,
 * which is maddening to diagnose. Re-encode to JPEG, which everything reads,
 * and cap the long edge: a 4000px carousel slide costs a fortune in tokens for
 * detail no model needs to read the words off it. */
const VISION_MAX_EDGE = 1568;

async function toJpegDataUrl(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    return blobToDataUrl(blob);   // not decodable here; let the endpoint try
  }

  const scale = Math.min(1, VISION_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const ctx = canvas.getContext("2d");
  // JPEG has no alpha; without this, transparent areas turn black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return canvas.toDataURL("image/jpeg", 0.92);
}

async function readPromptFrom(blob, config) {
  const dataUrl = await toJpegDataUrl(blob);
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
        { role: "system", content: VISION_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: "Copy out the prompt written on this image, if there is one." },
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

  const { parseVisionReply } = await import("./vision-util.js");
  return parseVisionReply(text);
}

/* Returns what was found, plus enough about what wasn't to explain an empty
 * result. "No prompt on these images" and "the gateway never delivered them"
 * produce the same silence otherwise, and only one of them is fine. */
async function readAllPrompts(files, config) {
  const found = [];
  const problems = [];
  let looked = 0;
  let undelivered = 0;

  for (const file of files) {
    if (file.kind !== "image") continue;
    looked++;
    try {
      const reply = await readPromptFrom(file.blob, config);
      if (reply.kind === "transcribed") {
        found.push({ name: file.name, text: reply.text });
      } else if (/no image|don.?t see|attach|upload/i.test(reply.raw || "")) {
        undelivered++;
      }
    } catch (e) {
      problems.push(`${file.name}: ${(e && e.message) || e}`);
    }
  }
  return { found, problems, looked, undelivered };
}

function promptText(post, transcribedPrompts, visionNote) {
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

  // Only words the author actually wrote reach this file. Nothing here is a
  // guess, so nothing needs a disclaimer saying it might be one.
  const transcribed = transcribedPrompts || [];
  if (transcribed.length) {
    lines.push(
      "=".repeat(70),
      "PROMPTS READ FROM THE IMAGES",
      "=".repeat(70),
      "This post published its prompt as a picture rather than as text. A vision",
      "model copied out the words printed on each image, so this IS the author's",
      "own prompt — check it against the image if the wording looks odd.",
      ""
    );
    for (const item of transcribed) {
      lines.push("-".repeat(70), item.name, "-".repeat(70), item.text, "");
    }
  }

  if (visionNote) {
    lines.push("=".repeat(70), "NOTE", "=".repeat(70), visionNote, "");
  }

  if (!snippet && !parts.length && !(transcribedPrompts && transcribedPrompts.length)) {
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
  // read otherwise, and every call costs the user money.
  // Only when the post published no prompt of its own — whether as a structured
  // attachment or as plain text in the post or a reply. Guessing at a prompt
  // that is already saved above costs money and reads worse than the original.
  let transcribedPrompts = [];
  let visionNote = "";
  let alreadyHasPrompt = true;
  try {
    const { postCarriesPrompt } = await import("./vision-util.js");
    alreadyHasPrompt = postCarriesPrompt(post);
  } catch (e) {
    alreadyHasPrompt = Boolean((post.snippet || "").trim());
  }

  if (!alreadyHasPrompt) {
    let apiConfig = null;
    try {
      apiConfig = await tpsGetApiConfig();
    } catch (e) {
      /* no config stored */
    }
    if (apiConfig && apiConfig.baseUrl && apiConfig.apiKey && apiConfig.model) {
      const result = await readAllPrompts(written, apiConfig);
      transcribedPrompts = result.found;

      if (!result.found.length && result.looked) {
        if (result.undelivered) {
          // The failure that wasted an afternoon once: a route that answers
          // cheerfully while never passing the picture along.
          visionNote =
            `The vision model never received ${result.undelivered} of ${result.looked} ` +
            "image(s) — it replied asking for one. The endpoint is not forwarding " +
            "images. Open the extension's options and press \"Find one that works\".";
        } else {
          visionNote =
            `No prompt text is written on ${result.looked === 1 ? "this image" : "these images"}, ` +
            "so nothing was copied out. The post's own words are above.";
        }
      }
      if (result.problems.length) {
        visionNote += (visionNote ? "\n\n" : "") +
          "Some images could not be read: " + result.problems.slice(0, 3).join("; ");
      }
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
      // Leading BOM: prompts are full of typographic dashes and curly quotes,
      // and Windows editors render UTF-8 as mojibake unless told what it is.
      new Blob(["﻿" + promptText(post, transcribedPrompts, visionNote)],
               { type: "text/plain;charset=utf-8" })
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

  // A directory handle knows its name and nothing more, so the full path can
  // only come from what the user told us once in the options page.
  let fullPath = "";
  try {
    const root = await tpsGetFolderPath();
    const { joinFolderPath } = await import("./path-util.js");
    fullPath = joinFolderPath(root, folderName);
  } catch (e) {
    /* no path configured, or the module failed to load: the button stays hidden */
  }

  return {
    ok: true,
    saved,
    images,
    videos,
    folder: `${handle.name}/${folderName}`,
    // The bare name too: the page that shows what was saved looks the folder up
    // by it, and cannot use the display string above.
    folderName,
    fullPath,
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

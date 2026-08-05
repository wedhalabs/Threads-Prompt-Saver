/*
 * content.js
 *
 * Adds the extension's buttons to Threads post pages: "Save post", which
 * extracts the post (see extract.js) and hands it to the background worker to
 * write to disk, and "Copy AI request", which prepares a message to paste into
 * whichever AI assistant you already pay for.
 */

(function () {
  "use strict";

  const BTN_ID = "tps-save-btn";
  const SAVE_BTN = "tps-do-save";
  const COPY_BTN = "tps-do-copy";
  const POST_URL_RE = /threads\.(?:com|net)\/@[^/]+\/post\/[A-Za-z0-9_-]+/;

  /* Where the last save put its files, so the copy button can point at the
   * folder to drag images from. A clipboard write can hold one item, so the
   * images themselves can't ride along with the text. */
  let lastSave = null;

  function onPostPage() {
    return POST_URL_RE.test(location.href);
  }

  function ensureStyles() {
    if (document.getElementById("tps-style")) return;
    const style = document.createElement("style");
    style.id = "tps-style";
    style.textContent = `
      /* Top-right, just below the browser toolbar so it sits under the
         extensions area and clear of Threads' own header. */
      #${BTN_ID} {
        position: fixed; right: 20px; top: 16px; z-index: 2147483647;
        display: flex; flex-direction: column; gap: 6px; align-items: flex-end;
        font: 500 13px/1.3 -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      #${BTN_ID} button {
        background: #6c8cff; color: #0c0f16; border: 0; border-radius: 999px;
        padding: 11px 18px; font-weight: 700; font-size: 13px; cursor: pointer;
        box-shadow: 0 4px 14px rgba(0,0,0,.35);
      }
      #${BTN_ID} button:hover { background: #8aa2ff; }
      #${BTN_ID} button:disabled { opacity: .6; cursor: not-allowed; }
      /* Secondary action: same shape, quieter, so "Save post" stays the
         obvious one. */
      #${COPY_BTN} {
        background: #262b36 !important; color: #e7e9ee !important;
        font-weight: 600 !important;
      }
      #${COPY_BTN}:hover { background: #333a49 !important; }
      #tps-status {
        max-width: 320px; padding: 9px 12px; border-radius: 10px;
        background: #171a21; color: #e7e9ee; border: 1px solid #2a2e38;
        white-space: pre-wrap; word-break: break-word; display: none;
      }
      #tps-status.show { display: block; }
      #tps-status.ok { border-color: #2f7d55; color: #7ee2af; }
      #tps-status.err { border-color: #7d2f2f; color: #ff9b9b; }
      #tps-open-options {
        display: block; margin-top: 9px; padding: 6px 12px; border-radius: 8px;
        background: transparent; color: #e7e9ee; border: 1px solid #3a3f4b;
        font-size: 12.5px; font-weight: 600; cursor: pointer;
      }
      #tps-open-options:hover { border-color: #6c8cff; }
    `;
    document.documentElement.appendChild(style);
  }

  function setStatus(text, kind, withOptions) {
    const el = document.getElementById("tps-status");
    if (!el) return;
    el.textContent = text;
    el.className = "show" + (kind ? " " + kind : "");
    if (withOptions) {
      const link = document.createElement("button");
      link.type = "button";
      link.id = "tps-open-options";
      link.textContent = "Open options";
      link.addEventListener("click", () =>
        chrome.runtime.sendMessage({ type: "open-options" })
      );
      el.appendChild(link);
    }
  }

  /* The message to paste into an AI assistant alongside the saved images.
   * Asks for a usable prompt rather than a description, and says plainly that
   * the result is a reconstruction — the author's own prompt isn't published
   * anywhere on the page, so nothing can recover it. */
  function buildRequest(post, imageCount) {
    const caption = (post.parts || [])
      .map((p) => (p.caption || "").trim())
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 1200);

    const files = imageCount === 1 ? "image1" : `image1 … image${imageCount}`;

    return [
      `I'm attaching ${imageCount} image${imageCount === 1 ? "" : "s"} from a social media post (${files}).`,
      "The author didn't publish the prompt they used, so I want to work out how these were made.",
      "",
      "For each image, write the image-generation prompt that would recreate something like it.",
      "Cover: subject, composition and layout, typography and text placement, colour palette,",
      "lighting, rendering style, and aspect ratio. Write it as a prompt to feed an image",
      "generator — not as a description of what you see.",
      "",
      "If the images share a template or house style, describe that once as a reusable base",
      "prompt, then give the per-image variations.",
      "",
      "Number each prompt to match the image order.",
      "",
      "--- context from the post ---",
      `Source: ${post.url || location.href.split("?")[0]}`,
      post.author ? `Author: @${post.author}` : null,
      caption ? `\nCaption:\n${caption}` : null,
    ]
      // Only the optional lines above drop out; the empty strings are
      // deliberate paragraph breaks.
      .filter((line) => line !== null)
      .join("\n");
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Clipboard API can be refused when the page isn't focused; fall back to
      // the old selection-based copy, which works from a click handler.
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
        document.documentElement.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
      } catch (err) {
        return false;
      }
    }
  }

  async function copyRequest() {
    const btn = document.getElementById(COPY_BTN);
    if (btn) btn.disabled = true;
    try {
      const result = window.__threadsPromptSaver.extractPost();
      if (!result.ok) throw new Error(result.error);

      const post = result.post;
      const images = (post.media || []).filter((m) => m.kind === "image").length;
      if (!images) throw new Error("This post has no images to analyse.");

      const published = (post.snippet || "").trim();
      const ok = await copyText(buildRequest(post, images));
      if (!ok) throw new Error("Chrome wouldn't let the page write to the clipboard.");

      // Only the text is on the clipboard — a clipboard write holds a single
      // item, so the images have to be dragged in from the saved folder.
      const saved = lastSave && lastSave.code === post.code ? lastSave : null;
      const where = saved
        ? `\n\nThen drag in the ${saved.images} image(s) from:\n${saved.folder}`
        : "\n\nThen drag in the post's images — click Save post first if you haven't.";

      setStatus(
        (published
          ? "Copied — though this post already publishes its own prompt, saved in prompt.txt, " +
            "so you probably don't need this.\n\nPaste the text into your AI assistant."
          : "Copied. Paste the text into your AI assistant.") + where,
        "ok"
      );
    } catch (e) {
      setStatus("Failed: " + String((e && e.message) || e), "err");
    } finally {
      const current = document.getElementById(COPY_BTN);
      if (current) current.disabled = false;
    }
  }

  async function save() {
    const btn = document.getElementById(SAVE_BTN);
    btn.disabled = true;
    setStatus("Reading this post…");

    // Threads is a single-page app, so the user can navigate to another post
    // while this save runs. Report only if they're still on the post we saved,
    // otherwise the result would appear to belong to whatever is on screen now.
    const savingUrl = location.href;
    const stillHere = () => location.href === savingUrl;

    try {
      const result = window.__threadsPromptSaver.extractPost();
      if (!result.ok) throw new Error(result.error);

      const { media, title, code } = result.post;
      const imgs = media.filter((m) => m.kind === "image").length;
      const vids = media.filter((m) => m.kind === "video").length;
      if (!media.length) throw new Error("No images or videos found on this post.");

      setStatus(`Found ${imgs} image(s), ${vids} video(s). Downloading…`);

      const reply = await chrome.runtime.sendMessage({ type: "save", post: result.post });
      if (!stillHere()) return;
      if (!reply) throw new Error("No response from the extension worker.");
      if (!reply.ok) {
        setStatus(reply.error || "Save failed.", "err", reply.needsSetup);
        return;
      }

      lastSave = { code: result.post.code, folder: reply.folder, images: reply.images };

      const counts = `${reply.images} image(s), ${reply.videos} video(s)`;
      const partial = reply.failed && reply.failed.length
        ? `\n${reply.failed.length} file(s) failed.`
        : "";
      setStatus(`Saved ${counts} to:\n${reply.folder}${partial}`, "ok");
    } catch (e) {
      if (!stillHere()) return;
      const msg = String(e && e.message ? e.message : e);
      setStatus("Failed: " + msg, "err");
    } finally {
      // The button may have been torn down and rebuilt by navigation.
      const current = document.getElementById(SAVE_BTN);
      if (current) current.disabled = false;
    }
  }

  function mount() {
    if (!onPostPage()) {
      const old = document.getElementById(BTN_ID);
      if (old) old.remove();
      return;
    }
    if (document.getElementById(BTN_ID)) return;

    ensureStyles();
    const wrap = document.createElement("div");
    wrap.id = BTN_ID;
    wrap.innerHTML =
      `<button type="button" id="${SAVE_BTN}">Save post</button>` +
      `<button type="button" id="${COPY_BTN}">Copy AI request</button>` +
      `<div id="tps-status"></div>`;
    wrap.querySelector(`#${SAVE_BTN}`).addEventListener("click", save);
    wrap.querySelector(`#${COPY_BTN}`).addEventListener("click", copyRequest);
    document.documentElement.appendChild(wrap);
  }

  mount();

  // Threads is a single-page app: re-check when the URL changes.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const el = document.getElementById("tps-status");
      if (el) el.className = "";
      mount();
    }
  }, 800);
})();

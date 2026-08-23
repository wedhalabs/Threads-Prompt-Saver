/*
 * content.js
 *
 * Adds a "Save post" button to Threads post pages. On click it extracts the
 * post (see extract.js) and hands it to the background worker, which writes
 * the media and prompt text to disk.
 */

(function () {
  "use strict";

  const BTN_ID = "tps-save-btn";
  const SAVE_BTN = "tps-do-save";
  const POST_URL_RE = /threads\.(?:com|net)\/@[^/]+\/post\/[A-Za-z0-9_-]+/;

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

  /* No extension can open a folder in the file manager, so the next best thing
   * is handing over the path: paste it into the address bar and you are there.
   * Only offered when the user has told the options page where the folder is. */
  function addCopyPath(fullPath) {
    const el = document.getElementById("tps-status");
    if (!el || !fullPath) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "tps-open-options";
    btn.textContent = "Copy path";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(fullPath);
        btn.textContent = "Copied — paste in your file manager";
      } catch (e) {
        // Clipboard can be blocked; showing the path still lets them copy it.
        btn.textContent = fullPath;
      }
    });
    el.appendChild(btn);
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

      setStatus(
        media.length
          ? `Found ${imgs} image(s), ${vids} video(s). Downloading…`
          : "No images or videos on this post. Saving prompt text…"
      );

      const reply = await chrome.runtime.sendMessage({ type: "save", post: result.post });
      if (!stillHere()) return;
      if (!reply) throw new Error("No response from the extension worker.");
      if (!reply.ok) {
        setStatus(reply.error || "Save failed.", "err", reply.needsSetup);
        return;
      }

      const counts = reply.images || reply.videos
        ? `${reply.images} image(s), ${reply.videos} video(s)`
        : "prompt text";
      const partial = reply.failed && reply.failed.length
        ? `\n${reply.failed.length} file(s) failed.`
        : "";
      setStatus(`Saved ${counts} to:\n${reply.folder}${partial}`, "ok");
      addCopyPath(reply.fullPath);
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
      `<div id="tps-status"></div>`;
    wrap.querySelector(`#${SAVE_BTN}`).addEventListener("click", save);
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

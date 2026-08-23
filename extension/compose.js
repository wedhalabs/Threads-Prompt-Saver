/*
 * compose.js
 *
 * Puts a segment into the Threads composer and waits. It never presses Post —
 * the author does. Threads ships DOM changes without notice, so every selector
 * lives in SELECTORS below; a break should be a one-line fix.
 *
 * The tab always speaks first. Messaging a tab from the extension would need a
 * host permission for it, while a content script may message the extension
 * without one, so this asks for work rather than being handed it.
 */

(function () {
  "use strict";

  const SELECTORS = {
    editor: 'div[contenteditable="true"][role="textbox"]',
    postUrl: 'a[href*="/post/"]',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(selector, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(150);
    }
    return null;
  }

  /* React ignores textContent assignment, so type through the paste path the
   * editor does listen to. */
  function setEditorText(editor, text) {
    editor.focus();
    const data = new DataTransfer();
    data.setData("text/plain", text);
    editor.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData: data, bubbles: true, cancelable: true,
    }));
  }

  async function fill(text) {
    const editor = await waitFor(SELECTORS.editor, 8000);
    if (!editor) return { ok: false, error: "Could not find the Threads composer" };
    setEditorText(editor, text);
    watchForPost();
    return { ok: true, error: null };
  }

  /* Best-effort: when the composer closes, look for the post it produced. */
  function watchForPost() {
    const started = Date.now();
    const observer = new MutationObserver(() => {
      if (document.querySelector(SELECTORS.editor)) return;   // still composing
      const link = document.querySelector(SELECTORS.postUrl);
      if (link && Date.now() - started > 1000) {
        observer.disconnect();
        chrome.runtime.sendMessage({ type: "tps-posted", url: link.href });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 300000);
  }

  function askForWork() {
    chrome.runtime.sendMessage({ type: "tps-ready" }, (reply) => {
      if (chrome.runtime.lastError) return;          // no dashboard listening
      if (reply && reply.text) fill(reply.text);
    });
  }

  askForWork();
  /* After the author posts and Threads navigates, ask again for the next reply. */
  window.addEventListener("tps-ask-again", askForWork);
})();

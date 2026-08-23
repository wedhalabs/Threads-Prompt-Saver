/*
 * background.js
 *
 * Hands an extracted post to the offscreen document, which writes it into the
 * folder chosen with Browse. The writing lives there because the File System
 * Access API needs a document context, which a service worker doesn't have.
 *
 * Chrome only keeps a folder's write permission for the browser session, so
 * saving reports what to do rather than quietly saving somewhere else.
 */

const SETUP_MESSAGE = {
  "no-folder": "No save folder chosen yet. Open the extension's options and click Browse to pick one.",
  "no-permission":
    "Chrome has forgotten permission for your save folder — it asks again after each restart. " +
    "Open the extension's options and click Re-allow.",
  unsupported:
    "This Chrome version can't write to a chosen folder. " +
    "Chrome 109 or newer is required.",
};

/* Which tab to return to is carried in the options URL rather than in a Map
 * here: this worker can be evicted while the user is picking a folder, and
 * module state would not survive that. */
async function openSetup(returnTabId, welcome) {
  const params = `${welcome ? "welcome" : "setup"}=1` +
    (returnTabId != null ? `&back=${returnTabId}` : "");
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?${params}`) });
  } catch (e) {
    chrome.runtime.openOptionsPage();
  }
}

/* Walk the user straight to picking a save folder, since nothing can be saved
 * until they have. */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") openSetup(null, true);
});

async function finishSetup(optionsTabId, backTabId) {
  const back = Number(backTabId);
  if (Number.isInteger(back) && back >= 0) {
    try {
      await chrome.tabs.update(back, { active: true });
    } catch (e) {
      /* the original tab may be gone */
    }
  }
  if (optionsTabId != null) {
    try {
      await chrome.tabs.remove(optionsTabId);
    } catch (e) {
      /* already closed */
    }
  }
}

async function hasOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    try {
      return await chrome.offscreen.hasDocument();
    } catch (e) {
      /* fall through to the context check below */
    }
  }
  // getContexts is no older than hasDocument, so on the Chrome versions where
  // that probe is missing this one is too. Report "no document" rather than
  // throwing, which would stop the caller from ever creating one.
  if (!chrome.runtime.getContexts) return false;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return contexts.length > 0;
  } catch (e) {
    return false;
  }
}

async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  try {
    if (await hasOffscreen()) return true;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Write saved posts into the folder you chose.",
    });
    return true;
  } catch (e) {
    // A concurrent save may have created it first.
    return hasOffscreen().catch(() => false);
  }
}

async function savePost(post) {
  if (!(await ensureOffscreen())) {
    return { ok: false, error: SETUP_MESSAGE.unsupported, needsSetup: true };
  }

  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ target: "offscreen", type: "save", post });
  } catch (e) {
    return { ok: false, error: "The extension's writer didn't respond. Try reloading the extension." };
  }

  if (reply && reply.ok) return reply;

  const reason = (reply && reply.reason) || "unsupported";
  if (SETUP_MESSAGE[reason]) {
    return { ok: false, error: SETUP_MESSAGE[reason], needsSetup: true };
  }
  return {
    ok: false,
    error: "Couldn't write to your save folder." + (reply && reply.detail ? ` (${reply.detail})` : ""),
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "open-options") {
    openSetup(sender.tab && sender.tab.id, false);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "setup-done") {
    finishSetup(sender.tab && sender.tab.id, msg.back);
    sendResponse({ ok: true });
    return;
  }

  /* Show what a save produced. Chrome never reveals where the chosen folder is,
   * so the extension reads the files back and displays them instead. */
  if (msg.type === "open-saved") {
    chrome.tabs.create({
      url: chrome.runtime.getURL("saved.html") +
           "?folder=" + encodeURIComponent(msg.folder || ""),
    });
    sendResponse({ ok: true });
    return;
  }

  // Anything addressed to the offscreen document is not ours to handle.
  if (msg.target === "offscreen" || msg.type !== "save") return;

  savePost(msg.post)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // keep the channel open for the async reply
});

/* The poster dashboard. Opening a tab needs no permission; reading its URL
 * would, so we never do. */
function openPoster(threadId) {
  const base = chrome.runtime.getURL("poster.html");
  chrome.tabs.create({ url: threadId ? `${base}?thread=${encodeURIComponent(threadId)}` : base });
}

chrome.action.onClicked.addListener(() => openPoster(null));

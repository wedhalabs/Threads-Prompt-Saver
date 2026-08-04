/* Options page: picks the folder that saved posts are written into. */

const $ = (id) => document.getElementById(id);

/* Opened automatically — on install, or from the Save button when permission
 * lapsed — so once a folder is usable we hand the user back to what they were
 * doing rather than leaving a stray tab. */
const PARAMS = new URLSearchParams(location.search);
const GUIDED = PARAMS.has("welcome") || PARAMS.has("setup");

async function finishIfGuided() {
  if (!GUIDED) return;
  flash("All set — taking you back…");
  setTimeout(
    () => chrome.runtime.sendMessage({ type: "setup-done", back: PARAMS.get("back") }),
    900
  );
}

function flash(text) {
  const el = $("status");
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1600);
}

/* Show the chosen folder and whether Chrome still lets us write to it. */
async function refreshFolder() {
  let handle = null;
  try {
    handle = await tpsGetDirHandle();
  } catch (e) {
    /* treated as "none chosen" below */
  }

  if (!handle) {
    $("chosen").textContent = "No folder chosen";
    $("chosen").className = "muted";
    $("regrant").classList.remove("show");
    $("forget").style.display = "none";
    return;
  }

  $("chosen").textContent = handle.name;
  $("chosen").className = "folder-name";
  $("forget").style.display = "";

  let permission = "prompt";
  try {
    permission = await handle.queryPermission({ mode: "readwrite" });
  } catch (e) {
    /* leave as prompt */
  }
  $("regrant").classList.toggle("show", permission !== "granted");
}

$("browse").addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    flash("This Chrome version can't pick folders.");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "tps-save-dir" });
    await tpsSetDirHandle(handle);
    await refreshFolder();
    // Picking implies permission, so setup is complete.
    if (GUIDED) await finishIfGuided();
    else flash("Folder set.");
  } catch (e) {
    if (e && e.name === "AbortError") return; // user closed the picker
    flash("Couldn't set that folder.");
  }
});

$("reallow").addEventListener("click", async () => {
  try {
    const handle = await tpsGetDirHandle();
    if (!handle) return;
    const permission = await handle.requestPermission({ mode: "readwrite" });
    await refreshFolder();
    if (permission === "granted" && GUIDED) await finishIfGuided();
    else flash(permission === "granted" ? "Folder re-allowed." : "Still not allowed.");
  } catch (e) {
    flash("Couldn't re-allow that folder.");
  }
});

$("forget").addEventListener("click", async () => {
  await tpsClearDirHandle().catch(() => {});
  await refreshFolder();
  flash("Folder cleared.");
});

/* ---- optional prompt reconstruction settings ----------------------------- */

function apiFlash(text, ok) {
  const el = $("apiStatus");
  el.textContent = text;
  el.style.color = ok === false ? "#c0392b" : "";
  setTimeout(() => { el.textContent = ""; }, 3000);
}

function originOf(url) {
  try {
    return new URL(url).origin + "/*";
  } catch (e) {
    return null;
  }
}

async function refreshApi() {
  let config = { baseUrl: "", apiKey: "", model: "" };
  try {
    config = await tpsGetApiConfig();
  } catch (e) {
    /* leave blank */
  }
  $("apiBase").value = config.baseUrl || "";
  $("apiModel").value = config.model || "";
  // Only ever indicate that a key exists; never render it back into the page.
  $("apiKey").value = "";
  $("apiKey").placeholder = config.apiKey ? "•••••••• (saved)" : "sk-…";
}

$("saveApi").addEventListener("click", async () => {
  const baseUrl = $("apiBase").value.trim();
  const model = $("apiModel").value.trim();
  const typedKey = $("apiKey").value.trim();

  let existing = { apiKey: "" };
  try {
    existing = await tpsGetApiConfig();
  } catch (e) {
    /* none yet */
  }
  const apiKey = typedKey || existing.apiKey || "";

  if (!baseUrl && !apiKey && !model) {
    await tpsSetApiConfig({ baseUrl: "", apiKey: "", model: "" }).catch(() => {});
    await refreshApi();
    apiFlash("Cleared.");
    return;
  }
  if (!baseUrl || !apiKey || !model) {
    apiFlash("Need all three: URL, key and model.", false);
    return;
  }

  const origin = originOf(baseUrl);
  if (!origin) {
    apiFlash("That URL doesn't look right.", false);
    return;
  }

  // Ask for access to just this endpoint, on this click, rather than shipping a
  // broad host permission everyone has to accept at install.
  let granted = true;
  try {
    granted = await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    granted = false;
  }
  if (!granted) {
    apiFlash("Chrome denied access to that endpoint.", false);
    return;
  }

  await tpsSetApiConfig({ baseUrl, apiKey, model });
  await refreshApi();
  apiFlash("Saved.");
});

$("clearApi").addEventListener("click", async () => {
  await tpsSetApiConfig({ baseUrl: "", apiKey: "", model: "" }).catch(() => {});
  $("apiBase").value = "";
  $("apiModel").value = "";
  await refreshApi();
  apiFlash("Cleared.");
});

if (PARAMS.has("welcome")) $("welcome").classList.add("show");
if (PARAMS.has("setup")) $("setup").classList.add("show");
refreshFolder();
refreshApi();

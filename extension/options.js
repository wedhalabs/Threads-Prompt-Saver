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

/* ---- picking and proving the vision model -------------------------------- *
 * Typing a model id by hand gave no feedback until a post was saved and the
 * txt file inspected — a wrong id or an endpoint that can't take images looked
 * exactly like a working setup. So the list is fetched, and a test button
 * sends a real image through the same request shape the saver uses.
 * ------------------------------------------------------------------------- */

const TEST_PHRASE = "VISION-OK-7431";

/* Sticky status: a test result is worth reading, unlike a "Saved." flash. */
function apiSay(text, ok) {
  const el = $("apiStatus");
  el.textContent = text;
  el.style.color = ok === false ? "#c0392b" : ok === true ? "#1e8449" : "";
}

async function currentKey() {
  const typed = $("apiKey").value.trim();
  if (typed) return typed;
  try {
    return (await tpsGetApiConfig()).apiKey || "";
  } catch (e) {
    return "";
  }
}

/* Ask for this endpoint only, on this click. A local OmniRoute is http, which
 * is why the manifest also offers localhost as an optional origin. */
async function ensureOrigin(baseUrl) {
  const origin = originOf(baseUrl);
  if (!origin) { apiSay("That URL doesn't look right.", false); return false; }
  try {
    if (await chrome.permissions.request({ origins: [origin] })) return true;
  } catch (e) {
    /* falls through to the message below */
  }
  apiSay(`Chrome denied access to ${origin}.`, false);
  return false;
}

/* Endpoints that front many providers can list hundreds of models, and a
 * hundreds-long dropdown is no more usable than the free-text box it replaced.
 * So: hide the ones that can't read images, put the strong readers on top,
 * group the rest by provider, and let a filter box do the real work. */

/* Families that reliably read text out of a picture, best first. Matched as
 * substrings because every gateway prefixes ids differently. */
const GOOD_READERS = ["gemini", "sonnet", "opus", "gpt-5", "gpt-4o", "qwen", "glm"];

function readerRank(id) {
  const i = GOOD_READERS.findIndex((name) => id.toLowerCase().includes(name));
  return i < 0 ? GOOD_READERS.length : i;
}

function providerOf(id) {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "other";
}

function optionFor(m) {
  const mark = m.vision === true ? " ✔" : m.vision === null ? " (untested)" : " ✖ text only";
  const label = String(m.id + mark).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<option value="${m.id}">${label}</option>`;
}

function renderModels(models) {
  const showAll = $("showAllModels").checked;
  const query = $("modelFilter").value.trim().toLowerCase();
  const select = $("apiModelSelect");

  const usable = models
    .filter((m) => showAll || m.vision !== false)
    .filter((m) => !query || m.id.toLowerCase().includes(query));

  // A short, opinionated list first, so the common case is one click.
  const suggested = usable
    .filter((m) => m.vision === true && readerRank(m.id) < GOOD_READERS.length)
    .sort((a, b) => readerRank(a.id) - readerRank(b.id) || a.id.localeCompare(b.id))
    .slice(0, 8);

  const suggestedIds = new Set(suggested.map((m) => m.id));
  const byProvider = new Map();
  usable.forEach((m) => {
    if (suggestedIds.has(m.id)) return;
    const key = providerOf(m.id);
    if (!byProvider.has(key)) byProvider.set(key, []);
    byProvider.get(key).push(m);
  });

  let html = `<option value="">— ${usable.length} model(s) —</option>`;
  if (suggested.length) {
    html += `<optgroup label="Good at reading text in images">` +
      suggested.map(optionFor).join("") + `</optgroup>`;
  }
  Array.from(byProvider.keys()).sort().forEach((key) => {
    html += `<optgroup label="${key} (${byProvider.get(key).length})">` +
      byProvider.get(key).map(optionFor).join("") + `</optgroup>`;
  });

  select.innerHTML = html;
  select.size = usable.length > 12 ? 12 : 0;
  select.style.display = "";
  $("modelFilterWrap").style.display = "";
  $("showAllWrap").style.display = "";
}

let fetchedModels = [];

$("fetchModels").addEventListener("click", async () => {
  const baseUrl = $("apiBase").value.trim();
  const apiKey = await currentKey();
  if (!baseUrl || !apiKey) { apiSay("Need the URL and key first.", false); return; }
  if (!(await ensureOrigin(baseUrl))) return;

  apiSay("Fetching models…");
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, "") + "/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) { apiSay(`Endpoint answered HTTP ${res.status}.`, false); return; }

    const { parseModelList } = await import("./vision-util.js");
    const { models, error } = parseModelList(await res.json());
    if (error) { apiSay(error, false); return; }

    fetchedModels = models;
    renderModels(models);
    const seeing = models.filter((m) => m.vision === true).length;
    apiSay(`Found ${models.length} model(s)` + (seeing ? `, ${seeing} that read images.` : "."), true);
  } catch (e) {
    apiSay("Could not reach that endpoint: " + ((e && e.message) || e), false);
  }
});

$("showAllModels").addEventListener("change", () => renderModels(fetchedModels));
$("modelFilter").addEventListener("input", () => renderModels(fetchedModels));

$("apiModelSelect").addEventListener("change", (e) => {
  if (e.target.value) $("apiModel").value = e.target.value;
});

/* Draw the test image here rather than shipping one: it keeps the extension
 * asset-free and proves the exact path the saver uses — including whether the
 * endpoint accepts a base64 data URL, which many bridges do not. */
function testImageDataUrl() {
  const canvas = document.createElement("canvas");
  canvas.width = 420;
  canvas.height = 140;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  ctx.font = "bold 44px sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(TEST_PHRASE, 24, 70);
  // JPEG, matching what the saver sends, so a passing test means a passing save.
  return canvas.toDataURL("image/jpeg", 0.92);
}

$("testApi").addEventListener("click", async () => {
  const baseUrl = $("apiBase").value.trim();
  const model = $("apiModel").value.trim();
  const apiKey = await currentKey();
  if (!baseUrl || !apiKey || !model) { apiSay("Need all three: URL, key and model.", false); return; }
  if (!(await ensureOrigin(baseUrl))) return;

  apiSay(`Testing ${model}…`);
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 100,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Reply with only the text written in this image." },
            { type: "image_url", image_url: { url: testImageDataUrl() } },
          ],
        }],
      }),
    });

    const body = await res.text();
    if (!res.ok) {
      apiSay(`HTTP ${res.status}. ${body.slice(0, 200)}`, false);
      return;
    }

    let reply = "";
    try {
      const data = JSON.parse(body);
      reply = (data.choices && data.choices[0] && data.choices[0].message
        && data.choices[0].message.content) || "";
    } catch (e) {
      apiSay("Endpoint returned something that isn't JSON.", false);
      return;
    }

    if (String(reply).toUpperCase().includes(TEST_PHRASE)) {
      apiSay(`${model} read the test image. Vision works.`, true);
    } else if (!String(reply).trim()) {
      apiSay(`${model} answered with nothing — it likely ignored the image.`, false);
    } else {
      apiSay(`${model} saw the image but read "${String(reply).trim().slice(0, 60)}" ` +
             `instead of ${TEST_PHRASE}. Text may be too small for it, or it ignored the image.`, false);
    }
  } catch (e) {
    apiSay("Request failed: " + ((e && e.message) || e), false);
  }
});

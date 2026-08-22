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

/* Image editors take an image in, so they advertise image input and look like
 * vision models in a /models listing — but they answer with a picture, not
 * words, and are served by a different endpoint than chat/completions. Picking
 * one produces a baffling failure, so keep them out of a chat model picker. */
const IMAGE_MAKERS = [
  "flux", "dall-e", "dalle", "gpt-image", "stable-diffusion", "sdxl", "imagen",
  "midjourney", "ideogram", "recraft", "seedream", "seededit", "qwen-image",
  "nano-banana", "kolors", "playground", "kling", "veo", "sora", "runway",
  "luma", "pika", "wan-", "hailuo", "-video", "-tts", "-image",
];

function isImageMaker(id) {
  const low = id.toLowerCase();
  return IMAGE_MAKERS.some((name) => low.includes(name));
}

function readerRank(id) {
  const i = GOOD_READERS.findIndex((name) => id.toLowerCase().includes(name));
  return i < 0 ? GOOD_READERS.length : i;
}

function providerOf(id) {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "other";
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function rowFor(m, chosen) {
  const mark = m.vision === true ? " ✔" : m.vision === null ? " (untested)" : " ✖ text only";
  return `<button type="button" class="m" data-model="${escapeHtml(m.id)}"` +
         `${m.id === chosen ? ' aria-selected="true"' : ""}>` +
         `${escapeHtml(m.id + mark)}</button>`;
}

function renderModels(models) {
  const showAll = $("showAllModels").checked;
  const query = $("modelFilter").value.trim().toLowerCase();
  const list = $("apiModelList");
  const chosen = $("apiModel").value.trim();

  const usable = models
    .filter((m) => showAll || (m.vision !== false && !isImageMaker(m.id)))
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

  let html = "";
  if (suggested.length) {
    html += `<div class="grp">Good at reading text in images</div>` +
      suggested.map((m) => rowFor(m, chosen)).join("");
  }
  Array.from(byProvider.keys()).sort().forEach((key) => {
    html += `<div class="grp">${escapeHtml(key)} (${byProvider.get(key).length})</div>` +
      byProvider.get(key).map((m) => rowFor(m, chosen)).join("");
  });
  if (!usable.length) html = `<div class="none">Nothing matches that filter.</div>`;

  list.innerHTML = html;
  list.style.display = "";
  // Selecting must not collapse the list — comparing models means clicking
  // several in a row, and a <select> closed after every one of them.
  list.querySelectorAll("button.m").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("apiModel").value = btn.dataset.model;
      list.querySelectorAll("button.m").forEach((b) => b.removeAttribute("aria-selected"));
      btn.setAttribute("aria-selected", "true");
      apiSay(`Picked ${btn.dataset.model}. Press Test vision, or Save.`);
    });
  });

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

/* One attempt. Returns why it failed rather than just that it did, because
 * "the gateway dropped the image" and "this model can't read" look identical
 * from the outside and lead to opposite next steps. */
async function testModel(baseUrl, apiKey, model) {
  let res;
  let body;
  try {
    res = await fetch(baseUrl.replace(/\/+$/, "") + "/chat/completions", {
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
    body = await res.text();
  } catch (e) {
    return { ok: false, detail: "request failed: " + ((e && e.message) || e) };
  }

  if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${body.slice(0, 120)}` };

  let reply = "";
  try {
    const data = JSON.parse(body);
    reply = (data.choices && data.choices[0] && data.choices[0].message
      && data.choices[0].message.content) || "";
  } catch (e) {
    return { ok: false, detail: "reply was not JSON" };
  }

  const said = String(reply).trim();
  if (said.toUpperCase().includes(TEST_PHRASE)) return { ok: true, detail: "read the test image" };
  if (!said) return { ok: false, detail: "answered with nothing" };

  // The telling case: the model is fine, the gateway never passed the image on.
  if (/no image|don.?t see|attach|upload/i.test(said)) {
    return { ok: false, detail: "never received the image — this route strips it" };
  }
  return { ok: false, detail: `read "${said.slice(0, 40)}" instead` };
}

$("testApi").addEventListener("click", async () => {
  const baseUrl = $("apiBase").value.trim();
  const model = $("apiModel").value.trim();
  const apiKey = await currentKey();
  if (!baseUrl || !apiKey || !model) { apiSay("Need all three: URL, key and model.", false); return; }
  if (!(await ensureOrigin(baseUrl))) return;

  apiSay(`Testing ${model}…`);
  const result = await testModel(baseUrl, apiKey, model);
  apiSay(`${model} ${result.detail}.`, result.ok);
});

/* A gateway can strip images for a whole provider at once, so trying eight
 * models from the same prefix proves nothing eight times. Take the best
 * candidate from each provider first and move on the moment one route fails. */
function autoCandidates(models) {
  const byProvider = new Map();
  models
    .filter((m) => m.vision === true && !isImageMaker(m.id))
    .sort((a, b) => readerRank(a.id) - readerRank(b.id) || a.id.localeCompare(b.id))
    .forEach((m) => {
      const key = providerOf(m.id);
      if (!byProvider.has(key)) byProvider.set(key, []);
      byProvider.get(key).push(m.id);
    });

  // Round-robin: every provider's best, then every provider's second, and so on.
  const lists = Array.from(byProvider.values());
  const out = [];
  for (let depth = 0; depth < 3; depth++) {
    lists.forEach((list) => { if (list[depth]) out.push(list[depth]); });
  }
  return out;
}

$("autoPick").addEventListener("click", async () => {
  const baseUrl = $("apiBase").value.trim();
  const apiKey = await currentKey();
  if (!baseUrl || !apiKey) { apiSay("Need the URL and key first.", false); return; }
  if (!fetchedModels.length) { apiSay("Press Fetch models first.", false); return; }
  if (!(await ensureOrigin(baseUrl))) return;

  const candidates = autoCandidates(fetchedModels).slice(0, 12);
  if (!candidates.length) { apiSay("No model in that list claims to read images.", false); return; }

  const deadProviders = new Set();
  const tried = [];

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    // Once a route is proven to strip images, its other models cannot help.
    if (deadProviders.has(providerOf(model))) continue;

    apiSay(`Trying ${i + 1}/${candidates.length}: ${model}…`);
    const result = await testModel(baseUrl, apiKey, model);

    if (result.ok) {
      $("apiModel").value = model;
      await tpsSetApiConfig({ baseUrl, apiKey, model });
      await refreshApi();
      apiSay(`${model} works — saved. Tried ${tried.length + 1} model(s).`, true);
      return;
    }

    tried.push(`${model} (${result.detail})`);
    if (/strips it/.test(result.detail)) deadProviders.add(providerOf(model));
  }

  apiSay(`No model worked. ${tried.slice(0, 3).join("; ")}` +
         (tried.length > 3 ? `; and ${tried.length - 3} more.` : ""), false);
});

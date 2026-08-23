/*
 * vision-util.js
 *
 * Pure helpers for the optional vision model: reading a /models listing and,
 * later, reading a model's reply. No browser APIs, so Node can test it.
 *
 * Loaded by dynamic import() so the classic scripts around it stay classic.
 */

/* Endpoints disagree about how they advertise image support, so check the
 * shapes seen in the wild and fall back to "unknown" rather than guessing. */
function visionOf(entry) {
  const arch = entry.architecture || {};

  if (Array.isArray(arch.input_modalities)) {
    return arch.input_modalities.some((m) => String(m).toLowerCase() === "image");
  }
  if (typeof arch.modality === "string") {
    return /image/i.test(arch.modality.split("->")[0] || "");
  }
  if (entry.capabilities && typeof entry.capabilities.vision === "boolean") {
    return entry.capabilities.vision;
  }
  return null;
}

export function parseModelList(json) {
  const rows = Array.isArray(json) ? json
    : json && Array.isArray(json.data) ? json.data
    : null;

  if (!rows) return { models: [], error: "Could not read the model list from that endpoint" };

  const models = rows
    .filter((entry) => entry && typeof entry.id === "string" && entry.id)
    .map((entry) => ({ id: entry.id, vision: visionOf(entry) }))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (!models.length) return { models: [], error: "That endpoint returned no models" };
  return { models, error: null };
}

/* Threads marks a prompt as a structured attachment only when the author uses
 * that feature. Most just type it into the post or a follow-up reply, and then
 * the prompt is plainly there in the caption — calling a vision model to guess
 * at it would cost money and produce a worse copy of text already saved.
 *
 * Length is what separates a prompt from chatter. "Step 1: Open ChatGPT…" runs
 * to about ninety characters; a real image prompt runs to several hundred. The
 * longest single caption decides, because a dozen short replies are a
 * conversation, not a prompt. */
export const PROMPT_MIN_CHARS = 200;

export function postCarriesPrompt(post, minChars = PROMPT_MIN_CHARS) {
  if (String((post && post.snippet) || "").trim()) return true;

  return ((post && post.parts) || []).some(
    (part) => String((part && part.caption) || "").trim().length >= minChars
  );
}

/* Only two outcomes matter: the image carried prompt text, or it did not.
 * Describing a picture back as an invented prompt is not wanted — it costs a
 * call, fills the file with something the author never wrote, and reads worse
 * than the image it came from. */
const KINDS = ["transcribed", "none"];

function stripFence(text) {
  return text.replace(/^\s*```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "");
}

/* Models add preambles despite being told not to, so take the outermost
 * braces rather than insisting the whole reply is JSON. */
function firstJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

/* A model transcribing a multi-line prompt tends to put real newlines inside
 * the JSON string, which is not legal JSON and makes JSON.parse give up. The
 * transcription is the whole point, so pull the fields out by hand instead of
 * throwing the words away. */
function salvage(text) {
  const body = text.match(/"text"\s*:\s*"([\s\S]*?)"\s*\}\s*$/);
  if (!body) return null;

  const kind = text.match(/"kind"\s*:\s*"([A-Za-z]+)"/);
  const unescaped = body[1]
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");

  return { kind: kind ? kind[1] : undefined, text: unescaped };
}

/* Anything uncertain becomes "none". Only a reply that says plainly it is a
 * transcription, and carries text, is written into prompt.txt as the author's
 * words; loose prose is the model describing or refusing, and is discarded.
 * The raw reply is kept so a route that never delivered the image can still be
 * told apart from an image that genuinely has no prompt on it. */
export function parseVisionReply(raw) {
  const text = String(raw === null || raw === undefined ? "" : raw).trim();
  const nothing = { kind: "none", text: "", raw: text };
  if (!text) return nothing;

  const stripped = stripFence(text).trim();
  const parsed = firstJsonObject(stripped) || salvage(stripped);
  if (!parsed || typeof parsed.text !== "string") return nothing;

  const claimed = KINDS.includes(parsed.kind) ? parsed.kind : "none";
  if (claimed !== "transcribed" || !parsed.text.trim()) return nothing;

  return { kind: "transcribed", text: parsed.text, raw: text };
}

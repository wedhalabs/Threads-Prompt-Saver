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

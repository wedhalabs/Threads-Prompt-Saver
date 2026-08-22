import test from "node:test";
import assert from "node:assert/strict";
import { parseModelList } from "../extension/vision-util.js";

test("reads an OpenAI-style model list", () => {
  const { models, error } = parseModelList({ data: [{ id: "b-model" }, { id: "a-model" }] });
  assert.equal(error, null);
  assert.deepEqual(models.map((m) => m.id), ["a-model", "b-model"], "sorted by id");
  assert.deepEqual(models.map((m) => m.vision), [null, null], "no metadata means unknown");
});

test("marks vision support from OpenRouter input_modalities", () => {
  const { models } = parseModelList({
    data: [
      { id: "seer", architecture: { input_modalities: ["text", "image"] } },
      { id: "blind", architecture: { input_modalities: ["text"] } }
    ]
  });
  assert.equal(models.find((m) => m.id === "seer").vision, true);
  assert.equal(models.find((m) => m.id === "blind").vision, false);
});

test("reads the older modality string form", () => {
  const { models } = parseModelList({
    data: [{ id: "old", architecture: { modality: "text+image->text" } }]
  });
  assert.equal(models[0].vision, true);
});

test("reads a capabilities.vision flag", () => {
  const { models } = parseModelList({ data: [{ id: "cap", capabilities: { vision: true } }] });
  assert.equal(models[0].vision, true);
});

test("accepts a bare array", () => {
  const { models, error } = parseModelList([{ id: "solo" }]);
  assert.equal(error, null);
  assert.deepEqual(models.map((m) => m.id), ["solo"]);
});

test("skips entries with no usable id", () => {
  const { models } = parseModelList({ data: [{ id: "good" }, { name: "no id" }, null] });
  assert.deepEqual(models.map((m) => m.id), ["good"]);
});

test("reports a shape it cannot read", () => {
  assert.match(parseModelList({ nonsense: true }).error, /could not read/i);
  assert.match(parseModelList(null).error, /could not read/i);
});

test("reports an endpoint that returned no models", () => {
  assert.match(parseModelList({ data: [] }).error, /no models/i);
});

import { parseVisionReply } from "../extension/vision-util.js";

test("reads a clean JSON reply", () => {
  const out = parseVisionReply('{"kind":"transcribed","text":"Transform a sketch."}');
  assert.deepEqual(out, { kind: "transcribed", text: "Transform a sketch." });
});

test("reads JSON wrapped in a code fence", () => {
  const raw = '```json\n{"kind":"transcribed","text":"Hello"}\n```';
  assert.deepEqual(parseVisionReply(raw), { kind: "transcribed", text: "Hello" });
});

test("reads JSON buried in prose", () => {
  const raw = 'Sure! {"kind":"reconstructed","text":"A brown slide."} Hope that helps.';
  assert.deepEqual(parseVisionReply(raw), { kind: "reconstructed", text: "A brown slide." });
});

const NL = String.fromCharCode(10);
const TWO_LINES = "first line" + NL + "second line";

test("keeps newlines inside the transcribed text", () => {
  // JSON.stringify escapes the newline properly, as a well-behaved model would.
  const raw = JSON.stringify({ kind: "transcribed", text: TWO_LINES });
  assert.equal(parseVisionReply(raw).text, TWO_LINES);
});

test("salvages JSON broken by a raw newline in the text", () => {
  // A model transcribing a multi-line prompt often emits a real newline inside
  // the string instead, which is invalid JSON. The words must still survive.
  const raw = '{"kind":"transcribed","text":"' + TWO_LINES + '"}';
  const out = parseVisionReply(raw);
  assert.equal(out.kind, "transcribed", "the words are still verbatim");
  assert.equal(out.text, TWO_LINES);
});

test("treats bare text as reconstructed, never as verbatim", () => {
  const out = parseVisionReply("A photorealistic render of a house.");
  assert.deepEqual(out, { kind: "reconstructed", text: "A photorealistic render of a house." });
});

test("falls back to reconstructed when kind is unrecognised", () => {
  const out = parseVisionReply('{"kind":"ocr","text":"Some words"}');
  assert.equal(out.kind, "reconstructed", "an unknown label must not claim verbatim");
  assert.equal(out.text, "Some words");
});

test("falls back to reconstructed when text is missing", () => {
  const out = parseVisionReply('{"kind":"transcribed"}');
  assert.equal(out.kind, "reconstructed");
});

test("handles an empty reply", () => {
  assert.deepEqual(parseVisionReply(""), { kind: "reconstructed", text: "" });
  assert.deepEqual(parseVisionReply(null), { kind: "reconstructed", text: "" });
});

test("treats the model reporting no prompt as reconstructed-empty", () => {
  const out = parseVisionReply('{"kind":"transcribed","text":""}');
  assert.equal(out.kind, "reconstructed", "empty transcription is not a transcription");
  assert.equal(out.text, "");
});

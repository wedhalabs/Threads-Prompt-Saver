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

const NL = String.fromCharCode(10);
const TWO_LINES = "first line" + NL + "second line";

test("reads a transcription", () => {
  const out = parseVisionReply('{"kind":"transcribed","text":"Transform a sketch."}');
  assert.equal(out.kind, "transcribed");
  assert.equal(out.text, "Transform a sketch.");
});

test("reads a transcription wrapped in a code fence", () => {
  const raw = '```json' + NL + '{"kind":"transcribed","text":"Hello"}' + NL + '```';
  assert.equal(parseVisionReply(raw).kind, "transcribed");
  assert.equal(parseVisionReply(raw).text, "Hello");
});

test("keeps newlines inside the transcribed text", () => {
  const raw = JSON.stringify({ kind: "transcribed", text: TWO_LINES });
  assert.equal(parseVisionReply(raw).text, TWO_LINES);
});

test("salvages JSON broken by a raw newline in the text", () => {
  const raw = '{"kind":"transcribed","text":"' + TWO_LINES + '"}';
  const out = parseVisionReply(raw);
  assert.equal(out.kind, "transcribed", "the words are still verbatim");
  assert.equal(out.text, TWO_LINES);
});

test("reports no prompt when the model says none", () => {
  const out = parseVisionReply('{"kind":"none","text":""}');
  assert.equal(out.kind, "none");
  assert.equal(out.text, "");
});

test("an empty transcription is no transcription", () => {
  assert.equal(parseVisionReply('{"kind":"transcribed","text":"   "}').kind, "none");
});

test("prose that is not a transcription is discarded, never invented into one", () => {
  // The model describing the picture, or refusing, must not reach prompt.txt.
  const out = parseVisionReply("A brown slide showing two floor plans on white cards.");
  assert.equal(out.kind, "none");
  assert.equal(out.text, "");
});

test("an unrecognised kind is treated as no prompt", () => {
  assert.equal(parseVisionReply('{"kind":"reconstructed","text":"a guess"}').kind, "none");
  assert.equal(parseVisionReply('{"kind":"ocr","text":"words"}').kind, "none");
});

test("handles an empty reply", () => {
  assert.equal(parseVisionReply("").kind, "none");
  assert.equal(parseVisionReply(null).kind, "none");
});

test("keeps the raw reply so a broken route can still be diagnosed", () => {
  const out = parseVisionReply("I don't see an image attached.");
  assert.equal(out.kind, "none");
  assert.match(out.raw, /don't see an image/);
});

import { PROMPT_MIN_CHARS, postCarriesPrompt } from "../extension/vision-util.js";

const LONG = "Ultra-detailed futuristic product packaging mockup featuring the official ".repeat(4);

test("a structured prompt attachment counts", () => {
  assert.equal(postCarriesPrompt({ snippet: "a short one", parts: [] }), true);
});

test("a caption long enough to be a prompt counts", () => {
  assert.ok(LONG.length >= PROMPT_MIN_CHARS, "fixture is long enough to matter");
  assert.equal(postCarriesPrompt({ snippet: "", parts: [{ caption: LONG }] }), true);
});

test("a prompt posted in a reply counts", () => {
  const post = { snippet: "", parts: [{ caption: "PROMPT down" }, { caption: LONG }] };
  assert.equal(postCarriesPrompt(post), true);
});

test("short chatter does not count", () => {
  // The floor-plan post: instructions, with the real prompt only in the image.
  const caption = ".\n\nStep 1: Open ChatGPT/Gemini\nStep 2: Upload your floor plan\nStep 3: Write the Prompt";
  assert.ok(caption.length < PROMPT_MIN_CHARS, "fixture is short enough to matter");
  assert.equal(postCarriesPrompt({ snippet: "", parts: [{ caption }] }), false);
});

test("many short captions do not add up to a prompt", () => {
  const parts = Array.from({ length: 12 }, () => ({ caption: "nice work!" }));
  assert.equal(postCarriesPrompt({ snippet: "", parts }), false);
});

test("a post with nothing on it does not count", () => {
  assert.equal(postCarriesPrompt({ snippet: "", parts: [] }), false);
  assert.equal(postCarriesPrompt({}), false);
});

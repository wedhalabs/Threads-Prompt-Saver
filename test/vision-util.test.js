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

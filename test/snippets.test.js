import test from "node:test";
import assert from "node:assert/strict";
import { dedupeSnippets } from "../extension/snippets.js";

test("keeps distinct prompts in the order they were published", () => {
  assert.deepEqual(
    dedupeSnippets(["Prompt1 text", "Prompt2 text"]),
    ["Prompt1 text", "Prompt2 text"]
  );
});

test("removes an exact repeat, keeping the first", () => {
  // The walker can reach the same attachment twice through nested nodes.
  assert.deepEqual(dedupeSnippets(["same", "other", "same"]), ["same", "other"]);
});

test("treats entries differing only by surrounding space as one", () => {
  assert.deepEqual(dedupeSnippets(["  a prompt  ", "a prompt"]), ["a prompt"]);
});

test("drops blanks rather than rendering an empty prompt section", () => {
  assert.deepEqual(dedupeSnippets(["real", "", "   ", null, undefined]), ["real"]);
});

test("survives a missing or empty list", () => {
  assert.deepEqual(dedupeSnippets([]), []);
  assert.deepEqual(dedupeSnippets(null), []);
  assert.deepEqual(dedupeSnippets(undefined), []);
});

test("keeps two prompts that merely start alike", () => {
  // Prompt1 and Prompt2 often share a long preamble; they are not duplicates.
  const a = "ULTRA-REALISTIC 8K HEADSHOT. Identity is highest priority. Navy blazer.";
  const b = "ULTRA-REALISTIC 8K HEADSHOT. Identity is highest priority. Blue blazer.";
  assert.deepEqual(dedupeSnippets([a, b]), [a, b]);
});

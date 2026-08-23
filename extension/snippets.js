/*
 * snippets.js
 *
 * A post can publish more than one prompt: authors number them Prompt1,
 * Prompt2 and put each in its own reply. Every one of them belongs in
 * prompt.txt, so the list is tidied rather than reduced to a single winner.
 *
 * Pure, so Node can test it.
 */

/* Same text reached twice through nested nodes is one prompt; two prompts
 * that merely open alike are two. Only exact matches collapse, and order is
 * the order they were published in. */
export function dedupeSnippets(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const text = String(item === null || item === undefined ? "" : item).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/*
 * extract.js
 *
 * Pulls a Threads post's real media list and text out of the JSON that
 * Threads embeds in the page. This is far more reliable than reading the
 * rendered DOM (obfuscated, lazy-loaded) or sniffing network traffic (can't
 * tell a post's photo from a reply's, or a video from its poster frame).
 *
 * Shape we rely on, inside <script type="application/json"> blobs:
 *   post.code                     - the id in the page URL
 *   post.caption.text             - the visible caption
 *   post.carousel_media[]         - one entry per slide
 *     .video_versions[]           - present only on video slides
 *     .image_versions2.candidates - still images (also the video's poster)
 *   post.…snippet_attachment_info.text_fragments.fragments[].plaintext
 *                                 - the grey "Read more" box, where long
 *                                   master prompts actually live
 */

(function () {
  "use strict";

  const POST_URL_RE = /threads\.(?:com|net)\/@([^/]+)\/post\/([A-Za-z0-9_-]+)/;

  // Posts in the same author chain (1/2, 2/2, ...) are published seconds
  // apart; later replies to commenters are minutes or hours later.
  const CHAIN_WINDOW_SECONDS = 300;

  function parsePostUrl(href) {
    const m = POST_URL_RE.exec(href || "");
    return m ? { author: m[1], code: m[2] } : null;
  }

  function walk(node, fn) {
    if (Array.isArray(node)) {
      for (const v of node) walk(v, fn);
    } else if (node && typeof node === "object") {
      fn(node);
      for (const k in node) walk(node[k], fn);
    }
  }

  function jsonBlobs() {
    const out = [];
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      const t = s.textContent;
      if (t) out.push(t);
    }
    return out;
  }

  function isPostNode(n) {
    return n && typeof n.code === "string" && ("caption" in n);
  }

  function biggestImage(item) {
    const cands = ((item.image_versions2 || {}).candidates || []).filter((c) => c && c.url);
    if (!cands.length) return null;
    return cands.reduce((a, b) =>
      (b.width || 0) * (b.height || 0) > (a.width || 0) * (a.height || 0) ? b : a
    );
  }

  function bestVideo(item) {
    const vv = (item.video_versions || []).filter((v) => v && v.url);
    if (!vv.length) return null;
    // Versions are ranked by `type`; when sizes are absent prefer the first,
    // which Threads serves as the primary rendition.
    return vv.reduce((a, b) =>
      (b.width || 0) * (b.height || 0) > (a.width || 0) * (a.height || 0) ? b : a
    );
  }

  function mediaFrom(post) {
    const items = (post.carousel_media && post.carousel_media.length)
      ? post.carousel_media
      : [post];
    const media = [];
    for (const item of items) {
      const vid = bestVideo(item);
      if (vid) {
        // Video slide: take the video itself, not its poster still.
        media.push({ kind: "video", url: vid.url });
        continue;
      }
      const img = biggestImage(item);
      if (img) media.push({ kind: "image", url: img.url });
    }
    return media;
  }

  function hasMedia(node) {
    if (node.carousel_media && node.carousel_media.length) return true;
    if (node.video_versions && node.video_versions.length) return true;
    return (((node.image_versions2 || {}).candidates) || []).length > 0;
  }

  /* A text post that quotes or reposts another one carries no media itself —
   * the media sits on the embedded post. Find the richest such post nested
   * inside this one. */
  function nestedPostWithMedia(post, excludeCode) {
    let best = null;
    walk(post, (n) => {
      if (typeof n.code !== "string" || n.code === excludeCode) return;
      if (!n.user && !n.caption) return; // link previews and the like
      if (!hasMedia(n)) return;
      if (!best || JSON.stringify(n).length > JSON.stringify(best).length) best = n;
    });
    return best;
  }

  function snippetsIn(post) {
    const out = [];
    walk(post, (n) => {
      const sa = n.snippet_attachment_info;
      if (!sa) return;
      const frags = ((sa.text_fragments || {}).fragments) || [];
      for (const fr of frags) if (fr && fr.plaintext) out.push(fr.plaintext);
    });
    return out;
  }

  /* Words that introduce a section of a prompt rather than name it. A prompt
   * built from these ("Basic Setting:", "Characters:", …) has no title of its
   * own, so the first line is a poor folder name. */
  const SECTION_WORD_RE =
    /^(basic\s+setting|character|characters|cast|equipment|sequence|scene|setting|visual\s+style|style|role|task|goal|objective|context|instruction|instructions|user\s+input|input|output|format|rule|rules|note|notes|overview|summary|step|steps|constraint|constraints|requirement|requirements|example|examples|prompt|prompts|master\s+prompt|negative\s+prompt)\b/i;

  /* A heading labels what comes after it instead of naming the whole thing. */
  function isHeadingLine(line) {
    if (/[:：]\s*$/.test(line)) return true;
    return SECTION_WORD_RE.test(line) && line.length <= 40;
  }

  /* Title for the save folder. Long prompts often open with a banner:
   *     ================================
   *     AI MICRO STORYBOARD EDUCATION GENERATOR
   *     V3.0 PRODUCTION STORYBOARD EDITION
   * which names the prompt, so it wins. Prompts that instead open with a
   * section heading ("Basic Setting:") have no name, so the first line of
   * real content is used and trimmed to its opening sentence. */
  function titleFromText(text) {
    const lines = (text || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^[=\-_*~#\s]+$/.test(l));
    if (!lines.length) return "";

    const start = lines.findIndex((l) => !isHeadingLine(l));
    if (start === -1) return "";

    let title = lines[start];
    const next = lines[start + 1];
    if (next) {
      const m = /^(V\d+(?:\.\d+)*)\b/i.exec(next);
      if (m) title += " " + m[1];
    }

    // A whole paragraph on one line: keep just the opening sentence.
    const sentence = /^(.{10,80}?[.!?])(?:\s|$)/.exec(title);
    if (sentence) title = sentence[1];

    return title;
  }

  function extractPost() {
    const target = parsePostUrl(location.href);
    if (!target) {
      return { ok: false, error: "Open a Threads post page first (…/@user/post/…)." };
    }

    let main = null;
    const authorPosts = [];

    for (const text of jsonBlobs()) {
      if (text.indexOf('"code"') === -1) continue;
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        continue;
      }
      walk(data, (n) => {
        if (!isPostNode(n)) return;
        if (n.code === target.code) {
          // Several copies exist; the richest one has the media.
          if (!main || JSON.stringify(n).length > JSON.stringify(main).length) main = n;
        }
        const user = (n.user || {}).username;
        if (user && user === target.author) authorPosts.push(n);
      });
    }

    if (!main) {
      return {
        ok: false,
        error:
          "Couldn't find this post's data in the page. Reload the post page " +
          "and try again (Threads may still be loading).",
      };
    }

    let media = mediaFrom(main);
    let quoted = null;
    if (!media.length) {
      quoted = nestedPostWithMedia(main, target.code);
      if (quoted) media = mediaFrom(quoted);
    }
    const mainTaken = main.taken_at || 0;

    // Author's own chained posts (the 1/2, 2/2 continuation), de-duplicated,
    // excluding much-later replies to other people.
    const chain = new Map();
    for (const p of authorPosts) {
      if (p.code === target.code) continue;
      const taken = p.taken_at || 0;
      if (!mainTaken || Math.abs(taken - mainTaken) > CHAIN_WINDOW_SECONDS) continue;
      const prev = chain.get(p.code);
      if (!prev || JSON.stringify(p).length > JSON.stringify(prev).length) chain.set(p.code, p);
    }

    const parts = [];
    const mainCaption = ((main.caption || {}).text) || "";
    if (mainCaption) parts.push({ code: main.code, caption: mainCaption });

    const allSnippets = snippetsIn(main);
    if (quoted) {
      const quotedCaption = ((quoted.caption || {}).text) || "";
      if (quotedCaption && quotedCaption !== mainCaption) {
        parts.push({ code: quoted.code, caption: quotedCaption });
      }
      allSnippets.push(...snippetsIn(quoted));
    }
    const ordered = [...chain.values()].sort((a, b) => (a.taken_at || 0) - (b.taken_at || 0));
    for (const p of ordered) {
      const cap = ((p.caption || {}).text) || "";
      if (cap) parts.push({ code: p.code, caption: cap });
      allSnippets.push(...snippetsIn(p));
    }

    // Longest snippet is the master prompt; it names the folder.
    let snippet = "";
    for (const s of allSnippets) if (s.length > snippet.length) snippet = s;

    const title = titleFromText(snippet) || titleFromText(mainCaption);

    return {
      ok: true,
      post: {
        code: target.code,
        author: target.author,
        url: location.href.split("?")[0],
        title,
        caption: mainCaption,
        snippet,
        parts,
        media,
      },
    };
  }

  window.__threadsPromptSaver = { extractPost };
})();

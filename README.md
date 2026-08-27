# Threads Prompt Saver

A Chrome extension for people who collect and write AI prompts on Threads.

It does two things: it **saves** a post's images, videos and prompt text into a
folder on your disk in one click, and it gives you a **library for drafting and
publishing** your own threads.

Everything runs inside your normal, already-signed-in Chrome. Private and
followers-only posts work with no separate login, nothing is uploaded anywhere,
and there is no server, account or subscription involved.

---

## Saving a post

Open any Threads post and click **Save post**. The extension reads the post's
own data, downloads its media, and writes everything into a folder of its own:

```
<your folder>/
└── luthfikim_/                          ← the author
    └── AI_MICRO_STORYBOARD_GENERATOR/   ← the post, named after its prompt
        ├── image1.webp … image10.webp
        ├── video1.mp4
        └── prompt.txt
```

Saving the same post again reuses its folder and refreshes the files rather than
making a second copy.

### What lands in `prompt.txt`

| Section | Contents |
| --- | --- |
| `POST TEXT` | The caption of every post in the author's chain, so a "1/3 + 2/3" write-up is captured whole |
| `MASTER PROMPT` | The prompt behind Threads' grey *Read more* box |
| `PROMPTS PUBLISHED IN THIS POST` | Replaces the above when an author numbers several prompts across replies — each one kept separately, in order |
| `PROMPTS READ FROM THE IMAGES` | Prompts printed on a slide rather than typed, copied out verbatim. Optional; see below |

### Seeing what was saved

After a save, **Show saved images and prompt** opens a page listing the
thumbnails, the video and the prompt text, with a download link per file and a
button to copy the prompt.

Chrome never reveals to an extension where a chosen folder actually sits on
disk, and offers no way to open one in a file manager. Tell the extension the
path once in its options and that page will show the folder's full location, and
can open Chrome's own listing for it.

---

## Reading prompts printed on images

Some authors share a prompt as a picture: a slide with the text set in a nice
typeface. The words are right there, but they are pixels.

Point the extension at any OpenAI-compatible endpoint — its own API base URL,
key and model — and it will copy that text out verbatim into
`PROMPTS READ FROM THE IMAGES`.

It only ever **copies**. If nothing is written on an image, nothing is saved for
it: the extension will not invent a prompt or describe the picture back to you,
because a guess is not what the author wrote and does not belong in a file whose
whole purpose is their words.

The options page helps you set this up rather than leaving you to guess:

- **Fetch models** lists what your endpoint actually offers, filtered to models
  that can read images and grouped by provider
- **Test vision** sends a generated test image through the exact request the
  saver uses, and tells you plainly whether the model read it — including
  whether your endpoint accepts inline image data at all, which some gateways
  quietly refuse
- **Find one that works** tries a candidate from each provider and saves the
  first that succeeds

**Cost.** Leave the fields blank and nothing is ever sent anywhere. Filled in, a
post that already publishes its prompt — as an attachment, in the post, or in a
reply — still costs nothing. Only a post with no prompt to be found is examined,
at one API call per image.

---

## Threads Poster

A local library for writing your own threads, opened from the extension's
toolbar button.

- **Compose a thread** as a parent post plus an ordered chain of replies, with a
  character meter per segment against Threads' 500-character limit
- **Keep them in one place** — searchable, filterable by draft, ready or posted
- **Set a reminder** and Chrome notifies you when a thread is due
- **Publish step by step**: the extension opens the composer with each segment
  ready, and detects when one lands so it can queue the next

**You press Post.** The extension never clicks it for you. Automating that
button is what gets Threads accounts rate-limited, and handing off still removes
the tedious part — retyping, tracking where you are in a chain, and collecting
the resulting links.

**Import and export.** The library round-trips through CSV, one row per
segment, so a batch of ideas drafted in a spreadsheet becomes threads in one
step. Imports merge by id and never delete; a file with any malformed row is
refused whole, with the offending lines named.

---

## Install

1. Go to `chrome://extensions` and turn on **Developer mode**
2. Click **Load unpacked** and choose this repository's `extension` folder
3. Open the extension's options and click **Browse…** to choose a save folder

![Loading the extension in Chrome](docs/demo.gif)

Requires Chrome 116 or newer. After editing any extension file, press the
reload ↻ button on `chrome://extensions` — Chrome caches the old code.

**A note on folder permission.** Chrome only keeps write access for the current
browser session. After a restart the first save says so and offers a
**Re-allow** button. That is Chrome's rule for folder access and cannot be
turned off.

---

## How it finds the right media

Threads embeds each post's real data as JSON in the page, and the extension
reads the media list straight from it rather than scraping the rendered page or
watching network traffic.

That distinction matters in practice: a naive approach mistakes a video's poster
frame for an extra photo, and cannot tell the author's own carousel from images
posted in the replies.

Folder names come from the prompt's title where it has one. Prompts built from
sections instead — `Basic Setting:`, `Characters:` — have no title, so the first
line of real content is used.

---

## Development

No build step, no bundler, no dependencies. The extension is plain JavaScript
loaded directly by Chrome.

```bash
npm test
```

69 tests run on Node's built-in test runner and cover the logic that is worth
proving rather than clicking through: CSV round-trips against text containing
commas, quotes, embedded newlines and emoji; character counting by code point;
segment splitting; and path handling across Windows and POSIX.

| Permission | Why |
| --- | --- |
| `offscreen` | The File System Access API needs a document, which a service worker has not got |
| `alarms` | Thread reminders |
| `notifications` | Telling you a thread is due |

Access to an API endpoint is requested for that one origin, at the moment you
save the setting — not bundled into the install.

---

## Limitations

- **Threads only.** Other sites are not supported.
- Media comes from the post in the URL. If an author splits media across a
  "1/2 + 2/2" thread, save each post separately — the *text* of the whole chain
  is captured either way.
- Threads changes its internal page data from time to time. If saving stops
  finding media, that is the likeliest cause.
- The publish flow reads Threads' live interface, so it is the part most exposed
  to those changes. Every step offers a manual fallback for when detection
  misses.

---

## License

[MIT](LICENSE) © wedhalabs

Saved posts belong to whoever wrote them. This licence covers the extension's
own code, not the material you download with it — respect the rights of the
authors whose posts you save.

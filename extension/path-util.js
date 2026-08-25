/*
 * path-util.js
 *
 * The save folder is a FileSystemDirectoryHandle, which exposes a name and
 * nothing else — no path, and no way to reveal it in the file manager. So the
 * user can tell us once where that folder lives, purely so the save toast can
 * offer the full path to copy. Nothing here reads or writes any file.
 *
 * Pure, so Node can test it.
 */

/* Keep whichever separator the user's own path uses, rather than imposing one:
 * they will paste the result straight into their file manager. */
function separatorFor(root) {
  return root.includes("\\") || /^[A-Za-z]:$/.test(root) ? "\\" : "/";
}

export function joinFolderPath(root, folderName) {
  const base = String(root || "").trim();
  const name = String(folderName || "").trim();
  if (!base || !name) return "";

  const sep = separatorFor(base);
  const trimmed = base.replace(/[\\/]+$/, "");
  return trimmed + sep + name;
}

/* A folder path as a URL Chrome can open. It shows Chrome's own directory
 * listing, not the file manager — no extension can open the file manager — but
 * it gets to the files in one click.
 *
 * encodeURI is the right tool here rather than encodeURIComponent: it leaves
 * the separators and a drive letter's colon intact while encoding spaces. It
 * spares # and ? though, and both are legal in a folder name. */
export function toFileUrl(path) {
  const clean = String(path || "").trim().replace(/[\\/]+$/, "");
  if (!clean) return "";

  const slashed = clean.replace(/\\/g, "/");
  const encoded = encodeURI(slashed).replace(/#/g, "%23").replace(/\?/g, "%3F");
  return "file:///" + encoded.replace(/^\/+/, "");
}

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

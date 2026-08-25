import test from "node:test";
import assert from "node:assert/strict";
import { joinFolderPath } from "../extension/path-util.js";

test("joins a Windows root and a folder name", () => {
  assert.equal(
    joinFolderPath("D:\\Download\\Threads", "Luxie_post"),
    "D:\\Download\\Threads\\Luxie_post"
  );
});

test("ignores a trailing separator on the root", () => {
  assert.equal(joinFolderPath("D:\\Download\\Threads\\", "Post"), "D:\\Download\\Threads\\Post");
  assert.equal(joinFolderPath("/home/me/threads/", "Post"), "/home/me/threads/Post");
});

test("keeps the separator style the root already uses", () => {
  assert.equal(joinFolderPath("/home/me/threads", "Post"), "/home/me/threads/Post");
});

test("treats a bare drive letter as a Windows root", () => {
  assert.equal(joinFolderPath("D:", "Post"), "D:\\Post");
});

test("trims stray whitespace around the root", () => {
  assert.equal(joinFolderPath("  D:\\Threads  ", "Post"), "D:\\Threads\\Post");
});

test("returns empty when no root is configured", () => {
  // The button that shows the path must stay hidden rather than offer half of one.
  assert.equal(joinFolderPath("", "Post"), "");
  assert.equal(joinFolderPath(null, "Post"), "");
  assert.equal(joinFolderPath("   ", "Post"), "");
});

test("returns empty when there is no folder name", () => {
  assert.equal(joinFolderPath("D:\\Threads", ""), "");
});

import { toFileUrl } from "../extension/path-util.js";

const BS = String.fromCharCode(92);

test("turns a Windows path into a file URL", () => {
  assert.equal(
    toFileUrl("D:" + BS + "Download" + BS + "Threads" + BS + "Post"),
    "file:///D:/Download/Threads/Post"
  );
});

test("leaves a drive letter's colon alone", () => {
  assert.ok(toFileUrl("D:" + BS + "x").startsWith("file:///D:/"), "colon must survive");
});

test("turns a POSIX path into a file URL", () => {
  assert.equal(toFileUrl("/home/me/threads/Post"), "file:///home/me/threads/Post");
});

test("encodes spaces and other characters a URL cannot carry raw", () => {
  assert.equal(toFileUrl("D:" + BS + "My Folder"), "file:///D:/My%20Folder");
  assert.equal(toFileUrl("D:" + BS + "a#b"), "file:///D:/a%23b");
  assert.equal(toFileUrl("D:" + BS + "a?b"), "file:///D:/a%3Fb");
});

test("ignores a trailing separator", () => {
  assert.equal(toFileUrl("D:" + BS + "Threads" + BS), "file:///D:/Threads");
});

test("returns empty when there is no path", () => {
  assert.equal(toFileUrl(""), "");
  assert.equal(toFileUrl(null), "");
  assert.equal(toFileUrl("   "), "");
});

// Verifies line-level staging against real git:  node scripts/test-lines-patch.mjs
// (Node 22.18+ runs the TypeScript import directly.)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linesPatch, parseDiff } from "../src/diff.ts";

const dir = mkdtempSync(join(tmpdir(), "gitolotl-lines-"));
const git = (args, input) => execFileSync("git", args, { cwd: dir, input, encoding: "utf8" });
const read = () => readFileSync(join(dir, "f.txt"), "utf8");
const pick = (hunk, ...texts) => new Set(texts.map((t) => { const i = hunk.lines.findIndex((l) => l.raw === t); assert.notEqual(i, -1, `line not found: ${t}`); return i; }));

for (const eol of ["\n", "\r\n"]) {
  git(["init", "-q"]);
  git(["config", "user.name", "t"]); git(["config", "user.email", "t@t"]); git(["config", "core.autocrlf", "false"]); git(["config", "commit.gpgsign", "false"]);
  const base = ["a", "b", "c", "d", "e", "f", "g"];
  writeFileSync(join(dir, "f.txt"), base.join(eol) + eol);
  git(["add", "-A"]); git(["commit", "-qm", "base"]);
  // b -> B, d removed, new line X after e, new line Y after X
  const work = ["a", "B", "c", "e", "X", "Y", "f", "g"].join(eol) + eol;
  writeFileSync(join(dir, "f.txt"), work);
  const cr = eol === "\r\n" ? "\r" : "";

  // 1. stage only "+X" and "-d": index gets those two changes and nothing else
  let d = parseDiff(git(["diff", "--", "f.txt"]));
  let h = d.hunks[0];
  git(["apply", "--cached", "--whitespace=nowarn", "-"], linesPatch(d, h, pick(h, `+X${cr}`, `-d${cr}`), false));
  assert.equal(git(["show", ":f.txt"]), ["a", "b", "c", "e", "X", "f", "g"].join(eol) + eol, "index after staging two lines");
  assert.equal(read(), work, "staging must not touch the working file");

  // 2. unstage just "+X" again: index keeps only the removal of d
  d = parseDiff(git(["diff", "--cached", "--", "f.txt"]));
  h = d.hunks[0];
  git(["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"], linesPatch(d, h, pick(h, `+X${cr}`), true));
  assert.equal(git(["show", ":f.txt"]), ["a", "b", "c", "e", "f", "g"].join(eol) + eol, "index after unstaging one line");
  assert.equal(read(), work, "unstaging must not touch the working file");

  // 3. discard only "+Y" from the working tree: X and the b->B edit survive
  d = parseDiff(git(["diff", "--", "f.txt"]));
  h = d.hunks.find((x) => x.lines.some((l) => l.raw === `+Y${cr}`));
  git(["apply", "--reverse", "--whitespace=nowarn", "-"], linesPatch(d, h, pick(h, `+Y${cr}`), true));
  assert.equal(read(), ["a", "B", "c", "e", "X", "f", "g"].join(eol) + eol, "working file after discarding one line");

  // 4. file without a trailing newline
  writeFileSync(join(dir, "f.txt"), ["a", "B", "c", "e", "X", "f", "g", "tail"].join(eol));
  d = parseDiff(git(["diff", "--", "f.txt"]));
  h = d.hunks[d.hunks.length - 1];
  git(["apply", "--cached", "--whitespace=nowarn", "-"], linesPatch(d, h, pick(h, "+tail"), false));
  assert.ok(git(["show", ":f.txt"]).endsWith(`g${eol}tail`), "staged the final line without a newline");

  rmSync(join(dir, ".git"), { recursive: true, force: true });
  console.log(`ok (${eol === "\n" ? "LF" : "CRLF"})`);
}
rmSync(dir, { recursive: true, force: true });

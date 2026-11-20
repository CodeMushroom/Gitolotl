/**
 * A deliberately small, dependency-free syntax colourer for diff lines.
 * It works one line at a time (diffs rarely show whole multi-line constructs)
 * and only distinguishes comments, strings, numbers and keywords.
 */
export type Token = [cls: "" | "c" | "s" | "n" | "k", text: string];

const SLASH = new Set("js jsx ts tsx mjs cjs rs go java kt kts swift c h cc cpp hpp cs dart scala php css scss less json jsonc proto zig".split(" "));
const HASH = new Set("py rb sh bash zsh fish yml yaml toml ini cfg conf pl r ps1 psm1 tf dockerfile makefile mk nix gitignore env".split(" "));
const DASH = new Set("sql lua hs elm".split(" "));

const KEYWORDS = new Set(
  ("as async await break case catch class const continue def default defer delete do elif else enum export extends " +
    "false final finally fn for from func function if impl import in interface is let loop match mod mut new nil none " +
    "null package private protected pub public return self static struct super switch this throw trait true try type " +
    "typeof undefined union unsafe use var void where while with yield None True False and or not lambda pass raise " +
    "select insert update where join create table alter drop begin end then elsif unless until module require").split(" "),
);

export function langOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile" || name === "makefile") return name;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1);
}

const STRING = `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\``;
const REST = `\\b\\d[\\w.]*\\b|[A-Za-z_$][\\w$]*`;
const build = (comment: string) => new RegExp(`(${comment})|(${STRING})|(${REST})`, "g");
const RE_SLASH = build("\\/\\/.*$|\\/\\*.*?\\*\\/");
const RE_HASH = build("#.*$");
const RE_DASH = build("--.*$");

export function tokenize(line: string, lang: string): Token[] {
  const re = SLASH.has(lang) ? RE_SLASH : HASH.has(lang) ? RE_HASH : DASH.has(lang) ? RE_DASH : null;
  if (!re || line.length > 500) return [["", line]];
  const out: Token[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const text = m[0];
    const cls: Token[0] = m[1] ? "c" : m[2] ? "s" : /^\d/.test(text) ? "n" : KEYWORDS.has(text) ? "k" : "";
    if (cls) {
      if (m.index > last) out.push(["", line.slice(last, m.index)]);
      out.push([cls, text]);
      last = m.index + text.length;
    }
    if (text.length === 0) re.lastIndex++;
  }
  if (last < line.length) out.push(["", line.slice(last)]);
  return out;
}

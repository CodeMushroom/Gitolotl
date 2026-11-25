// Builds latest.json, the manifest the in-app updater reads, from the signed packages of
// one release. It runs once, after every platform has uploaded, so no two build jobs ever
// write the same file. Every platform must be present or it fails.
//
//   node scripts/make-manifest.mjs <owner/repo> <release id | tag:vX.Y.Z> <version> <tag> [--upload]
//
// Reads GH_TOKEN (needed for a draft release and for --upload) and NOTES (shown by the
// in-app update prompt). Prints the manifest; with --upload it also replaces latest.json
// on the release.
const [repo, release, version, tag, flag] = process.argv.slice(2);
if (!repo || !release || !version || !tag) {
  console.error("usage: make-manifest.mjs <owner/repo> <release id | tag:vX.Y.Z> <version> <tag> [--upload]");
  process.exit(2);
}

// updater target -> package file. The plain target is what an installed app asks for first.
const PACKAGES = {
  "windows-x86_64": "Windows-setup.exe",
  "windows-x86_64-nsis": "Windows-setup.exe",
  "windows-x86_64-msi": "Windows.msi",
  "darwin-aarch64": "Mac-AppleSilicon.app.tar.gz",
  "darwin-aarch64-app": "Mac-AppleSilicon.app.tar.gz",
  "darwin-x86_64": "Mac-Intel.app.tar.gz",
  "darwin-x86_64-app": "Mac-Intel.app.tar.gz",
  "linux-x86_64": "Linux.AppImage",
  "linux-x86_64-appimage": "Linux.AppImage",
  "linux-x86_64-deb": "Linux.deb",
  "linux-x86_64-rpm": "Linux.rpm",
};

const token = process.env.GH_TOKEN;
const headers = { "User-Agent": "gitolotl-release", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
const api = async (url, init = {}) => {
  const r = await fetch(url, { ...init, headers: { Accept: "application/vnd.github+json", ...headers, ...init.headers } });
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${url} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r;
};

const base = `https://api.github.com/repos/${repo}/releases`;
const rel = await (await api(release.startsWith("tag:") ? `${base}/tags/${release.slice(4)}` : `${base}/${release}`)).json();
const assets = await (await api(`${base}/${rel.id}/assets?per_page=100`)).json();
const byName = new Map(assets.map((a) => [a.name, a]));

const signatures = new Map();
const platforms = {};
for (const [target, suffix] of Object.entries(PACKAGES)) {
  const name = `Gitolotl-${version}-${suffix}`;
  const sig = byName.get(`${name}.sig`);
  if (!byName.has(name) || !sig) throw new Error(`The release has no ${byName.has(name) ? `${name}.sig` : name}, needed for ${target}.`);
  if (!signatures.has(name)) {
    const text = (await (await api(sig.url, { headers: { Accept: "application/octet-stream" } })).text()).trim();
    if (!text) throw new Error(`${name}.sig is empty.`);
    signatures.set(name, text);
  }
  platforms[target] = { signature: signatures.get(name), url: `https://github.com/${repo}/releases/download/${tag}/${name}` };
}

const manifest = JSON.stringify({ version, notes: process.env.NOTES ?? "", pub_date: new Date().toISOString(), platforms }, null, 2);
console.log(manifest);

if (flag === "--upload") {
  const old = byName.get("latest.json");
  if (old) await api(old.url, { method: "DELETE" });
  await api(`https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=latest.json`, { method: "POST", headers: { "Content-Type": "application/json" }, body: manifest });
  console.error(`uploaded latest.json with ${Object.keys(platforms).length} platforms`);
}

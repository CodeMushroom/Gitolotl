// Checks the public update channel the way an installed copy of Gitolotl does:
//   node scripts/verify-update.mjs [installed-version]
// 1. fetches latest.json from the public releases repo
// 2. confirms it offers a version newer than the installed one
// 3. downloads every platform's update package and verifies its signature against
//    the public key compiled into the app (minisign: Ed25519 over a BLAKE2b-512 digest)
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const installed = process.argv[2] ?? "0.0.0";
const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const { pubkey, endpoints } = conf.plugins.updater;

const lines = (b64) => Buffer.from(b64, "base64").toString("utf8").split("\n");
const pk = Buffer.from(lines(pubkey)[1], "base64"); // "Ed" + 8-byte key id + 32-byte key
const keyId = pk.subarray(2, 10);
const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pk.subarray(10)]), format: "der", type: "spki" });

const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.replace(/^v/, "").split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

const manifest = await (await fetch(endpoints[0])).json();
console.log(`manifest: version ${manifest.version}, published ${manifest.pub_date}`);
console.log(`installed ${installed} -> update offered: ${newer(manifest.version, installed)}`);
console.log(`notes shown to the user begin: ${JSON.stringify((manifest.notes ?? "").slice(0, 90))}`);

let failed = 0;
const seen = new Map();
for (const [platform, entry] of Object.entries(manifest.platforms)) {
  const name = decodeURIComponent(entry.url.split("/").pop());
  try {
    if (!seen.has(entry.url)) {
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      seen.set(entry.url, Buffer.from(await res.arrayBuffer()));
    }
    const file = seen.get(entry.url);
    const sig = Buffer.from(lines(entry.signature)[1], "base64"); // "ED" + key id + 64-byte signature
    if (sig.subarray(0, 2).toString() !== "ED") throw new Error("unexpected signature algorithm");
    if (!sig.subarray(2, 10).equals(keyId)) throw new Error("signed with a different key");
    const digest = createHash("blake2b512").update(file).digest();
    if (!verify(null, digest, publicKey, sig.subarray(10))) throw new Error("SIGNATURE DOES NOT VERIFY");
    console.log(`  ok   ${platform.padEnd(24)} ${name} (${(file.length / 1048576).toFixed(1)} MB)`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${platform.padEnd(24)} ${name}: ${e.message}`);
  }
}
if (failed || !newer(manifest.version, installed)) {
  console.log(failed ? `${failed} platform(s) failed` : "no newer version is offered");
  process.exit(1);
}
console.log("update channel is healthy");

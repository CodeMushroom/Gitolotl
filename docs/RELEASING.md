# Releasing: installers and the auto-updater

## One repository

Source, issues, CI and releases all live in the public `CodeMushroom/Gitolotl`. The updater inside every
installed copy downloads from its Releases, so no server or storage bucket is needed.

## How it fits together

1. A version tag (`v0.2.0`) is pushed.
2. `.github/workflows/release.yml` builds on Windows, macOS (Apple silicon and Intel) and Linux.
3. Each build is signed with the **update-signing key** and uploaded to a draft Release. When all of
   them are there, `scripts/make-manifest.mjs` writes `latest.json`, the manifest listing every
   platform's download URL and signature.
4. Installed copies of Gitolotl fetch
   `https://github.com/CodeMushroom/Gitolotl/releases/latest/download/latest.json` on launch. If the
   version is newer they offer **Install and restart**, download the package, verify its signature
   against the public key compiled into the app, and only then install it.

A package that is not signed by the matching private key is rejected, so a compromised download host
cannot push code to users.

## What each platform gets

| Platform | Installer | Updates via |
| --- | --- | --- |
| Windows | `-Windows-setup.exe` (per-user, no admin) and `.msi` | the setup.exe |
| macOS | `.dmg` | `.app.tar.gz` |
| Linux | `.AppImage`, `.deb`, `.rpm` | AppImage only; `.deb` / `.rpm` users update through a new package |

## One-time setup

### 1. The update-signing key

A keypair was generated on the original development machine:

- private key: `~/.tauri/gitolotl.key` (outside the repository)
- public key: committed in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`

**Back the private key up somewhere safe.** If it is lost, existing installs can never be updated
again; users would have to reinstall a build carrying a new public key. If it leaks, anyone who can also
control the download URL could ship a malicious update, so rotate it.

To replace it:

```bash
npm run tauri signer generate -- -w ~/.tauri/gitolotl.key
```

Then paste the printed public key into `plugins.updater.pubkey`.

### 2. GitHub secrets

In the repository's **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | The full contents of `~/.tauri/gitolotl.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The key's password (empty if the key has none) |

Until these exist the release workflow fails at the bundling step. Publishing the release itself uses the
workflow's own short-lived token, so no personal access token is needed. Secrets are never given to
workflows started from a fork's pull request.

## Cutting a release

1. Set the same new version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json` and
   `package-lock.json`, and add a `## x.y.z` section to `CHANGELOG.md`. That section becomes the
   "What's new" text on the release page and in the in-app update prompt.
2. Commit, then tag and push:

```bash
git tag v0.2.0
```

```bash
git push origin main v0.2.0
```

3. Watch the **release** workflow. It refuses to run if the tag does not match the app
   version. It creates the release as a **draft**, lets every platform upload into it, writes the update
   manifest from the signed packages (failing if any platform is missing), and only then publishes. If
   one platform fails, the draft stays hidden and existing users keep seeing the previous version:
   re-run the failed jobs and `publish` runs again after them. A new package file also needs a line in
   the table at the top of `scripts/make-manifest.mjs`.
4. The release description is generated: your changelog section, then a plain-language download table
   with one link per platform. Download files are named by the `asset` pattern of each matrix entry in
   `release.yml` (for example `Gitolotl-0.2.0-Windows-setup.exe`). The text of the release body is what users see in the update
   prompt.

The updater reads the *latest published, non-prerelease* release. Mark a release as a prerelease to keep
it away from existing users.

## Building installers locally

Bundling needs the signing key in the environment.

PowerShell:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\gitolotl.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run tauri build
```

bash:

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/gitolotl.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run tauri build
```

Output lands in `src-tauri/target/release/bundle/`. To compile without bundling (no key needed), which
is what the regular CI build does:

```bash
npm run tauri build -- --no-bundle
```

## OS code signing

Update signing (above) proves an update came from us. It is separate from the operating system's own
code signing, which is **not set up yet**:

- **Windows**: without an Authenticode certificate, SmartScreen warns on first run ("More info → Run
  anyway"). Fix by buying a code-signing certificate (or using Azure Trusted Signing) and setting
  `bundle.windows.certificateThumbprint` or a `signCommand`.
- **macOS**: without a Developer ID certificate and notarization, Gatekeeper blocks the app until the
  user right-clicks → Open. Fix by adding the `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` secrets, which
  `tauri-action` picks up automatically.
- **Linux**: nothing required.

## Testing the updater

The update check is skipped in `npm run tauri dev`. To test end to end, install a build of version N,
publish a release of version N+1, and launch the installed app; or use **Check for updates** on the
welcome screen or in the command palette.

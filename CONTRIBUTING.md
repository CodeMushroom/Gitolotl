# Contributing to Gitolotl

Thanks for wanting to help. Gitolotl is made by CodeMushroom and licensed under [Apache 2.0](LICENSE).

## Before you start

- **Bugs and small fixes:** open an issue or send a pull request directly.
- **New features:** open an issue first. Gitolotl deliberately stays small, and a feature that is not
  agreed beforehand may be declined however well it is built.

## The rule that matters most

**Gitolotl must never damage a repository.** Read [docs/SAFETY.md](docs/SAFETY.md) before touching
`src-tauri/src/git.rs`. In short:

- Anything that can lose work (commits, uncommitted changes, refs, stashes) must save a backup snapshot
  first, and must refuse to run if the snapshot fails.
- A new destructive command needs a case in the `destructive_operations_are_recoverable` test.
- Reading must never write. Commands that only look at a repository must not change it.
- Arguments that reach `git` must be validated, and `git` is never run through a shell.

## Building and testing

You need Node 22+, npm 11+, Rust (stable) and `git` 2.31+. See the [README](README.md) for platform
packages.

```bash
npm install
npm run tauri dev
```

Before sending a pull request, all of these must pass:

```bash
npx tsc --noEmit
node scripts/test-lines-patch.mjs
cd src-tauri && cargo test --lib
```

## Sign your commits off

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/):
by adding a `Signed-off-by` line you state that you wrote the change, or have the right to submit it, and
that it may be distributed under Apache 2.0.

```bash
git commit -s
```

## AI-assisted contributions

Welcome, and fitting for this project. You are responsible for what you submit: read it, test it, and keep
the `Co-authored-by` trailer your tool adds so the history stays honest.

## Security issues

Please do not open a public issue for a vulnerability. Use GitHub's **Report a vulnerability** button on
the repository's Security tab.

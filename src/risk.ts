import type { FileDiff } from "./diff";

export interface Risk { label: string; why: string }

const SECRET_ASSIGN = /(api[_-]?key|secret|passw(?:or)?d|token|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i;
const SECRET_SHAPE = /[a-z][a-z0-9+.-]*:\/\/[^\s:@\/"']+:[^\s:@\/"']{4,}@[^\s"']+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/;

/**
 * Things in a change that deserve a second look, especially when an agent
 * wrote it. Purely local pattern checks: a hint, never a verdict.
 */
export function fileRisks(path: string, d: FileDiff): Risk[] {
  const risks: Risk[] = [];
  const p = path.toLowerCase();
  let add = 0;
  let del = 0;
  let secret = false;
  let installScript = false;
  for (const h of d.hunks) {
    for (const l of h.lines) {
      if (l.type === "-") del++;
      if (l.type !== "+") continue;
      add++;
      if (!secret && (SECRET_SHAPE.test(l.text) || SECRET_ASSIGN.test(l.text))) secret = true;
      if (!installScript && /"(pre|post)install"\s*:/.test(l.text)) installScript = true;
    }
  }
  const deleted = d.header.some((l) => l.startsWith("deleted file mode"));
  const isTest = /(^|\/)(tests?|specs?|__tests__)\/|[._-](test|spec)\.[a-z]+$/.test(p);

  if (secret) risks.push({ label: "Possible secret", why: "An added line looks like a credential or private key." });
  if (/(^|\/)\.env(\.|$)/.test(p)) risks.push({ label: "Env file", why: "Environment files often hold secrets and should rarely be committed." });
  if (/^\.github\/workflows\/|\.gitlab-ci\.yml$|(^|\/)jenkinsfile$|azure-pipelines|(^|\/)\.circleci\//.test(p)) risks.push({ label: "CI config", why: "Changes what runs automatically with your repository's secrets." });
  if (installScript || /(^|\/)(\.husky|\.githooks)\//.test(p)) risks.push({ label: "Runs on install", why: "Adds a script that executes on install or on git hooks." });
  if (/(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.lock|go\.sum|poetry\.lock|gemfile\.lock|composer\.lock)$/.test(p)) risks.push({ label: "Lockfile", why: "Dependency versions changed; check it matches an intended upgrade." });
  else if (/(^|\/)(package\.json|cargo\.toml|go\.mod|pyproject\.toml|gemfile|composer\.json|requirements[^/]*\.txt)$/.test(p)) risks.push({ label: "Dependencies", why: "Adds, removes or changes a dependency." });
  if (/(^|\/)migrations?\//.test(p) || p.endsWith(".sql")) risks.push({ label: "Migration / SQL", why: "Schema or data changes are hard to roll back." });
  if (!isTest && /auth|login|session|permission|crypto|security|oauth|jwt|password/.test(p)) risks.push({ label: "Auth / security", why: "Touches code that guards access." });
  if (isTest && (deleted || (del >= 5 && del > add * 2))) risks.push({ label: "Tests removed", why: "Tests were deleted or cut back, which can hide a regression." });
  else if (!isTest && del >= 200 && del > add * 3) risks.push({ label: "Large deletion", why: `${del} lines removed.` });
  return risks;
}

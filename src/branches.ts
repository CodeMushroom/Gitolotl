// Which branches are a repository's "primary" ones: the long-lived branches work starts from
// and returns to. They are pinned to the top of branch lists.

/** Conventional names, in the order they are shown after the remote's default branch. */
const PRIMARY = ["main", "master", "trunk", "staging", "develop", "development", "dev", "production", "prod"];

/** "origin/main" -> "main" */
export const defaultName = (remoteDefault: string | null) =>
  remoteDefault ? remoteDefault.slice(remoteDefault.indexOf("/") + 1) : null;

/** 0 for the default branch, 1.. for other conventional names, -1 for ordinary branches. */
export const primaryRank = (short: string, remoteDefault: string | null) => {
  if (short === defaultName(remoteDefault)) return 0;
  const i = PRIMARY.indexOf(short.toLowerCase());
  return i < 0 ? -1 : i + 1;
};

/** Primary branches first (by rank), then everything else in its existing order. */
export function primaryFirst<T>(items: T[], name: (t: T) => string, remoteDefault: string | null): { pinned: T[]; rest: T[] } {
  const ranked = items.map((t) => ({ t, r: primaryRank(name(t), remoteDefault) }));
  return {
    pinned: ranked.filter((x) => x.r >= 0).sort((a, b) => a.r - b.r).map((x) => x.t),
    rest: ranked.filter((x) => x.r < 0).map((x) => x.t),
  };
}

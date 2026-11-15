// Append-only paths: files a base's lanes only ever add to the end of (Serenity's docs/LOG.md, where
// every landing writes its entry). Two landings that each append are not in conflict: the merged file is
// the base head plus the proposal's appended tail. Anything else on such a path (an edit above the end,
// a deletion, a file both sides created) is still a conflict. Pure string logic, worker-safe: the
// decision (decide.ts) computes the merge and both mergers check it again before they write it.

/** Paths treated as append-only on every base when the gate is given no list of its own. */
export const DEFAULT_APPEND_ONLY_PATHS: readonly string[] = ["docs/LOG.md"];

/** Where a base names its own append-only paths, read at the base head: `{"appendOnly": ["docs/LOG.md"]}`. */
export const BASE_GATE_CONFIG_PATH = ".foundry/gate.json";

const MAX_PATHS = 64;

function cleanPaths(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const p = v.trim();
    // Exact repo-relative file paths only: no globs, no directories, nothing that escapes the tree.
    if (!p || p.length > 1024 || p.startsWith("/") || p.endsWith("/") || /[*?\[\\\x00-\x1f\x7f]/.test(p)) continue;
    if (p.split("/").some((s) => s === "" || s === "." || s === "..")) continue;
    if (!out.includes(p)) out.push(p);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

/**
 * The gate-wide list from its environment (GATE_APPEND_ONLY_PATHS): comma or newline separated paths.
 * Unset means DEFAULT_APPEND_ONLY_PATHS; an empty value turns the gate-wide list off (bases can still
 * name their own).
 */
export function appendOnlyPathsFrom(value: string | undefined | null): string[] {
  if (value === undefined || value === null) return [...DEFAULT_APPEND_ONLY_PATHS];
  return cleanPaths(value.split(/[,\n]/));
}

/** A base's own list from BASE_GATE_CONFIG_PATH. Absent, malformed or wrongly shaped config names none. */
export function baseAppendOnlyPaths(configText: string | null): string[] {
  if (configText === null) return [];
  try {
    const parsed = JSON.parse(configText) as { appendOnly?: unknown };
    return Array.isArray(parsed?.appendOnly) ? cleanPaths(parsed.appendOnly) : [];
  } catch {
    return [];
  }
}

/** True when `after` is `before` with text added at a line boundary (or nothing added). */
function appendsTo(before: string, after: string): boolean {
  if (!after.startsWith(before)) return false;
  if (after.length === before.length || before === "" || before.endsWith("\n")) return true;
  return after[before.length] === "\n";
}

/** The appended text of `after` over `before`, without the blank lines it starts with. */
function tailOf(before: string, after: string): string {
  return after.slice(before.length).replace(/^\n+/, "");
}

/** The separator between existing text and an appended entry: one blank line. */
function separatorAfter(text: string): string {
  if (text === "" || text.endsWith("\n\n")) return "";
  return text.endsWith("\n") ? "\n" : "\n\n";
}

/**
 * The merge of an append-only file, or null when it is a real conflict.
 *
 * `forkPoint` is the file at the ticket's fork point, `base` at the base head, `fork` at the proposal.
 * Both sides must be the fork-point text plus appended text. The result is the base head unchanged plus
 * the proposal's tail after a blank line. When the base's own additions already hold that tail (the same
 * entry landed under an earlier push of the change), the result is the base head: an entry never lands twice.
 */
export function mergeAppendOnly(forkPoint: string, base: string, fork: string): string | null {
  if (!appendsTo(forkPoint, base) || !appendsTo(forkPoint, fork)) return null;
  if (base === forkPoint) return fork;
  const tail = tailOf(forkPoint, fork);
  if (tail === "") return base;
  if (base.slice(forkPoint.length).includes(tail.trim())) return base;
  return base + separatorAfter(base) + tail;
}

/**
 * The merger's own check of a merge it is handed: `merged` must be the base head's text unchanged followed
 * only by a tail of the proposal's text. It cannot see the fork point, so it proves the two properties
 * that matter for what lands: nothing on the base is lost or rewritten, and nothing is added that the
 * proposal does not end with.
 */
export function isAppendMergeOf(base: string, fork: string, merged: string): boolean {
  if (!merged.startsWith(base)) return false;
  return fork.endsWith(merged.slice(base.length).replace(/^\n+/, ""));
}

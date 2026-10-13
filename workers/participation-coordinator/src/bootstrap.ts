// First-run prescription for the Participation Network.
//
// "Build it from the ground up, assuming I am the first user" = the coordinator
// ships with one *prescribed* account and the base objects it owns, so a fresh
// database is already usable: the first user exists, has a series and a home
// sphere, is subscribed, and every device that recovers with the matching
// account hint lands in that same actor.
//
// Everything here is idempotent and re-runnable. `resetStatements()` clears the
// derived tables (never the consent instruments) so the prescription can be laid
// down on a clean slate.
import { Db } from "./store.js";
import { iso } from "./canonical.js";

export interface PrescribedFirstUser {
  /** Stable actor id for the first user. */
  actorID: string;
  accountID: string;
  /**
   * The account hint the app sends on recovery. `complete_actor_recovery`
   * matches an existing actor by `display_name == accountHint`, so this value
   * must equal the app's default (`participation.dev.actorID`).
   */
  displayName: string;
  roles: string[];
  seriesID: string;
  seriesTitle: string;
  seriesSummary: string;
  sphereID: string;
  sphereTitle: string;
  sphereSummary: string;
}

export const DEFAULT_FIRST_USER: PrescribedFirstUser = {
  actorID: "actor-mo-0001",
  accountID: "account-mo-0001",
  displayName: "mo-motionmix",
  roles: ["organizer", "participant", "viewer"],
  seriesID: "series-mo-0001",
  seriesTitle: "Motion Mix Sessions",
  seriesSummary: "Mo's default participation series.",
  sphereID: "sphere-mo-studio",
  sphereTitle: "Studio",
  sphereSummary: "The first participation sphere.",
};

/** Derived tables cleared by a reset. Consent instruments are preserved. */
export const RESET_TABLES = [
  "admission_receipts", "audit_log", "challenges", "consents", "device_sessions",
  "devices", "handoffs", "idempotency", "join_attempts", "memberships", "series",
  "sessions", "sources", "spheres", "subscriptions", "token_nonces", "actors",
] as const;

export interface Statement { sql: string; params: unknown[] }

export function resetStatements(): Statement[] {
  return RESET_TABLES.map((t) => ({ sql: `DELETE FROM ${t};`, params: [] }));
}

const sorted = (xs: string[]) => [...new Set(xs)].sort();

export function bootstrapStatements(
  user: PrescribedFirstUser = DEFAULT_FIRST_USER,
  now: string = iso(new Date()),
): Statement[] {
  const roles = JSON.stringify(sorted(user.roles));
  return [
    // The first user. Re-running keeps it canonical (name + roles), never duplicates.
    { sql:
      `INSERT INTO actors (actor_id,account_id,display_name,roles_json,created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(actor_id) DO UPDATE SET display_name=excluded.display_name, roles_json=excluded.roles_json`,
      params: [user.actorID, user.accountID, user.displayName, roles, now] },
    // A default series the first user organizes.
    { sql:
      `INSERT INTO series (series_id,organizer_actor_id,title,summary,next_occurrence_at,created_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(series_id) DO NOTHING`,
      params: [user.seriesID, user.actorID, user.seriesTitle, user.seriesSummary, null, now] },
    // A home sphere under that series.
    { sql:
      `INSERT INTO spheres (sphere_id,series_id,organizer_actor_id,title,summary,starts_at,capacity_remaining,created_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(sphere_id) DO NOTHING`,
      params: [user.sphereID, user.seriesID, user.actorID, user.sphereTitle, user.sphereSummary, null, null, now] },
    // The first user is subscribed to their own series.
    { sql:
      `INSERT INTO subscriptions (subscription_id,actor_id,series_id,is_active,updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(actor_id,series_id) DO UPDATE SET is_active=excluded.is_active, updated_at=excluded.updated_at`,
      params: [`sub-${user.actorID}-${user.seriesID}`, user.actorID, user.seriesID, 1, now] },
  ];
}

export interface BootstrapReport {
  actorID: string;
  displayName: string;
  seriesID: string;
  sphereID: string;
  statements: number;
}

export async function bootstrapFirstUser(
  db: Db,
  user: PrescribedFirstUser = DEFAULT_FIRST_USER,
  now: string = iso(new Date()),
): Promise<BootstrapReport> {
  const statements = bootstrapStatements(user, now);
  for (const s of statements) await db.run(s.sql, s.params);
  return {
    actorID: user.actorID, displayName: user.displayName,
    seriesID: user.seriesID, sphereID: user.sphereID, statements: statements.length,
  };
}

/** True when the prescribed first user already exists (idempotency check). */
export async function firstUserExists(db: Db, user: PrescribedFirstUser = DEFAULT_FIRST_USER): Promise<boolean> {
  const row = await db.get<{ actor_id: string }>(`SELECT actor_id FROM actors WHERE actor_id=?`, [user.actorID]);
  return !!row;
}

/**
 * Prescribe the first user only when the database has no actors at all — the
 * true first-run case. Safe to call on every worker boot: once any actor exists
 * (even a real invited one) this is a single COUNT and a no-op, so it never
 * overwrites a live account.
 */
export async function ensureFirstUser(
  db: Db,
  user: PrescribedFirstUser = DEFAULT_FIRST_USER,
  now: string = iso(new Date()),
): Promise<BootstrapReport | null> {
  const row = await db.get<{ n: number }>(`SELECT count(*) AS n FROM actors`);
  if ((row?.n ?? 0) > 0) return null;
  return bootstrapFirstUser(db, user, now);
}

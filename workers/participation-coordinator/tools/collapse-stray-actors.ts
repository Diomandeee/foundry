// Print (never run) the SQL that collapses bring-up residue in the live D1:
// actors other than the prescribed first user that organize nothing, hold no
// consents and no sources, plus devices that never bound to an actor. The
// output is meant to be reviewed and then applied through a gated, receipted
// step — not from a login shell.
//
//   npx tsx tools/collapse-stray-actors.ts > /tmp/collapse.sql
//
// Review the SELECTs first (they list what the DELETEs will remove):
//   wrangler d1 execute participation --remote --command "<the SELECT>"
import { DEFAULT_FIRST_USER } from "../src/bootstrap.js";

const keep = DEFAULT_FIRST_USER.actorID;
const strayActors = `
  SELECT a.actor_id FROM actors a
   WHERE a.actor_id <> '${keep}'
     AND NOT EXISTS (SELECT 1 FROM spheres s WHERE s.organizer_actor_id = a.actor_id)
     AND NOT EXISTS (SELECT 1 FROM series  r WHERE r.organizer_actor_id = a.actor_id)
     AND NOT EXISTS (SELECT 1 FROM memberships m JOIN consents c ON c.membership_id = m.membership_id WHERE m.actor_id = a.actor_id)
     AND NOT EXISTS (SELECT 1 FROM memberships m JOIN sources  o ON o.membership_id = m.membership_id WHERE m.actor_id = a.actor_id)`;

const out = [
  `-- review: stray actors`,
  `SELECT * FROM actors WHERE actor_id IN (${strayActors});`,
  `-- review: devices never bound`,
  `SELECT * FROM devices WHERE actor_id IS NULL;`,
  `-- apply (in this order)`,
  `DELETE FROM admission_receipts WHERE actor_id IN (${strayActors});`,
  `DELETE FROM sessions WHERE actor_id IN (${strayActors});`,
  `DELETE FROM memberships WHERE actor_id IN (${strayActors});`,
  `DELETE FROM subscriptions WHERE actor_id IN (${strayActors});`,
  `DELETE FROM device_sessions WHERE actor_id IN (${strayActors}) OR actor_id IS NULL;`,
  `DELETE FROM devices WHERE actor_id IN (${strayActors}) OR actor_id IS NULL;`,
  `DELETE FROM actors WHERE actor_id IN (${strayActors});`,
];
console.log(out.join("\n"));

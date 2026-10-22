// v2 test helpers: the two things every flow now needs before it can touch an
// actor or a sphere — a recovery grant and an invitation.
import { Db } from "../src/store.js";
import { issueRecoveryGrant } from "../src/security.js";
import { provePossession, proveAdmission } from "./p256.js";

/** Operator-style grant straight into the store (what Fabric will issue). */
export async function operatorGrant(db: Db, actorID: string, now: string, ttlSeconds?: number): Promise<string> {
  return (await issueRecoveryGrant(db, actorID, "operator", "test-operator", now, ttlSeconds)).recoverySecret;
}

/** Full recovery round trip for a device with a grant secret. */
export async function recoverWith(callf: (op: string, p: any) => Promise<any>, dev: any, recoverySecret: string, accountHint = "test-hint") {
  const begin = await callf("begin_actor_recovery", { accountHint, deviceKey: dev, recoverySecret });
  if (!begin.ok) return { begin, done: begin };
  const proof = {
    challengeID: begin.payload.challengeID, purpose: "account_recovery", keyID: dev.keyID,
    algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(dev._pair, begin.payload),
  };
  const done = await callf("complete_actor_recovery", { request: { accountHint, deviceKey: dev, recoverySecret }, proof });
  return { begin, done };
}

/** Organizer mints an invitation for a sphere. */
export async function invite(callf: (op: string, p: any) => Promise<any>, sphereID: string, extra: Record<string, unknown> = {}) {
  const r = await callf("create_invitation", { sphereID, role: "participant", idempotencyKey: `inv-${crypto.randomUUID()}`, ...extra });
  if (!r.ok) throw new Error(`create_invitation failed: ${JSON.stringify(r.failure)}`);
  return r.payload as { invitationID: string; sphereID: string; role: string; grantedScopes: string[]; reference: string; expiresAt: string; maxUses: number; url: string };
}

/** Full admission round trip for a device with an invitation. */
export async function admitWith(callf: (op: string, p: any) => Promise<any>, dev: any, inv: { sphereID: string; reference: string; role: string }) {
  const adm = await callf("begin_admission", { invitation: { sphereID: inv.sphereID, joinAttemptReference: inv.reference, requestedRole: inv.role }, deviceKey: dev });
  if (!adm.ok) return { adm, receipt: adm };
  const proof = { challengeID: adm.payload.challengeID, purpose: "admission", keyID: dev.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await proveAdmission(dev._pair, adm.payload) };
  const receipt = await callf("complete_admission", proof);
  return { adm, receipt };
}

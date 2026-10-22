// Operator recovery grant: the server half of the Fabric-approved path.
//
//   OPERATOR_BEARER=... npx tsx tools/operator-grant.ts https://<origin> actor-mo-0001 [ttlSeconds]
//
// Prints the single-use secret once. The bearer is compared by sha256 digest on
// the server (OPERATOR_BEARER_SHA256); it must never live in a login account —
// in production it is used by a fleet-authority template the phone approves.
export async function operatorGrant(base: string, bearer: string, actorID: string, ttlSeconds?: number, label = "operator-cli") {
  const res = await fetch(`${base.replace(/\/$/, "")}/participation/v1/operator/recovery-grant`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ actorID, ttlSeconds, label }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!body?.ok || typeof body.recoverySecret !== "string") throw new Error(`operator grant failed (${res.status}): ${JSON.stringify(body)}`);
  return body as { grantID: string; actorID: string; recoverySecret: string; expiresAt: string; issuedBy: "operator" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [base, actorID, ttl] = process.argv.slice(2);
  const bearer = process.env.OPERATOR_BEARER;
  if (!base || !actorID || !bearer) {
    console.error("usage: OPERATOR_BEARER=... tsx tools/operator-grant.ts <origin> <actorID> [ttlSeconds]");
    process.exit(2);
  }
  operatorGrant(base, bearer, actorID, ttl ? Number(ttl) : undefined)
    .then((g) => { console.log(JSON.stringify(g, null, 2)); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}

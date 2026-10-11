// Participation -> Knowledge Graph emission.
//
// The canonical triple shapes live in @foundry/lkg-client (packages/lkg-client/
// src/triples.ts); this file adds the participation namespaces on top of the same
// NewTriple wire shape so readers (overlap oracle, board) can join on them.
// Namespaces used here: actor:<id>, account:<id>, sphere:<id>, membership:<id>,
// source:<id>, consent:<id>.
//
// Emission is opt-in: with no emitter configured the coordinator is a pure
// function of its database and never touches the network (CI/offline default).
export interface NewTriple {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
  source?: string;
}

export interface GraphEmitter {
  emit(triples: NewTriple[]): Promise<void>;
}

const T = (subject: string, predicate: string, object: string): NewTriple => ({
  subject, predicate, object, source: "participation",
});

/** Derive the graph facts a successful operation just committed. */
export function graphTriples(operation: string, payload: any): NewTriple[] {
  if (!payload) return [];
  switch (operation) {
    case "complete_actor_recovery":
      return [T(`actor:${payload.actorID}`, "recovered_on_account", `account:${payload.accountID}`)];
    case "complete_admission":
      return [
        T(`actor:${payload.actorID}`, "admitted_to", `sphere:${payload.sphereID}`),
        T(`membership:${payload.membershipID}`, "member_of", `sphere:${payload.sphereID}`),
        T(`membership:${payload.membershipID}`, "member_state", payload.membershipState),
        ...(payload.grantedScopes ?? []).map((s: string) => T(`membership:${payload.membershipID}`, "granted_scope", s)),
      ];
    case "append_consent":
      return (Array.isArray(payload) ? payload : [payload]).map((r: any) =>
        T(`membership:${r.membershipID}`, `consent:${r.purpose}`, `${r.decision}@${r.revision}`));
    case "revoke_consent":
      return [T(`membership:${payload.membershipID}`, `consent:${payload.purpose}`, `revoked@${payload.revision}`)];
    case "register_source":
      return [T(`sphere:${payload.sphereID}`, "has_source", `source:${payload.sourceID}`)];
    case "exchange_full_app_handoff":
    case "resume_full_app_session":
      return [T(`actor:${payload.admission?.actorID}`, "active_session_on", `sphere:${payload.admission?.sphereID}`)];
    default:
      return [];
  }
}

/** POSTs triples to a Live Knowledge Graph REST API (K11). Same body shape the
 *  foundry gate/orchestrator write via @foundry/lkg-client's KGClient.addTriple. */
export class HttpGraphEmitter implements GraphEmitter {
  constructor(private baseURL: string, private token?: string) {}
  async emit(triples: NewTriple[]): Promise<void> {
    for (const t of triples) {
      const res = await fetch(`${this.baseURL.replace(/\/$/, "")}/triples`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(t),
      });
      if (!res.ok) throw new Error(`kg addTriple failed: ${res.status}`);
    }
  }
}

/** Test/dev emitter that just records what would have been written. */
export class RecordingGraphEmitter implements GraphEmitter {
  readonly triples: NewTriple[] = [];
  async emit(triples: NewTriple[]): Promise<void> { this.triples.push(...triples); }
}

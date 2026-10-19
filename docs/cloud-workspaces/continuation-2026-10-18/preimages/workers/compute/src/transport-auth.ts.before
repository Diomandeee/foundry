import { createHash, timingSafeEqual } from 'node:crypto';

export type TransportActor = {
  principal: string;
  role: 'owner' | 'executor' | 'verifier' | 'projector' | 'submitter';
};

type Entry = TransportActor & { tokenSha256: string; environment: string };
const identifier = /^[A-Za-z0-9._-]{1,64}(?![\s\S])/;
const roles = new Set(['owner', 'executor', 'verifier', 'projector', 'submitter']);
const fields = ['tokenSha256', 'principal', 'role', 'environment'];
const validIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && identifier.test(value);
const reject = (): never => { throw new Error('Unauthorized'); };

/** Host-configured identities only. Bearers are hashed in memory and never retained. */
export function authenticate(request: Request, configJSON: string, environment: string): TransportActor {
  // Validate the entire configuration before selecting any identity, including other environments.
  let entries: Entry[];
  try {
    if (typeof configJSON !== 'string' || !validIdentifier(environment)) return reject();
    const parsed: unknown = JSON.parse(configJSON);
    if (!Array.isArray(parsed)) return reject();
    const seen = new Set<string>();
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          Object.keys(entry).length !== fields.length ||
          !fields.every(key => Object.hasOwn(entry, key)) ||
          typeof entry.tokenSha256 !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(entry.tokenSha256) ||
          !validIdentifier(entry.principal) || !validIdentifier(entry.environment) ||
          typeof entry.role !== 'string' || !roles.has(entry.role) || seen.has(entry.tokenSha256)) {
        return reject();
      }
      seen.add(entry.tokenSha256);
    }
    entries = parsed as Entry[];
  } catch {
    return reject();
  }

  // Fetch Headers merges duplicate Authorization fields with commas, which this grammar rejects.
  const authorization = request.headers.get('authorization');
  const bearer = authorization && /^Bearer ([A-Za-z0-9._~+/-]{32,}=*)(?![\s\S])/i.exec(authorization);
  if (!bearer) return reject();
  const digest = createHash('sha256').update(bearer[1], 'utf8').digest();
  let actor: TransportActor | undefined;
  for (const entry of entries) {
    const matches = timingSafeEqual(digest, Buffer.from(entry.tokenSha256, 'hex'));
    if (matches && entry.environment === environment) {
      actor = { principal: entry.principal, role: entry.role };
    }
  }
  return actor ?? reject();
}

/** Strict header grammar shared with durable managed enrollment; never persists the bearer. */
export function credentialDigest(request:Request):string {
 const value=request.headers.get('authorization');
 const bearer=value&&/^Bearer ([A-Za-z0-9._~+/-]{32,}=*)(?![\s\S])/i.exec(value);
 if(!bearer)throw new Error('Unauthorized');
 return createHash('sha256').update(bearer[1],'utf8').digest('hex');
}

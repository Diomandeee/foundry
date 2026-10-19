/** Fixed schema; constructor compares sqlite_schema against a fresh reference before any write. */
export const SCHEMA = `
CREATE TABLE binding (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL) STRICT;
CREATE TABLE clock (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL CHECK(value>=0)) STRICT;
CREATE TABLE grants (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)), budget INTEGER NOT NULL CHECK(budget>=0),
 CHECK(json_extract(body,'$.grantId') IS id), CHECK(json_extract(body,'$.byteBudget') IS budget)) STRICT;
CREATE TABLE reads (grant_id TEXT NOT NULL REFERENCES grants(id), request_id TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size>=0), state TEXT NOT NULL CHECK(state IN ('reserved','completed','unknown')), bytes BLOB,
 PRIMARY KEY(grant_id,request_id), CHECK((state='completed' AND bytes IS NOT NULL AND length(bytes)=size) OR (state!='completed' AND bytes IS NULL))) STRICT;
CREATE TABLE revoked (id TEXT PRIMARY KEY, binding TEXT NOT NULL CHECK(json_valid(binding))) STRICT;
CREATE TABLE revocation_commands (key TEXT PRIMARY KEY, command TEXT NOT NULL CHECK(json_valid(command)), reply TEXT NOT NULL CHECK(json_valid(reply)),
 CHECK(json_extract(command,'$.key') IS key), CHECK(json_extract(reply,'$.key') IS key),
 CHECK(json_extract(reply,'$.grantId') IS json_extract(command,'$.grantId')), CHECK(json_extract(reply,'$.evidenceId') IS json_extract(command,'$.evidenceId'))) STRICT;
CREATE TRIGGER clock_update BEFORE UPDATE ON clock WHEN NEW.id!=OLD.id OR NEW.value<OLD.value BEGIN SELECT RAISE(ABORT,'clock regression'); END;
CREATE TRIGGER grant_limit BEFORE INSERT ON grants BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM grants)>=json_extract((SELECT value FROM binding),'$.limits.maxGrants') THEN RAISE(ABORT,'grant capacity') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM revoked WHERE id=NEW.id) THEN RAISE(ABORT,'revoked') END;
END;
CREATE TRIGGER read_insert BEFORE INSERT ON reads BEGIN
 SELECT CASE WHEN NEW.state!='reserved' OR NEW.bytes IS NOT NULL THEN RAISE(ABORT,'reservation required') END;
 SELECT CASE WHEN NEW.size!=json_extract((SELECT body FROM grants WHERE id=NEW.grant_id),'$.object.sizeBytes') THEN RAISE(ABORT,'read size') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM revoked WHERE id=NEW.grant_id) THEN RAISE(ABORT,'revoked') END;
 SELECT CASE WHEN (SELECT count(*) FROM reads)>=json_extract((SELECT value FROM binding),'$.limits.maxReads') THEN RAISE(ABORT,'read capacity') END;
 SELECT CASE WHEN (SELECT count(*) FROM reads WHERE state!='completed')>=json_extract((SELECT value FROM binding),'$.limits.maxActiveReads') THEN RAISE(ABORT,'unresolved provider capacity') END;
 SELECT CASE WHEN NEW.size>json_extract((SELECT value FROM binding),'$.limits.maxReadBytes') OR NEW.size+coalesce((SELECT sum(size) FROM reads),0)>json_extract((SELECT value FROM binding),'$.limits.maxStoredBytes') THEN RAISE(ABORT,'storage capacity') END;
 SELECT CASE WHEN NEW.size+coalesce((SELECT sum(size) FROM reads WHERE grant_id=NEW.grant_id),0)>(SELECT budget FROM grants WHERE id=NEW.grant_id) THEN RAISE(ABORT,'byte budget') END;
END;
CREATE TRIGGER read_update BEFORE UPDATE ON reads BEGIN
 SELECT CASE WHEN NEW.grant_id!=OLD.grant_id OR NEW.request_id!=OLD.request_id OR NEW.size!=OLD.size OR OLD.state!='reserved' OR NEW.state NOT IN ('completed','unknown') THEN RAISE(ABORT,'immutable read') END;
 SELECT CASE WHEN NEW.state='completed' AND EXISTS(SELECT 1 FROM revoked WHERE id=OLD.grant_id) THEN RAISE(ABORT,'revoked') END;
END;
CREATE TRIGGER revoke_limit BEFORE INSERT ON revoked BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM grants WHERE id=NEW.id) AND (SELECT count(*) FROM revoked WHERE id NOT IN (SELECT id FROM grants))>=json_extract((SELECT value FROM binding),'$.limits.maxPreemptiveRevocations') THEN RAISE(ABORT,'preemptive revocation capacity') END;
END;
CREATE TRIGGER command_limit BEFORE INSERT ON revocation_commands BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM revocation_commands)>=json_extract((SELECT value FROM binding),'$.limits.maxRevocationCommands') + json_extract((SELECT value FROM binding),'$.limits.maxGrants') + json_extract((SELECT value FROM binding),'$.limits.maxPreemptiveRevocations') THEN RAISE(ABORT,'revocation capacity') END;
END;
`;
// Explicit insert guards prohibit INSERT OR REPLACE regardless of connection recursive_triggers.
export const GUARDS = ['binding','clock','grants','reads','revoked','revocation_commands'].map(table => {
  const identity = table === 'reads' ? 'grant_id=NEW.grant_id AND request_id=NEW.request_id' : `${table === 'revocation_commands' ? 'key' : 'id'}=NEW.${table === 'revocation_commands' ? 'key' : 'id'}`;
  return `CREATE TRIGGER ${table}_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${identity}) BEGIN SELECT RAISE(ABORT,'replacement forbidden'); END;
CREATE TRIGGER ${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'deletion forbidden'); END;
${table === 'reads' || table === 'clock' ? '' : `CREATE TRIGGER ${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END;`}`;
}).join('\n');

/** Dedicated namespace, exact schema checked on reopen; never auto-repair evidence. */
const tables = [
  `CREATE TABLE library_catalog_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), binding TEXT NOT NULL CHECK(length(CAST(binding AS BLOB))<=2048))`,
  `CREATE TABLE library_catalog_records (seq INTEGER PRIMARY KEY CHECK(seq BETWEEN 1 AND 225), kind TEXT NOT NULL CHECK(kind IN ('intent','authorization','cancellation','revocation','transferAttestation','snapshot','verification','candidate','promotion')), id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 128), principal TEXT NOT NULL CHECK(length(principal) BETWEEN 1 AND 96), at INTEGER NOT NULL CHECK(at>=0), body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=1792), UNIQUE(kind,id))`,
  `CREATE TABLE library_catalog_commands (seq INTEGER PRIMARY KEY CHECK(seq BETWEEN 1 AND 1057), key TEXT NOT NULL UNIQUE CHECK(length(key) BETWEEN 1 AND 96), digest TEXT NOT NULL CHECK(length(digest)=64), control INTEGER NOT NULL CHECK(control IN (0,1)), actor TEXT NOT NULL CHECK(length(CAST(actor AS BLOB))<=1024), request TEXT NOT NULL CHECK(length(CAST(request AS BLOB))<=8192), reply TEXT NOT NULL CHECK(length(CAST(reply AS BLOB))<=1024), at INTEGER NOT NULL CHECK(at>=0))`,
];
export const schema = [
  ...tables,
  ...['meta','records','commands'].flatMap(t => [
    ...['UPDATE','DELETE'].map(a => `CREATE TRIGGER library_catalog_${t}_${a.toLowerCase()} BEFORE ${a} ON library_catalog_${t} BEGIN SELECT RAISE(ABORT,'immutable catalog evidence'); END`),
    `CREATE TRIGGER library_catalog_${t}_replace BEFORE INSERT ON library_catalog_${t} WHEN ${t === 'meta' ? 'EXISTS(SELECT 1 FROM library_catalog_meta)' : t === 'records' ? 'EXISTS(SELECT 1 FROM library_catalog_records WHERE seq=NEW.seq OR (kind=NEW.kind AND id=NEW.id))' : 'EXISTS(SELECT 1 FROM library_catalog_commands WHERE seq=NEW.seq OR key=NEW.key)'} BEGIN SELECT RAISE(ABORT,'immutable catalog identity'); END`,
  ]),
  `CREATE TRIGGER library_catalog_records_capacity BEFORE INSERT ON library_catalog_records WHEN (SELECT count(*) FROM library_catalog_records WHERE (kind IN ('cancellation','revocation'))=(NEW.kind IN ('cancellation','revocation')))>=CASE WHEN NEW.kind IN ('cancellation','revocation') THEN 33 ELSE 192 END BEGIN SELECT RAISE(ABORT,'catalog capacity'); END`,
  `CREATE TRIGGER library_catalog_intents_capacity BEFORE INSERT ON library_catalog_records WHEN NEW.kind='intent' AND (SELECT count(*) FROM library_catalog_records WHERE kind='intent')>=32 BEGIN SELECT RAISE(ABORT,'catalog intent capacity'); END`,
  `CREATE TRIGGER library_catalog_commands_capacity BEFORE INSERT ON library_catalog_commands WHEN (SELECT count(*) FROM library_catalog_commands WHERE control=NEW.control)>=CASE NEW.control WHEN 1 THEN 33 ELSE 1024 END BEGIN SELECT RAISE(ABORT,'catalog command capacity'); END`,
];
export const schemaObjects = schema.map(sql => ({ name: sql.split(' ')[2], sql }));

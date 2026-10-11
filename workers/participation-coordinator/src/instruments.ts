// Seed consent instruments. Production loads these from the corpus; the shape
// matches ParticipationDomain.ConsentInstrument exactly.
export const CONSENT_INSTRUMENTS = [
  ["capture_video", "Video capture", "Record video of this session on your device.",
   "You can still attend; the session will not include your camera."],
  ["live_display", "Live display", "Show your camera on the room display during the session.",
   "You can still participate; your feed is not shown live."],
  ["archival_retention", "Archive retention", "Keep the recording in the session archive.",
   "Your take is not retained after the session."],
  ["process_pose", "On-device pose processing", "Process movement on-device to drive sound and visuals.",
   "The motion-generated layer will not respond to you."],
  ["retain_raw_pose", "Raw pose retention", "Retain raw pose data beyond the session.",
   "Only derived motion features are kept."],
  ["health_inference", "Health inference", "Derive health-related signals from movement.",
   "No health inference is performed."],
  ["group_program", "Group program", "Include your movement in the group composition.",
   "You are excluded from the group program."],
  ["personal_cut", "Personal edit", "Generate a personal edit of your movement.",
   "No personal edit is generated."],
  ["movement_record", "Movement record", "Keep a record of your movement for this session.",
   "No movement record is kept."],
  ["movement_generated_score", "Movement-generated score", "Turn your movement into a music score.",
   "No movement-generated score is produced."],
  ["social_publication", "Social publication", "Publish clips of this session publicly.",
   "Nothing from your session is published."],
  ["training_use", "Model training", "Use your session data to train models.",
   "Your data is excluded from training."],
] as const;

/** sha256 of the canonical English consent language, per purpose. */
export async function instrumentRows() {
  const rows = [];
  for (const [purpose, title, explanation, consequence] of CONSENT_INSTRUMENTS) {
    const language = `${title}\n${explanation}\n${consequence}`;
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(language));
    const sha = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    rows.push({ instrument_id: `${purpose}.v1`, version: "1", purpose, locale: "en-US",
      language_sha256: sha, title, explanation, consequence_of_denial: consequence });
  }
  return rows;
}

export async function seedInstruments(db: { run: (s: string, p?: unknown[]) => Promise<void> }) {
  for (const r of await instrumentRows()) {
    await db.run(
      `INSERT INTO consent_instruments (instrument_id,version,purpose,locale,language_sha256,title,explanation,consequence_of_denial)
       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(instrument_id,version,locale) DO UPDATE SET title=excluded.title, explanation=excluded.explanation, consequence_of_denial=excluded.consequence_of_denial, language_sha256=excluded.language_sha256`,
      [r.instrument_id, r.version, r.purpose, r.locale, r.language_sha256, r.title, r.explanation, r.consequence_of_denial]);
  }
}

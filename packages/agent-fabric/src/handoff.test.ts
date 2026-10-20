import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { checkPacket, gateWrite, shapeRepair, validateHandoff, violationClass } from "./handoff";

function artifactDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-fabric-"));
  writeFileSync(join(dir, "receipt.md"), "# receipt\n");
  return dir;
}

function goodPacket(dir: string) {
  return {
    handoff_id: "test-handoff-20261020T000000Z",
    generated_at: "2026-10-20T18:00:00Z",
    lifecycle: { continuity_assumed: false },
    objective: { statement: "Port the handoff validator." },
    evidence: {
      items: [{ claim: "The port exists", artifact: join(dir, "receipt.md"), command: "ls" }],
      still_false: ["corpus parity on Mac4 and Mac5 not run"],
      open_questions: [],
    },
    next_prompt: "Run the corpus parity test.",
    stop_condition: "Verdicts match the Python validator on every file.",
  };
}

describe("checkPacket (R1-R5, Python-identical strings)", () => {
  it("passes a complete packet", () => {
    expect(checkPacket(goodPacket(artifactDir()))).toEqual([]);
  });

  it("accepts still_false and open_questions at top level too", () => {
    const p: Record<string, unknown> = goodPacket(artifactDir());
    const ev = p.evidence as Record<string, unknown>;
    p.still_false = ev.still_false; p.open_questions = ev.open_questions;
    delete ev.still_false; delete ev.open_questions;
    expect(checkPacket(p)).toEqual([]);
  });

  it("names every missing key, in order", () => {
    expect(checkPacket({})).toEqual([
      "MISSING_KEY: handoff_id", "MISSING_KEY: generated_at", "MISSING_KEY: objective",
      "MISSING_KEY: evidence", "MISSING_KEY: still_false", "MISSING_KEY: open_questions",
      "MISSING_KEY: next_prompt", "MISSING_KEY: stop_condition",
      "BAD_OBJECTIVE_STATEMENT", "NO_EVIDENCE_ITEMS", "BAD_GENERATED_AT",
    ]);
  });

  it("R2: an artifact that is not on disk fails, with the path", () => {
    const p = goodPacket(artifactDir());
    p.evidence.items[0].artifact = "/nonexistent/receipt.md";
    expect(checkPacket(p)).toEqual(["ITEM_0_ARTIFACT_MISSING: /nonexistent/receipt.md"]);
  });

  it("R2: repo-relative artifacts resolve against root; ~ expands", () => {
    const dir = artifactDir();
    const p = goodPacket(dir);
    p.evidence.items[0].artifact = "receipt.md";
    expect(checkPacket(p)).toEqual(["ITEM_0_ARTIFACT_MISSING: receipt.md"]);
    expect(checkPacket(p, dir)).toEqual([]);
    p.evidence.items[0].artifact = "~";
    expect(checkPacket(p)).toEqual([]);
    expect(existsSync(homedir())).toBe(true);
  });

  it("old park shape: evidence as a list of strings", () => {
    const park = {
      name: "x", created: "2026-09-23", state: "s", next: ["n"], status: "active",
      evidence: ["Desktop/X/a.md (thing)"], verify: [], blocked_on_mo: [],
    };
    expect(checkPacket(park)).toEqual([
      "MISSING_KEY: handoff_id", "MISSING_KEY: generated_at", "MISSING_KEY: objective",
      "MISSING_KEY: still_false", "MISSING_KEY: open_questions",
      "MISSING_KEY: next_prompt", "MISSING_KEY: stop_condition",
      "BAD_OBJECTIVE_STATEMENT", "ITEM_0_NOT_OBJECT", "BAD_GENERATED_AT",
    ]);
  });

  it("R5: done/proved language without still_false is an OVERCLAIM", () => {
    const p = goodPacket(artifactDir());
    p.evidence.items[0].claim = "Everything is DONE";
    p.evidence.still_false = [];
    expect(checkPacket(p)).toEqual(["OVERCLAIM_WITHOUT_BOUNDS"]);
    p.evidence.still_false = ["the parity run"];
    expect(checkPacket(p)).toEqual([]);
  });

  it("generated_at accepts the forms Python's fromisoformat accepts", () => {
    const p = goodPacket(artifactDir());
    for (const ok of ["2026-09-23", "2026-10-10T18:45:00Z", "2026-09-24T02:05:00+00:00", "2026-09-24 02:05:00.123456-05:00"]) {
      p.generated_at = ok;
      expect(checkPacket(p), ok).toEqual([]);
    }
    for (const bad of ["", "yesterday", "2026-13-01", "2026-02-30T00:00:00Z"]) {
      p.generated_at = bad;
      expect(checkPacket(p), bad).toEqual(["BAD_GENERATED_AT"]);
    }
  });

  it("violationClass collapses item indices", () => {
    expect(violationClass("ITEM_3_ARTIFACT_MISSING: /tmp/x")).toBe("ITEM_ARTIFACT_MISSING");
    expect(violationClass("MISSING_KEY: still_false")).toBe("MISSING_KEY");
    expect(violationClass("OVERCLAIM_WITHOUT_BOUNDS")).toBe("OVERCLAIM_WITHOUT_BOUNDS");
  });
});

describe("validateHandoff (fabric: R1-R5 + lifecycle)", () => {
  it("rejects a packet that assumes continuity", () => {
    const p = goodPacket(artifactDir());
    p.lifecycle.continuity_assumed = true as unknown as false;
    expect(validateHandoff(p)).toEqual(["CONTINUITY_ASSUMED"]);
  });
  it("rejects an unknown lookup policy", () => {
    const p = { ...goodPacket(artifactDir()), lookup_policy: { backward_lookup: "everything" } };
    expect(validateHandoff(p)).toEqual(["BAD_LOOKUP_POLICY"]);
  });
});

describe("shapeRepair and gateWrite", () => {
  it("repairs shape only: nesting, missing lists, string objective, bad date, lifecycle", () => {
    const dir = artifactDir();
    const broken = {
      handoff_id: "repair-me-0001", generated_at: "soon", objective: "Do the thing.",
      evidence: { items: [{ claim: "c", artifact: join(dir, "receipt.md") }], still_false: ["x"] },
      next_prompt: "n", stop_condition: "s",
    };
    const fixed = shapeRepair(broken, () => "2026-10-20T00:00:00Z");
    expect(fixed.objective).toEqual({ statement: "Do the thing." });
    expect(fixed.still_false).toEqual(["x"]);
    expect(fixed.open_questions).toEqual([]);
    expect(fixed.generated_at).toBe("2026-10-20T00:00:00Z");
    expect(fixed.lifecycle).toEqual({ continuity_assumed: false });
    expect(validateHandoff(fixed)).toEqual([]);
    expect(validateHandoff(broken)).not.toEqual([]); // the input is untouched
  });

  it("never invents content: a packet with no evidence is flagged, not stored", () => {
    const store = mkdtempSync(join(tmpdir(), "agent-fabric-store-"));
    const out = gateWrite(
      { handoff_id: "empty-0001", generated_at: "2026-10-20T00:00:00Z", objective: { statement: "x" }, evidence: { items: [] }, next_prompt: "n", stop_condition: "s" },
      { storeDir: store, now: () => "2026-10-20T00:00:00Z" },
    );
    expect(out.written).toBe(false);
    expect(out.path).toBe(join(store, "_flagged", "empty-0001.json"));
    expect(out.violations).toEqual(["NO_EVIDENCE_ITEMS"]);
    expect(readdirSync(store)).toEqual(["_flagged"]);
    const rec = JSON.parse(readFileSync(out.path, "utf8"));
    expect(rec.validation.verdict).toBe("FAIL");
  });

  it("stores a packet that passes after shape repair, with its validation record", () => {
    const store = mkdtempSync(join(tmpdir(), "agent-fabric-store-"));
    const dir = artifactDir();
    const out = gateWrite(
      { handoff_id: "ok-0001", generated_at: "2026-10-20T00:00:00Z", objective: "Ship it.", evidence: { items: [{ claim: "c", artifact: join(dir, "receipt.md") }] }, next_prompt: "n", stop_condition: "s" },
      { storeDir: store, now: () => "2026-10-20T00:00:00Z" },
    );
    expect(out.written).toBe(true);
    expect(out.path).toBe(join(store, "ok-0001.json"));
    const rec = JSON.parse(readFileSync(out.path, "utf8"));
    expect(rec.validation).toEqual({ at: "2026-10-20T00:00:00Z", verdict: "PASS", attempts: 1, violations: [] });
    expect(rec.lifecycle).toEqual({ continuity_assumed: false });
  });
});

// Parity with the canonical Python engine over the real park corpus. Runs only
// where both exist (Mohamed's Macs); CI has neither and skips.
const PY = join(homedir(), "Developer/UCTM-Studio/bridge/handoff/validate_handoff.py");
const PARKS = join(homedir(), "Developer/UCTM-Studio/bridge/parks");
const haveCorpus = existsSync(PY) && existsSync(PARKS);

describe.skipIf(!haveCorpus)("corpus parity with bridge/handoff/validate_handoff.py", () => {
  it("gives the same verdict and violations for every packet in bridge/parks", () => {
    let raw: string;
    try {
      raw = execFileSync("python3", [PY, PARKS, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      raw = (e as { stdout?: string }).stdout ?? "";
    }
    const py = JSON.parse(raw) as { total: number; passed: number; results: { file: string; verdict: string; violations: string[] }[] };
    expect(py.total).toBeGreaterThan(0);
    const mismatches: string[] = [];
    for (const r of py.results) {
      const packet = JSON.parse(readFileSync(join(PARKS, r.file), "utf8"));
      const ours = checkPacket(packet);
      if (JSON.stringify(ours) !== JSON.stringify(r.violations)) {
        mismatches.push(`${r.file}\n  py:  ${JSON.stringify(r.violations)}\n  ts:  ${JSON.stringify(ours)}`);
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
    expect(py.results.filter(r => r.verdict === "PASS").length).toBe(py.passed);
  });
});

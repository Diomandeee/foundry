import {DatabaseSync, type SQLInputValue} from 'node:sqlite';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {DurableAuthority} from '../../packages/compute-authority/src/durable/authority';
import {BuildAuthority} from '../../packages/build-jobs/src/authority';
import type {BuildActor, BuildCommand, InputApproval, TransactionPort} from '../../packages/build-jobs/src/contracts';
import {hash} from '../../packages/build-jobs/src/validation';
import {jobId, loadRecipes, parseRecipes, planJobs, submitBody, type MergeRow} from './plan';

const RECIPES = join(__dirname, '..', '..', 'docs', 'app-fleet', 'build-recipes.v1.json');
const sha = (n: number) => n.toString(16).padStart(40, '0');
const merge = (id: number, base: string, n = id): MergeRow => ({id, base_repo: base, merged_sha: sha(n), decided_at: '2026-11-01T00:00:00Z', task_id: `t${id}`});
const closes: (() => void)[] = [];
afterEach(() => { for (const c of closes.splice(0)) c(); });

describe('recipes', () => {
  it('validates every committed recipe with the authority validator', () => {
    const recipes = loadRecipes(RECIPES);
    expect(recipes.map(r => r.base).sort()).toEqual(['airdeck', 'comp-core']);
  });
  it('hashes comp-core exactly as the 2026-10-21 Linux pilot recorded (serverProfileHash)', () => {
    const r = loadRecipes(RECIPES).find(r => r.base === 'comp-core')!;
    expect(r.profileHash).toBe('202e9c920cc4312767e97a688454b8f4b46ad946687f819553f984320550e28b');
  });
  it('refuses an unpinned image and a duplicate base', () => {
    const doc = JSON.parse(JSON.stringify({format: 'foundry.build-recipes.v1', records: [loadRecipes(RECIPES).find(r => r.base === 'comp-core')]}));
    delete doc.records[0].profileHash;
    expect(parseRecipes(doc)).toHaveLength(1);
    expect(() => parseRecipes({...doc, records: [doc.records[0], doc.records[0]]})).toThrow('recipe-duplicate-base');
    doc.records[0].profile.recipe.image = 'python:3.12';
    expect(() => parseRecipes(doc)).toThrow('image-must-be-pinned');
  });
});

describe('planJobs', () => {
  const recipes = loadRecipes(RECIPES);
  const air = recipes.find(r => r.base === 'airdeck')!;
  it('one job per merge on a recipe base, oldest first, ids deterministic and valid', () => {
    const plan = planJobs([merge(9, 'airdeck'), merge(3, 'motionmix'), merge(5, 'comp-core')], recipes, []);
    expect(plan.map(p => p.decision.id)).toEqual([5, 9]);
    expect(plan[1].jobId).toBe(`airdeck-${sha(9).slice(0, 12)}-${air.profileHash.slice(0, 8)}`);
    expect(planJobs([merge(9, 'airdeck')], recipes, [])[0].jobId).toBe(plan[1].jobId);
  });
  it('skips merges that already have a job and repeated merge shas', () => {
    const existing = [{job_id: 'x', merged_sha: sha(9), profile_hash: air.profileHash}];
    expect(planJobs([merge(9, 'airdeck'), merge(10, 'airdeck', 9)], recipes, existing)).toEqual([]);
    expect(planJobs([merge(9, 'airdeck'), merge(10, 'airdeck', 9)], recipes, [])).toHaveLength(1);
  });
  it('a changed recipe re-plans the same merge under a new id', () => {
    const existing = [{job_id: 'x', merged_sha: sha(9), profile_hash: hash('older profile')}];
    expect(planJobs([merge(9, 'airdeck')], recipes, existing)).toHaveLength(1);
  });
  it('keeps long base names inside the authority id limit', () => {
    const id = jobId('b'.repeat(80), sha(1), air.profileHash);
    expect(id.length).toBe(64);
    expect(id.endsWith(`-${sha(1).slice(0, 12)}-${air.profileHash.slice(0, 8)}`)).toBe(true);
  });
});

// The planned body against the real BuildAuthority (in-memory SQLite, same adapter as
// packages/build-jobs/src/authority.test.ts): approveProfile returns the hash the planner
// printed, and submit admits the planned job once the owner has approved an input.
describe('planned jobs against the build authority', () => {
  it('approveProfile agrees on the hash and submit admits the planned body', () => {
    const db = new DatabaseSync(':memory:'); closes.push(() => db.close());
    db.exec('PRAGMA foreign_keys=ON');
    let depth = 0;
    const port: TransactionPort = {
      sql: {exec(sql, ...b) { return db.prepare(sql).all(...b as SQLInputValue[]); }},
      transactionSync(fn) { if (depth) return fn(); db.exec('BEGIN IMMEDIATE'); depth++;
        try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth--; } },
    };
    const issuerKey = 'local-build-test-fixture-only-not-a-real-credential';
    new DurableAuthority(port, {environment: 'test', authorityId: 'local', issuerId: 'fixture', issuerKey, now: () => 1000});
    const core = new BuildAuthority(port, 'test', 'local', {issuerKey, now: () => 1000});
    const owner: BuildActor = {role: 'owner', principal: 'owner', expectedEpoch: 1};
    let n = 0;
    const run = <O extends BuildCommand['operation']>(operation: O, body: Extract<BuildCommand, {operation: O}>['body']) =>
      core.execute(owner, {operation, key: `k-${++n}`, body} as BuildCommand) as any;

    const recipes = loadRecipes(RECIPES);
    const [p] = planJobs([merge(361, 'comp-core')], recipes, []);
    expect(run('approveProfile', p.recipe.profile).profileHash).toBe(p.recipe.profileHash);
    const manifest = hash('fixture manifest');
    const input: InputApproval = {projectId: 'comp-core', snapshotHash: hash('snapshot'),
      manifest: {projectId: 'comp-core', objectKey: `projects/comp-core/manifests/${manifest}`, generation: '1', sha256: manifest, sizeBytes: 64},
      git: {remote: null, revision: p.decision.merged_sha, historyPreserved: false}, requiredInputs: [], missingInputs: [], reconstructable: true};
    const inputHash = run('approveInput', input).inputHash as string;
    expect(run('submit', submitBody(p, inputHash))).toEqual({ok: true});
    expect(() => run('submit', {...submitBody(p, inputHash)})).toThrow('job-exists');
  });
});

// Merge -> build job planning. Pure: no network, no credentials, no disk writes.
//
// A recipe is one BuildProfile per Foundry base (docs/app-fleet/build-recipes.v1.json),
// checked with the compute authority's own validator, so the profileHash printed here
// is the hash approveProfile will return. A gate MERGE on a base that has a recipe
// becomes one job: id <base>-<merged sha 12>-<profile 8>, so re-planning the same merge
// never yields a second job, and a changed recipe yields a new one.
import {readFileSync} from 'node:fs';
import * as v from '../../packages/build-jobs/src/validation';
import type {BuildJob, BuildProfile} from '../../packages/build-jobs/src/contracts';

export interface Recipe {
  base: string;
  status: 'proposed' | 'approved';
  worker: string;
  evidence: string;
  input: {roots: string[]; requiredInputs: string[]; vendored?: string};
  profile: BuildProfile;
  profileHash: string;
}
/** One gate decision row joined to its ticket (decisions.repo is the fork). */
export interface MergeRow {id: number; base_repo: string; merged_sha: string; decided_at: string; task_id: string | null}
/** Rows already in D1 build_jobs. */
export interface JobRow {job_id: string; merged_sha: string; profile_hash: string}
export interface PlannedJob {decision: MergeRow; recipe: Recipe; jobId: string}

const SHA1 = /^[a-f0-9]{40}$/;

export function parseRecipes(doc: unknown): Recipe[] {
  const d = doc as {format?: unknown; records?: unknown};
  v.need(d && d.format === 'foundry.build-recipes.v1' && Array.isArray(d.records), 'recipes-format', 400);
  const seen = new Set<string>();
  return (d.records as any[]).map(r => {
    v.need(r && typeof r === 'object', 'recipe-shape', 400);
    v.id(r.base);
    v.need(!seen.has(r.base), 'recipe-duplicate-base', 400); seen.add(r.base);
    v.need(r.status === 'proposed' || r.status === 'approved', 'recipe-status', 400);
    v.text(r.worker, 64); v.text(r.evidence, 512);
    v.need(r.input && Array.isArray(r.input.roots) && r.input.roots.length > 0 && Array.isArray(r.input.requiredInputs), 'recipe-input', 400);
    for (const p of r.input.roots) if (p !== '.') v.relative(p);
    r.input.requiredInputs.forEach(v.relative);
    v.profile(r.profile);
    return {base: r.base, status: r.status, worker: r.worker, evidence: r.evidence, input: r.input,
      profile: r.profile, profileHash: v.hash(r.profile)};
  });
}

export function loadRecipes(file: string): Recipe[] {
  return parseRecipes(JSON.parse(readFileSync(file, 'utf8')));
}

export function jobId(base: string, mergedSha: string, profileHash: string): string {
  v.need(SHA1.test(mergedSha), 'merged-sha', 400); v.digest(profileHash);
  const tail = `-${mergedSha.slice(0, 12)}-${profileHash.slice(0, 8)}`;
  const id = base.slice(0, 64 - tail.length) + tail;
  v.id(id);
  return id;
}

/** Merges on bases with a recipe that have no job for (merged sha, profile) yet, oldest first. */
export function planJobs(merges: MergeRow[], recipes: Recipe[], existing: JobRow[]): PlannedJob[] {
  const byBase = new Map(recipes.map(r => [r.base, r]));
  const done = new Set(existing.map(j => `${j.merged_sha}:${j.profile_hash}`));
  return [...merges].sort((a, b) => a.id - b.id).flatMap(m => {
    const recipe = byBase.get(m.base_repo);
    if (!recipe || !SHA1.test(m.merged_sha) || done.has(`${m.merged_sha}:${recipe.profileHash}`)) return [];
    done.add(`${m.merged_sha}:${recipe.profileHash}`);
    return [{decision: m, recipe, jobId: jobId(recipe.base, m.merged_sha, recipe.profileHash)}];
  });
}

/** The submit body for a planned job, once the owner has approved its input. */
export function submitBody(p: PlannedJob, inputHash: string): BuildJob {
  const body: BuildJob = {id: p.jobId, projectId: p.recipe.profile.projectId, inputHash, profileHash: p.recipe.profileHash, maxAttempts: 1};
  v.job(body);
  return body;
}

// foundry-job: which gate merges should become build/test jobs, and what each job is.
//
//   npx tsx tools/foundry-job/cli.ts recipes [--json]
//   npx tsx tools/foundry-job/cli.ts pending [--since <decision id>] [--json]
//   npx tsx tools/foundry-job/cli.ts plan <decision id>
//
// Read-only: it reads docs/app-fleet/build-recipes.v1.json and the staging D1 ledger
// (SELECT only, Cloudflare token from `wrangler auth token`). It never approves, submits
// or writes. Submitting goes through tools/foundry-pilot/build-submission.ts submitBuild
// (durable intent journal) once builds are enabled and the job's input is approved;
// see docs/app-fleet/BUILD-JOBS.md for what is still owner-gated.
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadRecipes, planJobs, type JobRow, type MergeRow, type Recipe} from './plan';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RECIPES = join(ROOT, 'docs', 'app-fleet', 'build-recipes.v1.json');
const STAGING = {namespace: 'foundry-staging', d1: '4dfb279c-4e61-4954-a13a-3e8ef8181484'};
const API = 'https://api.cloudflare.com/client/v4';

async function d1(sql: string, params: (string | number)[] = []): Promise<any[]> {
  const token = JSON.parse(execFileSync('npx', ['wrangler', 'auth', 'token', '--json'], {cwd: ROOT, encoding: 'utf8'})).token as string;
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(API + path, {method: body ? 'POST' : 'GET', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      body: body ? JSON.stringify(body) : undefined});
    const out = await res.json() as any;
    if (!res.ok || !out.success) throw new Error(`cloudflare ${path}: ${(out.errors ?? []).map((e: any) => e.message).join('; ') || res.status}`);
    return out.result;
  };
  const account = (await call('/accounts'))[0].id as string;
  return (await call(`/accounts/${account}/d1/database/${STAGING.d1}/query`, {sql, params}))[0].results;
}

async function merges(recipes: Recipe[], since = 0, only?: number): Promise<MergeRow[]> {
  if (!recipes.length) return [];
  const bases = recipes.map(() => '?').join(',');
  return d1(`SELECT d.id, t.base_repo, d.merged_sha, d.decided_at, d.task_id FROM decisions d
             JOIN tickets t ON t.fork_repo = d.repo
             WHERE d.verdict = 'merge' AND d.merged_sha IS NOT NULL AND d.namespace = ? AND d.id > ?
               AND t.base_repo IN (${bases}) ${only ? 'AND d.id = ?' : ''} ORDER BY d.id`,
    [STAGING.namespace, since, ...recipes.map(r => r.base), ...(only ? [only] : [])]);
}

/** build_jobs is a proposed table (workers/gate/schema.sql); until it is applied every merge is pending. */
async function existingJobs(): Promise<{rows: JobRow[]; applied: boolean}> {
  const t = await d1(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'build_jobs'`);
  if (!t.length) return {rows: [], applied: false};
  return {rows: await d1('SELECT job_id, merged_sha, profile_hash FROM build_jobs'), applied: true};
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv, json = rest.includes('--json');
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const recipes = loadRecipes(RECIPES);
  if (cmd === 'recipes') {
    const rows = recipes.map(r => ({base: r.base, status: r.status, worker: r.worker, kind: r.profile.kind, profileHash: r.profileHash}));
    if (json) return console.log(JSON.stringify(rows, null, 1));
    for (const r of rows) console.log(`${r.base.padEnd(16)} ${r.status.padEnd(9)} ${r.worker.padEnd(10)} ${r.kind.padEnd(15)} ${r.profileHash}`);
    return;
  }
  if (cmd === 'pending') {
    const since = Number(flag('--since') ?? 0);
    const [m, jobs] = await Promise.all([merges(recipes, since), existingJobs()]);
    const plan = planJobs(m, recipes, jobs.rows);
    if (json) return console.log(JSON.stringify({buildJobsTable: jobs.applied, pending: plan.map(p => ({decision: p.decision.id, base: p.recipe.base,
      mergedSha: p.decision.merged_sha, decidedAt: p.decision.decided_at, jobId: p.jobId, profileHash: p.recipe.profileHash}))}, null, 1));
    if (!jobs.applied) console.log('build_jobs table not applied: every merge on a recipe base counts as pending.');
    for (const p of plan) console.log(`${String(p.decision.id).padStart(5)} ${p.decision.decided_at.slice(0, 16)} ${p.recipe.base.padEnd(12)} ${p.jobId}`);
    console.log(`${plan.length} pending across ${new Set(plan.map(p => p.recipe.base)).size} base(s).`);
    return;
  }
  if (cmd === 'plan') {
    const id = Number(rest[0]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('usage: plan <decision id>');
    const [m] = await merges(recipes, 0, id);
    if (!m) throw new Error(`decision ${id} is not a merge on a base with a recipe`);
    const [p] = planJobs([m], recipes, []);
    console.log(JSON.stringify({decision: m, recipe: {base: p.recipe.base, status: p.recipe.status, worker: p.recipe.worker, profileHash: p.recipe.profileHash},
      input: {roots: p.recipe.input.roots, requiredInputs: p.recipe.input.requiredInputs, git: {revision: m.merged_sha}},
      submit: {id: p.jobId, projectId: p.recipe.profile.projectId, inputHash: '<from approveInput>', profileHash: p.recipe.profileHash, maxAttempts: 1},
      blockedOn: ['COMPUTE_BUILDS_ENABLED (owner go)', 'approveProfile for this profileHash (owner)', 'input snapshot of the merged tree + approveInput (owner)',
        'an enrolled, approved worker for this profile']}, null, 1));
    return;
  }
  throw new Error('usage: foundry-job recipes|pending|plan');
}

main(process.argv.slice(2)).catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });

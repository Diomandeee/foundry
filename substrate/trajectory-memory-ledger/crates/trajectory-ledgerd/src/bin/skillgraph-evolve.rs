use anyhow::{bail, Context, Result};
use clap::Parser;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

#[derive(Debug, Parser)]
#[command(name = "skillgraph-evolve")]
#[command(
    about = "Turn executable benchmark deltas into typed skill packages and a regression-gated SkillDAG"
)]
struct Args {
    /// Public task prompts JSONL.
    #[arg(long)]
    public_tasks: PathBuf,

    /// Canonical executable task specs JSONL.
    #[arg(long)]
    task_specs: PathBuf,

    /// Baseline executable-task-bench JSON report.
    #[arg(long)]
    baseline_report: PathBuf,

    /// Comparison executable-task-bench JSON report.
    #[arg(long)]
    comparison_report: PathBuf,

    /// Optional label overriding the baseline report condition.
    #[arg(long)]
    baseline_label: Option<String>,

    /// Optional label overriding the comparison report condition.
    #[arg(long)]
    comparison_label: Option<String>,

    /// Output directory for skill packages, graph, router index, and report.
    #[arg(long)]
    output_dir: PathBuf,

    /// Require this many net passed tasks before a comparison can be promoted.
    #[arg(long, default_value_t = 1)]
    min_net_pass_delta: i64,

    /// Maximum allowed regressed tasks before a comparison is quarantined.
    #[arg(long, default_value_t = 0)]
    max_regressions: usize,
}

#[derive(Debug, Deserialize)]
struct PublicTask {
    task_id: String,
    candidate_paths: Vec<String>,
    public_prompt: String,
    starter_files: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct TaskSpec {
    task_id: String,
    #[serde(default)]
    task_set: Option<String>,
    verifier_command: String,
}

#[derive(Debug, Deserialize)]
struct BenchReport {
    #[serde(default)]
    input_rows: usize,
    #[serde(default)]
    synthetic_rows: usize,
    conditions: BTreeMap<String, serde_json::Value>,
    row_results: Vec<RowResult>,
}

#[derive(Debug, Deserialize)]
struct RowResult {
    condition: String,
    task_id: String,
    passed: bool,
    #[serde(default)]
    timed_out: bool,
    #[serde(default)]
    stderr_preview: String,
}

#[derive(Debug, Clone)]
struct TaskMeta {
    task_set: Option<String>,
    candidate_path: String,
    function_name: Option<String>,
    family: String,
    public_prompt: String,
    verifier_command: String,
}

#[derive(Debug, Clone, Serialize)]
struct SkillEvidence {
    task_id: String,
    task_set: Option<String>,
    family: String,
    candidate_path: String,
    function_name: Option<String>,
    public_prompt: String,
    verifier_command: String,
    baseline_passed: bool,
    comparison_passed: bool,
    relation: DeltaRelation,
    timed_out: bool,
    stderr_preview: String,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DeltaRelation {
    Fixed,
    Regressed,
    PreservedPass,
    SharedFail,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum SkillStatus {
    Promoted,
    Proposed,
    Quarantined,
    Diagnostic,
}

#[derive(Debug, Clone, Serialize)]
struct TrajectorySkill {
    id: String,
    title: String,
    status: SkillStatus,
    family: String,
    candidate_paths: Vec<String>,
    applies_when: Vec<String>,
    avoid_when: Vec<String>,
    repairs_task_ids: Vec<String>,
    regression_task_ids: Vec<String>,
    shared_failure_task_ids: Vec<String>,
    preserved_pass_task_ids: Vec<String>,
    evidence: Vec<SkillEvidence>,
    package_dir: String,
}

#[derive(Debug, Serialize)]
struct SkillEdge {
    source: String,
    target: String,
    edge_type: String,
    evidence_task_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
struct SkillGraph {
    graph_schema: String,
    baseline_condition: String,
    comparison_condition: String,
    nodes: Vec<TrajectorySkill>,
    edges: Vec<SkillEdge>,
}

#[derive(Debug, Serialize)]
struct RouterIndex {
    router_schema: String,
    active_skill_ids: Vec<String>,
    proposed_skill_ids: Vec<String>,
    quarantined_skill_ids: Vec<String>,
    diagnostic_skill_ids: Vec<String>,
    by_family: BTreeMap<String, Vec<String>>,
    rule: String,
}

#[derive(Debug, Serialize)]
struct RegressionGate {
    promotable: bool,
    baseline_passed: usize,
    comparison_passed: usize,
    net_pass_delta: i64,
    fixed_task_ids: Vec<String>,
    regressed_task_ids: Vec<String>,
    shared_failed_task_ids: Vec<String>,
    preserved_pass_task_ids: Vec<String>,
    reasons: Vec<String>,
}

#[derive(Debug, Serialize)]
struct EvolveReport {
    skillgraph_schema: String,
    baseline_condition: String,
    comparison_condition: String,
    task_count: usize,
    baseline_input_rows: usize,
    comparison_input_rows: usize,
    baseline_synthetic_rows: usize,
    comparison_synthetic_rows: usize,
    gate: RegressionGate,
    skill_count: usize,
    promoted_skill_count: usize,
    proposed_skill_count: usize,
    quarantined_skill_count: usize,
    diagnostic_skill_count: usize,
    artifacts: BTreeMap<String, String>,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let task_meta = read_task_meta(&args.public_tasks, &args.task_specs)?;
    let baseline = read_report(&args.baseline_report)?;
    let comparison = read_report(&args.comparison_report)?;
    let baseline_condition = condition_name(&baseline, args.baseline_label.as_deref(), "baseline")?;
    let comparison_condition =
        condition_name(&comparison, args.comparison_label.as_deref(), "comparison")?;
    let baseline_rows = rows_for_condition(&baseline, &baseline_condition)?;
    let comparison_rows = rows_for_condition(&comparison, &comparison_condition)?;
    validate_same_task_set(&task_meta, &baseline_rows, &comparison_rows)?;

    let gate = build_gate(
        &task_meta,
        &baseline_rows,
        &comparison_rows,
        args.min_net_pass_delta,
        args.max_regressions,
    )?;
    let skills = build_skills(&task_meta, &baseline_rows, &comparison_rows, &gate)?;
    let task_set = task_set_label(&task_meta);
    let graph = build_graph(
        &baseline_condition,
        &comparison_condition,
        &task_set,
        &skills,
    );
    let router = build_router_index(&skills);

    fs::create_dir_all(&args.output_dir)?;
    let package_root = args.output_dir.join("packages");
    fs::create_dir_all(&package_root)?;
    for skill in &skills {
        write_skill_package(&package_root, skill)?;
    }

    let skills_jsonl = args.output_dir.join("trajectory-skills.jsonl");
    write_jsonl(&skills_jsonl, &skills)?;
    let graph_json = args.output_dir.join("skill-graph.json");
    write_json(&graph_json, &graph)?;
    let router_json = args.output_dir.join("router-index.json");
    write_json(&router_json, &router)?;
    let report_json = args.output_dir.join("skillgraph-evolution-report.json");

    let mut artifacts = BTreeMap::new();
    artifacts.insert("skills_jsonl".to_string(), path_string(&skills_jsonl));
    artifacts.insert("skill_graph".to_string(), path_string(&graph_json));
    artifacts.insert("router_index".to_string(), path_string(&router_json));
    artifacts.insert("packages".to_string(), path_string(&package_root));
    artifacts.insert("report".to_string(), path_string(&report_json));

    let report = EvolveReport {
        skillgraph_schema: "trajectory-skillgraph-v1".to_string(),
        baseline_condition,
        comparison_condition,
        task_count: task_meta.len(),
        baseline_input_rows: baseline.input_rows,
        comparison_input_rows: comparison.input_rows,
        baseline_synthetic_rows: baseline.synthetic_rows,
        comparison_synthetic_rows: comparison.synthetic_rows,
        promoted_skill_count: skills
            .iter()
            .filter(|skill| skill.status == SkillStatus::Promoted)
            .count(),
        proposed_skill_count: skills
            .iter()
            .filter(|skill| skill.status == SkillStatus::Proposed)
            .count(),
        quarantined_skill_count: skills
            .iter()
            .filter(|skill| skill.status == SkillStatus::Quarantined)
            .count(),
        diagnostic_skill_count: skills
            .iter()
            .filter(|skill| skill.status == SkillStatus::Diagnostic)
            .count(),
        skill_count: skills.len(),
        gate,
        artifacts,
    };
    write_json(&report_json, &report)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn read_task_meta(
    public_tasks_path: &Path,
    task_specs_path: &Path,
) -> Result<BTreeMap<String, TaskMeta>> {
    let specs = read_task_specs(task_specs_path)?;
    let file = fs::File::open(public_tasks_path)
        .with_context(|| format!("open public tasks {}", public_tasks_path.display()))?;
    let mut tasks = BTreeMap::new();
    for (idx, line) in BufReader::new(file).lines().enumerate() {
        let line = line.with_context(|| format!("read public task line {}", idx + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let task: PublicTask = serde_json::from_str(&line)
            .with_context(|| format!("parse public task line {}", idx + 1))?;
        let candidate_path = task
            .candidate_paths
            .first()
            .cloned()
            .with_context(|| format!("{} has no candidate path", task.task_id))?;
        let starter = task
            .starter_files
            .get(&candidate_path)
            .cloned()
            .unwrap_or_default();
        let spec = specs
            .get(&task.task_id)
            .with_context(|| format!("public task {} missing task spec", task.task_id))?;
        let meta = TaskMeta {
            task_set: spec.task_set.clone(),
            family: infer_family(&candidate_path, &task.task_id),
            function_name: infer_function_name(&starter),
            candidate_path,
            public_prompt: task.public_prompt,
            verifier_command: spec.verifier_command.clone(),
        };
        tasks.insert(task.task_id, meta);
    }
    if tasks.is_empty() {
        bail!("public task input contained no rows");
    }
    Ok(tasks)
}

fn read_task_specs(path: &Path) -> Result<BTreeMap<String, TaskSpec>> {
    let file =
        fs::File::open(path).with_context(|| format!("open task specs {}", path.display()))?;
    let mut specs = BTreeMap::new();
    for (idx, line) in BufReader::new(file).lines().enumerate() {
        let line = line.with_context(|| format!("read task spec line {}", idx + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let spec: TaskSpec = serde_json::from_str(&line)
            .with_context(|| format!("parse task spec line {}", idx + 1))?;
        specs.insert(spec.task_id.clone(), spec);
    }
    Ok(specs)
}

fn read_report(path: &Path) -> Result<BenchReport> {
    let text =
        fs::read_to_string(path).with_context(|| format!("read report {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parse report {}", path.display()))
}

fn condition_name(
    report: &BenchReport,
    override_label: Option<&str>,
    role: &str,
) -> Result<String> {
    if let Some(label) = override_label {
        if label.trim().is_empty() {
            bail!("{role} condition override was empty");
        }
        return Ok(label.to_string());
    }
    if report.conditions.len() != 1 {
        bail!(
            "{role} report must contain exactly one condition or pass --{role}-label; found {}",
            report.conditions.len()
        );
    }
    Ok(report
        .conditions
        .keys()
        .next()
        .expect("length checked")
        .clone())
}

fn rows_for_condition(
    report: &BenchReport,
    condition: &str,
) -> Result<BTreeMap<String, RowResult>> {
    let mut rows = BTreeMap::new();
    for row in &report.row_results {
        if row.condition == condition && rows.insert(row.task_id.clone(), clone_row(row)).is_some()
        {
            bail!(
                "duplicate row for condition {condition} task {}",
                row.task_id
            );
        }
    }
    if rows.is_empty() {
        bail!("report has no row_results for condition {condition}");
    }
    Ok(rows)
}

fn clone_row(row: &RowResult) -> RowResult {
    RowResult {
        condition: row.condition.clone(),
        task_id: row.task_id.clone(),
        passed: row.passed,
        timed_out: row.timed_out,
        stderr_preview: row.stderr_preview.clone(),
    }
}

fn validate_same_task_set(
    task_meta: &BTreeMap<String, TaskMeta>,
    baseline: &BTreeMap<String, RowResult>,
    comparison: &BTreeMap<String, RowResult>,
) -> Result<()> {
    let task_ids: BTreeSet<_> = task_meta.keys().cloned().collect();
    let baseline_ids: BTreeSet<_> = baseline.keys().cloned().collect();
    let comparison_ids: BTreeSet<_> = comparison.keys().cloned().collect();
    if task_ids != baseline_ids {
        bail!("baseline report task ids do not match public task ids");
    }
    if task_ids != comparison_ids {
        bail!("comparison report task ids do not match public task ids");
    }
    Ok(())
}

fn build_gate(
    task_meta: &BTreeMap<String, TaskMeta>,
    baseline: &BTreeMap<String, RowResult>,
    comparison: &BTreeMap<String, RowResult>,
    min_net_pass_delta: i64,
    max_regressions: usize,
) -> Result<RegressionGate> {
    let mut baseline_passed = 0usize;
    let mut comparison_passed = 0usize;
    let mut fixed_task_ids = Vec::new();
    let mut regressed_task_ids = Vec::new();
    let mut shared_failed_task_ids = Vec::new();
    let mut preserved_pass_task_ids = Vec::new();

    for task_id in task_meta.keys() {
        let base = baseline.get(task_id).context("baseline missing task")?;
        let comp = comparison.get(task_id).context("comparison missing task")?;
        if base.passed {
            baseline_passed += 1;
        }
        if comp.passed {
            comparison_passed += 1;
        }
        match (base.passed, comp.passed) {
            (false, true) => fixed_task_ids.push(task_id.clone()),
            (true, false) => regressed_task_ids.push(task_id.clone()),
            (false, false) => shared_failed_task_ids.push(task_id.clone()),
            (true, true) => preserved_pass_task_ids.push(task_id.clone()),
        }
    }

    let net_pass_delta = comparison_passed as i64 - baseline_passed as i64;
    let mut reasons = Vec::new();
    if net_pass_delta < min_net_pass_delta {
        reasons.push(format!(
            "net_pass_delta {net_pass_delta} is below required {min_net_pass_delta}"
        ));
    }
    if regressed_task_ids.len() > max_regressions {
        reasons.push(format!(
            "{} regression(s) exceed allowed {}",
            regressed_task_ids.len(),
            max_regressions
        ));
    }
    let promotable = reasons.is_empty();
    Ok(RegressionGate {
        promotable,
        baseline_passed,
        comparison_passed,
        net_pass_delta,
        fixed_task_ids,
        regressed_task_ids,
        shared_failed_task_ids,
        preserved_pass_task_ids,
        reasons,
    })
}

fn build_skills(
    task_meta: &BTreeMap<String, TaskMeta>,
    baseline: &BTreeMap<String, RowResult>,
    comparison: &BTreeMap<String, RowResult>,
    gate: &RegressionGate,
) -> Result<Vec<TrajectorySkill>> {
    let mut by_family: BTreeMap<String, Vec<SkillEvidence>> = BTreeMap::new();
    for (task_id, meta) in task_meta {
        let base = baseline.get(task_id).context("baseline missing task")?;
        let comp = comparison.get(task_id).context("comparison missing task")?;
        let relation = match (base.passed, comp.passed) {
            (false, true) => DeltaRelation::Fixed,
            (true, false) => DeltaRelation::Regressed,
            (true, true) => DeltaRelation::PreservedPass,
            (false, false) => DeltaRelation::SharedFail,
        };
        let evidence = SkillEvidence {
            task_id: task_id.clone(),
            task_set: meta.task_set.clone(),
            family: meta.family.clone(),
            candidate_path: meta.candidate_path.clone(),
            function_name: meta.function_name.clone(),
            public_prompt: meta.public_prompt.clone(),
            verifier_command: meta.verifier_command.clone(),
            baseline_passed: base.passed,
            comparison_passed: comp.passed,
            relation,
            timed_out: comp.timed_out,
            stderr_preview: comp.stderr_preview.chars().take(320).collect(),
        };
        by_family
            .entry(meta.family.clone())
            .or_default()
            .push(evidence);
    }

    let mut skills = Vec::new();
    for (family, evidence) in by_family {
        let repairs_task_ids = task_ids_with(&evidence, DeltaRelation::Fixed);
        let regression_task_ids = task_ids_with(&evidence, DeltaRelation::Regressed);
        let shared_failure_task_ids = task_ids_with(&evidence, DeltaRelation::SharedFail);
        let preserved_pass_task_ids = task_ids_with(&evidence, DeltaRelation::PreservedPass);
        if repairs_task_ids.is_empty()
            && regression_task_ids.is_empty()
            && shared_failure_task_ids.is_empty()
        {
            continue;
        }

        let status = if !regression_task_ids.is_empty() {
            SkillStatus::Quarantined
        } else if gate.promotable && !repairs_task_ids.is_empty() {
            SkillStatus::Promoted
        } else if !repairs_task_ids.is_empty() {
            SkillStatus::Proposed
        } else {
            SkillStatus::Diagnostic
        };
        let candidate_paths = evidence
            .iter()
            .map(|item| item.candidate_path.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let id = format!("python_stdlib_{}_trajectory_delta", safe_id(&family));
        let title = format!("Python stdlib {family} trajectory delta skill");
        let applies_when = applies_when(&family, &candidate_paths, &evidence);
        let avoid_when = avoid_when(&regression_task_ids, &shared_failure_task_ids);
        let package_dir = format!("packages/{id}");
        skills.push(TrajectorySkill {
            id,
            title,
            status,
            family,
            candidate_paths,
            applies_when,
            avoid_when,
            repairs_task_ids,
            regression_task_ids,
            shared_failure_task_ids,
            preserved_pass_task_ids,
            evidence,
            package_dir,
        });
    }
    Ok(skills)
}

fn task_ids_with(evidence: &[SkillEvidence], relation: DeltaRelation) -> Vec<String> {
    evidence
        .iter()
        .filter(|item| item.relation == relation)
        .map(|item| item.task_id.clone())
        .collect()
}

fn applies_when(
    family: &str,
    candidate_paths: &[String],
    evidence: &[SkillEvidence],
) -> Vec<String> {
    let mut out = vec![
        format!("task family is {family}"),
        format!("candidate path is one of {}", candidate_paths.join(", ")),
    ];
    let funcs = evidence
        .iter()
        .filter_map(|item| item.function_name.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if !funcs.is_empty() {
        out.push(format!(
            "starter function matches one of {}",
            funcs.join(", ")
        ));
    }
    out
}

fn avoid_when(regressions: &[String], shared_failures: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    if !regressions.is_empty() {
        out.push(format!(
            "do not activate until regressions are repaired: {}",
            regressions.join(", ")
        ));
    }
    if !shared_failures.is_empty() {
        out.push(format!(
            "diagnostic only for shared failures: {}",
            shared_failures.join(", ")
        ));
    }
    out
}

fn build_graph(
    baseline_condition: &str,
    comparison_condition: &str,
    task_set: &str,
    skills: &[TrajectorySkill],
) -> SkillGraph {
    let mut edges = Vec::new();
    for skill in skills {
        edges.push(SkillEdge {
            source: skill.id.clone(),
            target: task_set.to_string(),
            edge_type: "depends_on".to_string(),
            evidence_task_ids: skill
                .evidence
                .iter()
                .map(|item| item.task_id.clone())
                .collect(),
        });
        edges.push(SkillEdge {
            source: skill.id.clone(),
            target: format!("family:{}", skill.family),
            edge_type: "specializes".to_string(),
            evidence_task_ids: skill
                .evidence
                .iter()
                .map(|item| item.task_id.clone())
                .collect(),
        });
        for task_id in &skill.repairs_task_ids {
            edges.push(SkillEdge {
                source: skill.id.clone(),
                target: format!("task:{task_id}"),
                edge_type: "repairs".to_string(),
                evidence_task_ids: vec![task_id.clone()],
            });
        }
        for task_id in &skill.regression_task_ids {
            edges.push(SkillEdge {
                source: skill.id.clone(),
                target: format!("task:{task_id}"),
                edge_type: "conflicts_with".to_string(),
                evidence_task_ids: vec![task_id.clone()],
            });
        }
    }
    SkillGraph {
        graph_schema: "trajectory-skillgraph-v1".to_string(),
        baseline_condition: baseline_condition.to_string(),
        comparison_condition: comparison_condition.to_string(),
        nodes: skills.to_vec(),
        edges,
    }
}

fn build_router_index(skills: &[TrajectorySkill]) -> RouterIndex {
    let mut active_skill_ids = Vec::new();
    let mut proposed_skill_ids = Vec::new();
    let mut quarantined_skill_ids = Vec::new();
    let mut diagnostic_skill_ids = Vec::new();
    let mut by_family: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for skill in skills {
        by_family
            .entry(skill.family.clone())
            .or_default()
            .push(skill.id.clone());
        match skill.status {
            SkillStatus::Promoted => active_skill_ids.push(skill.id.clone()),
            SkillStatus::Proposed => proposed_skill_ids.push(skill.id.clone()),
            SkillStatus::Quarantined => quarantined_skill_ids.push(skill.id.clone()),
            SkillStatus::Diagnostic => diagnostic_skill_ids.push(skill.id.clone()),
        }
    }
    RouterIndex {
        router_schema: "trajectory-skill-router-v1".to_string(),
        active_skill_ids,
        proposed_skill_ids,
        quarantined_skill_ids,
        diagnostic_skill_ids,
        by_family,
        rule: "Only promoted skills may be auto-injected. Proposed skills need a clean regression gate; quarantined skills are evidence for repair, not activation.".to_string(),
    }
}

fn write_skill_package(root: &Path, skill: &TrajectorySkill) -> Result<()> {
    let dir = root.join(&skill.id);
    fs::create_dir_all(&dir)?;
    write_json(&dir.join("skill.json"), skill)?;
    fs::write(dir.join("SKILL.md"), render_skill_md(skill))?;
    fs::write(dir.join("MEMORY.md"), render_skill_memory(skill))?;
    write_jsonl(&dir.join("tests.jsonl"), &skill.evidence)?;
    let failure_modes = json!({
        "skill_id": skill.id,
        "status": skill.status,
        "regression_task_ids": skill.regression_task_ids,
        "shared_failure_task_ids": skill.shared_failure_task_ids,
        "avoid_when": skill.avoid_when,
    });
    write_json(&dir.join("failure_modes.json"), &failure_modes)?;
    Ok(())
}

fn render_skill_md(skill: &TrajectorySkill) -> String {
    let mut text = String::new();
    text.push_str(&format!("# {}\n\n", skill.title));
    text.push_str(&format!("Status: `{:?}`\n\n", skill.status));
    text.push_str("## Activation Boundary\n\n");
    for item in &skill.applies_when {
        text.push_str(&format!("- {item}\n"));
    }
    if !skill.avoid_when.is_empty() {
        text.push_str("\n## Do Not Activate When\n\n");
        for item in &skill.avoid_when {
            text.push_str(&format!("- {item}\n"));
        }
    }
    text.push_str("\n## Evidence\n\n");
    text.push_str(&format!(
        "- Repairs: {}\n",
        list_or_none(&skill.repairs_task_ids)
    ));
    text.push_str(&format!(
        "- Regressions: {}\n",
        list_or_none(&skill.regression_task_ids)
    ));
    text.push_str(&format!(
        "- Shared failures: {}\n",
        list_or_none(&skill.shared_failure_task_ids)
    ));
    text.push_str("\n## Usage Rule\n\n");
    match skill.status {
        SkillStatus::Promoted => text.push_str(
            "This skill passed the regression gate and may be injected by the router for matching tasks.\n",
        ),
        SkillStatus::Proposed => text.push_str(
            "This skill has positive evidence but did not pass the global gate. Keep it out of automatic routing until a follow-up regression run promotes it.\n",
        ),
        SkillStatus::Quarantined => text.push_str(
            "This skill caused or co-occurred with regressions. Use it only as diagnostic evidence for a future repair skill.\n",
        ),
        SkillStatus::Diagnostic => text.push_str(
            "This package records persistent failures. It is not an activation skill.\n",
        ),
    }
    text
}

fn render_skill_memory(skill: &TrajectorySkill) -> String {
    let mut text = String::new();
    text.push_str(&format!("# Memory for {}\n\n", skill.id));
    text.push_str("This package was generated from executable benchmark deltas. It is intentionally evidence-bound.\n\n");
    for item in &skill.evidence {
        text.push_str(&format!(
            "- `{}`: `{:?}` baseline={} comparison={} path=`{}`\n",
            item.task_id,
            item.relation,
            item.baseline_passed,
            item.comparison_passed,
            item.candidate_path
        ));
    }
    text
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string_pretty(value)? + "\n")
        .with_context(|| format!("write {}", path.display()))
}

fn write_jsonl<T: Serialize>(path: &Path, values: &[T]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut rendered = String::new();
    for value in values {
        rendered.push_str(&serde_json::to_string(value)?);
        rendered.push('\n');
    }
    fs::write(path, rendered).with_context(|| format!("write {}", path.display()))
}

fn infer_family(candidate_path: &str, task_id: &str) -> String {
    let file_stem = Path::new(candidate_path)
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    if let Some(prefix) = file_stem.strip_suffix("_tools") {
        return prefix.to_string();
    }
    task_id
        .strip_prefix("py_v1_")
        .and_then(|rest| rest.split('_').next())
        .unwrap_or("unknown")
        .to_string()
}

fn infer_function_name(starter: &str) -> Option<String> {
    starter.lines().find_map(|line| {
        let line = line.trim_start();
        let rest = line.strip_prefix("def ")?;
        let name = rest.split('(').next()?.trim();
        if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        }
    })
}

fn safe_id(input: &str) -> String {
    input
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn list_or_none(items: &[String]) -> String {
    if items.is_empty() {
        "none".to_string()
    } else {
        items.join(", ")
    }
}

fn path_string(path: &Path) -> String {
    path.display().to_string()
}

fn task_set_label(task_meta: &BTreeMap<String, TaskMeta>) -> String {
    let labels = task_meta
        .values()
        .filter_map(|meta| meta.task_set.clone())
        .collect::<BTreeSet<_>>();
    if labels.len() == 1 {
        labels.into_iter().next().expect("length checked")
    } else if labels.is_empty() {
        "taskset:unknown".to_string()
    } else {
        format!(
            "taskset:mixed:{}",
            labels.into_iter().collect::<Vec<_>>().join("+")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infers_family_from_tool_path() {
        assert_eq!(
            infer_family("src/path_tools.py", "py_v1_safe_filename"),
            "path"
        );
        assert_eq!(
            infer_family("src/text_tools.py", "py_v1_slugify_text"),
            "text"
        );
    }

    #[test]
    fn infers_function_from_starter() {
        assert_eq!(
            infer_function_name("def normalize_whitespace(text):\n    raise NotImplementedError\n"),
            Some("normalize_whitespace".to_string())
        );
    }

    #[test]
    fn derives_single_task_set_label() {
        let mut meta = BTreeMap::new();
        meta.insert(
            "task_a".to_string(),
            TaskMeta {
                task_set: Some("python-stdlib-heldout-v1-60".to_string()),
                candidate_path: "src/path_tools.py".to_string(),
                function_name: Some("is_subpath".to_string()),
                family: "path".to_string(),
                public_prompt: "prompt".to_string(),
                verifier_command: "python3 -m unittest".to_string(),
            },
        );
        assert_eq!(task_set_label(&meta), "python-stdlib-heldout-v1-60");
    }
}

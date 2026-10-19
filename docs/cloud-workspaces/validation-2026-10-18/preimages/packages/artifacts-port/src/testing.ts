// GitTestKit — shared harness for tests over real git (node-only).
// Seeds base repos, clones working copies, commits + pushes as agents would.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { runGit } from "./git.js";
import type { ArtifactsPort } from "./port.js";

export class GitTestKit {
  constructor(
    private root: string,
    private port: ArtifactsPort,
  ) {}

  bare(name: string): string {
    return path.join(this.root, `${name}.git`);
  }

  cloneTo(name: string, workdir: string): void {
    mkdirSync(path.dirname(workdir), { recursive: true });
    runGit(["clone", "--quiet", this.bare(name), workdir]);
  }

  commitAll(
    workdir: string,
    message: string,
    files: Record<string, string>,
    author = "agent",
    remove: string[] = [],
  ): string {
    for (const [name, content] of Object.entries(files)) {
      const fp = path.join(workdir, name);
      mkdirSync(path.dirname(fp), { recursive: true });
      writeFileSync(fp, content);
    }
    for (const name of remove) {
      rmSync(path.join(workdir, name), { force: true });
    }
    runGit(["add", "-A"], workdir);
    runGit(
      [
        "-c",
        `user.name=${author}`,
        "-c",
        "user.email=agent@local",
        "commit",
        "--quiet",
        "-m",
        message,
      ],
      workdir,
    );
    runGit(["push", "--quiet", "origin", "HEAD"], workdir);
    return runGit(["rev-parse", "HEAD"], workdir);
  }

  async seedBase(
    name: string,
    files: Record<string, string>,
    workdir: string,
  ): Promise<string> {
    await this.port.create(name, { defaultBranch: "main" });
    this.cloneTo(name, workdir);
    return this.commitAll(workdir, "seed", files, "seed");
  }

  headOf(name: string): string {
    return runGit([`--git-dir=${this.bare(name)}`, "rev-parse", "HEAD"]);
  }
}

# Independent dependencies review

**Rating: REQUEST_CHANGES — source contracts only; no merge or activation verdict.**

## Review: /Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/native/linux-isolation.py:423–428

**Severity**: MEDIUM  
**Issue**: Launch admission does not verify the kernel interface required for termination. `start()` checks cgroup v2, but `contain()` unconditionally opens `cgroup.kill`. That interface is absent from upstream Linux 5.13 and present in 5.14. On an older cgroup-v2 host, execution can start, then both normal completion and watchdog containment fail at this operation. Cancellation may freeze processes without killing them; successful jobs cannot reach capture. See the kernel’s [5.13 contract](https://www.kernel.org/doc/html/v5.13/admin-guide/cgroup-v2.html) and [5.14 contract](https://www.kernel.org/doc/html/v5.14/admin-guide/cgroup-v2.html#core-interface-files).

**Fix**: Before launching any workload, require the actual attempt cgroup’s kill/freeze/event interfaces and compatible domain type. Document Linux 5.14+ or an explicitly verified backport as a prerequisite.

**Evidence/uncertainty**: Source path: initialization at lines 210–214 → admission at 443–454 → containment at 423–435. The proposed Ubuntu 24.04 image should satisfy this requirement; this finding concerns missing rejection of incompatible hosts, not an observed failure on that image.

## Review: /Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/native/linux-isolation.py:398–399

**Severity**: MEDIUM  
**Issue**: Both mounts require `bind-recursive=disabled`, but neither policy validation nor launch admission establishes a compatible Docker CLI version. Docker CLI 24 rejects this key; CLI 25 introduces it. A correctly hash-pinned CLI 24 can pass the existing checks, consume the durable attempt slot, allocate/mount the workspace, accept all inputs, and then fail every container creation. Upstream evidence: [CLI 24 parser](https://github.com/docker/cli/blob/v24.0.9/opts/mount.go), [CLI 25 parser](https://github.com/docker/cli/blob/v25.0.5/opts/mount.go).

**Fix**: Declare Docker CLI 25+ and verify compatibility before accepting the attempt or allocating its disk. Preserve nonrecursive mount semantics.

**Evidence/uncertainty**: Executable hashing at lines 120–127 establishes identity, not supported features. No installed Docker version was inspected.

**Accepted operational gates:** Owner provisioning, installed pins, Mac CAS/VM acceptance, and retained resources after the single Linux attempt remain explicit gates. I found no additional concrete Mac platform/API incompatibility in the inspected paths.

**RTD:** Structure, source integration, content and user journey inspected. Compilation, tests, lint, builds and deployment **not run; gated**. No files written or subagents used.


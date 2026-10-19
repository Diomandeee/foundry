# Primary research used during source review

- [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/): host bind mounts require explicit protection; this design uses root-private sources and a dedicated bounded work filesystem.
- [Docker user namespaces](https://docs.docker.com/engine/security/userns-remap/): remapping changes bind-mount ownership requirements. This pilot explicitly uses a non-root host UID with `--userns=host`; it does not claim rootless Docker or remapped-root protection.
- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/): reviewed as a different daemon/account model, not silently substituted for the supplied root broker.
- [Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html): freeze is inherited, new descendants remain frozen, `cgroup.kill` addresses descendants, and `cgroup.events` reports actual frozen/populated state. These are the intended kernel basis; runtime demonstration is pending.
- [libuv Linux source](https://raw.githubusercontent.com/libuv/libuv/v1.x/src/unix/linux.c): precise hrtime uses CLOCK_MONOTONIC on Linux.
- [Python time](https://docs.python.org/3/library/time.html): monotonic is shared across processes; CLOCK_BOOTTIME includes suspension. Installed Node/Python versions and time namespaces still require acceptance.

Retrieved during this local task. No user cloud resources were queried. Documentation is architectural support, not evidence of successful installation or execution.

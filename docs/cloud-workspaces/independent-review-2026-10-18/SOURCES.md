# Primary references used for source decisions

- [AppArmor policy language](https://manpages.ubuntu.com/manpages/jammy/man5/apparmor.d.5.html): read/readby and trace/tracedby require the corresponding peer-side permissions. The prepared profile denies all four.
- [Docker AppArmor integration](https://docs.docker.com/engine/security/apparmor/): explicitly select a loaded profile; source preparation does not load one.
- [Linux 6.8 AppArmor filesystem implementation](https://raw.githubusercontent.com/torvalds/linux/v6.8/security/apparmor/apparmorfs.c): kernel policy magic link, per-profile mode/name and compiled raw_sha256 export. Owner installation must bind source/compiler/features/compiled hash; a loaded name alone is insufficient.
- [Linux mount contract](https://man7.org/linux/man-pages/man2/mount.2.html): read-only remount applies to the filesystem when not MS_BIND; outstanding writable users can make it fail.
- [Docker CLI 25 mount parser](https://github.com/docker/cli/blob/v25.0.5/opts/mount.go): nonrecursive bind option support, unlike CLI24.
- [Linux cgroup v2 5.14 interfaces](https://www.kernel.org/doc/html/v5.14/admin-guide/cgroup-v2.html#core-interface-files): cgroup.kill plus freeze/events. Actual interface availability is checked, not inferred from a cgroup-v2 label.

These sources support implementation reasoning only. No installed host or runtime behavior was validated.

- [Docker user namespace remapping](https://docs.docker.com/engine/security/userns-remap/): default per-container remapping and explicit host opt-out; mapped bind ownership requires approved configuration.
- [Linux ptrace permission algorithm](https://man7.org/linux/man-pages/man2/ptrace.2.html): commoncap namespace and capability checks, beyond matching numeric credentials.
- [AppArmor task mediation](https://github.com/torvalds/linux/blob/v6.8/security/apparmor/task.c): the unconfined-accessor exception is why target policy alone was rejected.

- [Linux commoncap implementation](https://github.com/torvalds/linux/blob/v6.8/security/commoncap.c) and [Docker 25 namespace construction](https://github.com/moby/moby/blob/v25.0.0/daemon/oci_linux.go): independent security reviewer checked the trusted-root runtime/user-namespace premise. Namespace owner/parent/mapping still require actual-host acceptance.

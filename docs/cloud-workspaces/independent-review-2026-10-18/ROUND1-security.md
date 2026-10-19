# Independent security review — preserved finding summary

Reviewer: Hilbert, agent 01a14feb-a18b-7a70-98ad-bd9f93cf6a49. Initial disposition REQUEST_CHANGES, source only. Original preimages are preserved.

- HIGH, native/linux-isolation.py:394–399 and capture:496–529: --userns=host permits matching host UID/GID procfs traversal when ptrace-read allows it. An external process can retain /proc/<pid>/root/work references outside the job cgroup. Require a procfs enforcement boundary plus a whole-filesystem readonly seal before capture; private ancestry and inode/size checks alone are insufficient.
- MEDIUM, native/linux-isolation.py:574–585: group-admitted unauthorized peer consumes the only accept and terminates the broker before exact UID check, leaving a retained socket. Reject peers inside the accept loop.

No further concrete Mac CAS security finding established in that pass. Installation/runtime gates accepted as separate; no tests or operations performed.

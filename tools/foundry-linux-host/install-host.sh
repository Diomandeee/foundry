#!/usr/bin/env bash
# Phase 1 of the Foundry Linux build host: everything the isolation broker
# (packages/build-runtime/native/linux-isolation.py) checks that does not
# depend on a build recipe. Phase 2 (write-policy.py) adds policy.json once a
# profile exists. Idempotent; run as root on a dedicated pilot VM only.
#
#   sudo bash install-host.sh /path/to/foundry-checkout
#
# It changes: the workspace disk's mount point, Docker (installed and
# configured), two system users, one AppArmor profile, one cgroup, and files
# under /var/lib/foundry-linux, /run/foundry-linux, /usr/local/libexec.
# It never starts the broker or runs a build.
set -euo pipefail

SRC=${1:?usage: install-host.sh /path/to/foundry-checkout}
NATIVE="$SRC/packages/build-runtime/native"
ROOT=/var/lib/foundry-linux
CTL_USER=foundry-ctl;   CTL_ID=1100
BUILD_USER=foundry-build; BUILD_ID=1200
APPARMOR_PROFILE=foundry-linux-build-v1
APPARMOR_SHA=95222d83c4360b08b9df6f89730a5fbc33c83d5ee4c1b6d4430e9e437d944f9e

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
. /etc/os-release
[[ $ID == ubuntu ]] || { echo "Ubuntu only (got $ID)" >&2; exit 1; }
[[ $(sha256sum "$NATIVE/$APPARMOR_PROFILE.apparmor" | cut -d' ' -f1) == "$APPARMOR_SHA" ]] \
  || { echo "AppArmor source does not match the broker's pinned digest" >&2; exit 1; }

step() { echo "== $*"; }

step "isolation root on the workspace disk (reserve needs >= 50 GiB; / is too small)"
# The broker rejects symlinks anywhere in the path, so the disk is mounted
# directly at ROOT instead of being linked from /workspace.
if findmnt -n /workspace >/dev/null; then
  [[ -z $(ls -A /workspace | grep -v '^lost+found$') ]] || { echo "/workspace is not empty; refusing to move it" >&2; exit 1; }
  umount /workspace
fi
sed -i 's#^LABEL=workspace /workspace #LABEL=workspace /var/lib/foundry-linux #' /etc/fstab
mkdir -p "$ROOT"
findmnt -n "$ROOT" >/dev/null || mount "$ROOT"
rmdir /workspace 2>/dev/null || true
chown root:root "$ROOT"; chmod 0700 "$ROOT"
install -d -o root -g root -m 0700 "$ROOT/attempts" "$ROOT/docker-config"
[[ -z $(ls -A "$ROOT/docker-config") ]] || { echo "$ROOT/docker-config must stay empty" >&2; exit 1; }

step "users: controller and build identities, distinct"
getent group "$CTL_USER" >/dev/null || groupadd --system --gid "$CTL_ID" "$CTL_USER"
getent passwd "$CTL_USER" >/dev/null || useradd --system --uid "$CTL_ID" --gid "$CTL_ID" --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$CTL_USER"
getent group "$BUILD_USER" >/dev/null || groupadd --system --gid "$BUILD_ID" "$BUILD_USER"
getent passwd "$BUILD_USER" >/dev/null || useradd --system --uid "$BUILD_ID" --gid "$BUILD_ID" --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$BUILD_USER"

step "Docker Engine >= 25 from Docker's apt repository"
if ! command -v dockerd >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io
fi

step "Docker: user-namespace remap, cgroupfs driver, root-only socket"
install -d -m 0755 /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{
  "userns-remap": "default",
  "exec-opts": ["native.cgroupdriver=cgroupfs"],
  "live-restore": false
}
JSON
# The broker requires /run/docker.sock to be owned by root with no group or
# other access (mode & 0o077 == 0); the stock unit makes it root:docker 0660.
install -d -m 0755 /etc/systemd/system/docker.socket.d
cat > /etc/systemd/system/docker.socket.d/foundry-root-only.conf <<'UNIT'
[Socket]
SocketMode=0600
SocketUser=root
SocketGroup=root
UNIT
getent group docker >/dev/null && [[ -n $(getent group docker | cut -d: -f4) ]] \
  && { echo "docker group has members; the socket would be shared" >&2; exit 1; }
systemctl daemon-reload
systemctl restart docker.socket docker.service

step "runtime directory /run/foundry-linux (root-controlled, recreated at boot)"
echo 'd /run/foundry-linux 0755 root root -' > /etc/tmpfiles.d/foundry-linux.conf
systemd-tmpfiles --create /etc/tmpfiles.d/foundry-linux.conf

step "cgroup /sys/fs/cgroup/foundry-builds (root domain with cpu, memory, pids)"
cat > /etc/systemd/system/foundry-builds-cgroup.service <<'UNIT'
[Unit]
Description=Create the Foundry build cgroup
DefaultDependencies=no
After=sys-fs-cgroup.mount
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'mkdir -p /sys/fs/cgroup/foundry-builds && chmod 0755 /sys/fs/cgroup/foundry-builds && echo "+cpu +memory +pids" > /sys/fs/cgroup/foundry-builds/cgroup.subtree_control'
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now foundry-builds-cgroup.service

step "AppArmor profile $APPARMOR_PROFILE (enforce)"
install -o root -g root -m 0644 "$NATIVE/$APPARMOR_PROFILE.apparmor" "/etc/apparmor.d/$APPARMOR_PROFILE"
apparmor_parser -r -W "/etc/apparmor.d/$APPARMOR_PROFILE"

step "broker pinned at /usr/local/libexec"
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$NATIVE/linux-isolation.py" /usr/local/libexec/foundry-linux-isolation.py

step "receipt"
python3 - "$ROOT" "$APPARMOR_PROFILE" <<'PY'
import hashlib, json, os, pathlib, pwd, subprocess, sys
root, profile = sys.argv[1], sys.argv[2]
def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
compiled = None
base = pathlib.Path('/sys/kernel/security/apparmor/policy/profiles')
for d in base.iterdir():
    if (d / 'name').read_text().strip() == profile:
        compiled = (d / 'raw_sha256').read_text().strip()
        mode = (d / 'mode').read_text().strip()
subuid = [l.split(':') for l in open('/etc/subuid') if l.startswith('dockremap:')][0]
subgid = [l.split(':') for l in open('/etc/subgid') if l.startswith('dockremap:')][0]
build = pwd.getpwnam('foundry-build')
st = os.statvfs(root)
info = json.loads(subprocess.check_output(['docker', 'info', '--format', '{{json .}}']))
print(json.dumps({
  'controllerUid': pwd.getpwnam('foundry-ctl').pw_uid, 'controllerGid': pwd.getpwnam('foundry-ctl').pw_gid,
  'buildUid': build.pw_uid, 'buildGid': build.pw_gid,
  'mappedBuildUid': int(subuid[1]) + build.pw_uid, 'mappedBuildGid': int(subgid[1]) + build.pw_gid,
  'apparmorCompiledSha256': compiled, 'apparmorMode': mode,
  'executables': {'docker': sha('/usr/bin/docker'), 'mkfs': sha('/usr/sbin/mke2fs'), 'mount': sha('/usr/bin/mount')},
  'broker': sha('/usr/local/libexec/foundry-linux-isolation.py'), 'python3.12': sha('/usr/bin/python3.12'),
  'dockerServer': info.get('ServerVersion'), 'cgroupDriver': info.get('CgroupDriver'),
  'securityOptions': info.get('SecurityOptions'), 'dockerWarnings': info.get('Warnings'),
  'rootFreeGiB': round(st.f_bavail * st.f_frsize / 2**30, 1),
}, indent=1))
PY

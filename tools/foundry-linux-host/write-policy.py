#!/usr/bin/python3 -I
# Phase 2 of the Foundry Linux build host: compose /var/lib/foundry-linux/policy.json
# from one profile file plus the pins the running host exposes, then prove the
# installed broker accepts it with its own load_policy(). Run as root:
#
#   sudo /usr/bin/python3 -I -S write-policy.py --profile profile.json \
#        [--profile-hash <localRecipeHash>] [--max-work-bytes N] [--reserve-bytes N]
#
# Without --profile-hash the profile is keyed by the sha256 of its canonical
# JSON. That is a pilot-only key: the controller (packages/build-runtime) keys
# profiles by binding.localRecipeHash, which only exists for recipes
# `foundry-build-pilot prepare` can express (npm/cargo/cmake today).
import argparse, hashlib, importlib.util, json, os, pwd, stat, sys

ROOT = '/var/lib/foundry-linux'
BROKER = '/usr/local/libexec/foundry-linux-isolation.py'
APPARMOR_PROFILE = 'foundry-linux-build-v1'
PROFILE_KEYS = 'image architecture commands env cpu ramMib pids tmpMib timeoutMs maxOutputBytes maxInputBytes outputPaths sourceCopy'.split()

def canonical(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=True, sort_keys=True).encode()

def sha(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()

def compiled_apparmor():
    base = '/sys/kernel/security/apparmor/policy/profiles'
    found = []
    for d in os.listdir(base):
        with open(os.path.join(base, d, 'name')) as f:
            if f.read().strip() != APPARMOR_PROFILE:
                continue
        with open(os.path.join(base, d, 'raw_sha256')) as f:
            raw = f.read().strip()
        with open(os.path.join(base, d, 'mode')) as f:
            mode = f.read().strip()
        found.append((raw, mode))
    if len(found) != 1 or found[0][1] != 'enforce':
        sys.exit('AppArmor profile %s: expected exactly one enforced load, got %r' % (APPARMOR_PROFILE, found))
    return found[0][0]

def subid(path, user):
    for line in open(path):
        name, start, _count = line.strip().split(':')
        if name == user:
            return int(start)
    sys.exit('%s has no %s entry' % (path, user))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--profile', required=True)
    ap.add_argument('--profile-hash')
    ap.add_argument('--max-work-bytes', type=int, default=2 * 1024**3)
    ap.add_argument('--reserve-bytes', type=int, default=50 * 1024**3)
    ap.add_argument('--force', action='store_true', help='replace an existing policy.json')
    a = ap.parse_args()
    if os.geteuid() != 0:
        sys.exit('run as root')
    with open(a.profile, 'rb') as f:
        profile = json.load(f)
    if sorted(profile) != sorted(PROFILE_KEYS):
        sys.exit('profile keys must be exactly %s' % PROFILE_KEYS)
    key = a.profile_hash or hashlib.sha256(canonical(profile)).hexdigest()
    ctl, build = pwd.getpwnam('foundry-ctl'), pwd.getpwnam('foundry-build')
    policy = {
        'version': 1,
        'controllerUid': ctl.pw_uid, 'controllerGid': ctl.pw_gid,
        'buildUid': build.pw_uid, 'buildGid': build.pw_gid,
        'mappedBuildUid': subid('/etc/subuid', 'dockremap') + build.pw_uid,
        'mappedBuildGid': subid('/etc/subgid', 'dockremap') + build.pw_gid,
        'maxWorkBytes': a.max_work_bytes, 'reserveBytes': a.reserve_bytes,
        'executables': {'docker': sha('/usr/bin/docker'), 'mkfs': sha('/usr/sbin/mke2fs'), 'mount': sha('/usr/bin/mount')},
        'profiles': {key: profile},
        'apparmorCompiledSha256': compiled_apparmor(),
    }
    path = ROOT + '/policy.json'
    if os.path.lexists(path) and not a.force:
        sys.exit('%s exists; pass --force to replace it' % path)
    if os.path.lexists(ROOT + '/slot.json'):
        sys.exit('slot.json exists: this host already ran its one attempt; policy is frozen')
    tmp = path + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(canonical(policy)); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path)
    # The broker's own check is the only acceptance that counts.
    spec = importlib.util.spec_from_file_location('broker', BROKER)
    broker = importlib.util.module_from_spec(spec); spec.loader.exec_module(broker)
    loaded = broker.load_policy()
    broker.apparmor_policy(loaded)
    print(json.dumps({'policy': path, 'profileHash': key, 'brokerSha256': sha(BROKER),
                      'apparmorCompiledSha256': policy['apparmorCompiledSha256'],
                      'executables': policy['executables'], 'mappedBuildUid': policy['mappedBuildUid'],
                      'loadPolicy': 'PASS', 'apparmorPolicy': 'PASS'}, indent=1))

if __name__ == '__main__':
    main()

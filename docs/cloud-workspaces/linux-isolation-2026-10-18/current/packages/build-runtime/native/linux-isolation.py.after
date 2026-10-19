#!/usr/bin/python3
"""Source-only Linux execution broker. No install/start/cleanup is implicit.

Owner provisions /var/lib/foundry-linux (0700 root), run (0755 root), an
empty Docker config directory and policy.json (0600 root). One root process,
one authenticated controller connection, one attempt per connection. Any
disconnect/error retains the durable slot, disks and containers for reconciliation.
The Docker socket is root-only. Clients cannot submit argv, host paths or images.
"""
import base64
import hashlib
import json
import os
import re
import selectors
import socket
import stat
import struct
import subprocess
import sys
import time

ROOT = '/var/lib/foundry-linux'
SOCKET = '/run/foundry-linux/broker.sock'
FRAME = 1450000
CHUNK = 1048576
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}

def require(value):
    if not value:
        raise ValueError('linux-isolation-refused')

def exact(obj, keys):
    require(type(obj) is dict and set(obj) == set(keys.split()))

def digest(b):
    return hashlib.sha256(b).hexdigest()

def number(n, low, high):
    require(type(n) is int and low <= n <= high)

def hexhash(s):
    require(type(s) is str and re.fullmatch('[0-9a-f]{64}', s))

def relative(s):
    require(type(s) is str and re.fullmatch('[A-Za-z0-9_./-]{1,240}', s))
    require(not s.startswith(('/', '-')) and all(p not in ('', '.', '..') for p in s.split('/')) and len(s.split('/')) <= 32)

def trusted(path, directory=False, private=False):
    require(os.path.isabs(path) and os.path.normpath(path) == path)
    current = '/'
    for part in path.split('/')[1:]:
        current = os.path.join(current, part)
        s = os.lstat(current)
        require(not stat.S_ISLNK(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022)
        require(not any(k.startswith('system.posix_acl_') for k in os.listxattr(current, follow_symlinks=False)))
        if current != path or directory:
            require(stat.S_ISDIR(s.st_mode))
    if private:
        require(not s.st_mode & 0o077)
    return s

def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def create(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as f:
            f.write(data)
            f.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    sync_dir(os.path.dirname(path))

def encoded(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=True).encode()

def receive(sock):
    def take(n):
        b = bytearray()
        while len(b) < n:
            p = sock.recv(n-len(b))
            require(p)
            b.extend(p)
        return bytes(b)
    n = struct.unpack('!I', take(4))[0]
    number(n, 1, FRAME)
    return json.loads(take(n))

def send(sock, value):
    b = encoded(value)
    number(len(b), 1, FRAME)
    sock.sendall(struct.pack('!I', len(b)) + b)

def peer(sock):
    return struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1:]

def load_policy():
    trusted(ROOT, True, True)
    trusted(ROOT+'/docker-config', True, True)
    require(not os.listdir(ROOT+'/docker-config'))
    s = trusted(ROOT+'/policy.json', private=True)
    require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= 262144)
    with open(ROOT+'/policy.json', 'rb') as f:
        p = json.load(f)
    exact(p, 'version controllerUid controllerGid buildUid buildGid maxWorkBytes reserveBytes executables profiles')
    require(p['version'] == 1)
    for k in ('controllerUid', 'controllerGid', 'buildUid', 'buildGid'):
        number(p[k], 1000, 2147483647)
    require(p['controllerUid'] != p['buildUid'] and p['controllerGid'] != p['buildGid'])
    number(p['maxWorkBytes'], 268435456, 8*1024**3)
    require(p['maxWorkBytes'] % 4096 == 0)
    number(p['reserveBytes'], 50*1024**3, 1024**5)
    exact(p['executables'], 'docker mkfs mount')
    paths = {'docker':'/usr/bin/docker', 'mkfs':'/usr/sbin/mke2fs', 'mount':'/usr/bin/mount'}
    for k, path in paths.items():
        hexhash(p['executables'][k])
        s = trusted(path)
        require(stat.S_ISREG(s.st_mode) and s.st_size <= 256*1024**2)
        with open(path, 'rb') as f:
            require(digest(f.read()) == p['executables'][k])
    trusted('/run', True)
    s = trusted('/run/docker.sock')
    require(stat.S_ISSOCK(s.st_mode) and not s.st_mode & 0o077)
    require(type(p['profiles']) is dict and 1 <= len(p['profiles']) <= 32)
    for key, q in p['profiles'].items():
        hexhash(key)
        exact(q, 'image architecture commands env cpu ramMib pids tmpMib timeoutMs maxOutputBytes maxInputBytes outputPaths sourceCopy')
        require(re.fullmatch('[a-z0-9][a-z0-9./:_-]{0,200}@sha256:[0-9a-f]{64}', q['image']))
        require(q['architecture'] in ('amd64', 'arm64') and type(q['sourceCopy']) is bool)
        for k, low, high in [('cpu',1,64),('ramMib',128,1048576),('pids',16,4096),('tmpMib',1,8192),('timeoutMs',1000,3600000),('maxOutputBytes',1,31*CHUNK),('maxInputBytes',1,2*1024**3)]:
            number(q[k], low, high)
        require(type(q['commands']) is list and 1 <= len(q['commands']) <= 2)
        for cmd in q['commands']:
            require(type(cmd) is list and 1 <= len(cmd) <= 40 and all(type(a) is str and 0 < len(a) <= 512 and not re.search('[\x00-\x1f\x7f]', a) for a in cmd))
            require(cmd[0].startswith('/') and os.path.normpath(cmd[0]) == cmd[0])
        require(type(q['env']) is dict and len(q['env']) <= 24)
        for k,v in q['env'].items():
            require(re.fullmatch('[A-Z][A-Z0-9_]{0,63}', k) and type(v) is str and len(v) <= 512 and not re.search('[\x00-\x1f\x7f]', v))
        require(type(q['outputPaths']) is list and len(q['outputPaths']) <= 64 and len(set(q['outputPaths'])) == len(q['outputPaths']))
        for path in q['outputPaths']:
            relative(path)
            require(not path.endswith(('.app','.dSYM','.xcarchive')))
    return p

def census(policy, helper_hash, python_hash, attempt=None):
    # Account backing images once; never recurse into mounted build filesystems.
    began=time.monotonic();entries=0;total=0;complete=True;dev=os.stat(ROOT).st_dev
    def walk(path,depth):
        nonlocal entries,total
        require(depth<=40 and time.monotonic()-began<2)
        with os.scandir(path) as iterator:
            for e in iterator:
                entries+=1;require(entries<=100000 and time.monotonic()-began<2)
                s=e.stat(follow_symlinks=False)
                if s.st_dev!=dev:
                    require(e.name=='work' and depth==1 and stat.S_ISDIR(s.st_mode))
                    continue
                require(s.st_uid==0 and not stat.S_ISLNK(s.st_mode))
                if stat.S_ISDIR(s.st_mode):walk(e.path,depth+1)
                else:
                    require(stat.S_ISREG(s.st_mode) and s.st_nlink==1)
                    total+=s.st_size
    try:walk(ROOT+'/attempts',0)
    except Exception:complete=False
    if attempt is not None and not getattr(attempt,'sealed',False):complete=False
    disk=os.statvfs(ROOT)
    value={'version':1,'observedAt':int(time.time()*1000),'freeBytes':disk.f_bavail*disk.f_frsize,
           'workspaceBytes':total if complete else None,'complete':complete,
           'slotFree':not os.path.lexists(ROOT+'/slot.json'),'profiles':sorted(policy['profiles']),
           'helperSha256':helper_hash,'pythonSha256':python_hash}
    path='/run/foundry-linux/census.json';temp=path+'.'+str(os.getpid())+'.'+str(time.monotonic_ns())
    create(temp,encoded(value));os.chmod(temp,0o444);os.replace(temp,path);sync_dir('/run/foundry-linux')

class Attempt:
    def __init__(self, p, request):
        exact(request, 'op attemptId profileHash inputHash filesHash bytes files')
        require(request['op'] == 'begin' and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,63}', request['attemptId']))
        for k in ('profileHash','inputHash','filesHash'):
            hexhash(request[k])
        self.p, self.q = p, p['profiles'][request['profileHash']]
        number(request['bytes'], 0, self.q['maxInputBytes'])
        number(request['files'], 1, 8192)
        self.identity = digest(encoded([request['attemptId'],request['profileHash'],request['inputHash'],request['filesHash']]))
        self.request, self.root = request, ROOT+'/attempts/'+request['attemptId']
        self.child = None
        self.container = None
        self.started = False
        self.terminal = False
        self.success = False
        self.exit_code = None
        self.phase = -1
        self.total = 0
        self.entries = []
        self.components = set()
        self.active = None
        self.log = bytearray()
        self.outputs = []
        self.expires = 0
        self.contained = False
        self.deadline = time.monotonic() + self.q['timeoutMs']/1000
        self.boot_offset=time.clock_gettime(time.CLOCK_BOOTTIME)-time.monotonic()
        # Durable global lock precedes all run-capable work. No restart replay.
        create(ROOT+'/slot.json', encoded({'version':1,'identity':self.identity,'request':request}))
        trusted('/sys/fs/cgroup/foundry-builds', True)
        self.cgroup='/sys/fs/cgroup/foundry-builds/'+self.identity
        os.mkdir(self.cgroup,0o700)
        with open(self.cgroup+'/cgroup.subtree_control','w') as f:f.write('+cpu +memory +pids')
        trusted(ROOT+'/attempts', True, True)
        free = os.statvfs(ROOT)
        overhead=(65536+8192+128)*free.f_frsize*2+self.q['maxOutputBytes']
        require(free.f_bavail*free.f_frsize >= p['reserveBytes']+request['bytes']+p['maxWorkBytes']+overhead)
        os.mkdir(self.root, 0o700)
        sync_dir(ROOT+'/attempts')
        os.mkdir(self.root+'/input', 0o755)
        os.mkdir(self.root+'/captured', 0o700)
        os.mkdir(self.root+'/work', 0o700)
        create(self.root+'/events.jsonl', encoded({'event':'intent','identity':self.identity})+b'\n')
        raw = self.root+'/work.ext4'
        fd = os.open(raw, os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
        try:
            os.posix_fallocate(fd, 0, p['maxWorkBytes'])
            os.fsync(fd)
        finally:
            os.close(fd)
        sync_dir(self.root)
        self.cmd(['/usr/sbin/mke2fs','-t','ext4','-q','-F','-m','0',raw])
        self.cmd(['/usr/bin/mount','-t','ext4','-o','loop,nodev,nosuid',raw,self.root+'/work'])
        self.work_dev = os.stat(self.root+'/work').st_dev
        require(self.work_dev != os.stat(self.root).st_dev)
        os.chown(self.root+'/work', p['buildUid'], p['buildGid'])
        os.chmod(self.root+'/work', 0o700)
        if self.q['sourceCopy']:
            os.mkdir(self.root+'/work/source', 0o700)
            os.chown(self.root+'/work/source',p['buildUid'],p['buildGid'])
        self.event({'event':'prepared-disk'})
        self.watch_read,self.watch_write=os.pipe()
        self.watch_pid=os.fork()
        if self.watch_pid==0:
            # A separate session survives broker/client death. Only its pipe is
            # retained; EOF, deadline or malformed input freezes/kills the scope.
            os.setsid()
            for name in os.listdir('/proc/self/fd'):
                fd=int(name)
                if fd!=self.watch_read:
                    try:os.close(fd)
                    except OSError:pass
            end=self.deadline+self.boot_offset;buffer=bytearray()
            sel=selectors.DefaultSelector();sel.register(self.watch_read,selectors.EVENT_READ)
            try:
                while time.clock_gettime(time.CLOCK_BOOTTIME)<end:
                    if not sel.select(min(.05,max(0,end-time.clock_gettime(time.CLOCK_BOOTTIME)))):continue
                    b=os.read(self.watch_read,1024)
                    if not b:break
                    buffer.extend(b);require(len(buffer)<=1024)
                    while b'\n' in buffer:
                        require(time.clock_gettime(time.CLOCK_BOOTTIME)<end)
                        line,_,rest=buffer.partition(b'\n');buffer=bytearray(rest)
                        require(re.fullmatch(b'[1-9][0-9]{0,19}',line))
                        target=int(line)/1000000000+self.boot_offset
                        require(time.clock_gettime(time.CLOCK_BOOTTIME)<target<=time.clock_gettime(time.CLOCK_BOOTTIME)+60)
                        end=min(self.deadline+self.boot_offset,target)
            except BaseException:
                pass  # Protocol/clock/IO errors close containment too.
            try:
                self.contain()
                create(self.root+'/watchdog-closed.json',encoded({'identity':self.identity,'closed':True}))
                os._exit(0)
            except BaseException:os._exit(1)
        os.close(self.watch_read)

    def pulse_watchdog(self,deadline):
        require(abs(time.clock_gettime(time.CLOCK_BOOTTIME)-time.monotonic()-self.boot_offset)<.05)
        require(not os.path.lexists(self.root+'/watchdog-closed.json') and os.waitpid(self.watch_pid,os.WNOHANG)==(0,0))
        data=(str(int(deadline*1000000000))+'\n').encode()
        require(os.write(self.watch_write,data)==len(data))

    def event(self, value):
        fd = os.open(self.root+'/events.jsonl', os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW)
        try:
            data=memoryview(encoded(value)+b'\n')
            while data:
                n=os.write(fd,data);require(n>0);data=data[n:]
            os.fsync(fd)
        finally:
            os.close(fd)

    def cmd(self, args):
        # Bounded output; no shell, plugins or ambient Docker context.
        p = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=ENV, cwd=ROOT, start_new_session=True)
        data = bytearray()
        end = time.monotonic()+10
        sel = selectors.DefaultSelector()
        sel.register(p.stdout, selectors.EVENT_READ)
        try:
            while sel.get_map():
                require(time.monotonic() < end)
                for key,_ in sel.select(.05):
                    b = os.read(key.fd, 65536)
                    if not b:
                        sel.unregister(key.fd)
                    else:
                        data.extend(b)
                        require(len(data) <= CHUNK)
            require(p.wait(timeout=max(.001,end-time.monotonic())) == 0)
            return bytes(data)
        finally:
            sel.close()
            if p.poll() is None:
                p.kill()
                p.wait()
            p.stdout.close()

    def docker(self, args):
        return self.cmd(['/usr/bin/docker','--config',ROOT+'/docker-config','--host','unix:///run/docker.sock']+args)

    def begin_file(self, r):
        exact(r,'op path sha256 sizeBytes mode')
        require(not self.started and not self.terminal and self.active is None and len(self.entries)<self.request['files'])
        relative(r['path']); hexhash(r['sha256']); number(r['sizeBytes'],0,64*CHUNK)
        number(r['mode'],0,0o777); require(not r['mode'] & 0o022)
        # Global casefold/path-prefix collision checks also cover file/dir aliases.
        name=r['path'].casefold()
        for f in self.entries:
            old=f['path'].casefold()
            require(name!=old and not name.startswith(old+'/') and not old.startswith(name+'/'))
        require(self.total+r['sizeBytes']<=self.request['bytes'])
        parts=r['path'].split('/')
        self.components.update('/'.join(parts[:i]) for i in range(1,len(parts)+1))
        require(len(self.components)<=65536)
        parent=os.path.dirname(self.root+'/input/'+r['path'])
        os.makedirs(parent,mode=0o755,exist_ok=True)
        fd=os.open(self.root+'/input/'+r['path'],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        self.active={'meta':{k:r[k] for k in ('path','sha256','sizeBytes','mode')},'fd':fd,'size':0,'hash':hashlib.sha256()}

    def append(self,r):
        exact(r,'op offset data')
        a=self.active; require(a is not None and r['offset']==a['size'])
        require(type(r['data']) is str and len(r['data'])<=1398104)
        b=base64.b64decode(r['data'],validate=True)
        require(0<len(b)<=CHUNK and a['size']+len(b)<=a['meta']['sizeBytes'])
        view=memoryview(b)
        while view:
            n=os.write(a['fd'],view);require(n>0);view=view[n:]
        a['hash'].update(b);a['size']+=len(b)

    def end_file(self):
        a=self.active; require(a is not None and a['size']==a['meta']['sizeBytes'] and a['hash'].hexdigest()==a['meta']['sha256'])
        os.fchmod(a['fd'],0o555 if a['meta']['mode'] & 0o111 else 0o444)
        os.fsync(a['fd']);os.close(a['fd']);self.active=None
        m=a['meta'];sync_dir(os.path.dirname(self.root+'/input/'+m['path']))
        if self.q['sourceCopy']:
            dst=self.root+'/work/source/'+m['path'];os.makedirs(os.path.dirname(dst),mode=0o755,exist_ok=True)
            # Source parents were created by root; only the mounted build UID can
            # write them during execution, never the host controller UID.
            cursor=os.path.dirname(dst)
            while cursor != self.root+'/work':
                os.chown(cursor,self.p['buildUid'],self.p['buildGid']);cursor=os.path.dirname(cursor)
            with open(self.root+'/input/'+m['path'],'rb') as src:
                fd=os.open(dst,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o700 if m['mode'] & 0o111 else 0o600)
                try:
                    while True:
                        b=src.read(CHUNK)
                        if not b:break
                        view=memoryview(b)
                        while view:
                            n=os.write(fd,view);require(n>0);view=view[n:]
                    os.fchown(fd,self.p['buildUid'],self.p['buildGid']);os.fsync(fd)
                finally:os.close(fd)
        self.entries.append(m);self.total+=m['sizeBytes']

    def seal(self):
        require(not self.started and self.active is None and len(self.entries)==self.request['files'] and self.total==self.request['bytes'])
        # Explicit ordered tuples avoid cross-language object serialization differences.
        tuples=[[f[k] for k in ('path','sha256','sizeBytes','mode')] for f in self.entries]
        require(digest(encoded(tuples))==self.request['filesHash'])
        self.event({'event':'input-verified','filesHash':self.request['filesHash']})
        self.sealed=True

    def launch(self,phase):
        require(not self.terminal and time.monotonic()<min(self.deadline,self.expires))
        require(not os.path.lexists(self.root+'/watchdog-closed.json') and os.waitpid(self.watch_pid,os.WNOHANG)==(0,0))
        self.phase=phase; q=self.q
        name='foundry-isolated-'+self.identity+'-'+str(phase)
        self.container=name
        self.event({'event':'create-intent','container':name,'phase':phase})
        args=['create','--name',name,'--label','foundry.isolated='+self.identity,'--restart=no','--pull=never','--runtime=runc',
              '--platform','linux/'+q['architecture'],'--network=none','--read-only','--privileged=false','--userns=host',
              '--user',str(self.p['buildUid'])+':'+str(self.p['buildGid']),'--cap-drop=ALL','--security-opt=no-new-privileges=true',
              '--cgroup-parent=/foundry-builds/'+self.identity,'--cgroupns=private','--ipc=private','--cpus',str(q['cpu']),'--memory',str(q['ramMib'])+'m','--memory-swap',str(q['ramMib'])+'m',
              '--pids-limit',str(q['pids']),'--ulimit','core=0:0','--ulimit','nofile=1024:1024','--log-driver=none',
              '--mount','type=bind,src='+self.root+'/input,dst=/input,readonly,bind-recursive=disabled',
              '--mount','type=bind,src='+self.root+'/work,dst=/work,bind-recursive=disabled',
              '--tmpfs','/tmp:rw,noexec,nosuid,nodev,size='+str(q['tmpMib'])+'m,mode=1777','--shm-size',str(q['tmpMib'])+'m',
              '--workdir=/work/source' if q['sourceCopy'] else '--workdir=/work','--entrypoint',q['commands'][phase][0]]
        for k,v in q['env'].items():args.extend(['--env',k+'='+v])
        args.extend([q['image']]+q['commands'][phase][1:])
        cid=self.docker(args).decode().strip();hexhash(cid)
        self.container=cid;self.event({'event':'container-created','container':cid})
        require(time.monotonic()<min(self.deadline,self.expires))
        self.child=subprocess.Popen(['/usr/bin/docker','--config',ROOT+'/docker-config','--host','unix:///run/docker.sock','start','--attach',cid],
              cwd=ROOT,env=ENV,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
        os.set_blocking(self.child.stdout.fileno(),False)
        self.event({'event':'start-client','pid':self.child.pid,'container':cid})

    def state(self):
        rows=json.loads(self.docker(['inspect',self.container]));require(len(rows)==1)
        s=rows[0];require(s['Config']['Labels'].get('foundry.isolated')==self.identity and s['Id']==self.container)
        require(s['HostConfig']['RestartPolicy']['Name']=='no')
        require(s['HostConfig']['CgroupParent']=='/foundry-builds/'+self.identity)
        return s['State']

    def empty(self):
        with open(self.cgroup+'/cgroup.events') as f:events=dict(line.split() for line in f)
        return events.get('populated')=='0'

    def contain(self):
        # This root-owned ancestor persists after Docker's child cgroup disappears.
        # Freezing is permanent: even a delayed daemon start cannot execute after
        # stop. No broker operation can thaw, move tasks or remove this cgroup.
        with open(self.cgroup+'/cgroup.freeze','w') as f:f.write('1')
        with open(self.cgroup+'/cgroup.kill','w') as f:f.write('1')
        end=time.monotonic()+2
        while time.monotonic()<end:
            with open(self.cgroup+'/cgroup.events') as f:events=dict(line.split() for line in f)
            if events.get('frozen')=='1' and events.get('populated')=='0':
                self.contained=True;return
            time.sleep(.01)
        raise ValueError('containment-unconfirmed')

    def runway(self,r):
        require(type(r['expiresAtNs']) is str and re.fullmatch('[1-9][0-9]{0,19}',r['expiresAtNs']))
        value=int(r['expiresAtNs']);now=time.monotonic_ns()
        require(now<value<=now+60000000000)
        return value/1000000000

    def start(self,r):
        exact(r,'op expiresAtNs')
        require(getattr(self,'sealed',False) and not self.started and not self.terminal)
        self.expires=self.runway(r)
        self.pulse_watchdog(self.expires)
        info=json.loads(self.docker(['info','--format','{{json .}}']))
        require(info['OSType']=='linux' and info['CgroupVersion']=='2' and info.get('CgroupDriver')=='cgroupfs' and all(info.get(k) is True for k in ('CpuCfsQuota','MemoryLimit','PidsLimit')))
        require(os.uname().machine==('x86_64' if self.q['architecture']=='amd64' else 'aarch64'))
        require('name=seccomp,profile=builtin' in info['SecurityOptions'] and not info.get('Warnings'))
        rows=json.loads(self.docker(['image','inspect',self.q['image']]))
        require(len(rows)==1 and rows[0]['Os']=='linux' and rows[0]['Architecture']==self.q['architecture'] and self.q['image'] in rows[0].get('RepoDigests',[]) and not rows[0]['Config'].get('Volumes'))
        self.started=True;self.launch(0)

    def drain(self):
        if not self.child:return
        while True:
            try:b=os.read(self.child.stdout.fileno(),65536)
            except BlockingIOError:return
            if not b:return
            self.log.extend(b);require(len(self.log)<=self.q['maxOutputBytes'])

    def tick(self):
        if not self.started or self.terminal:return
        require(not os.path.lexists(self.root+'/watchdog-closed.json') and os.waitpid(self.watch_pid,os.WNOHANG)==(0,0))
        self.drain()
        if time.monotonic()>=min(self.deadline,self.expires):
            self.stop();return
        if self.child.poll() is None:return
        self.drain()
        # Client completion alone does not establish stopped execution.
        s=self.state();require(not s['Running'] and s['Status'] in ('exited','dead') and self.empty())
        self.child.stdout.close()
        if self.child.returncode==0 and s['ExitCode']==0 and self.phase+1<len(self.q['commands']):
            self.launch(self.phase+1);return
        number(s['ExitCode'],0,255);self.exit_code=s['ExitCode']
        self.terminal=True;self.success=self.child.returncode==0 and s['Status']=='exited' and self.exit_code==0
        self.contain()
        self.event({'event':'stopped','success':self.success,'container':self.container})

    def stop(self):
        # Close admission permanently BEFORE requesting physical stop. Ambiguous
        # clients/containers retain the durable slot; no disappearance-as-success.
        self.terminal=True;self.success=False
        self.exit_code=None
        self.contain()
        if self.child and self.child.poll() is None:
            self.child.kill();self.child.wait(timeout=2)
        if self.container:
            s=self.state()
            if s['Running']:self.docker(['kill','--signal=KILL',self.container])
            s=self.state();require(not s['Running'] and s['Status'] in ('exited','dead','created'))
        self.event({'event':'stopped','success':False,'container':self.container})

    def capture(self):
        require(self.terminal and self.success and self.contained and self.empty() and not self.outputs)
        s=self.state();require(not s['Running'] and s['Status']=='exited' and s['ExitCode']==0)
        total=len(self.log); chunks=(len(self.log)+CHUNK-1)//CHUNK
        selected=[]
        # The broker is the only Docker authority. Terminal state has no restart
        # operation. Builds have no socket/host root access; all phases are stopped.
        for path in self.q['outputPaths']:
            relative(path);cur=self.root+'/work'
            for component in path.split('/'):
                cur+='/'+component;st=os.lstat(cur)
                require(not stat.S_ISLNK(st.st_mode) and st.st_dev==self.work_dev)
                require(not any(k.startswith('system.posix_acl_') for k in os.listxattr(cur,follow_symlinks=False)))
            require(stat.S_ISREG(st.st_mode) and st.st_nlink==1 and not st.st_mode & 0o7000)
            total+=st.st_size;chunks+=(st.st_size+CHUNK-1)//CHUNK
            require(total<=self.q['maxOutputBytes'] and chunks<=31)
            selected.append((path,cur,st))
        for index,(path,src,expected) in enumerate(selected):
            fd=os.open(src,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            try:
                st=os.fstat(fd);require((st.st_dev,st.st_ino,st.st_size)==(expected.st_dev,expected.st_ino,expected.st_size))
                out=os.open(self.root+'/captured/'+str(index),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)
                h=hashlib.sha256();size=0
                try:
                    while True:
                        b=os.read(fd,CHUNK)
                        if not b:break
                        size+=len(b);require(size<=expected.st_size);h.update(b)
                        view=memoryview(b)
                        while view:
                            n=os.write(out,view);require(n>0);view=view[n:]
                    require(size==expected.st_size);os.fsync(out)
                finally:os.close(out)
                self.outputs.append({'path':path,'sha256':h.hexdigest(),'sizeBytes':size})
            finally:os.close(fd)
        create(self.root+'/captured/log',bytes(self.log));os.chmod(self.root+'/captured/log',0o400)
        sync_dir(self.root+'/captured')
        self.event({'event':'captured','outputs':self.outputs,'logSha256':digest(self.log),'logBytes':len(self.log)})
        self.captured=True

    def dispatch(self,r):
        op=r.get('op')
        if op=='file':self.begin_file(r)
        elif op=='append':self.append(r)
        elif op=='end':exact(r,'op');self.end_file()
        elif op=='seal':exact(r,'op');self.seal()
        elif op=='start':self.start(r)
        elif op=='pulse':
            exact(r,'op expiresAtNs')
            # Completion between status and pulse is a terminal reply, never revival.
            require(self.started)
            if not self.terminal:
                require(time.monotonic()<self.expires)
                self.expires=self.runway(r)
                self.pulse_watchdog(self.expires)
        elif op=='status':exact(r,'op')
        elif op=='stop':exact(r,'op');self.stop()
        elif op=='capture':exact(r,'op');self.capture()
        elif op=='read':
            exact(r,'op index offset');require(getattr(self,'captured',False))
            number(r['index'],-1,len(self.outputs)-1);number(r['offset'],0,31*CHUNK)
            path='log' if r['index']==-1 else str(r['index'])
            with open(self.root+'/captured/'+path,'rb') as f:
                f.seek(r['offset']);b=f.read(CHUNK)
            return {'identity':self.identity,'data':base64.b64encode(b).decode()}
        else:raise ValueError('operation')
        return {'identity':self.identity,'terminal':self.terminal and self.contained,'success':self.success and self.contained,'exitCode':self.exit_code,'outputs':self.outputs,
                'log':{'sha256':digest(self.log),'sizeBytes':len(self.log)}}

def server():
    require(sys.platform=='linux' and os.geteuid()==0)
    os.umask(0o022)
    p=load_policy();trusted('/run/foundry-linux',True)
    trusted(sys.executable);trusted(os.path.abspath(__file__))
    with open(sys.executable,'rb') as f:python_hash=digest(f.read())
    with open(os.path.abspath(__file__),'rb') as f:helper_hash=digest(f.read())
    require(not os.path.lexists(ROOT+'/slot.json') and not os.path.lexists(SOCKET))
    sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);sock.bind(SOCKET)
    os.chown(SOCKET,0,p['controllerGid']);os.chmod(SOCKET,0o660);sock.listen(1)
    sock.settimeout(1)
    while True:
        census(p,helper_hash,python_hash)
        try:conn,_=sock.accept();break
        except socket.timeout:continue
    attempt=None
    try:
        require(peer(conn)==(p['controllerUid'],p['controllerGid']))
        conn.settimeout(10)
        request=receive(conn)
        attempt=Attempt(p,request)
        send(conn,{'identity':attempt.identity,'profile':attempt.q,'helperSha256':helper_hash,'pythonSha256':python_hash})
        # Serialized frames are bounded by an absolute deadline even when a peer
        # dribbles bytes. A separate timer is not allowed to race mutation handlers.
        conn.setblocking(False)
        buf=bytearray(); frame_start=None;last=time.monotonic();observed=0
        while True:
            attempt.tick()
            if time.monotonic()-observed>=1:
                census(p,helper_hash,python_hash,attempt);observed=time.monotonic()
            require(time.monotonic()<attempt.deadline and time.monotonic()-last<(10 if attempt.started and not attempt.terminal else 60))
            if frame_start is not None:require(time.monotonic()-frame_start<2)
            ready=selectors.DefaultSelector()
            try:
                ready.register(conn,selectors.EVENT_READ)
                events=ready.select(.05)
            finally:ready.close()
            if not events:continue
            b=conn.recv(65536);require(b)
            if not buf:frame_start=time.monotonic()
            buf.extend(b);require(len(buf)<=FRAME+4)
            if len(buf)<4:continue
            n=struct.unpack('!I',buf[:4])[0];number(n,1,FRAME)
            if len(buf)<n+4:continue
            require(len(buf)==n+4)
            r=json.loads(bytes(buf[4:]));buf.clear();frame_start=None
            # tick BEFORE a pulse; a late request cannot revive expired admission.
            attempt.tick();response=attempt.dispatch(r);last=time.monotonic()
            conn.settimeout(2);send(conn,response);conn.setblocking(False)
    finally:
        if attempt:
            try:attempt.stop()
            except Exception:pass  # Durable slot already retained; never claim stop.
            try:os.close(attempt.watch_write)
            except Exception:pass
        conn.close();sock.close()
        # No unlink, unmount, container removal, slot clearing or restart replay.

def client():
    require(sys.platform=='linux' and os.geteuid()!=0)
    trusted(sys.executable)
    trusted(os.path.abspath(__file__))
    trusted('/run/foundry-linux',True)
    s=os.lstat(SOCKET);require(stat.S_ISSOCK(s.st_mode) and s.st_uid==0 and s.st_mode & 0o007==0)
    sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);sock.settimeout(45);sock.connect(SOCKET)
    require(peer(sock)[0]==0)
    try:
        while True:
            header=sys.stdin.buffer.read(4)
            if not header:break
            require(len(header)==4);n=struct.unpack('!I',header)[0];number(n,1,FRAME)
            b=sys.stdin.buffer.read(n);require(len(b)==n)
            sock.sendall(header+b);r=receive(sock);out=encoded(r)
            sys.stdout.buffer.write(struct.pack('!I',len(out))+out);sys.stdout.buffer.flush()
            sock.settimeout(12)
    finally:sock.close()

if __name__=='__main__':
    try:
        require(sys.flags.isolated and sys.flags.no_site and len(sys.argv)==2)
        if sys.argv[1]=='serve':server()
        elif sys.argv[1]=='client':client()
        else:raise ValueError('mode')
    except Exception:
        # No exception text, paths, source, logs, environment or policy on stdout.
        sys.exit(1)

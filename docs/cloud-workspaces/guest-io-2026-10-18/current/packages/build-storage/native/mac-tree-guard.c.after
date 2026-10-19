/* mac-tree-guard/1: observation and FD lifetime only. No mount/image/unmount,
 * shell, writes to the tree, privilege elevation, or cooperative writer lock.
 * A trusted root administrator provisions an ACL-free static tree and helper.
 * The kernel's MNT_RDONLY supplies immutability against unprivileged writers.
 * Root administration, raw block access and host-process compromise are outside
 * this contract. See FILESYSTEM-REVIEW.md before any build or admission. */
#ifndef __APPLE__
#error "mac-tree-guard requires macOS"
#endif
#include <sys/param.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/attr.h>
#include <sys/acl.h>
#include <sys/proc_info.h>
#include <libproc.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <uuid/uuid.h>

#define ENTRY_LIMIT 200000U
#define DEPTH_LIMIT 128U
#define MOUNT_LIMIT 4096U

static void die(void) {
    /* Bounded constant diagnostic: never echo paths, content, or errno strings. */
    (void)write(STDERR_FILENO, "mac-tree-guard: refused\n", 24);
    _exit(1);
}
static void need(int yes) { if (!yes) die(); }
static int beneath(const char *path, const char *parent) {
    size_t n = strlen(parent);
    return !strcmp(path, parent) || (!strncmp(path, parent, n) && path[n] == '/');
}
static void canonical(const char *path) {
    size_t n = strlen(path);
    need(n > 1 && n < MAXPATHLEN && path[0] == '/' && path[n - 1] != '/');
    const char *p = path + 1;
    while (*p) {
        const char *end = strchr(p, '/');
        size_t len = end ? (size_t)(end - p) : strlen(p);
        need(len > 0 && len <= NAME_MAX && !(len == 1 && p[0] == '.') &&
             !(len == 2 && p[0] == '.' && p[1] == '.'));
        for (size_t i = 0; i < len; i++) need((unsigned char)p[i] >= 0x20 && (unsigned char)p[i] <= 0x7e);
        if (!end) break;
        p = end + 1;
    }
}
static uint64_t number(const char *s) {
    need(*s && !(s[0] == '0' && s[1]));
    for (const char *p = s; *p; p++) need(*p >= '0' && *p <= '9');
    errno = 0; char *end = NULL;
    unsigned long long v = strtoull(s, &end, 10);
    need(!errno && end && !*end);
    return (uint64_t)v;
}
static int32_t fsid_number(const char *s) {
    errno = 0; char *end = NULL; long long n = strtoll(s, &end, 10);
    need(*s && !errno && end && !*end && n >= INT32_MIN && n <= INT32_MAX);
    return (int32_t)n;
}
static void no_acl(int fd) {
    /* Refuse even deny-only ACLs: do not try to approximate effective ACL rights. */
    /* Distinguish an absent ACL from an API failure. acl_get_fd_np alone returns
     * NULL for both; an ordinary ACL-free node need not contain an empty ACL. */
    filesec_t security = filesec_init(); need(security != NULL);
    struct stat observed; int present = 0;
    need(fstatx_np(fd, &observed, security) == 0 &&
         filesec_query_property(security, FILESEC_ACL, &present) == 0);
    if (!present) { filesec_free(security); return; }
    acl_t acl = NULL;
    need(filesec_get_property(security, FILESEC_ACL, &acl) == 0 && acl != NULL &&
         (void *)acl != _FILESEC_REMOVE_ACL);
    acl_entry_t entry;
    int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
    int entry_errno = errno;
    need(acl_free(acl) == 0);
    filesec_free(security);
    /* Darwin acl_get_entry returns -1/EINVAL for an out-of-range entry index. */
    need(result == -1 && entry_errno == EINVAL);
}
static int same_node(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
           a->st_uid == b->st_uid && a->st_mode == b->st_mode && a->st_nlink == b->st_nlink;
}
static void secure_directory(int fd) {
    struct stat s; struct statfs fs;
    need(fstat(fd, &s) == 0 && S_ISDIR(s.st_mode) && s.st_uid == 0 && !(s.st_mode & 0022));
    no_acl(fd);
    need(fstatfs(fd, &fs) == 0 && fs.f_owner == 0 && (fs.f_flags & MNT_LOCAL));
}
/* Walk from / with openat; each directory is held while its child is opened.
 * An unprivileged UID cannot replace entries in these ACL-free root directories. */
static int secure_open(const char *path, int executable) {
    canonical(path);
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    need(fd >= 0); secure_directory(fd);
    char copy[MAXPATHLEN]; memcpy(copy, path + 1, strlen(path));
    char *save = NULL, *part = strtok_r(copy, "/", &save);
    while (part) {
        char *next = strtok_r(NULL, "/", &save);
        int leaf = !next && executable;
        int child = openat(fd, part, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (leaf ? 0 : O_DIRECTORY));
        need(child >= 0);
        if (leaf) {
            struct stat s;
            need(fstat(child, &s) == 0 && S_ISREG(s.st_mode) && s.st_uid == 0 &&
                 s.st_nlink == 1 && !(s.st_mode & 06022) && (s.st_mode & 0111));
            no_acl(child);
        } else secure_directory(child);
        need(close(fd) == 0); fd = child; part = next;
    }
    return fd;
}
static const char self_image_anchor[] = "mac-tree-guard/1";
static void verify_executable(const char *expected) {
    char actual[PROC_PIDPATHINFO_MAXSIZE] = {0};
    need(proc_pidpath(getpid(), actual, sizeof(actual)) > 0 &&
         memchr(actual, '\0', sizeof(actual)) != NULL && !strcmp(actual, expected));
    int fd = secure_open(expected, 1);
    struct stat named;
    need(fstat(fd, &named) == 0);
    /* Check the vnode backing this image's own constant mapping, not argv[0]
     * or merely a second pathname stat. No privilege or caller attestation. */
    struct proc_regionwithpathinfo image = {0};
    uint64_t address = (uint64_t)(uintptr_t)self_image_anchor;
    need(proc_pidinfo(getpid(), PROC_PIDREGIONPATHINFO, address,
                      &image, sizeof(image)) == (int)sizeof(image));
    need(address >= image.prp_prinfo.pri_address &&
         address - image.prp_prinfo.pri_address < image.prp_prinfo.pri_size);
    struct vinfo_stat *loaded = &image.prp_vip.vip_vi.vi_stat;
    need(loaded->vst_dev == (uint32_t)named.st_dev && loaded->vst_ino == (uint64_t)named.st_ino &&
         loaded->vst_uid == 0 && S_ISREG(loaded->vst_mode) && !(loaded->vst_mode & 06022) &&
         loaded->vst_size == named.st_size && memchr(image.prp_vip.vip_path, '\0', sizeof(image.prp_vip.vip_path)) != NULL &&
         !strcmp(image.prp_vip.vip_path, expected));
    need(close(fd) == 0);
}
struct identity {
    struct stat root;
    struct statfs fs;
    uuid_t uuid;
};
static int same_fs(const struct statfs *a, const struct statfs *b) {
    return a->f_fsid.val[0] == b->f_fsid.val[0] && a->f_fsid.val[1] == b->f_fsid.val[1] &&
           !strcmp(a->f_mntonname, b->f_mntonname) && !strcmp(a->f_mntfromname, b->f_mntfromname) &&
           !strcmp(a->f_fstypename, b->f_fstypename) && a->f_owner == b->f_owner;
}
static void volume_uuid(int fd, uuid_t out) {
    struct attrlist attrs = {0};
    attrs.bitmapcount = ATTR_BIT_MAP_COUNT;
    attrs.commonattr = ATTR_CMN_RETURNED_ATTRS;
    attrs.volattr = ATTR_VOL_INFO | ATTR_VOL_UUID;
    /* getattrlist packing is 4-byte aligned; byte-copy avoids C padding assumptions. */
    unsigned char bytes[sizeof(uint32_t) + sizeof(attribute_set_t) + sizeof(uuid_t)] = {0};
    need(fgetattrlist(fd, &attrs, bytes, sizeof(bytes), 0) == 0);
    uint32_t length; attribute_set_t returned;
    memcpy(&length, bytes, sizeof(length));
    memcpy(&returned, bytes + sizeof(length), sizeof(returned));
    need(length == sizeof(bytes) && (returned.volattr & ATTR_VOL_UUID));
    memcpy(out, bytes + sizeof(length) + sizeof(returned), sizeof(uuid_t));
    need(!uuid_is_null(out));
}
static void observe(int fd, int mountfd, const char *path, struct identity *out) {
    secure_directory(fd);
    need(fstat(fd, &out->root) == 0 && fstatfs(fd, &out->fs) == 0);
    struct statfs named;
    /* Both pathname and held-descriptor observations must agree. */
    need(statfs(path, &named) == 0 && same_fs(&named, &out->fs));
    need((out->fs.f_flags & (MNT_RDONLY | MNT_LOCAL)) == (MNT_RDONLY | MNT_LOCAL) &&
         (named.f_flags & (MNT_RDONLY | MNT_LOCAL)) == (MNT_RDONLY | MNT_LOCAL) && out->fs.f_owner == 0);
    need(!strcmp(out->fs.f_fstypename, "apfs") || !strcmp(out->fs.f_fstypename, "hfs"));
    struct statfs mounted;
    need(fstatfs(mountfd, &mounted) == 0 && same_fs(&mounted, &out->fs) &&
         (mounted.f_flags & (MNT_RDONLY | MNT_LOCAL)) == (MNT_RDONLY | MNT_LOCAL));
    /* Volume attributes require the volume root, even when the managed tree is
     * a subdirectory. The separate retained mountpoint FD supplies that root. */
    volume_uuid(mountfd, out->uuid);
    /* Use getattrlist too, independently of the descriptor's fgetattrlist. */
    struct attrlist attrs = {0}; attrs.bitmapcount = ATTR_BIT_MAP_COUNT;
    attrs.volattr = ATTR_VOL_INFO | ATTR_VOL_UUID;
    unsigned char bytes[sizeof(uint32_t) + sizeof(uuid_t)] = {0};
    uint32_t length;
    need(getattrlist(out->fs.f_mntonname, &attrs, bytes, sizeof(bytes), FSOPT_NOFOLLOW) == 0);
    memcpy(&length, bytes, sizeof(length));
    need(length == sizeof(bytes) && !memcmp(bytes + sizeof(length), out->uuid, sizeof(uuid_t)));
}
static void mount_table(const struct identity *id, const char *mountpoint) {
    int count = getfsstat(NULL, 0, MNT_NOWAIT);
    need(count > 0 && count < (int)MOUNT_LIMIT);
    /* One spare entry detects growth/truncation, never silently accepts it. */
    size_t capacity = (size_t)count + 1;
    struct statfs *mounts = calloc(capacity, sizeof(*mounts)); need(mounts != NULL);
    int used = getfsstat(mounts, (int)(capacity * sizeof(*mounts)), MNT_NOWAIT);
    need(used == count && getfsstat(NULL, 0, MNT_NOWAIT) == count);
    int seen = 0;
    for (int i = 0; i < used; i++) {
        struct statfs *m = &mounts[i];
        if (!strcmp(m->f_mntonname, mountpoint)) {
            need(same_fs(m, &id->fs) && (m->f_flags & MNT_RDONLY) && (m->f_flags & MNT_LOCAL) && m->f_owner == 0);
            seen++;
        } else {
            need(!beneath(m->f_mntonname, mountpoint));
            /* No second alias of this volume, including a writable mount alias. */
            need(strcmp(m->f_mntfromname, id->fs.f_mntfromname) &&
                 !(m->f_fsid.val[0] == id->fs.f_fsid.val[0] && m->f_fsid.val[1] == id->fs.f_fsid.val[1]));
        }
        /* Every mounted filesystem covering the namespace must be root-mounted. */
        if (!strcmp(m->f_mntonname, "/") || beneath(mountpoint, m->f_mntonname))
            need(m->f_owner == 0 && (m->f_flags & MNT_LOCAL));
    }
    need(seen == 1); free(mounts);
}
static void scan(int fd, const struct identity *id, unsigned depth, unsigned *entries) {
    need(depth <= DEPTH_LIMIT); secure_directory(fd);
    int iterator = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    need(iterator >= 0);
    DIR *dir = fdopendir(iterator); need(dir != NULL);
    for (;;) {
        errno = 0; struct dirent *entry = readdir(dir);
        if (!entry) {need(errno == 0); break;}
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        need(++*entries <= ENTRY_LIMIT);
        struct stat before, opened; struct statfs fs;
        need(fstatat(fd, entry->d_name, &before, AT_SYMLINK_NOFOLLOW) == 0 &&
             before.st_dev == id->root.st_dev && before.st_uid == 0 && !(before.st_mode & 0022) &&
             (S_ISDIR(before.st_mode) || (S_ISREG(before.st_mode) && before.st_nlink == 1)));
        int child = openat(fd, entry->d_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK |
                           (S_ISDIR(before.st_mode) ? O_DIRECTORY : 0));
        need(child >= 0 && fstat(child, &opened) == 0 && same_node(&before, &opened));
        need(fstatfs(child, &fs) == 0 && same_fs(&fs, &id->fs) && (fs.f_flags & MNT_RDONLY));
        no_acl(child);
        if (S_ISDIR(opened.st_mode)) scan(child, id, depth + 1, entries);
        need(close(child) == 0);
    }
    need(closedir(dir) == 0);
}
static void json_string(const char *s) {
    need(putchar('"') != EOF);
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        need(c >= 0x20 && c <= 0x7e);
        if (c == '"' || c == '\\') need(putchar('\\') != EOF);
        need(putchar(c) != EOF);
    }
    need(putchar('"') != EOF);
}
static void frame(const char *event, const char *nonce, const char *path, const struct identity *id) {
    char uuid[37]; uuid_unparse_lower(id->uuid, uuid);
    need(printf("{\"protocol\":\"mac-tree-guard/1\",\"event\":") > 0); json_string(event);
    need(printf(",\"nonce\":") > 0); json_string(nonce);
    need(printf(",\"path\":") > 0); json_string(path);
    need(printf(",\"mountPoint\":") > 0); json_string(id->fs.f_mntonname);
    need(printf(",\"filesystem\":") > 0); json_string(id->fs.f_fstypename);
    need(printf(",\"fsid\":[%" PRId32 ",%" PRId32 "],\"mountSource\":", id->fs.f_fsid.val[0], id->fs.f_fsid.val[1]) > 0);
    json_string(id->fs.f_mntfromname);
    need(printf(",\"volumeUuid\":") > 0); json_string(uuid);
    need(printf(",\"rootDevice\":\"%" PRIu64 "\",\"rootInode\":\"%" PRIu64 "\",\"mountOwner\":0,\"readonly\":true,\"local\":true}\n",
                (uint64_t)id->root.st_dev, (uint64_t)id->root.st_ino) > 0);
    need(fflush(stdout) == 0);
}
int main(int argc, char **argv) {
    /* Owner-only observation for the offline image assembler. This does NOT
     * grant a read capability: the unprivileged client still pins and holds its
     * own readonly-v1 session. No mutations or privilege escalation here. */
    if (argc == 5 && !strcmp(argv[1], "--describe-readonly-v1")) {
        need(getuid() == 0 && geteuid() == 0 && !issetugid());
        verify_executable(argv[2]); canonical(argv[3]); canonical(argv[4]);
        need(beneath(argv[3], argv[4]));
        int mounted = secure_open(argv[4], 0), root = secure_open(argv[3], 0);
        struct identity id; observe(root, mounted, argv[3], &id);
        need(!strcmp(id.fs.f_mntonname, argv[4]));
        mount_table(&id, argv[4]); unsigned entries = 0; scan(root, &id, 0, &entries);
        frame("observed", "00000000000000000000000000000000", argv[3], &id);
        need(close(root) == 0 && close(mounted) == 0); return 0;
    }
    need(argc == 13 && !strcmp(argv[1], "--readonly-v1"));
    need(getuid() != 0 && getuid() == geteuid() && getgid() == getegid() && !issetugid());
    need(signal(SIGPIPE, SIG_IGN) != SIG_ERR);
    const char *helper = argv[2], *nonce = argv[3], *path = argv[4], *mountpoint = argv[5];
    canonical(path); canonical(mountpoint); need(beneath(path, mountpoint));
    need(strlen(nonce) == 32 && strspn(nonce, "0123456789abcdef") == 32);
    /* TS pins the executable bytes; here require ACL-free root-owned placement. */
    verify_executable(helper);
    int mounted = secure_open(mountpoint, 0), root = secure_open(path, 0);
    struct identity before, after;
    observe(root, mounted, path, &before);
    struct statfs mountfs; struct stat mountstat;
    need(fstatfs(mounted, &mountfs) == 0 && same_fs(&mountfs, &before.fs) && fstat(mounted, &mountstat) == 0);
    need(!strcmp(before.fs.f_mntonname, mountpoint) && !strcmp(before.fs.f_fstypename, argv[6]) &&
         before.fs.f_fsid.val[0] == fsid_number(argv[7]) && before.fs.f_fsid.val[1] == fsid_number(argv[8]) &&
         !strcmp(before.fs.f_mntfromname, argv[9]) && (uint64_t)before.root.st_dev == number(argv[11]) &&
         (uint64_t)before.root.st_ino == number(argv[12]));
    uuid_t expected; need(uuid_parse(argv[10], expected) == 0 && !uuid_compare(expected, before.uuid));
    mount_table(&before, mountpoint);
    unsigned entries = 0; scan(root, &before, 0, &entries);
    frame("ready", nonce, path, &before);
    /* Blocking private stdin: no command language. EOF alone releases. Root FD
     * remains open across the complete host callback and postflight validation. */
    char byte;
    for (;;) {
        ssize_t n = read(STDIN_FILENO, &byte, 1);
        if (n < 0 && errno == EINTR) continue;
        need(n == 0); break;
    }
    int reopened = secure_open(path, 0), remounted = secure_open(mountpoint, 0);
    struct stat named, mountnamed;
    need(fstat(reopened, &named) == 0 && same_node(&named, &before.root));
    need(fstat(remounted, &mountnamed) == 0 && same_node(&mountnamed, &mountstat));
    observe(root, mounted, path, &after);
    need(same_node(&before.root, &after.root) && same_fs(&before.fs, &after.fs) && !uuid_compare(before.uuid, after.uuid));
    mount_table(&after, mountpoint);
    entries = 0; scan(root, &after, 0, &entries);
    verify_executable(helper);
    frame("released", nonce, path, &after);
    need(close(reopened) == 0 && close(remounted) == 0 && close(mounted) == 0 && close(root) == 0);
    return 0;
}

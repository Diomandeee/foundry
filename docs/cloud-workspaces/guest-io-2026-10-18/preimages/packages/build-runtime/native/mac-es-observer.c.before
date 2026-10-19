/* Source candidate only. Public Apple EndpointSecurity APIs, macOS 11+ message
 * version >=5. No AUTH_FORK assumption: FORK is a notification. No ES notifications
 * can establish closure of work in existing/shared XPC services. No root adoption,
 * PID scan, account filter, process-group inference or termination claim is made.
 *
 * The privileged caller must integrate one continuously owned ES client with
 * suspended launch, one-shot tickets, authenticated IPC, durable signed projection
 * and service containment. None of those missing pieces is simulated here.
 */
#include "mac-es-observer.h"
#include <EndpointSecurity/EndpointSecurity.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

struct foundry_mac_es_observer {
    es_client_t *client;
    int fd;
    atomic_bool poisoned;
    bool have_global, have_type[3];
    uint64_t global, per_type[3], mach;
    size_t bytes, records;
};

enum { MAX_BYTES = 8 * 1048576, MAX_RECORDS = 32768, FAULT_RESERVE = 256 };

/* ES delivers this client's callbacks serially. No message pointers escape the
 * callback; copying only the required numeric fields avoids paths/argv/env/secrets.
 * Synchronous durability can cause ES backpressure. A drop then poisons the stream;
 * slow storage is NEVER converted into a complete-coverage assertion.
 */
static bool write_all(int fd, const char *bytes, size_t size) {
    size_t offset = 0;
    while (offset < size) {
        ssize_t count = write(fd, bytes + offset, size - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return false;
        offset += (size_t)count;
    }
    return fsync(fd) == 0;
}

static void poison(foundry_mac_es_observer *s) {
    if (!atomic_exchange(&s->poisoned, true)) {
        static const char fault[] = "[\"fault\",\"coverage-lost-no-stop-proof\"]\n";
        (void)write_all(s->fd, fault, sizeof(fault)-1);
    }
}

static bool emit(foundry_mac_es_observer *s, const char *line, size_t size) {
    if (atomic_load(&s->poisoned)) return false;
    if (s->records >= MAX_RECORDS || size > MAX_BYTES - FAULT_RESERVE - s->bytes ||
        !write_all(s->fd, line, size)) {
        poison(s); return false;
    }
    s->records++; s->bytes += size; return true;
}

static bool identity(char *out, size_t size, const es_process_t *p) {
    if (!p || p->audit_token.val[5] == 0 || p->start_time.tv_sec < 0 ||
        p->start_time.tv_usec < 0 || p->start_time.tv_usec >= 1000000) return false;
    const unsigned int *a = p->audit_token.val;
    int n = snprintf(out, size, "[[%u,%u,%u,%u,%u,%u,%u,%u],\"%lld\",%d]",
        a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],
        (long long)p->start_time.tv_sec,(int)p->start_time.tv_usec);
    return n > 0 && (size_t)n < size;
}

static void observe(foundry_mac_es_observer *s, const es_message_t *m) {
    if (atomic_load(&s->poisoned)) return;
    /* Reading newer structure members before checking message.version is unsafe. */
    if (!m || m->version < 5 || m->action_type != ES_ACTION_TYPE_NOTIFY) { poison(s); return; }
    int type;
    const char *name;
    const es_process_t *target = NULL;
    switch (m->event_type) {
        case ES_EVENT_TYPE_NOTIFY_FORK: type = 0; name = "fork"; target = m->event.fork.child; break;
        case ES_EVENT_TYPE_NOTIFY_EXEC: type = 1; name = "exec"; target = m->event.exec.target; break;
        case ES_EVENT_TYPE_NOTIFY_EXIT: type = 2; name = "exit"; break;
        default: poison(s); return;
    }
    uint64_t global = m->global_seq_num, sequence = m->seq_num;
    if ((s->have_global && (s->global == UINT64_MAX || global != s->global+1 || m->mach_time < s->mach)) ||
        (s->have_type[type] && (s->per_type[type] == UINT64_MAX || sequence != s->per_type[type]+1))) {
        poison(s); return;
    }
    /* First observations establish baselines, never prove an earlier interval.
     * An owning supervisor cannot arm a launch until all needed baselines exist.
     * All subscribed host events advance counters, including unrelated UIDs.
     */
    s->have_global = true; s->have_type[type] = true;
    s->global = global; s->per_type[type] = sequence; s->mach = m->mach_time;
    char source[256], dest[256], event[768], line[1024];
    if (!identity(source,sizeof(source),m->process) || (type != 2 && !identity(dest,sizeof(dest),target))) { poison(s); return; }
    int en = type == 2 ? snprintf(event,sizeof(event),"[\"%s\",%s]",name,source) :
        snprintf(event,sizeof(event),"[\"%s\",%s,%s]",name,source,dest);
    if (en <= 0 || (size_t)en >= sizeof(event)) { poison(s); return; }
    int n = snprintf(line,sizeof(line),"[\"event\",%u,\"%" PRIu64 "\",\"%" PRIu64 "\",\"%" PRIu64 "\",%s]\n",
        m->version,global,sequence,m->mach_time,event);
    if (n <= 0 || (size_t)n >= sizeof(line)) { poison(s); return; }
    (void)emit(s,line,(size_t)n);
}

int foundry_mac_es_observer_open(int fd, foundry_mac_es_observer **out, int *es_result) {
    if (!out || !es_result) return EINVAL;
    *out = NULL; *es_result = -1;
    struct stat st;
    int flags = fcntl(fd,F_GETFL);
    if (geteuid() != 0 || flags < 0 || fstat(fd,&st) != 0 || !S_ISREG(st.st_mode) ||
        st.st_uid != 0 || st.st_nlink != 1 || st.st_size != 0 || (st.st_mode & 0077) != 0 ||
        (flags & O_ACCMODE) != O_WRONLY || !(flags & O_APPEND)) return EACCES;
    foundry_mac_es_observer *s = calloc(1,sizeof(*s));
    if (!s) return ENOMEM;
    s->fd = fcntl(fd,F_DUPFD_CLOEXEC,0);
    if (s->fd < 0) { int error = errno; free(s); return error; }
    atomic_init(&s->poisoned,false);
    static const char header[] = "[\"observer\",1,\"process-events-only\",\"unsigned-no-stop-proof\"]\n";
    if (!emit(s,header,sizeof(header)-1)) { close(s->fd); free(s); return EIO; }
    es_new_client_result_t result = es_new_client(&s->client, ^(es_client_t *client, const es_message_t *message) {
        (void)client; observe(s,message);
    });
    *es_result = (int)result;
    if (result != ES_NEW_CLIENT_RESULT_SUCCESS) { poison(s); close(s->fd); free(s); return EACCES; }
    /* Fresh client, no account/path filters added by this source. Clearing path
     * muting is required; no "unmuted" readiness receipt is emitted by this library.
     * The owning supervisor must also audit process muting/subscription state.
     */
    const es_event_type_t types[] = {ES_EVENT_TYPE_NOTIFY_FORK,ES_EVENT_TYPE_NOTIFY_EXEC,ES_EVENT_TYPE_NOTIFY_EXIT};
    if (es_unmute_all_paths(s->client) != ES_RETURN_SUCCESS || es_subscribe(s->client,types,3) != ES_RETURN_SUCCESS) {
        poison(s);
        if (es_delete_client(s->client) != ES_RETURN_SUCCESS) { *out = s; return EIO; }
        close(s->fd); free(s); return EIO;
    }
    *out = s; return 0; // client creation/subscription only, NEVER native readiness
}

int foundry_mac_es_observer_poisoned(const foundry_mac_es_observer *s) {
    return !s || atomic_load(&s->poisoned);
}

int foundry_mac_es_observer_close(foundry_mac_es_observer *s) {
    if (!s) return 0;
    /* Stop callbacks before releasing their state. No reconnection/recovery path. */
    if (es_delete_client(s->client) != ES_RETURN_SUCCESS) { poison(s); return EIO; }
    static const char ended[] = "[\"observer-ended\",\"no-seal-no-stop-proof\"]\n";
    if (!atomic_load(&s->poisoned)) (void)emit(s,ended,sizeof(ended)-1);
    close(s->fd); free(s); return 0;
}

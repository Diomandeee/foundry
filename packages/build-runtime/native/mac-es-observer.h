#ifndef FOUNDRY_MAC_ES_OBSERVER_H
#define FOUNDRY_MAC_ES_OBSERVER_H

/* Opt-in macOS Endpoint Security collection source; no main, installer or service.
 * Requires Apple entitlement, root, TCC approval and an owner-provisioned descriptor.
 * This is NOT a launch/termination supervisor and exposes NO stop-proof API.
 * Raw records are unsigned observations, NOT the authenticated TS journal protocol.
 */
typedef struct foundry_mac_es_observer foundry_mac_es_observer;

/* fd must be a fresh root-owned 0600 regular file, opened O_WRONLY|O_APPEND by
 * the privileged caller with exclusive creation and a protected directory. The
 * caller retains fd ownership; this function duplicates it. No resume/reattach.
 * Returns 0 or an errno value; es_result receives the actual es_new_client result.
 * On shutdown failure, *out retains poisoned state so callbacks never use freed memory.
 */
int foundry_mac_es_observer_open(int fd, foundry_mac_es_observer **out, int *es_result);
int foundry_mac_es_observer_poisoned(const foundry_mac_es_observer *observer);
/* Caller serializes close against its own status calls. No seal is emitted.
 * Returns 0 on destruction, EIO on failure (state is retained, never freed).
 * Destroying the ES client ends observation; it does not stop any workload. */
int foundry_mac_es_observer_close(foundry_mac_es_observer *observer);

#endif

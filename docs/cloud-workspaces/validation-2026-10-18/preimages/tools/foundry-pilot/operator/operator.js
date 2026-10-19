/* Plain browser source. DTO: workers/compute/src/operator-feed.ts.
 * Bridge envelopes: tools/foundry-pilot/CONTRACT.md. No runtime dependencies. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const REFRESH = 15000, DEADLINE = 10000, STALE = 45000, MAX_BODY = 280000;
  const families = ['workers', 'workloads', 'leases', 'attempts', 'placements', 'receipts', 'events'];
  const leaseStates = ['RUNNING', 'VERIFYING', 'SUCCEEDED', 'REVOKED'];
  const eventKinds = ['workload-requeued', 'workload-failed', 'lease-revoked', 'worker-quarantined',
    'quota-set', 'worker-registered', 'workload-submitted', 'lease-renewed', 'result-staged',
    'workload-verifying', 'workload-cancelled', 'reservation-released', 'worker-reconciled',
    'epoch-bumped', 'lease-issued', 'workload-running', 'lease-succeeded', 'workload-succeeded'];
  let observation = null, observationClock = 0, busy = false, failure = true;
  let cursor = 0, intent = null, submitted = false, sourceKey = null, restoreResultFocus = null;
  let session = 'unknown', logoutPending = false;
  const fail = () => { throw new Error('invalid-response'); };
  const uint = v => Number.isSafeInteger(v) && v >= 0 ? v : fail();
  const bool = v => typeof v === 'boolean' ? v : fail();
  const text = (v, max = 256) => typeof v === 'string' && v.length <= max ? v : fail();
  const id = v => typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}(?![\s\S])/.test(v) ? v : fail();
  const choice = values => v => values.includes(v) ? v : fail();
  const literal = expected => v => v === expected ? v : fail();
  const nullable = read => v => v === null ? null : read(v);
  const optional = read => v => v === undefined ? undefined : read(v);
  const list = (read, max) => v => Array.isArray(v) && v.length <= max ? v.map(read) : fail();
  // Reconstruct only declared properties. Unknown response properties are never rendered.
  const shape = fields => v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
    const result = {};
    for (const [key, read] of Object.entries(fields)) result[key] = read(v[key]);
    return result;
  };
  const windowShape = shape({total:uint, returned:uint, truncated:bool});
  const windowRead = v => {
    const w = windowShape(v);
    if (w.returned > w.total || w.truncated !== (w.returned < w.total)) fail();
    return w;
  };
  const device = shape({id, kind:choice(['cuda', 'metal']), vramMib:uint, busy:nullable(bool)});
  const resources = shape({cpu:uint, ramMib:uint, gpuKind:nullable(choice(['cuda', 'metal'])), gpuVram:nullable(uint)});
  const baseWorker = {id, principal:id, workerClass:choice(['general', 'edge']), incarnation:uint,
    quarantined:bool, cpu:uint, ramMib:uint};
  const enrollment = shape({revision:uint, incarnation:uint, expiresAt:uint, revokedAt:nullable(uint),
    lastSeen:nullable(uint), sequence:uint, freshnessMs:uint, freshness:choice(['never-seen', 'fresh', 'stale', 'inactive'])});
  const worker = shape({...baseWorker, enrollment:nullable(enrollment), devices:list(device, 8), deviceWindow:windowRead});
  const workload = shape({id, principal:id, status:choice(['QUEUED', 'RUNNING', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
    generation:uint, attemptsUsed:uint, maxAttempts:uint, winner:nullable(id), resources,
    maxBytes:uint, exitCode:uint, pure:bool, reconstructible:bool});
  const lease = shape({id, workloadId:id, workerId:id, epoch:uint, generation:uint, incarnation:uint,
    issuedAt:uint, expiresAt:uint, capAt:uint, sequence:uint, state:choice(leaseStates), verificationDeadline:nullable(uint)});
  const attempt = shape({id, workloadId:id, placementId:id, generation:uint, state:choice(leaseStates)});
  const candidate = shape({worker:shape(baseWorker), used:shape({cpu:uint, ramMib:uint}), devices:list(device, 8),
    deviceWindow:windowRead, reasons:list(choice(['edge', 'quarantined', 'cpu', 'ram', 'gpu']), 5), reasonWindow:windowRead});
  const placement = shape({id, workloadId:id, workerId:id, generation:uint, epoch:uint, createdAt:uint,
    policyVersion:literal('vector-exclusive-v1'), selected:id, reason:literal('requested-feasible-worker'),
    resources, candidates:list(candidate, 16), candidateWindow:windowRead, omittedCandidates:uint});
  const receiptFields = {workloadId:id, leaseId:id, bytes:uint, epoch:uint, generation:uint,
    incarnation:uint, verifier:id, verifiedAt:uint};
  const receipt = shape(receiptFields);
  const event = shape({seq:uint, epoch:uint, at:uint, kind:choice([...eventKinds, 'unknown']), entity:id,
    actor:id, entityVersion:uint, reason:nullable(choice(eventKinds)), metadataRedacted:bool});
  const viewRead = shape({version:literal(1), source:shape({environment:id, authorityId:id, epoch:uint, observedAt:uint, head:uint}),
    workers:list(worker, 32), workloads:list(workload, 32), leases:list(lease, 64), attempts:list(attempt, 64),
    placements:list(placement, 8), receipts:list(receipt, 32),
    events:shape({after:uint, through:uint, head:uint, hasMore:bool, items:list(event, 64)}),
    windows:shape(Object.fromEntries(families.map(k => [k, windowRead])))});
  const sha = v => typeof v === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(v) ? v : fail();
  const provenanceRead = shape({kind:literal('synthetic-pilot-input'),actualChainObservation:literal(false),inputSha256:sha,inputAuthorityId:id,template:literal('epoch-event-summary-v1')});
  const envelopeRead = shape({version:literal(1), state:literal('connected'), sourceMode:choice(['local-authority', 'remote-authority']),
    requestedAt:uint, receivedAt:uint, view:viewRead,
    actions:shape({submitEnabled:bool, inputConfigured:bool, provenance:nullable(provenanceRead), template:literal('epoch-event-summary-v1'), allowedWorkloadIds:optional(v => {
      const ids = list(id, 8)(v); if (!ids.length || new Set(ids).size !== ids.length) fail(); return ids;
    })})});
  const sessionRead = shape({version:literal(1), state:choice(['unconfigured', 'locked', 'ready'])});
  const submitRead = shape({version:literal(1), state:literal('submitted'), workloadId:id, requestId:id, replayed:bool, provenance:provenanceRead});
  const resultRead = shape({version:literal(1), state:literal('accepted'),
    receipt:shape({...receiptFields, sha256:v => typeof v === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(v) ? v : fail()}),
    text:v => text(v, 4096),provenance:provenanceRead});
  function counted(w, rows) { if (w.returned !== rows.length) fail(); }
  function validateObservation(raw, after) {
    const data = envelopeRead(raw), v = data.view, e = v.events;
    if (data.actions.inputConfigured !== (data.actions.provenance !== null)) fail();
    if (data.requestedAt > data.receivedAt || v.source.epoch < 1 || e.after !== after || e.head !== v.source.head ||
      e.through < e.after || e.through > e.head || e.hasMore !== (e.through < e.head)) fail();
    e.items.forEach((item, i) => { if (item.seq !== e.after + i + 1) fail(); });
    if (e.through !== (e.items.length ? e.items[e.items.length - 1].seq : e.after)) fail();
    if (v.windows.events.total !== e.head - e.after || (e.hasMore && e.items.length === 0)) fail();
    for (const key of families) counted(v.windows[key], key === 'events' ? e.items : v[key]);
    for (const w of v.workers) counted(w.deviceWindow, w.devices);
    for (const p of v.placements) {
      counted(p.candidateWindow, p.candidates);
      if (p.selected !== p.workerId || p.omittedCandidates !== p.candidateWindow.total - p.candidates.length) fail();
      for (const c of p.candidates) { counted(c.deviceWindow, c.devices); counted(c.reasonWindow, c.reasons); }
    }
    for (const key of families.filter(k => k !== 'events')) {
      const keys = v[key].map(x => key === 'receipts' ? x.workloadId : x.id);
      if (new Set(keys).size !== keys.length) fail();
    }
    return data;
  }
  const node = (tag, value, className) => {
    const n = document.createElement(tag);
    if (value !== undefined) n.textContent = String(value);
    if (className) n.className = className;
    return n;
  };
  const stamp = value => value === null ? 'Unknown / not recorded' :
    Number.isNaN(new Date(value).getTime()) ? 'Timestamp outside display range' : new Date(value).toLocaleString();
  const flag = value => value ? 'Yes' : 'No';
  function facts(entries) {
    const dl = node('dl', undefined, 'facts');
    for (const [label, value] of entries) {
      const group = node('div'); group.append(node('dt', label), node('dd', value === null ? 'Not recorded' : value)); dl.append(group);
    }
    return dl;
  }
  function badge(value, tone = 'warn') { const b = node('span', value, 'badge'); b.dataset.tone = tone; return b; }
  function table(title, columns, rows) {
    if (!rows.length) return node('p', 'No entries in this returned window. See source window limits.', 'empty');
    const wrap = node('div', undefined, 'table-scroll'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', title);
    const t = node('table'), head = node('thead'), tr = node('tr'), body = node('tbody');
    t.append(node('caption', title));
    for (const [label] of columns) { const th = node('th', label); th.scope = 'col'; tr.append(th); }
    head.append(tr);
    for (const row of rows) {
      const r = node('tr');
      for (const [, read] of columns) { const cell = node('td'), value = read(row); cell.append(value instanceof Node ? value : node('span', value === null ? 'Not recorded' : value)); r.append(cell); }
      body.append(r);
    }
    t.append(head, body); wrap.append(t); return wrap;
  }
  const resourceText = r => `${r.cpu} CPU · ${r.ramMib} MiB RAM · GPU ${r.gpuKind === null ? 'none requested' : r.gpuKind} · VRAM ${r.gpuVram === null ? 'not requested' : r.gpuVram + ' MiB'}`;
  const windowText = w => `${w.returned} / ${w.total} returned${w.truncated ? ' · truncated; omitted ' + (w.total - w.returned) : ' · complete window'}`;
  function devices(parent, rows, window) {
    parent.append(node('p', 'Devices: ' + windowText(window), 'muted'));
    parent.append(table('Device facts', [['Device', d => d.id], ['Kind', d => d.kind], ['VRAM MiB', d => d.vramMib], ['Busy', d => d.busy === null ? 'Unknown' : flag(d.busy)]], rows));
  }
  function render(data) {
    const v = data.view, s = v.source;
    const openDetails = new Set([...document.querySelectorAll('details[data-key][open]')].map(d => d.dataset.key));
    const active = document.activeElement;
    const focusedResult = active?.dataset.result;
    const focusedDetail = active?.tagName === 'SUMMARY' ? active.parentElement.dataset.key : null;
    $('source').replaceChildren(facts([['Bridge source', data.sourceMode], ['Environment', s.environment], ['Authority', s.authorityId],
      ['Epoch', s.epoch], ['Authority observed', stamp(s.observedAt)], ['Bridge requested', stamp(data.requestedAt)],
      ['Bridge received', stamp(data.receivedAt)], ['Event head', s.head]]));
    const windows = node('div', undefined, 'window-list');
    for (const key of families) windows.append(node('span', key + ': ' + windowText(v.windows[key]), 'window-label'));
    $('windows').replaceChildren(windows);
    $('workload-options').replaceChildren();
    for (const value of data.actions.allowedWorkloadIds || []) {
      const option = node('option'); option.value = value; $('workload-options').append(option);
    }
    $('workers').replaceChildren();
    if (!v.workers.length) $('workers').append(node('p', 'No workers returned by this source.', 'empty'));
    for (const w of v.workers) {
      const card = node('article', undefined, 'card'); card.append(node('h3', w.id), badge(w.workerClass), badge(w.quarantined ? 'Quarantined' : 'Not quarantined', w.quarantined ? 'bad' : 'good'));
      card.append(facts([['Principal', w.principal], ['Incarnation', w.incarnation], ['Approved CPU', w.cpu], ['Approved RAM', w.ramMib + ' MiB'],
        ['Execution role', w.workerClass === 'edge' ? 'Zero execution: edge excluded from placement' : 'General; runtime approval not provided by feed'],
        ['Zero CPU capacity', w.cpu === 0 ? 'Source reports zero CPU' : 'Source reports nonzero CPU']]));
      if (w.enrollment === null) card.append(node('p', 'Enrollment / heartbeat: unknown; no enrollment record projected.', 'muted'));
      else {
        const e = w.enrollment; card.append(badge('Enrollment: ' + e.freshness, e.freshness === 'fresh' ? 'good' : 'warn'));
        card.append(facts([['Revision', e.revision], ['Enrollment incarnation', e.incarnation], ['Last seen', stamp(e.lastSeen)],
          ['Freshness threshold', e.freshnessMs + ' ms'], ['Expires', stamp(e.expiresAt)], ['Revoked', stamp(e.revokedAt)], ['Sequence', e.sequence]]));
      }
      const d = node('details'); d.dataset.key = 'worker:' + w.id; d.append(node('summary', 'Approved devices')); devices(d, w.devices, w.deviceWindow); card.append(d); $('workers').append(card);
    }
    $('workloads').replaceChildren(table('Workloads · active first, then ID; not chronological history', [
      ['Workload', w => w.id], ['State', w => w.status === 'VERIFYING' ? 'VERIFYING · staged, not accepted' : w.status],
      ['Owner', w => w.principal], ['Generation', w => w.generation], ['Attempts', w => `${w.attemptsUsed} / ${w.maxAttempts}`],
      ['Resources', w => resourceText(w.resources)], ['Winner lease', w => w.winner], ['Output limit / exit', w => `${w.maxBytes} bytes / ${w.exitCode}`],
      ['Pure / reconstructible', w => `${flag(w.pure)} / ${flag(w.reconstructible)}`]], v.workloads));
    $('attempts').replaceChildren(table('Attempts · placement time descending', [['Attempt', a => a.id], ['Workload', a => a.workloadId],
      ['Placement', a => a.placementId], ['Generation', a => a.generation], ['State', a => a.state]], v.attempts));
    $('leases').replaceChildren(table('Leases · issued time descending; expiry does not prove physical stop', [
      ['Lease', l => l.id], ['Workload', l => l.workloadId], ['Worker', l => l.workerId], ['State', l => l.state],
      ['Epoch / generation / incarnation', l => `${l.epoch} / ${l.generation} / ${l.incarnation}`], ['Issued', l => stamp(l.issuedAt)],
      ['Expires / cap', l => `${stamp(l.expiresAt)} / ${stamp(l.capAt)}`], ['Sequence', l => l.sequence], ['Verification deadline', l => stamp(l.verificationDeadline)]], v.leases));
    $('placements').replaceChildren();
    if (!v.placements.length) $('placements').append(node('p', 'No placement snapshot in this window. No rejection reason can be inferred for unplaced jobs.', 'empty'));
    for (const p of v.placements) {
      const card = node('details'); card.dataset.key = 'placement:' + p.id; card.append(node('summary', `${p.workloadId} → ${p.selected} · ${p.reason}`));
      card.append(facts([['Placement', p.id], ['Worker', p.workerId], ['Epoch / generation', `${p.epoch} / ${p.generation}`],
        ['Decision time', stamp(p.createdAt)], ['Policy', p.policyVersion], ['Requested', resourceText(p.resources)],
        ['Candidates', windowText(p.candidateWindow)], ['Omitted candidates', p.omittedCandidates]]));
      for (const c of p.candidates) {
        const detail = node('details'); detail.dataset.key = 'candidate:' + p.id + ':' + c.worker.id; detail.append(node('summary', `${c.worker.id} · ${c.reasons.length ? c.reasons.join(', ') : 'no recorded rejection'}`));
        detail.append(facts([['Principal', c.worker.principal], ['Class', c.worker.workerClass], ['Incarnation', c.worker.incarnation],
          ['Quarantined at decision', flag(c.worker.quarantined)], ['Approved capacity', `${c.worker.cpu} CPU / ${c.worker.ramMib} MiB`],
          ['Used at decision', `${c.used.cpu} CPU / ${c.used.ramMib} MiB`], ['Rejection facts', windowText(c.reasonWindow)]]));
        devices(detail, c.devices, c.deviceWindow); card.append(detail);
      }
      $('placements').append(card);
    }
    $('receipts').replaceChildren(table('Accepted receipt metadata · verified time descending', [
      ['Workload', r => r.workloadId], ['Lease', r => r.leaseId], ['Bytes', r => r.bytes],
      ['Epoch / generation / incarnation', r => `${r.epoch} / ${r.generation} / ${r.incarnation}`], ['Verifier', r => r.verifier],
      ['Verified', r => stamp(r.verifiedAt)], ['Output', r => {
        if (data.actions.allowedWorkloadIds && !data.actions.allowedWorkloadIds.includes(r.workloadId)) return 'Outside configured pilot scope';
        const button = node('button', 'Look up accepted output'); button.type = 'button'; button.dataset.result = r.workloadId;
        button.setAttribute('aria-label', 'Look up independently accepted output for ' + r.workloadId);
        button.addEventListener('click', () => lookup(r)); return button;
      }]], v.receipts));
    const e = v.events;
    $('cursor').textContent = `After ${e.after} · through ${e.through} · head ${e.head} · ${e.hasMore ? 'more events available' : 'at observed head'} · ${windowText(v.windows.events)}`;
    $('events').replaceChildren(table('Immutable events · ascending sequence', [['Sequence', e => e.seq], ['Time', e => stamp(e.at)],
      ['Kind', e => e.kind], ['Entity', e => e.entity], ['Actor', e => e.actor], ['Epoch / version', e => `${e.epoch} / ${e.entityVersion}`],
      ['Reason', e => e.reason === null ? 'Not disclosed / unrecognized' : e.reason], ['Redaction', e => e.metadataRedacted ? 'Metadata redacted' : 'Allowlisted metadata only']], e.items));
    for (const d of document.querySelectorAll('details[data-key]')) {
      d.open = openDetails.has(d.dataset.key);
      if (focusedDetail === d.dataset.key) d.querySelector('summary').focus({preventScroll:true});
    }
    if (focusedResult) restoreResultFocus = focusedResult;
  }
  function healthy() {
    if (!observation || failure || session !== 'ready' || logoutPending) return false;
    const now = Date.now(), s = observation.view.source;
    return performance.now() - observationClock <= STALE && now - observation.receivedAt <= STALE &&
      now - s.observedAt <= STALE && observation.receivedAt <= now + 5000 && s.observedAt <= now + 5000;
  }
  function controls() {
    const good = healthy(), allowed = good && observation.actions.submitEnabled && observation.actions.inputConfigured;
    $('login-form').hidden = session !== 'locked' || logoutPending;
    $('login').disabled = busy;
    $('operator-credential').disabled = busy;
    $('logout').hidden = session !== 'ready' && !logoutPending;
    $('logout').disabled = busy;
    $('logout').textContent = logoutPending ? 'Retry logout' : 'Log out';
    $('refresh').disabled = busy; $('load-page').disabled = busy; $('follow').disabled = busy; $('after').disabled = busy;
    $('next-page').disabled = busy || !observation || !observation.view.events.hasMore;
    $('submit').disabled = busy || !allowed || submitted || !globalThis.crypto?.randomUUID;
    $('workload-id').readOnly = !!intent;
    $('workload-id').disabled = busy;
    $('submit').textContent = intent && !submitted ? 'Retry same submission' : submitted ? 'Submission confirmed' : 'Submit configured pilot';
    $('input-provenance').textContent = observation?.actions.provenance ? `Synthetic pilot input · not an observed chain event. Source namespace: ${observation.actions.provenance.inputAuthorityId}. Canonical SHA-256: ${observation.actions.provenance.inputSha256}` : 'Synthetic-only pilot. No validated input pin is currently available.';
    $('submit-gate').textContent = !good ? 'Submission disabled: current source is unavailable, stale or has a clock mismatch.' :
      !observation.actions.submitEnabled ? 'Submission disabled by host configuration.' :
      !observation.actions.inputConfigured ? 'Submission disabled: immutable input is not configured.' :
      !globalThis.crypto?.randomUUID ? 'Submission disabled: secure ID generation is unavailable.' :
      submitted ? 'One submission confirmed in this page. Follow its workload and receipts below.' : 'Configured input available; host permits submission.';
    for (const b of document.querySelectorAll('[data-result]')) b.disabled = busy || !good;
    if (observation) {
      const age = Math.max(0, Math.floor((Date.now() - observation.view.source.observedAt) / 1000));
      $('age').textContent = `Authority observation ${age}s ago · browser age ${Math.floor((performance.now() - observationClock) / 1000)}s`;
      $('connection').textContent = good ? 'Authority observed' : 'Stale / unavailable observation';
    }
  }
  function tell(message, good = false) { $('notice').textContent = message; $('notice').dataset.tone = good ? 'good' : 'warn'; }
  async function request(path, options = {}) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), DEADLINE);
    const expires = performance.now() + DEADLINE;
    const checkDeadline = () => { if (abort.signal.aborted || performance.now() >= expires) { abort.abort(); throw new Error('bridge-unavailable'); } };
    let reader;
    try {
      const response = await fetch(path, {...options, credentials:'same-origin', cache:'no-store', redirect:'error', signal:abort.signal,
        headers:{Accept:'application/json', ...(options.method === 'POST' ? {'Content-Type':'application/json'} : {})}});
      checkDeadline();
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') || !response.body) fail();
      const length = response.headers.get('content-length');
      if (length !== null && (!/^[0-9]{1,7}$/.test(length) || Number(length) > MAX_BODY)) fail();
      reader = response.body.getReader(); const bytes = new Uint8Array(MAX_BODY); let count = 0;
      for (let chunks = 0; ; chunks++) {
        checkDeadline(); if (chunks >= 65536) fail();
        const part = await reader.read();
        checkDeadline();
        if (part.done) break;
        if (count + part.value.byteLength > MAX_BODY) fail();
        bytes.set(part.value, count); count += part.value.byteLength;
      }
      const raw = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes.subarray(0, count)));
      checkDeadline();
      if (response.status !== 200) {
        const e = shape({version:literal(1), state:choice(['unconfigured', 'unavailable', 'locked']), code:v => text(v, 80)})(raw);
        if (response.status === 401 && e.state === 'locked') {
          setSession('locked'); throw new Error('operator-locked');
        }
        // Never echo provider messages or arbitrary code strings into the page.
        const error = new Error(e.state === 'unconfigured' ? 'bridge-unconfigured' : 'bridge-unavailable');
        throw error;
      }
      return raw;
    } finally {
      abort.abort(); clearTimeout(timer);
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
  function safeError(error) {
    if (error?.message === 'operator-locked') return 'Local operator access is locked. Sign in with the separate local operator credential. [operator-login-required]';
    if (error?.message === 'bridge-unconfigured') return 'The bridge is not configured. Owner configuration is required. [bridge-unconfigured]';
    if (error?.message === 'invalid-response') return 'The bridge response was incomplete or outside the supported contract. [invalid-response]';
    return 'The bridge could not confirm this request. It may be unavailable or the deadline expired. [bridge-unavailable]';
  }
  async function exclusive(work) {
    if (busy) return;
    restoreResultFocus = document.activeElement?.dataset.result || null;
    busy = true; controls();
    try { await work(); } finally {
      busy = false; controls();
      if (restoreResultFocus) {
        const target = [...document.querySelectorAll('[data-result]')].find(b => b.dataset.result === restoreResultFocus);
        if (target && !target.disabled) target.focus({preventScroll:true});
        restoreResultFocus = null;
      }
    }
  }
  async function refresh(after = cursor) {
    if (logoutPending) return;
    if (session !== 'ready') { await synchronizeSession(); if (session !== 'ready') return; }
    await exclusive(async () => {
      try {
        const data = validateObservation(await request('/api/operator/view?afterEvent=' + after), after);
        const key = `${data.view.source.environment}/${data.view.source.authorityId}`;
        if (observation?.actions.provenance && data.actions.provenance && JSON.stringify(observation.actions.provenance) !== JSON.stringify(data.actions.provenance)) fail();
        if (sourceKey && key !== sourceKey) { $('result').replaceChildren(); fail(); }
        if (observation && (data.view.source.epoch < observation.view.source.epoch || data.view.source.head < observation.view.source.head ||
          data.view.source.observedAt < observation.view.source.observedAt)) fail();
        sourceKey = key; observation = data; observationClock = performance.now(); failure = false; cursor = after;
        render(data); controls();
        tell(healthy() ? 'Authenticated authority observation received. Worker freshness is reported separately; execution is not proven by this view.' :
          'The authority observation is stale or clocks disagree. Actions are disabled.', healthy());
      } catch (error) {
        failure = true; $('connection').textContent = observation ? 'Stale / unavailable observation' : 'Not connected';
        tell(safeError(error) + (observation ? ' Previously observed data remains visible and stale.' : ' No authority data available.'));
      }
    });
  }
  async function submit(event) {
    event.preventDefault();
    if (busy || !healthy() || !observation.actions.submitEnabled || !observation.actions.inputConfigured || submitted || !globalThis.crypto?.randomUUID) return;
    if (!intent) {
      const workloadId = $('workload-id').value;
      if (!/^[A-Za-z0-9._-]{1,64}(?![\s\S])/.test(workloadId)) {
        $('submit-status').textContent = 'Enter the exact approved workload ID (letters, digits, dot, underscore or hyphen; up to 64 characters). [invalid-workload-id]';
        $('workload-id').focus(); return;
      }
      if (observation.actions.allowedWorkloadIds && !observation.actions.allowedWorkloadIds.includes(workloadId)) {
        $('submit-status').textContent = 'Choose an ID from the host-approved workload list. [workload-out-of-scope]';
        $('workload-id').focus(); return;
      }
      intent = Object.freeze({requestId:'r1-' + crypto.randomUUID(), workloadId});
    }
    if (observation.actions.allowedWorkloadIds && !observation.actions.allowedWorkloadIds.includes(intent.workloadId)) {
      $('submit-status').textContent = 'The retained submission is outside the current host scope. Its IDs were preserved; owner resolution is required. [workload-out-of-scope]'; return;
    }
    $('intent').replaceChildren(facts([['Request ID', intent.requestId], ['Workload ID', intent.workloadId]]));
    await exclusive(async () => {
      $('submit-status').textContent = 'Submitting the configured input. Awaiting durable authority confirmation…';
      try {
        const result = submitRead(await request('/api/pilot/jobs', {method:'POST', body:JSON.stringify(intent)}));
        if (result.requestId !== intent.requestId || result.workloadId !== intent.workloadId || JSON.stringify(result.provenance) !== JSON.stringify(observation.actions.provenance)) fail();
        submitted = true;
        $('submit-status').textContent = `Durably submitted synthetic-input pilot ${result.workloadId}${result.replayed ? ' (same intent replayed)' : ''}. This is not execution or acceptance.`;
      } catch (error) {
        $('submit-status').textContent = safeError(error) + ' Submission outcome is uncertain. Retry uses the exact same IDs; do not create a replacement job.';
      }
    });
  }
  async function lookup(expected) {
    if (busy || !healthy()) return;
    $('result').replaceChildren();
    await exclusive(async () => {
      $('result-status').textContent = 'Checking the independently accepted receipt and exact artifact bytes…';
      try {
        const result = resultRead(await request('/api/pilot/jobs/' + encodeURIComponent(expected.workloadId) + '/result'));
        if (JSON.stringify(result.provenance) !== JSON.stringify(observation.actions.provenance)) fail();
        for (const key of Object.keys(receiptFields)) if (result.receipt[key] !== expected[key]) fail();
        if (result.receipt.bytes > 4096 || new TextEncoder().encode(result.text).byteLength !== result.receipt.bytes) fail();
        const box = node('article', undefined, 'card');
        box.append(node('h3', 'Independently accepted computation on synthetic input'), facts([['Input kind', 'Synthetic pilot; no actual chain observation'], ['Input namespace', result.provenance.inputAuthorityId], ['Input SHA-256', result.provenance.inputSha256], ['Workload', result.receipt.workloadId],
          ['Receipt lease', result.receipt.leaseId], ['Verifier', result.receipt.verifier], ['Verified', stamp(result.receipt.verifiedAt)],
          ['SHA-256', result.receipt.sha256], ['Bytes', result.receipt.bytes], ['Lookup received', stamp(Date.now())]]));
        const pre = node('pre', result.text); pre.tabIndex = 0; pre.setAttribute('aria-label', 'Receipt-bound accepted output'); box.append(pre);
        $('result').replaceChildren(box); $('result-status').textContent = 'Accepted-result lookup confirmed this computation on the pinned synthetic input; it proves no chain event. Worker quarantine is unchanged.';
      } catch (error) { $('result-status').textContent = safeError(error) + ' Accepted output is unavailable; no staged bytes are displayed.'; }
    });
  }
  function setSession(state) {
    if (state !== session || state !== 'locked') $('operator-credential').value = '';
    session = state;
    window.dispatchEvent(new CustomEvent('foundry-operator-session',{detail:{state}}));
    $('session-status').textContent = state === 'ready' ? 'Local operator session ready. Authority access remains on the host.' :
      state === 'locked' ? 'Local operator session locked. Protected data is cleared from this page.' :
      state === 'unconfigured' ? 'Host unconfigured. No login or authority defaults are enabled.' : 'Local session could not be confirmed. Protected actions are disabled.';
    if (state !== 'ready') {
      observation = null; failure = true; cursor = 0;
      for (const key of ['source', 'workers', 'workloads', 'attempts', 'leases', 'placements', 'receipts', 'events']) $(key).replaceChildren(node('p', 'Protected source unavailable until local operator access is ready.', 'empty'));
      for (const key of ['windows', 'result', 'workload-options']) $(key).replaceChildren();
      $('result-status').textContent = 'No accepted output displayed.';
      $('cursor').textContent = 'Cursor unavailable.';
      $('age').textContent = 'No current authority observation';
      $('connection').textContent = state === 'locked' ? 'Operator locked' : 'Not connected';
    }
    controls();
  }
  async function synchronizeSession() {
    await exclusive(async () => {
      try {
        const status = sessionRead(await request('/api/operator/session'));
        setSession(status.state);
        if (status.state !== 'ready') tell(status.state === 'locked' ? 'Sign in to read the protected operator source. [operator-login-required]' : 'The operator host is not configured. [bridge-unconfigured]');
      } catch (error) { if (session !== 'locked') setSession('unknown'); tell(safeError(error)); }
    });
  }
  async function login(event) {
    event.preventDefault();
    if (busy || session !== 'locked' || logoutPending) return;
    await exclusive(async () => {
      try {
        // Start the fetch with a transient value, then immediately clear the field.
        const pending = request('/api/operator/session', {method:'POST', body:JSON.stringify({credential:$('operator-credential').value})});
        $('operator-credential').value = '';
        const status = sessionRead(await pending);
        if (status.state !== 'ready') fail();
        setSession('ready');
      } catch (error) {
        setSession('locked'); $('session-status').textContent = safeError(error) + ' Login was not confirmed; re-enter the local operator credential.';
      } finally { $('operator-credential').value = ''; }
    });
    if (session === 'ready') await refresh();
  }
  async function logout() {
    if (busy) return;
    logoutPending = true; setSession('unknown');
    await exclusive(async () => {
      try {
        const status = sessionRead(await request('/api/operator/logout', {method:'POST', body:'{}'}));
        if (status.state === 'ready') fail();
        logoutPending = false; setSession(status.state); tell('Local operator logout confirmed. Protected data cleared.');
      } catch (error) {
        $('session-status').textContent = safeError(error) + ' Logout is unconfirmed. Data is cleared and automatic reads are paused; retry logout.';
      }
    });
  }
  function scheduledCursor() { return $('follow').checked && observation ? Math.max(0, observation.view.source.head - 64) : cursor; }
  $('login-form').addEventListener('submit', login);
  $('logout').addEventListener('click', logout);
  $('refresh').addEventListener('click', () => refresh(scheduledCursor()));
  $('submit-form').addEventListener('submit', submit);
  $('load-page').addEventListener('click', () => {
    const raw = $('after').value;
    if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) { tell('Enter a nonnegative whole event sequence. [invalid-cursor]'); return; }
    $('follow').checked = false; void refresh(Number(raw));
  });
  $('next-page').addEventListener('click', () => { if (observation) { $('follow').checked = false; $('after').value = String(observation.view.events.through); void refresh(observation.view.events.through); } });
  $('follow').addEventListener('change', () => { if ($('follow').checked) void refresh(scheduledCursor()); });
  setInterval(() => { controls(); if (observation && !healthy() && !failure) tell('The observation is stale or clocks disagree. Actions are disabled until a healthy refresh. [source-stale]'); }, 1000);
  setInterval(() => { if (!busy) void refresh(scheduledCursor()); }, REFRESH);
  void refresh();
})();

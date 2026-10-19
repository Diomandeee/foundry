'use strict';
let catalog, selected;
const $ = id => document.getElementById(id);
function element(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request unavailable');
  return data;
}
async function refreshStorage() {
  try {
    const storage = await api('/api/storage');
    const gib = bytes => (bytes / 1073741824).toFixed(2) + ' GiB';
    if (storage.status !== 'observed') {
      $('storage').textContent = `Cache usage unknown (${storage.reason || 'unavailable'}). Limit ${gib(storage.limitBytes)}. No automatic cleanup.`;
      return;
    }
    $('storage').textContent = `Cache accounted usage ${gib(storage.accountedBytes)} / ${gib(storage.limitBytes)}; quota remaining ${gib(storage.availableBudgetBytes)}; filesystem free ${gib(storage.filesystemFreeBytes)}. ${storage.partialFileCount} retained partial files. Observed ${storage.observedAt}. No automatic cleanup.`;
  } catch (error) {
    $('storage').textContent = 'Cache usage unavailable. No capacity observation or cleanup performed.';
  }
}
function renderList() {
  const q = $('search').value.toLocaleLowerCase();
  const projects = catalog.projects.filter(p => (!$('available').checked || p.versions > 0) &&
    (p.title + ' ' + p.family).toLocaleLowerCase().includes(q));
  $('count').textContent = `${projects.length} entries`;
  $('projects').replaceChildren();
  for (const p of projects) {
    const card = element('button', undefined, 'project');
    card.append(element('strong', p.title), element('span', `${p.versions} copies · ${p.machines.join(', ') || 'no copied source'}`));
    card.append(element('small', p.defaultVersion ? 'Suggested starting version available' : p.versions ? 'Versions need a choice' : 'Not in uploaded source scope'));
    card.addEventListener('click', () => show(p.id).catch(fail));
    $('projects').append(card);
  }
}
async function show(id) {
  const project = await api('/api/project/' + encodeURIComponent(id));
  selected = project;
  const panel = $('detail');
  panel.hidden = false;
  panel.replaceChildren(element('h2', project.title), element('p', project.family), element('p', project.defaultReason));
  if (project.heldPaths.length) panel.append(element('aside', `${project.heldPaths.length} paths were held or unavailable during the source copy. Pulling this project does not restore those files.`));
  panel.append(element('aside', 'Catalog grouping is a browse hint. Repository lineage requires explicit approved metadata; names, normalized origins and timestamps do not establish authority.'));
  if (!catalog.pullEnabled) panel.append(element('aside', 'Browsing only. Pull activation is still gated on this machine.'));
  panel.append(element('aside', 'Local changed-workspace snapshots require the explicit snapshot CLI. Browser snapshot creation and publication are unsupported.'));
  panel.append(element('aside', 'New source files require one explicit --include-new relative path per file in the snapshot CLI. Unlisted additions are outside the capture.'));
  if (!project.versions.length) panel.append(element('p', 'No copied files. This entry remains visible so missing coverage is not hidden.'));
  for (const version of project.versions) {
    const card = element('article', undefined, 'version');
    card.append(element('h3', version.member), element('p', `${version.files.toLocaleString()} files · ${(version.bytes / 1048576).toFixed(1)} MiB`));
    card.append(element('small', 'Revision ' + version.id.slice(0, 16)));
    const readiness = version.reconstructability;
    card.append(element('p', 'Reconstructability: ' + (readiness?.state || 'unknown') + ' · build readiness is unverified.'));
    if (readiness) {
      const evidence = element('details');
      evidence.append(element('summary', 'Required inputs, dependencies and held/missing reasons'),
        element('pre', JSON.stringify(readiness, null, 2)));
      card.append(evidence);
    }
    const comparison = project.comparison[version.id];
    if (comparison) {
      card.append(element('p', `${comparison.uniquePaths} unique paths · ${comparison.pathsAbsentFromThisCopy} paths present only in other copies · ${comparison.conflictingPaths.length} paths with different bytes or permissions`));
      if (comparison.conflictingPaths.length) {
        const differences = element('details');
        differences.append(element('summary', 'Paths that differ between copies'), element('pre', comparison.conflictingPaths.join('\n')));
        card.append(differences);
      }
    }
    if (version.id === project.defaultVersion) card.append(element('p', 'Suggested starting copy · not a canonical promotion', 'good'));
    if (version.captureChanged) card.append(element('aside', 'Content changed across captures. Earlier file observations remain preserved below; this is not an atomic project snapshot.'));
    if (version.kind === 'earlier-file-observation') card.append(element('aside', 'Historical file only — not a complete project version.'));
    if (version.pullBlocked) card.append(element('aside', 'Pull blocked: ' + version.pullBlocked));
    const button = element('button', 'Pull this version to this Mac', 'pull');
    button.disabled = !catalog.pullEnabled || !!version.pullBlocked || !!version.localWorkspace;
    button.addEventListener('click', () => pull(project.id, version.id).catch(fail));
    card.append(button);
    if (version.localWorkspace) card.append(element('p', 'Recorded workspace on this Mac. Local edits may differ from the captured version.'));
    const files = element('details');
    files.append(element('summary', 'Browse captured files'));
    const list = element('pre');
    // Render in bounded pages so a large repository does not freeze the browser.
    let offset = 0;
    const more = element('button', 'Show next 200 paths');
    function page() {
      list.textContent += version.entries.slice(offset, offset + 200).map(e => `${e.path}  (${e.bytes} bytes)`).join('\n') + '\n';
      offset += 200;
      more.hidden = offset >= version.entries.length;
    }
    more.addEventListener('click', page);
    files.addEventListener('toggle', () => { if (files.open && offset === 0) page(); });
    files.append(list, more);
    card.append(files);
    panel.append(card);
  }
  panel.scrollIntoView({behavior: 'smooth', block: 'start'});
}
async function pull(project, version) {
  $('status').textContent = 'Starting verified project pull…';
  await api('/api/pull', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Foundry-Intent': 'pull-version'},
    body: JSON.stringify({project, version, catalogRevision: catalog.revision})});
  poll();
}
async function poll() {
  try {
    const state = await api('/api/pull-status');
    await refreshStorage();
    if (state.state === 'pulling') {
      $('status').textContent = 'Downloading pinned archives and verifying project files. This may take several minutes.';
      setTimeout(poll, 1500);
    } else if (state.state === 'complete') {
      $('status').textContent = `${state.receipt.files} source files verified. Workspace receipt saved; build readiness remains unverified.`;
      if (selected && selected.id === state.project) await show(selected.id);
    } else if (state.state === 'failed') {
      $('status').textContent = 'Pull stopped: ' + state.error;
    }
  } catch (error) { fail(error); }
}
function fail(error) { $('status').textContent = error.message; }
api('/api/catalog').then(data => {
  catalog = data;
  $('capture').textContent = 'Captured ' + data.captured.slice(0, 10);
  $('scope').textContent = `${data.uniqueDeliveredPaths.toLocaleString()} delivered source/support paths; ${data.heldPathCount} held/unavailable paths. ${data.scope}`;
  $('search').addEventListener('input', renderList);
  $('available').addEventListener('change', renderList);
  $('refresh-storage').addEventListener('click', refreshStorage);
  renderList();
  poll();
}).catch(fail);

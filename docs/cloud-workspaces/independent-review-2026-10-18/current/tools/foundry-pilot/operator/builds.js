'use strict';
(() => {
 const $=id=>document.getElementById(id);let view=null,preview=null,pending=null,busy=false,generation=0,ready=false,placementRevision=0,recoveryBusy=false,submissionBusy=false,sessionSeen=false;const downloads=new Set();
 const set=(id,text)=>{$(id).textContent=text;};
 async function api(path,body){const epoch=generation;const r=await fetch('/api/builds/'+path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});const value=await r.json();if(epoch!==generation)throw Error('operator-session-changed');if(!r.ok){if(r.status===401){ready=false;clearProtected();}throw Error(value.code||'build-source-unavailable');}return value;}
 function option(select,value,label){const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o);}
 function resetPreview(){placementRevision++;preview=null;$('build-submit').disabled=true;set('build-placement','Review placement for this exact project, input and recipe.');}
 function fill(savedInput=$('build-input').value,savedProfile=$('build-profile').value){const project=$('build-project').value;$('build-input').replaceChildren();$('build-profile').replaceChildren();for(const i of view.inputs.filter(i=>i.project===project))option($('build-input'),i.hash,`${i.hash.slice(0,12)} · ${i.body.reconstructable?'approved reconstructable':'missing/unproven inputs'}`);for(const p of view.profiles.filter(p=>p.project===project))option($('build-profile'),p.hash,`${p.body.kind} · ${p.hash.slice(0,12)}`);if([...$('build-input').options].some(o=>o.value===savedInput))$('build-input').value=savedInput;if([...$('build-profile').options].some(o=>o.value===savedProfile))$('build-profile').value=savedProfile;$('build-preview').disabled=!$('build-input').value||!$('build-profile').value;resetPreview();}
 function list(id,items,render){const root=$(id);root.replaceChildren();if(!items.length){root.textContent='No records in this bounded authority window.';return;}for(const item of items){const p=document.createElement('p');p.textContent=render(item);root.append(p);}}
 function clearView(){placementRevision++;view=null;preview=null;for(const id of ['build-project','build-input','build-profile','build-placement','build-workers','build-jobs','build-attempts','build-events','build-result','build-capacity','build-window-status'])$(id).replaceChildren();$('build-preview').disabled=true;$('build-submit').disabled=true;}
 function clearProtected(){$('build-repeat').checked=false;generation++;for(const a of downloads)a.abort();downloads.clear();clearView();pending=null;$('build-intents').replaceChildren();$('build-intents-refresh').disabled=true;$('build-retry-pending').disabled=true;set('build-recovery-status','Sign in to read durable submissions.');set('build-status','Operator access unavailable. Protected build data cleared; durable submission intent remains on the host.');}
 const sameSelection=(a,b)=>a.projectId===b.projectId&&a.inputHash===b.inputHash&&a.profileHash===b.profileHash;
 function recoveryControls(){const disabled=!ready||recoveryBusy||submissionBusy;$('build-intents-refresh').disabled=disabled;$('build-retry-pending').disabled=disabled||!pending;for(const b of $('build-intents').querySelectorAll('button'))b.disabled=disabled||b.dataset.blocked==='true';}
 function renderIntents(intents){
  const root=$('build-intents');root.replaceChildren();
  if(!intents.length){root.textContent='No durable submission intents recorded on this operator host. Recovery cannot create one.';return;}
  for(const intent of intents){
   const row=document.createElement('p');row.textContent=`${intent.jobId} · request ${intent.requestId} · ${intent.projectId} · input ${intent.inputHash} · recipe ${intent.profileHash} · epoch ${intent.epoch} · ${intent.phase}${intent.blockedReason?' · blocked: '+intent.blockedReason:''} `;
   const action=intent.phase==='submitted'?'ack':'recover',button=document.createElement('button');button.type='button';button.textContent=intent.phase==='acknowledged'?'Read acknowledged receipt':action==='recover'?'Recover existing submission':'Acknowledge submission receipt';button.dataset.blocked=String(!!intent.blockedReason);button.disabled=!!intent.blockedReason;
   button.onclick=()=>void actOnIntent(intent,action);row.append(button);
   root.append(row);
  }
 }
 async function refreshIntents(message=''){
  if(!ready||recoveryBusy||submissionBusy)return;const epoch=generation;recoveryBusy=true;recoveryControls();
  try{const result=await api('intents');renderIntents(result.intents);set('build-recovery-status',`${message?message+' ':''}${result.intents.length}/${result.limit} durable intents. Recovery and acknowledgement use stored identity; worker eligibility is not required.`);}
  catch(e){if(epoch===generation){$('build-intents').replaceChildren();set('build-recovery-status',`${message?message+' ':''}Recovery unavailable: ${e.message}. Existing intents remain on the host.`);}}
  finally{recoveryBusy=false;recoveryControls();}
 }
 async function actOnIntent(intent,action){
  if(!ready||recoveryBusy||submissionBusy||intent.blockedReason)return;const epoch=generation;let message='';recoveryBusy=true;resetPreview();recoveryControls();
  try{
   const identity={requestId:intent.requestId,jobId:intent.jobId};
   const result=await api(action,action==='recover'?{...identity,projectId:intent.projectId,inputHash:intent.inputHash,profileHash:intent.profileHash}:identity);
   if(result.jobId!==intent.jobId||(action==='recover'&&result.requestId!==intent.requestId))throw Error('build-recovery-receipt-conflict');
   const acknowledged=action==='ack'||!result.ackRequired;
   if(acknowledged&&pending&&sameSelection(pending,intent)){pending=null;$('build-repeat').checked=false;}
   // Replace the stale action immediately, even if the next read fails.
   $('build-intents').replaceChildren();message=acknowledged?`Submission ${intent.jobId} acknowledged. This is not a build-success receipt.`:`Recovered submission ${intent.jobId}. Read its stored identity below, then acknowledge the submission receipt.`;
  }catch(e){message=`Recovery/acknowledgement uncertain or rejected: ${e.message}. Retry uses this same stored identity.`;}
  finally{recoveryBusy=false;recoveryControls();}
  if(epoch===generation&&ready){set('build-recovery-status',message);await refreshIntents(message);}
 }
 window.addEventListener('foundry-operator-session',e=>{sessionSeen=true;ready=e.detail?.state==='ready';if(!ready)clearProtected();else void refresh();});
 setInterval(()=>{if(ready&&!busy)void refresh();},15000);
 async function refresh(){if(!ready||busy||submissionBusy)return;void refreshIntents();const epoch=generation;busy=true;try{view=await api('view');set('build-status',`Authority observed ${new Date(view.observedAt).toLocaleString()}. ${view.actionsEnabled?'Build actions explicitly enabled.':'Build actions gated.'} Candidate validation remains pending.`);set('build-window-status',Object.entries(view.windows||{}).map(([name,w])=>`${name}: ${w.returned}/${w.total}${w.truncated?' (truncated)':''}`).join(' · '));const chosen=$('build-project').value;$('build-project').replaceChildren();for(const p of [...new Set(view.profiles.map(p=>p.project))])option($('build-project'),p,p);if([...$('build-project').options].some(o=>o.value===chosen))$('build-project').value=chosen;fill();list('build-workers',view.workers,w=>`${w.worker}: ${w.body.os} ${w.body.architecture}; host Xcode build IDs ${w.body.xcodeBuilds.join(', ')||'none'}; ${w.body.vm?`guest macOS ${w.body.vm.macos}, Xcode ${w.body.vm.xcodeBuild}, SDKs ${w.body.vm.sdks.join(', ')}, image ${w.body.vm.bootSha256.slice(0,12)} (owner activation checked in placement)`:'guest capability unavailable'}; census received ${new Date(w.observed_ms).toLocaleString()}; active jobs ${w.body.activeJobs}`);list('build-capacity',view.workers,w=>`${w.worker}: ${(w.body.freeBytes/1024**3).toFixed(1)} GiB reported free; managed cache ${w.body.storage?.cacheBytes===null||w.body.storage?.cacheBytes===undefined?'unknown':(w.body.storage.cacheBytes/1024**3).toFixed(1)+' GiB'}; workspaces ${w.body.storage?.workspaceBytes===null||w.body.storage?.workspaceBytes===undefined?'unknown':(w.body.storage.workspaceBytes/1024**3).toFixed(1)+' GiB'}; inventory ${w.body.storage?.complete?'complete':'incomplete'}. Cleanup not approved.`);
 list('build-events',view.events,e=>{const body=JSON.parse(e.body);return `${e.seq} · ${e.kind} · ${e.entity} · ${new Date(e.at_ms).toLocaleString()}${body.placement?' · '+JSON.stringify(body.placement):''}`;});list('build-attempts',view.attempts,a=>`${a.jobId} / ${a.id}: ${a.effectiveState} (recorded ${a.state}); worker ${a.workerId}; epoch ${a.epoch}, generation ${a.generation}, incarnation ${a.incarnation}; lease expiry ${new Date(a.expiresAt).toLocaleString()}; guest capability ${a.vmCapabilityHash?.slice(0,12)||'none'}; stop ${a.stopped?'confirmed':'unconfirmed'}, host slot ${a.slotHeld?'retained':'released'}`);const root=$('build-jobs');root.replaceChildren();for(const j of view.jobs){const p=document.createElement('p');p.textContent=`${j.id} · ${j.effectiveState||j.state} (recorded ${j.state}) · generation ${j.generation} · attempts ${j.attempts} `;if(j.state==='SUCCEEDED'){const b=document.createElement('button');b.textContent='Read verified artifact receipt';b.onclick=async()=>{try{const r=await api('result',{jobId:j.id});showResult(r);}catch(e){set('build-result',e.message);}};p.append(b);}if(view.actionsEnabled&&!['EXPIRED','FENCED'].includes(j.effectiveState)&&['QUEUED','RUNNING','VERIFYING'].includes(j.state)){const b=document.createElement('button');b.textContent='Cancel build';let requestId=null;b.onclick=async()=>{requestId??=crypto.randomUUID();try{await api('cancel',{jobId:j.id,requestId});await refresh();}catch(e){set('build-status',`Cancellation uncertain: ${e.message}; retry preserves its request ID.`);}};p.append(b);}root.append(p);}if(!view.jobs.length)root.textContent='No build jobs in this window.';
 }catch(e){if(epoch===generation){clearView();set('build-status',`Authority view unavailable: ${e.message}. Durable submission recovery is read separately.`);}}finally{busy=false;}}
 function showResult(r){const root=$('build-result');root.replaceChildren();const pre=document.createElement('pre');pre.textContent=JSON.stringify(r,null,2);root.append(pre);[...r.outputs,...r.logs.map((log,index)=>({path:'build-log-'+index+'.log',format:'file',sha256:log.sha256,bytes:log.bytes,chunks:1,logIndex:index}))].forEach((o,index)=>{const b=document.createElement('button');b.textContent='Download verified '+o.path;b.onclick=async()=>{const epoch=generation,abort=new AbortController();downloads.add(abort);b.disabled=true;try{const chunks=[];let size=0;for(let i=0;i<o.chunks;i++){if(epoch!==generation||abort.signal.aborted)throw Error('operator-session-changed');const response=await fetch(o.logIndex===undefined?'/api/builds/result-chunk':'/api/builds/result-log',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(o.logIndex===undefined?{jobId:r.jobId,outputIndex:index,chunkIndex:i}:{jobId:r.jobId,logIndex:o.logIndex}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(12000)])});if(epoch!==generation)throw Error('operator-session-changed');if(!response.ok)throw Error('artifact-read-unavailable');const bytes=new Uint8Array(await response.arrayBuffer());if(epoch!==generation||abort.signal.aborted)throw Error('operator-session-changed');size+=bytes.length;if(size>o.bytes||size>128*1024*1024)throw Error('artifact-size-limit');chunks.push(bytes);}if(size!==o.bytes)throw Error('artifact-size-mismatch');const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');if(epoch!==generation)throw Error('operator-session-changed');if(digest!==o.sha256)throw Error('artifact-integrity-mismatch');const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));const a=document.createElement('a');a.href=url;a.download=o.path.split('/').pop()+(o.format==='tar'?'.tar':'');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){set('build-status',e.message);}finally{downloads.delete(abort);abort.abort();b.disabled=false;}};root.append(b);});}
 $('build-intents-refresh').onclick=()=>void refreshIntents();$('build-refresh').onclick=refresh;$('build-project').onchange=()=>fill('','');$('build-input').onchange=resetPreview;$('build-profile').onchange=resetPreview;
 $('build-preview').onclick=async()=>{const revision=placementRevision;try{const selection={profileHash:$('build-profile').value,inputHash:$('build-input').value};const r=await api('preview',selection);if(revision!==placementRevision||selection.profileHash!==$('build-profile').value||selection.inputHash!==$('build-input').value)return;preview=selection;list('build-placement',r.candidates,c=>`${c.workerId}: ${c.eligible?'eligible':'deferred'} · ${c.reasons.join(', ')}`);$('build-submit').disabled=submissionBusy||!!pending||!view?.actionsEnabled||!view.allowedProfiles.includes(selection.profileHash)||!r.candidates.some(c=>c.eligible);}catch(e){if(revision!==placementRevision)return;resetPreview();set('build-status',e.message);}};
 $('build-submit').onclick=async()=>{
  if(!ready||submissionBusy||!view?.actionsEnabled||!preview)return;
  if(recoveryBusy){set('build-status','Wait for the durable submission read or recovery to finish, then submit.');return;}
  if(pending){set('build-status','Resolve the uncertain submission in Durable submission recovery before submitting again.');return;}
  const selection={projectId:$('build-project').value,profileHash:$('build-profile').value,inputHash:$('build-input').value};
  if(selection.profileHash!==preview.profileHash||selection.inputHash!==preview.inputHash)return;
  pending={...selection,repeat:$('build-repeat').checked,jobId:'build-'+crypto.randomUUID(),requestId:crypto.randomUUID()};
  await sendPending();
 };
 async function sendPending(){
  if(!ready||submissionBusy||recoveryBusy||!pending)return;
  const epoch=generation;submissionBusy=true;recoveryControls();
  try{
   $('build-submit').disabled=true;const receipt=await api('submit',pending);
   await api('ack',{requestId:receipt.requestId,jobId:receipt.jobId});
   pending=null;$('build-repeat').checked=false;set('build-status',`Submission ${receipt.jobId} acknowledged. Build completion remains a separate authority observation.`);
  }catch(e){if(epoch===generation)set('build-status',`Submission uncertain or rejected: ${e.message}. Retry this page’s original submission, or recover an existing journaled intent below. Both preserve identity.`);}
  finally{submissionBusy=false;recoveryControls();if(epoch===generation){resetPreview();void refreshIntents();}}
 }
 $('build-retry-pending').onclick=()=>void sendPending();
 // operator.js may have announced the initial session before this deferred
 // script loaded. Read it once; a newer session event always wins.
 void (async()=>{
  try{
   const response=await fetch('/api/operator/session',{credentials:'same-origin',signal:AbortSignal.timeout(12000)}),session=await response.json();
   if(sessionSeen)return;ready=response.ok&&session.state==='ready';
   if(ready)void refresh();else clearProtected();
  }catch{if(!sessionSeen)clearProtected();}
 })();
})();

import { PRIVATE_HEADERS } from './http';

/** Public auth shell only; ALL account data comes from authenticated, no-store APIs.
 * Owner credential lives in page memory, never a URL, cookie, localStorage or notification.
 */
export function ownerShell(): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>zeniba · local shadow</title><style nonce="${nonce}">
body{font:16px system-ui;max-width:960px;margin:2rem auto;padding:0 1rem;background:#101820;color:#edf4f5}button,input{font:inherit;padding:.5rem;margin:.25rem}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#182731;padding:1rem}strong{color:#ffd38a}section{border-top:1px solid #49616e;margin-top:1rem}label{display:block}input{max-width:90%}.muted{color:#b5c8d0}
</style><main><h1>zeniba · synthetic shadow</h1>
<p><strong>No trade authorization. No live data. No broker-writing capability.</strong></p>
<p>This is an offline transport/workflow demo, not an investment strategy or a production account pilot.</p>
<form id="login"><label>Local owner bearer token <input id="token" type="password" autocomplete="off" required size="50"></label><button>Unlock private view</button></form>
<p id="error" role="status"></p><div id="app" hidden><button id="lock">Lock view</button>
<button id="bootstrap">Initialize synthetic account</button><button id="refresh">Refresh view</button>
<button id="sync">Sync mock observer</button><button id="propose">Create new shadow version</button><button id="backup">Private backup</button>
<p class="muted">The demo window lasts one hour from initialization. It is not an exchange calendar. Expiry does not trigger a new plan.</p>
<div id="summary"></div><section><h2>Saved proposal versions</h2><div id="proposals"></div></section>
<section><h2>Actual synthetic observations</h2><p>These controls simulate broker evidence, not order placement.</p>
<button id="partial">Observe synthetic partial fill</button><button id="cancel">Observe synthetic cancellation</button><pre id="ledger"></pre></section>
<section><h2>Workflow events (not fills)</h2><pre id="events"></pre></section></div></main>
<script nonce="${nonce}">
let credential = ''; let state = null;
const byId = id => document.getElementById(id);
const show = (id, value) => byId(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const eid = () => crypto.randomUUID();
async function api(path, body) {
  const response = await fetch(path, {method:body === undefined ? 'GET':'POST', cache:'no-store',
    headers:{Authorization:'Bearer '+credential, ...(body === undefined ? {} : {'Content-Type':'application/json'})},
    ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  const data = await response.json(); if (!response.ok) throw new Error(data.error?.code || 'request_failed'); return data;
}
async function run(fn) { show('error',''); try { await fn(); } catch(e) { show('error', e.message); } }
async function refresh() {
  state = await api('/api/state');
  show('summary', 'Mode: mock · account revision '+state.revision+' · observed '+state.observed_at+' · blockers: '+(state.readiness.join(', ') || 'none'));
  show('ledger', {current:state.current, issues:state.issues, ledger:state.ledger, evidence_count:state.evidence_count});
  show('events', state.workflow_events);
  const container = byId('proposals'); container.replaceChildren();
  for (const record of [...state.proposals].reverse()) {
    const p = record.proposal; const box = document.createElement('section');
    const heading = document.createElement('h3'); heading.textContent = 'Shadow '+p.proposal_id.slice(0,12)+' · '+record.status; box.append(heading);
    const detail = document.createElement('pre');
    const fresh = ['unseen','seen','reported'].includes(record.status);
    detail.textContent = JSON.stringify({request_id:p.request_id, valid_until:p.valid_until, status:p.status,
      mode:p.mode, broker_execution_enabled:p.broker_execution_enabled, blocks:p.blocks,
      ...(fresh ? {proposed_intents_not_broker_orders:p.orders} : {notice:'Intents hidden: blocked, expired, stale, skipped or superseded.'})}, null, 2); box.append(detail);
    if (p.proposal_id === state.latest_proposal_id) {
      for (const [action,label] of [['seen','Seen'],['skip','Skip'],['placed','I placed orders'],['sync','Sync']]) {
        const button = document.createElement('button'); button.textContent = label;
        // Reports remain audit-only, even if late. An old view can never authorize anything.
        button.disabled = record.status === 'skipped' && !['skip','sync'].includes(action);
        button.onclick = () => run(async()=>{await api('/api/workflow',{event_id:eid(),proposal_id:p.proposal_id,action});await refresh();}); box.append(button);
      }
    }
    container.append(box);
  }
}
byId('login').onsubmit = e => { e.preventDefault(); credential = byId('token').value; byId('token').value = '';
  run(async()=>{await api('/api/bootstrap',{});byId('login').hidden=true;byId('app').hidden=false;await refresh();}); };
byId('lock').onclick = () => { credential='';state=null;byId('app').hidden=true;byId('login').hidden=false;
  for(const id of ['summary','proposals','ledger','events','error']) byId(id).replaceChildren(); };
byId('bootstrap').onclick = () => run(async()=>{await api('/api/bootstrap',{});await refresh();});
byId('refresh').onclick = () => run(refresh);
byId('sync').onclick = () => run(async()=>{await api('/api/sync',{event_id:eid()});await refresh();});
byId('propose').onclick = () => run(async()=>{await api('/api/proposals',{request_id:eid()});await refresh();});
byId('backup').onclick = () => run(async()=>{const r=await api('/api/backup',{event_id:eid()});show('error','Private backup stored: '+r.backup_key);});
byId('partial').onclick = () => run(async()=>{await api('/api/synthetic',{event_id:eid(),scenario:'partial'});await refresh();});
byId('cancel').onclick = () => run(async()=>{await api('/api/synthetic',{event_id:eid(),scenario:'canceled'});await refresh();});
</script></html>`;
  return new Response(html, { headers: { ...PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` } });
}

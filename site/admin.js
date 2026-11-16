// Moderator dashboard: review queue, publish / reject / hide, team management, audit log.
(() => {
  const API = ((window.SITE_CONFIG || {}).API_BASE || '').replace(/\/+$/, '');
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let token = sessionStorage.getItem('do28_mod') || '';
  let me = null, tab = 'pending';

  async function call(path, body) {
    const r = await fetch(API + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.status === 401) { signOut(); throw new Error('Token not accepted.'); }
    if (!r.ok) throw new Error('Request failed (' + r.status + ')');
    return r.json();
  }

  if (!API) { $('#loginMsg').textContent = 'Set API_BASE in config.js first — the moderator area needs the live API.'; }

  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault(); token = $('#tok').value.trim();
    try { me = await call('/api/admin/me'); sessionStorage.setItem('do28_mod', token); start(); }
    catch (err) { $('#loginMsg').textContent = err.message; }
  });
  $('#logout').addEventListener('click', signOut);
  function signOut() { sessionStorage.removeItem('do28_mod'); token = ''; me = null; $('#panel').hidden = true; $('#login').hidden = false; $('#who').textContent = ''; }

  function start() {
    $('#login').hidden = true; $('#panel').hidden = false;
    $('#who').textContent = `Signed in as ${me.name} (${me.role}).`;
    $('#teamTab').hidden = me.role === 'moderator';
    show('pending');
  }
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]'); if (b) show(b.dataset.tab);
  });

  async function show(t) {
    tab = t;
    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    $('#view').innerHTML = '<p>Loading…</p>';
    try {
      if (t === 'team') return team();
      if (t === 'log') return log();
      const rows = await call('/api/admin/queue?status=' + t);
      if (!rows.length) { $('#view').innerHTML = '<p class="empty">Nothing here.</p>'; return; }
      $('#view').innerHTML = rows.map(r => `
        <article class="item${r.appeal ? ' appeal' : ''}" data-id="${esc(r.id)}">
          <div class="meta"><b>${esc(r.first_name)}, ${esc(r.state)}</b><span>${new Date(r.created_at).toLocaleString()}</span>
            ${r.appeal ? '<span class="flag">Appeal</span>' : ''}
            ${r.ai_verdict ? `<span class="flag">AI: ${esc(r.ai_verdict)}${r.ai_category && r.ai_category !== 'ok' ? ' · ' + esc(r.ai_category) : ''}</span>` : ''}
            ${(r.signals || []).map(s => `<span class="flag">${esc(s.replace('_', ' '))}</span>`).join('')}
            ${r.reviewed_by ? `<span>Reviewed by ${esc(r.reviewed_by)}</span>` : ''}</div>
          ${r.headline ? `<h3 style="margin:8px 0 0">${esc(r.headline)}</h3>` : ''}
          <blockquote>“${esc(r.text)}”</blockquote>
          ${r.ai_reason ? `<p class="meta">AI note: ${esc(r.ai_reason)}</p>` : ''}
          <div class="act">
            <input class="note" placeholder="Note for the log (optional)" aria-label="Note">
            ${t !== 'approved' ? '<button class="btn btn-red btn-sm" data-do="approved">Publish</button>' : ''}
            ${t !== 'rejected' ? '<button class="btn btn-outline btn-sm" data-do="rejected">Reject</button>' : ''}
            ${t === 'approved' ? '<button class="btn btn-navy btn-sm" data-do="hidden">Hide from wall</button>' : ''}
          </div>
        </article>`).join('');
    } catch (err) { $('#view').innerHTML = `<p class="form-msg err">${esc(err.message)}</p>`; }
  }

  $('#view').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-do]'); if (!b) return;
    const item = b.closest('.item'); b.disabled = true;
    try {
      await call('/api/admin/decide', { id: item.dataset.id, status: b.dataset.do, note: item.querySelector('.note').value });
      item.remove();
    } catch (err) { b.disabled = false; alert(err.message); }
  });

  async function team() {
    const rows = await call('/api/admin/moderators');
    $('#view').innerHTML = `
      <form id="addMod" class="item" style="border-left-color:var(--navy)">
        <h3 style="margin:0">Add a team member</h3>
        <div class="two"><div><label for="mName">Name</label><input id="mName" required maxlength="60"></div>
        <div><label for="mRole">Role</label><select id="mRole" class="select"><option value="moderator">Moderator — reviews posts</option>${me.role === 'owner' ? '<option value="admin">Admin — also manages the team</option>' : ''}</select></div></div>
        <button class="btn btn-navy" style="margin-top:12px">Create token</button>
        <div id="newTok"></div>
      </form>
      <table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map(m => `<tr><td>${esc(m.name)}</td><td>${esc(m.role)}</td><td>${m.active ? 'Active' : 'Removed'}</td>
        <td>${m.active ? `<button class="btn btn-outline btn-sm" data-off="${esc(m.id)}">Remove</button>` : ''}</td></tr>`).join('')}
      </tbody></table>`;
    $('#addMod').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await call('/api/admin/moderators', { action: 'create', name: $('#mName').value, role: $('#mRole').value });
      $('#newTok').innerHTML = `<p><b>Send this token to ${esc(r.name)} privately.</b> It is shown only once:</p><p class="token">${esc(r.token)}</p>`;
    });
    $('#view').querySelectorAll('[data-off]').forEach(b => b.addEventListener('click', async () => {
      await call('/api/admin/moderators', { action: 'deactivate', id: b.dataset.off }); team();
    }));
  }

  async function log() {
    const rows = await call('/api/admin/log');
    $('#view').innerHTML = `<table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Note</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${new Date(r.created_at).toLocaleString()}</td><td>${esc(r.moderator_name)}</td><td>${esc(r.action)}</td><td>${esc(r.note || '')}</td></tr>`).join('')}
      </tbody></table>`;
  }

  if (token && API) call('/api/admin/me').then(m => { me = m; start(); }).catch(() => {});
})();

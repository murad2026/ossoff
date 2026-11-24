// Draft Ossoff 2028 — front-end. Works against the API worker, or in DEMO MODE (localStorage) when API_BASE is empty.
(() => {
  const CFG = window.SITE_CONFIG || {};
  const API = (CFG.API_BASE || '').replace(/\/+$/, '');
  const DEMO = !API;
  const $ = (s) => document.querySelector(s);

  const STATES = [['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming']];
  const STATE_NAME = Object.fromEntries(STATES);

  // ---------- local memory (this browser only) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('do28_' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('do28_' + k, JSON.stringify(v)); } catch {} }
  };
  const refFromUrl = (new URLSearchParams(location.search).get('r') || '').toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(refFromUrl)) store.set('referredBy', refFromUrl);

  // ---------- API (real or demo) ----------
  const api = DEMO ? demoApi() : {
    pledge: (answer, state) => post('/api/pledge', { answer, state }),
    review: (text, turnstile) => post('/api/review', { text, turnstile }),
    submit: (body) => post('/api/submit', body),
    stories: (state) => get('/api/stories?limit=60' + (state ? '&state=' + state : '')),
    stats: () => get('/api/stats'),
    ref: (code) => get('/api/ref/' + code)
  };
  async function get(path) {
    const r = await fetch(API + path);
    if (!r.ok) throw await errOf(r);
    return r.json();
  }
  async function post(path, body) {
    const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw await errOf(r);
    return r.json();
  }
  async function errOf(r) {
    let d = {}; try { d = await r.json(); } catch {}
    const e = new Error(d.message || d.reason || 'Something went wrong. Please try again.');
    Object.assign(e, d, { status: r.status });
    return e;
  }

  // ---------- setup ----------
  if (DEMO) $('#demoBar').hidden = false;
  if (CFG.HERO_PHOTO) {
    const img = new Image();
    img.alt = 'Sen. Jon Ossoff';
    img.onload = () => { $('#portrait').classList.add('has-photo'); $('#portrait').prepend(img); };
    img.src = CFG.HERO_PHOTO;
    $('#photoCredit').textContent = CFG.HERO_PHOTO_CREDIT || '';
  }
  $('#legal').textContent = `Unofficial supporter site run by ${CFG.ORG_NAME || 'volunteers'}. Not authorized by any candidate or candidate's committee. We do not solicit or accept contributions. No photos or logos of Sen. Ossoff are used. Contact: ${CFG.CONTACT_EMAIL || ''}`;
  const opts = (first) => `<option value="">${first}</option>` + STATES.map(([c, n]) => `<option value="${c}">${n}</option>`).join('') + '<option value="Abroad">Living abroad</option>';
  $('#pledgeState').innerHTML = opts('Choose your state');
  $('#state').innerHTML = opts('Choose…');
  $('#wallFilter').innerHTML = opts('All states');
  const savedState = store.get('state', '');
  if (savedState) { $('#pledgeState').value = savedState; $('#state').value = savedState; }

  // ---------- ladder ----------
  function paintLadder() {
    const done = store.get('steps', []);
    let next = 1; while (done.includes(next)) next++;
    document.querySelectorAll('#steps li').forEach(li => {
      const n = Number(li.dataset.step);
      li.classList.toggle('done', done.includes(n));
      li.classList.toggle('now', n === next);
    });
  }
  function markStep(n) { const d = store.get('steps', []); if (!d.includes(n)) { d.push(n); store.set('steps', d); } paintLadder(); }
  paintLadder();

  // ---------- STEP 1: the one-click question ----------
  function showAsked(answer, yes) {
    $('#askButtons').hidden = true;
    $('#askDone').hidden = false;
    $('#askThanks').textContent = answer === 'yes'
      ? 'Your name is in the count. Thank you — you just took step one.'
      : 'Fair enough. Read why others want him to run, and come back any time.';
    if (typeof yes === 'number') paintYes(yes);
  }
  const prior = store.get('pledge', null);
  if (prior) showAsked(prior);
  $('#askButtons').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-answer]'); if (!b) return;
    const answer = b.dataset.answer;
    b.disabled = true;
    try {
      const r = await api.pledge(answer, $('#pledgeState').value || null);
      store.set('pledge', answer);
      if (answer === 'yes') markStep(1);
      showAsked(answer, r.yes);
    } catch (err) { b.disabled = false; alertMsg('#askMsg', err.message); }
  });
  $('#pledgeState').addEventListener('change', async (e) => {
    const s = e.target.value; store.set('state', s); $('#state').value = s;
    const a = store.get('pledge', null);
    if (a && s) { try { await api.pledge(a, s); $('#stateOk').textContent = '✓ Counted for ' + (s === 'Abroad' ? 'Americans abroad' : (STATE_NAME[s] || s)) + '.'; loadStats(); } catch {} }
  });

  // ---------- STEP 2: write + AI check ----------
  let reviewed = null;
  const text = $('#storyText');
  text.addEventListener('input', () => { $('#charCount').textContent = text.value.length; drawCard(); });
  $('#storyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = text.value.trim();
    if (t.length < 20) return alertMsg('#checkMsg', 'Write at least a sentence or two.');
    const btn = $('#checkBtn'); btn.disabled = true; msg('#checkMsg', 'Checking…');
    try {
      reviewed = await api.review(t, turnstileToken());
      reviewed.original = t;
      showReview(reviewed);
      msg('#checkMsg', '');
    } catch (err) { alertMsg('#checkMsg', err.message); }
    btn.disabled = false;
  });

  function showReview(r) {
    $('#reviewBox').hidden = false;
    const v = $('#verdict');
    v.className = 'verdict ' + (r.verdict === 'publish' ? 'ok' : r.verdict === 'review' ? 'warn' : 'no');
    v.textContent = r.verdict === 'publish' ? 'Looks great — ready to post.'
      : r.verdict === 'review' ? 'A volunteer will take a quick look before it goes up. ' + (r.reason || '')
      : 'This one can’t go up as written. ' + (r.reason || '');
    $('#tagList').innerHTML = (r.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
    $('#polishedText').textContent = r.polished || '';
    $('#originalText').textContent = r.original;
    $('#chooseBox').hidden = !r.polished;
    if (!r.polished) document.querySelector('input[name=version][value=mine]').checked = true;
    $('#submitBtn').textContent = r.verdict === 'reject' ? 'Ask a human to review it' : 'Post my message';
    drawCard();
    $('#reviewBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  document.querySelectorAll('input[name=version]').forEach(r => r.addEventListener('change', drawCard));
  $('#firstName').addEventListener('input', drawCard);
  $('#state').addEventListener('change', drawCard);

  function finalText() {
    if (!reviewed) return text.value.trim() || store.get('myText', '');
    const v = document.querySelector('input[name=version]:checked').value;
    return v === 'polished' && reviewed.polished ? reviewed.polished : reviewed.original;
  }

  // ---------- STEPS 3–4: post, card, referral ----------
  $('#submitForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      text: finalText(),
      firstName: $('#firstName').value.trim(),
      state: $('#state').value,
      email: $('#email').value.trim(),
      consent: $('#consent').checked,
      ref: store.get('referredBy', null),
      appeal: reviewed && reviewed.verdict === 'reject',
      turnstile: turnstileToken()
    };
    if (!body.firstName || !body.state) return alertMsg('#submitMsg', 'Add your first name and state.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) return alertMsg('#submitMsg', 'Check your email address.');
    if (!body.consent) return alertMsg('#submitMsg', 'Please tick the box to continue.');
    const btn = $('#submitBtn'); btn.disabled = true; msg('#submitMsg', 'Posting…');
    try {
      const r = await api.submit(body);
      store.set('state', body.state); store.set('refCode', r.refCode); store.set('name', body.firstName); store.set('myText', body.text);
      if (r.headline) { reviewed = { ...(reviewed || {}), headline: r.headline }; store.set('myHeadline', r.headline); }
      markStep(2); markStep(3);
      msg('#submitMsg', r.status === 'approved' ? 'Posted! It’s on the wall below.' : 'Thanks! A volunteer will review it shortly — usually within a day.');
      showShare(r.refCode);
      loadWall(); loadStats();
    } catch (err) {
      if (err.refCode) { showShare(err.refCode); }
      alertMsg('#submitMsg', err.message);
    }
    btn.disabled = false;
  });

  function refUrl(code) {
    const base = CFG.SITE_URL || (location.origin + location.pathname);
    return base + (base.includes('?') ? '&' : '?') + 'r=' + code;
  }
  async function showShare(code) {
    $('#shareBox').hidden = false;
    const link = refUrl(code);
    const a = $('#refLink'); a.href = link; a.textContent = link;
    drawCard(code);
    try { const r = await api.ref(code);
      if (r.text && !store.get('myText', '')) { store.set('myText', r.text); if (r.headline) store.set('myHeadline', r.headline); drawCard(code); }
      $('#refStats').textContent = r.recruited ? `You've brought in ${r.recruited} ${r.recruited === 1 ? 'person' : 'people'} so far.` : 'Share it — every friend who joins through it counts toward step 4.'; } catch {}
  }
  const savedRef = store.get('refCode', null);
  if (savedRef) showShare(savedRef);

  const shareText = () => `"${finalText() || 'I want Jon Ossoff to run for President in 2028.'}" — Add your voice:`;
  $('#copyBtn').addEventListener('click', async () => {
    const code = store.get('refCode', '');
    try { await navigator.clipboard.writeText(shareText() + ' ' + refUrl(code)); flash('#copyBtn', 'Copied!'); } catch { flash('#copyBtn', 'Copy failed'); }
  });
  $('#downloadBtn').addEventListener('click', () => {
    const a = document.createElement('a');
    a.download = 'draft-ossoff-2028-card.png';
    a.href = $('#card').toDataURL('image/png');
    a.click(); markStep(3);
  });
  $('#shareBtn').addEventListener('click', async () => {
    const code = store.get('refCode', '');
    const url = refUrl(code);
    try {
      const blob = await new Promise(res => $('#card').toBlob(res, 'image/png'));
      const file = new File([blob], 'draft-ossoff-2028.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], text: shareText() + ' ' + url });
      else if (navigator.share) await navigator.share({ text: shareText(), url });
      else { await navigator.clipboard.writeText(shareText() + ' ' + url); flash('#shareBtn', 'Link copied'); }
      markStep(3);
    } catch {}
  });

  // ---------- the share card (1080×1080 placard) ----------
  const cv = $('#card'), cx = cv.getContext('2d');
  function star(x, y, r, color) {
    cx.save(); cx.fillStyle = color; cx.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.42 : r; cx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); }
    cx.closePath(); cx.fill(); cx.restore();
  }
  function wrap(t, maxW) {
    const words = t.split(/\s+/), lines = []; let line = '';
    for (const w of words) { const test = line ? line + ' ' + w : w; if (cx.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test; }
    if (line) lines.push(line); return lines;
  }
  function drawCard(code) {
    const W = 1080, H = 1080;
    cx.fillStyle = '#0A2342'; cx.fillRect(0, 0, W, H);
    cx.globalAlpha = .08; for (let y = 40; y < H - 160; y += 90) for (let x = 40 + (y / 90 % 2) * 45; x < W; x += 90) star(x, y, 14, '#fff'); cx.globalAlpha = 1;
    for (let i = 0; i < 13; i++) { cx.fillStyle = i % 2 ? '#FFFFFF' : '#B22234'; cx.fillRect(i * (W / 13), H - 40, W / 13 + 1, 40); }
    cx.fillStyle = '#B22234'; cx.fillRect(0, 0, W, 16);
    // header
    cx.fillStyle = '#fff'; cx.font = '700 64px Oswald, Impact, sans-serif'; cx.textBaseline = 'alphabetic';
    cx.fillText('OSSOFF', 72, 140); const w1 = cx.measureText('OSSOFF').width;
    star(72 + w1 + 34, 118, 22, '#B22234');
    cx.fillStyle = '#FF4757'; cx.fillText('2028', 72 + w1 + 68, 140);
    cx.fillStyle = '#C9D3E3'; cx.font = '600 26px Inter, sans-serif'; cx.fillText('RUN, JON, RUN.', 72, 186);
    // headline
    const headline = ((reviewed && reviewed.headline) || store.get('myHeadline', '') || 'Why I want Jon to run').toUpperCase();
    cx.fillStyle = '#fff'; cx.font = '700 54px Oswald, Impact, sans-serif';
    let y = 290; for (const l of wrap(headline, W - 144).slice(0, 2)) { cx.fillText(l, 72, y); y += 64; }
    // quote
    const q = finalText() || 'Your words will appear here as you write.';
    let size = q.length > 180 ? 38 : q.length > 110 ? 44 : 50;
    cx.font = `italic 500 ${size}px "Source Serif 4", Georgia, serif`; cx.fillStyle = '#EEF2F8';
    y += 20; const lines = wrap('“' + q + '”', W - 144).slice(0, 7);
    for (const l of lines) { cx.fillText(l, 72, y); y += size * 1.32; }
    // byline
    const name = ($('#firstName').value.trim() || store.get('name', '')).split(/\s+/)[0] || 'Your name';
    const st = $('#state').value; const stName = st === 'Abroad' ? 'abroad' : (STATE_NAME[st] || 'your state');
    cx.fillStyle = '#FF4757'; cx.font = '700 34px Inter, sans-serif'; cx.fillText('— ' + name + ', ' + stName, 72, Math.min(y + 30, H - 170));
    // footer
    cx.fillStyle = '#B22234'; cx.fillRect(72, H - 132, 330, 54);
    cx.fillStyle = '#fff'; cx.font = '700 28px Oswald, Impact, sans-serif'; cx.fillText('#DRAFTOSSOFF2028', 88, H - 94);
    cx.fillStyle = '#9FB0C8'; cx.font = '500 21px Inter, sans-serif'; cx.textAlign = 'right';
    cx.fillText('Unofficial supporter card', W - 72, H - 112);
    const c = code || store.get('refCode', '');
    if (c) cx.fillText('Add your voice · code ' + c, W - 72, H - 84);
    cx.textAlign = 'left';
  }
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => drawCard());

  // ---------- tally ----------
  // ---------- live tally ----------
  // Counts up on load, re-checks every 20 s while the tab is open, and flashes "+N just now"
  // when real people back Jon. No fake activity: every number comes from the server.
  let shownYes = null;
  function countTo(el, from, to, ms) {
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (to - from) * e).toLocaleString();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function ago(iso) {
    const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60); if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    const d = Math.round(h / 24); return d + (d === 1 ? ' day ago' : ' days ago');
  }
  function paintYes(n) {
    const el = $('#yesCount');
    if (shownYes === null) countTo(el, 0, n, 1400);
    else if (n > shownYes) {
      countTo(el, shownYes, n, 900);
      const f = $('#yesFlash'); f.textContent = '+' + (n - shownYes) + ' just now';
      f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
      el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    } else el.textContent = n.toLocaleString();
    shownYes = n;
  }
  async function loadStats() {
    try {
      const s = await api.stats();
      paintYes(s.yes);
      $('#tYes').textContent = s.yes.toLocaleString();
      $('#tStories').textContent = s.stories.toLocaleString();
      const by = Object.fromEntries((s.states || []).map(r => [r.state, r.n]));
      const on = STATES.filter(([c]) => by[c]);
      $('#tStates').textContent = on.length;
      $('#heroStates').textContent = on.length;
      $('#heroStateList').textContent = on.sort((a, b) => by[b[0]] - by[a[0]]).map(([c]) => c).join(' · ');
      $('#stateGrid').innerHTML = STATES.map(([c, n]) => `<div class="st${by[c] ? ' on' : ''}" title="${n}: ${by[c] || 0}">${c}<small>${by[c] || 0}</small></div>`).join('');
      const bits = [];
      if (s.latestAt && Date.now() - Date.parse(s.latestAt) < 30 * 864e5) bits.push('Latest: ' + ago(s.latestAt));
      if (s.last24h) bits.push(s.last24h.toLocaleString() + ' in the last 24 hours');
      $('#liveLine').hidden = !bits.length;
      $('#liveText').textContent = bits.join(' · ');
    } catch { if (!$('#stateGrid').innerHTML) $('#stateGrid').innerHTML = '<p>Tally unavailable right now.</p>'; }
  }
  setInterval(() => { if (!document.hidden) loadStats(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStats(); });

  // ---------- wall ----------
  async function loadWall() {
    try {
      const list = await api.stories($('#wallFilter').value || '');
      $('#wallEmpty').hidden = list.length > 0;
      $('#wallGrid').innerHTML = list.map(p => `
        <article class="post">
          ${p.headline ? `<h3>${esc(p.headline)}</h3>` : ''}
          <blockquote>“${esc(p.text)}”</blockquote>
          <p class="by">— ${esc(String(p.first_name || '').trim().split(/\s+/)[0])}, ${esc(p.state === 'Abroad' ? 'abroad' : (STATE_NAME[p.state] || p.state))}</p>
          ${pubTags(p.tags).length ? `<div class="tags">${pubTags(p.tags).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
        </article>`).join('');
    } catch { $('#wallGrid').innerHTML = '<p class="empty">The wall can’t be reached right now.</p>'; }
  }
  $('#wallFilter').addEventListener('change', loadWall);
  loadStats(); loadWall();

  // ---------- optional captcha ----------
  if (CFG.TURNSTILE_SITEKEY && !DEMO) {
    $('#turnstileSlot').innerHTML = `<div class="cf-turnstile" data-sitekey="${esc(CFG.TURNSTILE_SITEKEY)}"></div>`;
    const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'; s.async = true; document.head.appendChild(s);
  }
  function turnstileToken() { const i = document.querySelector('[name="cf-turnstile-response"]'); return i ? i.value : undefined; }

  // ---------- helpers ----------
  // Internal moderator notes never show on the public wall.
  const PRIVATE_TAGS = new Set(['Needs a source', 'Emotion without argument']);
  function pubTags(t) { return (Array.isArray(t) ? t : []).filter(x => !PRIVATE_TAGS.has(x)); }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function msg(sel, t) { const el = $(sel); el.classList.remove('err'); el.textContent = t; }
  function alertMsg(sel, t) { const el = $(sel); el.classList.add('err'); el.textContent = t; }
  function flash(sel, t) { const b = $(sel), o = b.textContent; b.textContent = t; setTimeout(() => (b.textContent = o), 1600); }

  // ---------- DEMO MODE: same API shape, kept in this browser ----------
  function demoApi() {
    const BAD = /\b(idiot|stupid|moron|traitor|kill|die|scum|trash|hate you)\b/i;
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const code = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
    return {
      async pledge(answer) { await wait(250); const n = store.get('demoYes', 0) + (answer === 'yes' && store.get('pledge', null) !== 'yes' ? 1 : 0); store.set('demoYes', n); return { yes: n }; },
      async review(t) {
        await wait(700);
        if (BAD.test(t)) return { verdict: 'reject', category: 'harassment', reason: 'Please make your point without insults — civil disagreement is welcome.', tags: [], headline: '', polished: '' };
        const tags = [];
        if (/\b(I|my|me)\b/.test(t)) tags.push('Personal story');
        if (/\b(should|would|ban|lower|fix|pass|build)\b/i.test(t)) tags.push('Specific proposal');
        if (/\b(both parties|republican|bipartisan|across the aisle)\b/i.test(t)) tags.push('Bipartisan appeal');
        const sentence = t.replace(/\s+/g, ' ').trim();
        const polished = sentence.length > 220 ? sentence.slice(0, 217).replace(/\s+\S*$/, '') + '…' : sentence;
        const headline = sentence.split(/[.!?]/)[0].split(' ').slice(0, 6).join(' ');
        return { verdict: 'publish', category: 'ok', reason: '', tags: tags.slice(0, 3), headline, polished };
      },
      async submit(b) {
        await wait(600);
        const list = store.get('demoWall', []);
        const c = code();
        list.unshift({ id: c, created_at: new Date().toISOString(), first_name: b.firstName, state: b.state, text: b.text, headline: (reviewed && reviewed.headline) || '', tags: (reviewed && reviewed.tags) || [] });
        store.set('demoWall', list.slice(0, 100));
        return { ok: true, status: b.appeal ? 'pending' : 'approved', refCode: c };
      },
      async stories(state) { await wait(150); return store.get('demoWall', []).filter(p => !state || p.state === state); },
      async stats() {
        const wall = store.get('demoWall', []); const by = {};
        wall.forEach(p => { by[p.state] = (by[p.state] || 0) + 1; });
        return { yes: store.get('demoYes', 0), stories: wall.length, signups: wall.length, states: Object.entries(by).map(([state, n]) => ({ state, n })) };
      },
      async ref() { return { recruited: 0 }; }
    };
  }
})();

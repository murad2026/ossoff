// End-to-end test of the worker with fake Supabase + Claude (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

function fakeBackend(aiReply) {
  const tables = { stories: [], signups: [], pledges: [], rate_events: [], moderators: [], mod_actions: [] };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('anthropic.com')) return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(aiReply) }] }), { status: 200 });
    const u = new URL(url); const table = u.pathname.split('/').pop(); const m = init.method || 'GET';
    const rows = tables[table] || [];
    const filt = [...u.searchParams].filter(([k]) => !['select','order','limit','on_conflict'].includes(k));
    const match = (r) => filt.every(([k, v]) => { const [op, val] = [v.split('.')[0], v.split('.').slice(1).join('.')];
      if (op === 'eq') return String(r[k]) === val; if (op === 'neq') return String(r[k]) !== val; if (op === 'gte') return true; return true; });
    if (m === 'POST') { const b = JSON.parse(init.body); if (table === 'pledges') { const i = rows.findIndex(r => r.ip_hash === b.ip_hash); if (i >= 0) rows[i] = b; else rows.push(b); } else rows.push({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...b }); tables[table] = rows; return new Response(null, { status: 201 }); }
    if (m === 'HEAD') { const n = rows.filter(match).length; return new Response(null, { status: 200, headers: { 'content-range': `0-0/${n}` } }); }
    if (m === 'PATCH') { const b = JSON.parse(init.body); rows.filter(match).forEach(r => Object.assign(r, b)); return new Response(null, { status: 204 }); }
    if (table === 'state_counts') { const by = {}; tables.stories.filter(s => s.status === 'approved').forEach(s => by[s.state] = (by[s.state] || 0) + 1); return Response.json(Object.entries(by).map(([state, n]) => ({ state, n }))); }
    const sel = u.searchParams.get('select'); const out = rows.filter(match);
    return Response.json(!sel || sel === '*' ? out : out.map(r => Object.fromEntries(sel.split(',').map(k => [k, r[k]]))));
  };
  return tables;
}
const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', ANTHROPIC_API_KEY: 'a', HASH_SALT: 's', ADMIN_TOKEN: 'owner-secret' };
const req = (path, body, headers = {}) => new Request('https://api.test' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4', ...headers }, body: body ? JSON.stringify(body) : undefined });
const good = { verdict: 'publish', category: 'ok', reason: '', tags: ['Personal story'], headline: 'A teacher asks Jon to run', polished: 'I teach in Savannah and want him to run.' };

test('pledge, review, submit, wall, stats, ref', async () => {
  const t = fakeBackend(good);
  let r = await (await worker.fetch(req('/api/pledge', { answer: 'yes', state: 'GA' }), env)).json();
  assert.equal(r.yes, 1);
  r = await (await worker.fetch(req('/api/pledge', { answer: 'yes' }), env)).json();
  assert.equal(r.yes, 1, 'same network counted once');
  r = await (await worker.fetch(req('/api/review', { text: 'I teach in Savannah and I want Jon to run because he fights corruption.' }), env)).json();
  assert.equal(r.verdict, 'publish');
  const sub = await worker.fetch(req('/api/submit', { text: 'I teach in Savannah and want him to run.', firstName: 'Ann', state: 'GA', email: 'ann@x.com', consent: true }), env);
  r = await sub.json(); assert.equal(sub.status, 200); assert.equal(r.status, 'approved'); assert.match(r.refCode, /^[A-Z2-9]{6}$/);
  const dupe = await worker.fetch(req('/api/submit', { text: 'Another message that is long enough.', firstName: 'Ann', state: 'GA', email: 'ann@x.com', consent: true }), env);
  assert.equal(dupe.status, 409);
  const wall = await (await worker.fetch(req('/api/stories'), env)).json();
  assert.equal(wall.length, 1); assert.equal(wall[0].email_hash, undefined, 'no private fields leak');
  const stats = await (await worker.fetch(req('/api/stats'), env)).json();
  assert.deepEqual([stats.yes, stats.stories], [1, 1]);
  assert.equal(t.signups.length, 1);
});

test('rejected posts are refused, appeals go to the queue, team + moderation', async () => {
  const t = fakeBackend({ verdict: 'reject', category: 'harassment', reason: 'No insults please.', tags: [], headline: '', polished: '' });
  const bad = await worker.fetch(req('/api/submit', { text: 'some rude text that is long enough to send', firstName: 'Bo', state: 'TX', email: 'bo@x.com', consent: true }), env);
  assert.equal(bad.status, 422);
  const ap = await (await worker.fetch(req('/api/submit', { text: 'some rude text that is long enough to send', firstName: 'Bo', state: 'TX', email: 'bo@x.com', consent: true, appeal: true }), env)).json();
  assert.equal(ap.status, 'pending');
  assert.equal((await worker.fetch(req('/api/admin/queue'), env)).status, 401);
  const owner = { Authorization: 'Bearer owner-secret' };
  const created = await (await worker.fetch(req('/api/admin/moderators', { action: 'create', name: 'Maria', role: 'moderator' }, owner), env)).json();
  assert.ok(created.token);
  const mod = { Authorization: 'Bearer ' + created.token };
  const me = await (await worker.fetch(req('/api/admin/me', null, mod), env)).json();
  assert.equal(me.name, 'Maria');
  assert.equal((await worker.fetch(req('/api/admin/moderators', null, mod), env)).status, 403, 'moderators cannot manage team');
  const q = await (await worker.fetch(req('/api/admin/queue?status=pending', null, mod), env)).json();
  assert.equal(q.length, 1);
  await worker.fetch(req('/api/admin/decide', { id: q[0].id, status: 'rejected', note: 'insults' }, mod), env);
  assert.equal(t.stories[0].status, 'rejected'); assert.equal(t.stories[0].reviewed_by, 'Maria');
  assert.ok(t.mod_actions.some(a => a.action === 'rejected' && a.moderator_name === 'Maria'));
});

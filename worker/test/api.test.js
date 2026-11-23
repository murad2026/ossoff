// End-to-end test of the worker with in-memory SQLite (D1 stand-in) + fake Claude (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Real SQLite in memory behind a D1-shaped binding, plus a fake Claude.
function fakeD1() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const prep = (q) => ({
    _args: [],
    bind(...a) { this._args = a; return this; },
    async all() { return { results: sql.prepare(q).all(...this._args) }; },
    async first() { return sql.prepare(q).get(...this._args) ?? null; },
    async run() { sql.prepare(q).run(...this._args); return { success: true }; }
  });
  const rows = (t) => sql.prepare(`SELECT * FROM ${t}`).all().map(r => {
    for (const c of ['tags', 'signals', 'roles']) if (typeof r[c] === 'string') r[c] = JSON.parse(r[c]);
    return r;
  });
  return { binding: { prepare: prep }, rows };
}
function fakeBackend(aiReply) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('anthropic.com')) return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'moderation_result', input: aiReply }] }), { status: 200 });
    throw new Error('unexpected fetch ' + url);
  };
  const d = fakeD1();
  env.DB = d.binding;
  return new Proxy({}, { get: (_, t) => d.rows(t) });
}
const env = { ANTHROPIC_API_KEY: 'a', HASH_SALT: 's', ADMIN_TOKEN: 'owner-secret' };
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

test('volunteer applications are private and admin-only', async () => {
  const t = fakeBackend(good);
  const bad = await worker.fetch(req('/api/volunteer', { name: 'Kim', email: 'kim@x.com', state: 'PA', roles: [], consent: true }), env);
  assert.equal(bad.status, 400);
  const ok = await worker.fetch(req('/api/volunteer', { name: 'Kim', email: 'kim@x.com', state: 'PA', roles: ['organizer', 'hacker'], hours: '3-5', consent: true }), env);
  assert.equal(ok.status, 200);
  assert.deepEqual(t.volunteers[0].roles, ['organizer']);
  const owner = { Authorization: 'Bearer owner-secret' };
  const mod = await (await worker.fetch(req('/api/admin/moderators', { action: 'create', name: 'Lee', role: 'moderator' }, owner), env)).json();
  assert.equal((await worker.fetch(req('/api/admin/volunteers', null, { Authorization: 'Bearer ' + mod.token }), env)).status, 403);
  const list = await (await worker.fetch(req('/api/admin/volunteers', null, owner), env)).json();
  assert.equal(list.length, 1);
});

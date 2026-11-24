// Draft Ossoff 2028 — API worker (Cloudflare Workers)
// Routes:
//   POST /api/review          -> AI moderation + suggestions (nothing stored)
//   POST /api/submit          -> re-moderates final text, stores story + signup
//   GET  /api/stories         -> latest approved stories
//   GET  /api/stats           -> counts for the tally board
//   GET  /api/ref/:code       -> how many people a supporter brought in
//   GET  /api/admin/queue     -> pending stories (needs ADMIN_TOKEN)
//   POST /api/admin/decide    -> approve / reject a pending story (needs ADMIN_TOKEN)

import { moderate, TAGS } from './moderation.js';
import { db } from './d1.js';
import { normalize, sha256, refCode, signals } from './util.js';

const STATES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','PR','Abroad']);
const MAX_TEXT = 600;
const SUBMITS_PER_HOUR = 3;
const REVIEWS_PER_HOUR = 15;

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(req, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      console.error(e);
      return json({ error: 'server_error' }, 500, cors);
    }
  }
};

async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '');
  const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const ipHash = await sha256(ip + (env.HASH_SALT || ''));

  if (req.method === 'POST' && p === '/api/pledge') return pledge(req, env, ipHash);
  if (req.method === 'POST' && p === '/api/volunteer') return volunteer(req, env, ipHash);
  if (req.method === 'POST' && p === '/api/review') return review(req, env, ipHash);
  if (req.method === 'POST' && p === '/api/submit') return submit(req, env, ipHash);
  if (req.method === 'GET' && p === '/api/stories') return stories(env, url);
  if (req.method === 'GET' && p === '/api/stats') return stats(env);
  if (req.method === 'GET' && p.startsWith('/api/ref/')) return refCount(env, p.split('/').pop());
  if (p.startsWith('/api/admin/')) {
    const me = await whoIs(req, env);
    if (!me) return json({ error: 'unauthorized' }, 401);
    if (req.method === 'GET' && p === '/api/admin/me') return json(me);
    if (req.method === 'GET' && p === '/api/admin/queue') return queue(env, url);
    if (req.method === 'POST' && p === '/api/admin/decide') return decide(req, env, me);
    if (req.method === 'GET' && p === '/api/admin/volunteers') {
      if (me.role === 'moderator') return json({ error: 'forbidden' }, 403);
      return json(await db(env).select('volunteers', 'select=*&order=created_at.desc&limit=500'));
    }
    if (req.method === 'POST' && p === '/api/admin/volunteer-status') {
      if (me.role === 'moderator') return json({ error: 'forbidden' }, 403);
      const b = await readJson(req);
      if (!b.id || !['new', 'contacted', 'active', 'declined'].includes(b.status)) return json({ error: 'bad_request' }, 400);
      await db(env).update('volunteers', `id=eq.${encodeURIComponent(b.id)}`, { status: b.status });
      await db(env).insert('mod_actions', { moderator_id: me.id, moderator_name: me.name, action: 'volunteer_' + b.status, note: String(b.id) });
      return json({ ok: true });
    }
    if (req.method === 'GET' && p === '/api/admin/log') return json(await db(env).select('mod_actions', 'select=*&order=created_at.desc&limit=100'));
    if (p === '/api/admin/moderators') {
      if (me.role === 'moderator') return json({ error: 'forbidden' }, 403);
      if (req.method === 'GET') return json(await db(env).select('moderators', 'select=id,name,role,active,created_at&order=created_at.asc'));
      if (req.method === 'POST') return manageModerators(req, env, me);
    }
  }
  return json({ error: 'not_found' }, 404);
}

// ---------- handlers ----------

// Volunteer applications (private; only admins/owner can read them)
const ROLES = ['moderator', 'social', 'organizer', 'content', 'design', 'developer', 'translator', 'research', 'outreach', 'elections'];
async function volunteer(req, env, ipHash) {
  const b = await readJson(req);
  const name = clean(b.name).slice(0, 60);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
  const state = STATES.has(b.state) ? b.state : null;
  const roles = (Array.isArray(b.roles) ? b.roles : []).filter(r => ROLES.includes(r)).slice(0, 5);
  const hours = ['1-2', '3-5', '6-10', '10+'].includes(b.hours) ? b.hours : null;
  const about = clean(b.about).slice(0, 600);
  const links = clean(b.links).slice(0, 300);
  if (!name || !state || !roles.length || b.consent !== true) return json({ error: 'missing_fields', message: 'Add your name, state and at least one role.' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'bad_email', message: 'Check your email address.' }, 400);
  if (!(await turnstileOk(env, b.turnstile, req))) return json({ error: 'captcha' }, 403);
  if (!(await underLimit(env, 'volunteer', ipHash, 3))) return json({ error: 'rate_limited', message: 'Too many applications from this network.' }, 429);
  await db(env).upsert('volunteers', { name, email, state, roles, hours, about, links, status: 'new', ip_hash: ipHash }, 'email', true);
  return json({ ok: true });
}

// Step 1 of the ladder: one click — "Do you support Jon Ossoff running in 2028?"
// One answer per network (re-clicking just changes it), no personal data.
async function pledge(req, env, ipHash) {
  const b = await readJson(req);
  const answer = ['yes', 'unsure'].includes(b.answer) ? b.answer : null;
  if (!answer) return json({ error: 'bad_request' }, 400);
  const state = STATES.has(b.state) ? b.state : null;
  await db(env).upsert('pledges', { ip_hash: ipHash, answer, state, updated_at: new Date().toISOString() }, 'ip_hash', true);
  const yes = await db(env).count('pledges', 'answer=eq.yes');
  return json({ ok: true, answer, yes });
}

async function review(req, env, ipHash) {
  const body = await readJson(req);
  const text = clean(body.text);
  if (text.length < 20) return json({ error: 'too_short', message: 'Write at least a sentence or two.' }, 400);
  if (!(await turnstileOk(env, body.turnstile, req))) return json({ error: 'captcha' }, 403);
  if (!(await underLimit(env, 'review', ipHash, REVIEWS_PER_HOUR))) return json({ error: 'rate_limited', message: 'Too many checks — try again in an hour.' }, 429);

  const sig = signals(text);
  const ai = await moderate(env, text);
  return json({ ...ai, signals: sig });
}

async function submit(req, env, ipHash) {
  const b = await readJson(req);
  const text = clean(b.text);
  const firstName = clean(b.firstName).slice(0, 40);
  const state = STATES.has(b.state) ? b.state : null;
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
  const referredBy = /^[A-Z0-9]{6}$/.test(b.ref || '') ? b.ref : null;
  const appeal = b.appeal === true;

  if (text.length < 20 || !firstName || !state) return json({ error: 'missing_fields' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'bad_email' }, 400);
  if (b.consent !== true) return json({ error: 'consent_required' }, 400);
  if (!(await turnstileOk(env, b.turnstile, req))) return json({ error: 'captcha' }, 403);
  if (!(await underLimit(env, 'submit', ipHash, SUBMITS_PER_HOUR))) return json({ error: 'rate_limited', message: 'Too many posts from this network — try again later.' }, 429);

  // Troll / bot signals that don't need AI
  const textHash = await sha256(normalize(text));
  const dup = await db(env).select('stories', `text_hash=eq.${textHash}&select=id&limit=1`);
  const emailHash = await sha256(email);
  const already = await db(env).select('stories', `email_hash=eq.${emailHash}&status=neq.rejected&select=id,ref_code&limit=1`);
  if (already.length) return json({ error: 'already_posted', message: 'This email already has a story on the wall.', refCode: already[0].ref_code }, 409);

  // Always re-moderate the final text on the server (never trust the browser)
  const ai = await moderate(env, text);
  const sig = signals(text);
  if (dup.length) sig.push('duplicate_text');

  let status;
  if (ai.verdict === 'publish' && !sig.includes('duplicate_text') && !sig.includes('link_spam')) status = 'approved';
  else if (ai.verdict === 'reject' && !appeal) return json({ error: 'rejected', reason: ai.reason, category: ai.category }, 422);
  else status = 'pending'; // needs a human: borderline, duplicate, link spam, or an appeal

  const code = await uniqueRef(env);
  const row = {
    first_name: firstName, state, text, headline: ai.headline, tags: ai.tags,
    status, ai_verdict: ai.verdict, ai_reason: ai.reason, ai_category: ai.category,
    signals: sig, appeal, ref_code: code, referred_by: referredBy,
    text_hash: textHash, email_hash: emailHash, ip_hash: ipHash
  };
  await db(env).insert('stories', row);
  await db(env).upsert('signups', { email, first_name: firstName, state, ref_code: code, referred_by: referredBy, consent: true }, 'email');

  return json({ ok: true, status, refCode: code, headline: ai.headline, tags: ai.tags });
}

async function stories(env, url) {
  const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 60);
  const state = url.searchParams.get('state');
  let q = `status=eq.approved&select=id,created_at,first_name,state,text,headline,tags&order=created_at.desc&limit=${limit}`;
  if (state && STATES.has(state)) q += `&state=eq.${state}`;
  // Public wall shows first names only ("Murad Esenov" -> "Murad").
  const rows = (await db(env).select('stories', q)).map(r => ({ ...r, first_name: firstOnly(r.first_name) }));
  return json(rows, 200, { 'Cache-Control': 'public, max-age=30' });
}

async function stats(env) {
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const [yes, stories, signups, states, last24h, latest] = await Promise.all([
    db(env).count('pledges', 'answer=eq.yes'),
    db(env).count('stories', 'status=eq.approved'),
    db(env).count('signups', ''),
    db(env).select('state_counts', 'select=state,n&order=n.desc'),
    db(env).count('pledges', `answer=eq.yes&created_at=gte.${dayAgo}`),
    db(env).select('pledges', 'answer=eq.yes&select=created_at&order=created_at.desc&limit=1')
  ]);
  return json({ yes, stories, signups, states, last24h, latestAt: latest[0]?.created_at || null }, 200, { 'Cache-Control': 'public, max-age=15' });
}

async function refCount(env, code) {
  if (!/^[A-Z0-9]{6}$/.test(code)) return json({ error: 'bad_code' }, 400);
  const [recruited, mine] = await Promise.all([
    db(env).count('signups', `referred_by=eq.${code}`),
    // Only an approved story — it is already public on the wall.
    db(env).select('stories', `ref_code=eq.${code}&status=eq.approved&select=text,headline&limit=1`)
  ]);
  return json({ code, recruited, text: mine[0]?.text || '', headline: mine[0]?.headline || '' });
}

// ---------- moderation team ----------
// Roles: owner (ADMIN_TOKEN secret) > admin (manages the team) > moderator (reviews posts).
// Each person gets a personal token; only its hash is stored. Every decision is logged.

async function whoIs(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) return { id: null, name: 'Owner', role: 'owner' };
  const hash = await sha256('mod:' + token);
  const rows = await db(env).select('moderators', `token_hash=eq.${hash}&active=eq.true&select=id,name,role&limit=1`);
  return rows[0] || null;
}

async function queue(env, url) {
  const status = ['pending', 'approved', 'rejected', 'hidden'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'pending';
  const order = status === 'pending' ? 'asc' : 'desc';
  return json(await db(env).select('stories', `status=eq.${status}&select=id,created_at,first_name,state,text,headline,tags,ai_verdict,ai_reason,ai_category,signals,appeal,reviewed_by&order=created_at.${order}&limit=100`));
}

async function decide(req, env, me) {
  const b = await readJson(req);
  if (!['approved', 'rejected', 'hidden'].includes(b.status) || !b.id) return json({ error: 'bad_request' }, 400);
  const id = encodeURIComponent(b.id);
  const note = clean(b.note).slice(0, 300);
  await db(env).update('stories', `id=eq.${id}`, { status: b.status, reviewed_at: new Date().toISOString(), reviewed_by: me.name });
  await db(env).insert('mod_actions', { story_id: b.id, moderator_id: me.id, moderator_name: me.name, action: b.status, note });
  return json({ ok: true });
}

async function manageModerators(req, env, me) {
  const b = await readJson(req);
  if (b.action === 'create') {
    const name = clean(b.name).slice(0, 60);
    const role = b.role === 'admin' && me.role === 'owner' ? 'admin' : 'moderator';
    if (!name) return json({ error: 'name_required' }, 400);
    const token = [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, '0')).join('');
    await db(env).insert('moderators', { name, role, token_hash: await sha256('mod:' + token), active: true });
    await db(env).insert('mod_actions', { moderator_id: me.id, moderator_name: me.name, action: 'add_' + role, note: name });
    return json({ ok: true, name, role, token }); // shown once — hand it to the person privately
  }
  if (b.action === 'deactivate' && b.id) {
    await db(env).update('moderators', `id=eq.${encodeURIComponent(b.id)}`, { active: false });
    await db(env).insert('mod_actions', { moderator_id: me.id, moderator_name: me.name, action: 'remove_member', note: String(b.id) });
    return json({ ok: true });
  }
  return json({ error: 'bad_request' }, 400);
}

// ---------- helpers ----------

function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT); }

async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.length === 0 || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
}

async function turnstileOk(env, token, req) {
  if (!env.TURNSTILE_SECRET) return true; // captcha is optional
  if (!token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  form.append('remoteip', req.headers.get('CF-Connecting-IP') || '');
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const d = await r.json();
  return d.success === true;
}

// Simple fixed-window rate limit stored in D1 (works across all worker instances)
async function underLimit(env, kind, ipHash, max) {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const n = await db(env).count('rate_events', `ip_hash=eq.${ipHash}&kind=eq.${kind}&created_at=gte.${since}`);
  if (n >= max) return false;
  await db(env).insert('rate_events', { ip_hash: ipHash, kind });
  return true;
}

async function uniqueRef(env) {
  for (let i = 0; i < 5; i++) {
    const c = refCode();
    const hit = await db(env).select('stories', `ref_code=eq.${c}&select=id&limit=1`);
    if (!hit.length) return c;
  }
  throw new Error('could not mint ref code');
}

export { TAGS };

function firstOnly(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'A supporter';
}

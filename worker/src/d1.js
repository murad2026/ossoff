// Tiny data layer over Cloudflare D1 (SQLite).
// Keeps the PostgREST-style query strings the handlers already use
// ("status=eq.approved&select=id,text&order=created_at.desc&limit=30")
// and turns them into parameterized SQL. Only the operators we use are supported.

const TABLES = new Set(['pledges', 'stories', 'signups', 'moderators', 'mod_actions', 'rate_events', 'volunteers', 'state_counts']);
const ARRAY_COLS = new Set(['tags', 'signals', 'roles']);
const BOOL_COLS = new Set(['appeal', 'consent', 'active']);
const IDENT = /^[a-z_][a-z0-9_]*$/;
const OPS = { eq: '=', neq: '!=', gte: '>=', lte: '<=', gt: '>', lt: '<' };

function ident(name) {
  if (!IDENT.test(name)) throw new Error('bad identifier: ' + name);
  return name;
}
function table(name) {
  if (!TABLES.has(name)) throw new Error('unknown table: ' + name);
  return name;
}

function toDb(col, v) {
  if (ARRAY_COLS.has(col)) return JSON.stringify(Array.isArray(v) ? v : []);
  if (BOOL_COLS.has(col)) return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}
function fromDb(row) {
  if (!row) return row;
  const out = { ...row };
  for (const c of ARRAY_COLS) if (typeof out[c] === 'string') { try { out[c] = JSON.parse(out[c]); } catch { out[c] = []; } }
  for (const c of BOOL_COLS) if (c in out && out[c] !== null) out[c] = !!out[c];
  return out;
}
function filterValue(col, raw) {
  if (BOOL_COLS.has(col)) return raw === 'true' ? 1 : 0;
  return decodeURIComponent(raw);
}

function parse(query) {
  const p = new URLSearchParams(query || '');
  const where = [], args = [];
  let cols = '*', order = '', limit = '';
  for (const [k, v] of p) {
    if (k === 'select') { cols = v === '*' ? '*' : v.split(',').map(c => ident(c.trim())).join(', '); continue; }
    if (k === 'order') { const [c, dir] = v.split('.'); order = ` ORDER BY ${ident(c)} ${dir === 'desc' ? 'DESC' : 'ASC'}`; continue; }
    if (k === 'limit') { const n = Math.max(1, Math.min(1000, parseInt(v, 10) || 1)); limit = ` LIMIT ${n}`; continue; }
    const dot = v.indexOf('.');
    const op = OPS[v.slice(0, dot)];
    if (!op) throw new Error('unsupported filter: ' + v);
    where.push(`${ident(k)} ${op} ?`);
    args.push(filterValue(k, v.slice(dot + 1)));
  }
  return { cols, where: where.length ? ' WHERE ' + where.join(' AND ') : '', args, order, limit };
}

function prepRow(t, row) {
  const r = { ...row };
  if (t !== 'pledges' && t !== 'rate_events' && !r.id) r.id = crypto.randomUUID();
  if (!r.created_at) r.created_at = new Date().toISOString();
  const keys = Object.keys(r).map(ident);
  return { keys, vals: keys.map(k => toDb(k, r[k])) };
}

export function db(env) {
  const D = env.DB;
  return {
    async select(t, query) {
      const q = parse(query);
      const { results } = await D.prepare(`SELECT ${q.cols} FROM ${table(t)}${q.where}${q.order}${q.limit}`).bind(...q.args).all();
      return (results || []).map(fromDb);
    },
    async count(t, query) {
      const q = parse(query);
      const row = await D.prepare(`SELECT COUNT(*) AS n FROM ${table(t)}${q.where}`).bind(...q.args).first();
      return row ? Number(row.n) : 0;
    },
    async insert(t, row) {
      const { keys, vals } = prepRow(table(t), row);
      await D.prepare(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...vals).run();
    },
    // merge=false: keep the existing row (insert-or-ignore). merge=true: overwrite the given columns.
    async upsert(t, row, conflict, merge = false) {
      const { keys, vals } = prepRow(table(t), row);
      const c = ident(conflict);
      const tail = merge
        ? ` ON CONFLICT(${c}) DO UPDATE SET ${keys.filter(k => k !== c && k !== 'id' && k !== 'created_at').map(k => `${k} = excluded.${k}`).join(', ')}`
        : ` ON CONFLICT(${c}) DO NOTHING`;
      await D.prepare(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})${tail}`).bind(...vals).run();
    },
    async update(t, query, patch) {
      const q = parse(query);
      const keys = Object.keys(patch).map(ident);
      await D.prepare(`UPDATE ${table(t)} SET ${keys.map(k => `${k} = ?`).join(', ')}${q.where}`)
        .bind(...keys.map(k => toDb(k, patch[k])), ...q.args).run();
    }
  };
}

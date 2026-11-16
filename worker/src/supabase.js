// Minimal Supabase REST (PostgREST) client using the service-role key.
// The key lives only in the worker as a secret; the browser never sees it.

export function db(env) {
  const base = env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/';
  const h = (extra = {}) => ({
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json',
    ...extra
  });
  const check = async (r) => {
    if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
    return r;
  };
  return {
    async select(table, query) {
      const r = await check(await fetch(base + table + '?' + query, { headers: h() }));
      return r.json();
    },
    async count(table, query) {
      const r = await check(await fetch(base + table + '?select=*' + (query ? '&' + query : ''), {
        method: 'HEAD', headers: h({ Prefer: 'count=exact' })
      }));
      const range = r.headers.get('content-range') || '*/0';
      return Number(range.split('/')[1]) || 0;
    },
    async insert(table, row) {
      await check(await fetch(base + table, { method: 'POST', headers: h({ Prefer: 'return=minimal' }), body: JSON.stringify(row) }));
    },
    async upsert(table, row, onConflict) {
      await check(await fetch(base + table + '?on_conflict=' + onConflict, {
        method: 'POST', headers: h({ Prefer: 'resolution=ignore-duplicates,return=minimal' }), body: JSON.stringify(row)
      }));
    },
    async update(table, query, patch) {
      await check(await fetch(base + table + '?' + query, { method: 'PATCH', headers: h({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) }));
    }
  };
}

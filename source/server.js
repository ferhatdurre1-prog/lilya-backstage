/* Lilya Backstage — Cloudflare Worker
   Gerekli bağlamalar: D1 veritabanı "DB"
   Gizli değişkenler: APP_PASSWORD, TRENDYOL_SELLER_ID, TRENDYOL_API_KEY, TRENDYOL_API_SECRET
   Zamanlayıcı (Cron): "* * * * *"  → her dakika içinde 10 saniye arayla 6 eşitleme */

const APP_VERSION = '1.0.0';
const TY_BASE = 'https://apigw.trendyol.com/integration/';
let READY = false;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS products(key TEXT PRIMARY KEY, sku TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', barcode TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', channels TEXT NOT NULL DEFAULT '[]', qty INTEGER NOT NULL DEFAULT 0, cost REAL, min INTEGER NOT NULL DEFAULT 5, created_at TEXT, updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS products_barcode ON products(barcode)`,
  `CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, channel TEXT, order_no TEXT, date TEXT, status TEXT, source TEXT, baseline INTEGER NOT NULL DEFAULT 0, lines TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS orders_date ON orders(date)`,
  `CREATE TABLE IF NOT EXISTS returns(id TEXT PRIMARY KEY, channel TEXT, order_no TEXT, order_id TEXT, line_key TEXT, pkey TEXT, sku TEXT, name TEXT, qty INTEGER, status TEXT, source TEXT, note TEXT, ext_status TEXT, created_at TEXT, decided_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS returns_created ON returns(created_at)`,
  `CREATE TABLE IF NOT EXISTS moves(id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, pkey TEXT, sku TEXT, name TEXT, delta INTEGER, after INTEGER, type TEXT, channel TEXT, ref TEXT, note TEXT)`,
  `CREATE INDEX IF NOT EXISTS moves_pkey ON moves(pkey)`,
  `CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS guard(x INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_pkg(pkg_id TEXT PRIMARY KEY, order_no TEXT, day TEXT, units INTEGER, revenue REAL, paid REAL, status TEXT, seen_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS audit_pkg_day ON audit_pkg(day)`,
  `CREATE TABLE IF NOT EXISTS order_fin(order_no TEXT PRIMARY KEY, revenue REAL, commission REAL, net REAL, cargo REAL, service REAL, updated_at TEXT)`,
  `INSERT OR IGNORE INTO settings(k,v) VALUES('rev','1'),('lock_sync','0'),('auto_accept','1'),('fee_cargo_ty','46.49'),('fee_cargo_t1','46.49'),('fee_cargo_t2','84.49'),('fee_cargo_t3','98.35'),('cargo_desi_mode','0'),('desi_table','[]'),('fee_service_ty','13.19'),('fee_cargo_sh','0'),('stopaj','1')`
];

/* ---------- küçük yardımcılar ---------- */
const iso = (ms) => new Date(ms ?? Date.now()).toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const bad = (msg, status = 400) => json({ error: msg }, status);
function numOrNull(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function intOr(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d; }
function skuKey(sku) {
  const s = String(sku ?? '').trim().toUpperCase();
  let o = 'p-';
  for (const c of s) o += /[A-Za-z0-9_\-.:@+]/.test(c) ? c : '~' + c.codePointAt(0).toString(16) + '~';
  return o.slice(0, 180);
}
function safeSeg(s) { let o = ''; for (const c of String(s)) o += /[A-Za-z0-9_\-.:@+]/.test(c) ? c : '~' + c.codePointAt(0).toString(16); return o.slice(0, 170) || 'x'; }
const orderId = (channel, no) => 'o-' + channel + '-' + safeSeg(String(no).trim());
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

async function init(env) {
  if (READY) return;
  if (!env.DB) throw new Error('D1 veritabanı bağlanmamış (DB).');
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  await env.DB.prepare(`INSERT OR IGNORE INTO settings(k,v) VALUES('started_at',?1)`).bind(iso()).run();
  try { await env.DB.prepare('ALTER TABLE products ADD COLUMN ty_qty INTEGER').run(); } catch (e) { /* sütun zaten var */ }
  let priceCol = false;
  try { await env.DB.prepare('ALTER TABLE products ADD COLUMN ty_price REAL').run(); priceCol = true; } catch (e) {}
  for (const c of ['ty_comm REAL', 'ty_vat REAL', 'desi REAL', 'same_day INTEGER']) { try { await env.DB.prepare('ALTER TABLE products ADD COLUMN ' + c).run(); } catch (e) {} }
  if (priceCol && await env.DB.prepare(`SELECT 1 FROM settings WHERE k='ty_prod_done' AND v<>''`).first()) await env.DB.batch([setStmt(env, 'ty_prod_page', 0), setStmt(env, 'ty_prod_done', '1970-01-01T00:00:00.000Z')]);
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_tydate'`).first())) {
    const sh = await env.DB.prepare(`SELECT v FROM settings WHERE k='ty_shift'`).first();
    const already = sh && Number(sh.v) >= 3 * 3600000;
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_tydate','1')`),
        ...(already ? [] : [env.DB.prepare(`UPDATE orders SET date=strftime('%Y-%m-%dT%H:%M:%fZ', date, '-3 hours') WHERE channel='trendyol' AND date IS NOT NULL AND date<>''`)]),
        REV(env)]);
    } catch (e) { /* başka bir kopya zaten çalıştırdı */ }
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_tydate_fix'`).first())) {
    try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_tydate_fix','1')`), setStmt(env, 'fin_backfill_day', '13')]); } catch (e) {}
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_rescan2'`).first())) {
    try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_rescan2','1')`), setStmt(env, 'fin_backfill_day', '13')]); } catch (e) {}
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_audit1'`).first())) {
    try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_audit1','1')`), setStmt(env, 'fin_backfill_day', '13'), setStmt(env, 'audit_state', 'running'), setStmt(env, 'audit_started', iso())]); } catch (e) {}
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_gross1'`).first())) {
    try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_gross1','1')`), setStmt(env, 'fin_backfill_day', '13'), setStmt(env, 'audit_state', 'running'), setStmt(env, 'audit_started', iso())]); } catch (e) {}
  }
  try { await env.DB.prepare('ALTER TABLE order_fin ADD COLUMN ret_cargo REAL').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE returns ADD COLUMN ext_at TEXT').run(); } catch (e) {}
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS order_cust(order_no TEXT PRIMARY KEY, channel TEXT, data TEXT, updated_at TEXT)').run();
  try { await env.DB.prepare('ALTER TABLE order_cust ADD COLUMN sname TEXT').run(); } catch (e) {}
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS ad_spend(day TEXT, channel TEXT, amount REAL, source TEXT, updated_at TEXT, PRIMARY KEY(day, channel))').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS fin_misc(id TEXT PRIMARY KEY, order_no TEXT, date TEXT, type TEXT, amount REAL, descr TEXT)').run();
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_misc1'`).first())) {
    // Kesinti faturalarının hepsi (ceza vb.) okunsun diye 15 günlük pencere yeniden taranır
    try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_misc1','1')`), env.DB.prepare('UPDATE order_fin SET cargo=NULL, ret_cargo=NULL'), setStmt(env, 'cargo_inv_done', '[]'), setStmt(env, 'fin_at', '')]); } catch (e) {}
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_retcargo1'`).first())) {
    // Kargo faturaları gidiş / iade olarak ayrı okunsun diye baştan okunur (Trendyol 15 günlük pencere: Ekim'in tamamı)
    try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_retcargo1','1')`), env.DB.prepare('UPDATE order_fin SET cargo=NULL, ret_cargo=NULL'), setStmt(env, 'cargo_inv_done', '[]'), setStmt(env, 'fin_at', ''), REV(env)]); } catch (e) {}
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_fintype1'`).first())) {
    try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_fintype1','1')`), env.DB.prepare('UPDATE order_fin SET cargo=NULL, ret_cargo=NULL'), setStmt(env, 'cargo_inv_done', '[]'), setStmt(env, 'fin_at', '')]); } catch (e) {}
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_und1'`).first())) {
    try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_und1','1')`), setStmt(env, 'fin_backfill_day', '13')]); } catch (e) {}
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_cust1'`).first())) {
    // Eski siparişlerin alıcı/fatura bilgileri için son 13 gün yeniden taranır
    try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_cust1','1')`), setStmt(env, 'fin_backfill_day', '13')]); } catch (e) {}
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_svc1'`).first())) {
    try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_svc1','1')`), setStmt(env, 'fin_at', '')]); } catch (e) {}
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_barem2'`).first())) {
    // Trendyol kargo faturasındaki gerçek barem tutarları: 46,49 / 84,49 (KDV dahil)
    try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_barem2','1')`), env.DB.prepare(`UPDATE settings SET v='46.49' WHERE k IN ('fee_cargo_t1','fee_cargo_ty') AND v IN ('46.48','46.5')`), env.DB.prepare(`UPDATE settings SET v='84.49' WHERE k='fee_cargo_t2' AND v IN ('84.50','84.5')`), REV(env)]); } catch (e) {}
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_carrier'`).first())) await env.DB.batch([setStmt(env, 'desi_tables', JSON.stringify(DEFAULT_DESI_TABLES)), setStmt(env, 'cargo_desi_mode', '1'), setStmt(env, 'mig_carrier', '1')]);
  READY = true;
}
async function getSetting(env, k) { const r = await env.DB.prepare('SELECT v FROM settings WHERE k=?1').bind(k).first(); return r ? r.v : null; }
async function getSettings(env, keys) { const out = {}; const { results } = await env.DB.prepare(`SELECT k,v FROM settings WHERE k IN (${keys.map((_, i) => '?' + (i + 1)).join(',')})`).bind(...keys).all(); for (const r of results) out[r.k] = r.v; return out; }
const setStmt = (env, k, v) => env.DB.prepare('INSERT INTO settings(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v WHERE settings.v IS NOT excluded.v').bind(k, String(v));
async function setSetting(env, k, v) { await setStmt(env, k, v).run(); }
const REV = (env) => env.DB.prepare(`UPDATE settings SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT) WHERE k='rev'`);
const guardStmt = (env, sql, ...b) => env.DB.prepare(`INSERT INTO guard(x) SELECT CASE WHEN ${sql} THEN 1 ELSE NULL END`).bind(...b);
const unguard = (env) => env.DB.prepare('DELETE FROM guard');
async function selectIn(env, sql, col, values, chunk = 80) {
  const out = [];
  for (let i = 0; i < values.length; i += chunk) {
    const part = values.slice(i, i + chunk);
    const { results } = await env.DB.prepare(`${sql} WHERE ${col} IN (${part.map((_, j) => '?' + (j + 1)).join(',')})`).bind(...part).all();
    out.push(...results);
  }
  return out;
}

/* ---------- stok ifadeleri (her biri tek atomik batch içinde kullanılır) ---------- */
function ensureProduct(env, key, c, channel) {
  const now = iso();
  const chs = Array.isArray(c.channels) ? c.channels : (channel && channel !== 'manuel' ? [channel] : []);
  const stmts = [env.DB.prepare(`INSERT INTO products(key,sku,name,barcode,image,channels,qty,cost,min,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,0,?7,?8,?9,?9)
    ON CONFLICT(key) DO UPDATE SET
      name=CASE WHEN (products.name='' OR products.name=products.sku) AND excluded.name<>'' THEN excluded.name ELSE products.name END,
      image=CASE WHEN products.image='' THEN excluded.image ELSE products.image END,
      barcode=CASE WHEN products.barcode='' THEN excluded.barcode ELSE products.barcode END,
      cost=COALESCE(products.cost, excluded.cost)`)
    .bind(key, String(c.sku || '').trim(), String(c.name || c.sku || '').trim(), String(c.barcode || '').trim(), String(c.image || ''), JSON.stringify(chs), numOrNull(c.cost), Number.isFinite(c.min) ? c.min : 5, now)];
  for (const x of chs) stmts.push(env.DB.prepare(`UPDATE products SET channels=json_insert(channels,'$[#]',?1) WHERE key=?2 AND NOT EXISTS(SELECT 1 FROM json_each(products.channels) WHERE value=?1)`).bind(x, key));
  return stmts;
}
function changeQty(env, key, d, m = {}) {
  const now = iso();
  return [
    env.DB.prepare('UPDATE products SET qty=qty+?1, updated_at=?2 WHERE key=?3').bind(d, now, key),
    env.DB.prepare(`INSERT INTO moves(t,pkey,sku,name,delta,after,type,channel,ref,note) SELECT ?1,key,sku,name,?2,qty,?3,?4,?5,?6 FROM products WHERE key=?7`).bind(now, d, m.type || 'in', m.channel || '', m.ref || '', m.note || '', key)
  ];
}
function setQty(env, key, n, m = {}) {
  const now = iso();
  return [
    env.DB.prepare(`INSERT INTO moves(t,pkey,sku,name,delta,after,type,channel,ref,note) SELECT ?1,key,sku,name,?2-qty,?2,?3,?4,?5,?6 FROM products WHERE key=?7 AND qty<>?2`).bind(now, n, m.type || 'count', m.channel || '', m.ref || '', m.note || '', key),
    env.DB.prepare('UPDATE products SET qty=?1, updated_at=?2 WHERE key=?3').bind(n, now, key)
  ];
}

/* ---------- sipariş işleme: kayıttaki durum ile gelen durum arasındaki fark stoğa yansır ---------- */
function orderStatus(lines) {
  if (!lines.length) return 'active';
  if (lines.every(l => l.status === 'cancelled')) return 'cancelled';
  if (lines.some(l => l.status === 'returned' || l.ret)) return 'returned';
  if (lines.some(l => l.status === 'cancelled')) return 'partial';
  return 'active';
}
async function barcodeMap(env, codes) {
  const m = new Map(); const list = [...new Set(codes.filter(Boolean))];
  if (!list.length) return m;
  for (const r of await selectIn(env, 'SELECT key, barcode FROM products', 'barcode', list)) m.set(r.barcode, r.key);
  return m;
}
function resolveLine(l, bmap) {
  const sku = String(l.sku ?? '').trim(), barcode = String(l.barcode ?? '').trim();
  if (sku) return { pkey: skuKey(sku), sku };
  if (barcode && bmap.has(barcode)) return { pkey: bmap.get(barcode), sku: null };
  if (barcode) return { pkey: skuKey(barcode), sku: barcode };
  return null;
}
/* orders: [{orderNo, date, lines:[{key, sku, barcode, name, image, qty, status:'active'|'cancelled'|'returned'}]}] */
function cleanFin(fin, price, qty) {
  const nn = (v) => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  if (fin && typeof fin === 'object' && Number.isFinite(Number(fin.revenue))) return { revenue: Number(fin.revenue), gross: nn(fin.gross), rate: nn(fin.rate), vat: nn(fin.vat), paid: nn(fin.paid), desi: nn(fin.desi), carrier: fin.carrier ? String(fin.carrier).slice(0, 60) : null, ...(fin.und ? { und: true } : {}), ...(fin.uns ? { uns: true } : {}), ...(fin.fast ? { fast: true } : {}) };
  const p = numOrNull(price);
  return p !== null && p >= 0 ? { revenue: Math.round(p * qty * 100) / 100, rate: null, vat: null } : null;
}
async function ingestOrders(env, channel, input, opts = {}) {
  const dry = !!opts.dry, source = opts.source || 'import';
  const start = opts.start !== undefined ? opts.start : await getSetting(env, 'started_at');
  const bmap = await barcodeMap(env, input.flatMap(o => (o.lines || []).filter(l => !String(l.sku || '').trim()).map(l => String(l.barcode || '').trim())));
  const merged = new Map();
  for (const o of input) {
    const no = String(o.orderNo ?? '').trim(); if (!no) continue;
    const m = merged.get(no) || { orderNo: no, date: null, lines: new Map() }; merged.set(no, m);
    if (o.date && (!m.date || o.date < m.date)) m.date = o.date;
    for (const l of (o.lines || [])) {
      const r = resolveLine(l, bmap); const qty = intOr(l.qty, 0);
      if (!r || qty <= 0) continue;
      const key = String(l.key || ('|' + r.pkey));
      m.lines.set(key, { key, pkey: r.pkey, sku: r.sku || String(l.sku || l.barcode || '').trim(), name: String(l.name || '').trim(), image: String(l.image || ''), barcode: String(l.barcode || '').trim(), qty, status: ['cancelled', 'returned'].includes(l.status) ? l.status : 'active', fin: cleanFin(l.fin, l.price, qty) });
    }
  }
  const orders = [...merged.values()].filter(o => o.lines.size);
  const ids = orders.map(o => orderId(channel, o.orderNo));
  const existing = new Map((await selectIn(env, 'SELECT * FROM orders', 'id', ids)).map(r => [r.id, r]));
  const pkeys = [...new Set(orders.flatMap(o => [...o.lines.values()].map(l => l.pkey)))];
  const known = new Map((await selectIn(env, 'SELECT key, sku, name, channels FROM products', 'key', pkeys)).map(r => [r.key, { ...r, channels: JSON.parse(r.channels || '[]') }]));
  const stats = { orders: orders.length, created: 0, changed: 0, same: 0, baseline: 0, sold: 0, restored: 0, newReturns: 0, newProducts: 0, failed: 0, recon: [] };
  const newSet = new Set();

  const compute = (o, ex) => {
    const id = orderId(channel, o.orderNo);
    const isNew = !ex, baseline = isNew && !!start && !!o.date && o.date < start;
    const prevLines = new Map((ex ? JSON.parse(ex.lines || '[]') : []).map(l => [l.key, l]));
    const stmts = [], s = { sold: 0, restored: 0, newReturns: 0 };
    let changed = isNew || (!!ex && !!o.date && ex.date !== o.date); const ensured = new Set();
    const pkOf = (k) => String(k).split('|')[0];
    const prevActivePk = new Set([...prevLines.values()].filter(l => l.status !== 'cancelled' && (Number(l.applied) || 0) > 0 && pkOf(l.key)).map(l => pkOf(l.key)));
    const inPk = new Set([...o.lines.values()].map(l => pkOf(l.key)).filter(Boolean));
    const suspect = !isNew && [...inPk].some(p => !prevActivePk.has(p)) && [...prevActivePk].some(p => !inPk.has(p));
    for (const fl of o.lines.values()) {
      const prev = prevLines.get(fl.key);
      const desired = fl.status === 'cancelled' ? 0 : fl.qty;
      const applied0 = prev ? (Number(prev.applied) || 0) : (baseline ? desired : 0);
      const d = applied0 - desired;
      const kp = known.get(fl.pkey);
      if (!kp) newSet.add(fl.pkey);
      if (!ensured.has(fl.pkey) && (!kp || (channel !== 'manuel' && !kp.channels.includes(channel)) || d)) { stmts.push(...ensureProduct(env, fl.pkey, { sku: fl.sku, name: fl.name, image: fl.image, barcode: fl.barcode }, channel)); ensured.add(fl.pkey); }
      if (d) {
        const type = d < 0 ? (prev ? 'adjust' : 'sale') : (fl.status === 'cancelled' ? 'cancel' : 'adjust');
        stmts.push(...changeQty(env, fl.pkey, d, { type, channel, ref: o.orderNo }));
        if (d < 0) s.sold += -d; else s.restored += d;
      }
      const line = { key: fl.key, pkey: fl.pkey, sku: fl.sku, name: fl.name || (prev && prev.name) || (kp && kp.name) || fl.sku, qty: fl.qty, status: fl.status, applied: desired, ret: !!(prev && prev.ret), fin: fl.fin ? (prev && prev.fin && prev.fin.und && !fl.fin.und ? { ...fl.fin, und: true } : fl.fin) : ((prev && prev.fin) || null) };
      if (fl.status === 'returned' && !line.ret) {
        line.ret = true; s.newReturns++;
        const rid = 'r-' + safeSeg(id + '~' + fl.key).slice(0, 180);
        stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO returns(id,channel,order_no,order_id,line_key,pkey,sku,name,qty,status,source,note,ext_status,created_at,decided_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'requested',?10,?11,'',?12,NULL)`)
          .bind(rid, channel, o.orderNo, id, fl.key, fl.pkey, fl.sku, line.name, fl.qty, source, 'Pazaryerinde iade olarak işaretlendi', iso()));
      }
      if (!prev || prev.qty !== line.qty || prev.status !== line.status || prev.applied !== line.applied || !!prev.ret !== line.ret || JSON.stringify(prev.fin || null) !== JSON.stringify(line.fin)) changed = true;
      prevLines.set(fl.key, line);
    }
    if (!changed) return { changed: false, isNew, baseline, s, suspect };
    const lines = [...prevLines.values()];
    const date = o.date || (ex && ex.date) || iso();
    const now = iso();
    const all = [guardStmt(env, `COALESCE((SELECT version FROM orders WHERE id=?1),0)=?2`, id, ex ? ex.version : 0), ...stmts,
      env.DB.prepare(`INSERT INTO orders(id,channel,order_no,date,status,source,baseline,lines,version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,?9,?9)
        ON CONFLICT(id) DO UPDATE SET date=excluded.date, status=excluded.status, lines=excluded.lines, version=orders.version+1, updated_at=excluded.updated_at`)
        .bind(id, channel, o.orderNo, date, orderStatus(lines), ex ? (ex.source || source) : source, (ex ? ex.baseline : baseline) ? 1 : 0, JSON.stringify(lines), now),
      unguard(env), REV(env)];
    return { changed: true, isNew, baseline, s, stmts: all, suspect };
  };

  for (const o of orders) {
    const id = orderId(channel, o.orderNo);
    let ex = existing.get(id), r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = compute(o, ex);
      if (!r.changed || dry) break;
      try { await env.DB.batch(r.stmts); break; }
      catch (e) {
        if (attempt === 2) { stats.failed++; r = null; break; }
        await sleep(150 + Math.random() * 300);
        ex = await env.DB.prepare('SELECT * FROM orders WHERE id=?1').bind(id).first() || undefined;
      }
    }
    if (!r) continue;
    if (r.suspect && !dry) stats.recon.push(o.orderNo);
    if (r.baseline) stats.baseline++;
    if (r.isNew) stats.created++; else if (r.changed) stats.changed++; else stats.same++;
    stats.sold += r.s.sold; stats.restored += r.s.restored; stats.newReturns += r.s.newReturns;
  }
  stats.newProducts = newSet.size;
  return stats;
}

/* ---------- ürün işleme ---------- */
async function ingestProducts(env, channel, items, opts = {}) {
  const dry = !!opts.dry;
  const bmap = await barcodeMap(env, items.filter(x => !String(x.sku || '').trim()).map(x => String(x.barcode || '').trim()));
  const uniq = new Map();
  for (const it of items) { const r = resolveLine(it, bmap); if (!r) continue; if (!uniq.has(r.pkey)) uniq.set(r.pkey, { ...it, pkey: r.pkey, sku: r.sku || String(it.sku || it.barcode).trim() }); }
  const list = [...uniq.values()];
  const existing = new Map((await selectIn(env, 'SELECT key, sku, name, image, barcode, channels, qty, cost FROM products', 'key', list.map(x => x.pkey))).map(r => [r.key, { ...r, channels: JSON.parse(r.channels || '[]') }]));
  const st = { created: 0, updated: 0, unchanged: 0, setQty: 0, units: 0 };
  let batch = [];
  const flush = async () => { if (!batch.length || dry) { batch = []; return; } batch.push(REV(env)); await env.DB.batch(batch); batch = []; };
  for (const it of list) {
    const ex = existing.get(it.pkey);
    const c = { sku: it.sku, name: it.name, image: /^https?:\/\//.test(it.image || '') ? it.image : '', barcode: it.barcode, cost: numOrNull(it.cost), min: Number.isFinite(it.min) ? it.min : undefined };
    const stock = Number.isFinite(Number(it.stock)) && it.stock !== null && it.stock !== '' ? Math.round(Number(it.stock)) : null;
    if (!ex) {
      batch.push(...ensureProduct(env, it.pkey, c, channel)); st.created++;
      if (opts.useStock && stock > 0) { batch.push(...changeQty(env, it.pkey, stock, { type: 'initial', channel })); st.units += stock; }
    } else {
      const needs = (c.name && (!ex.name || ex.name === ex.sku)) || (c.image && !ex.image) || (c.barcode && !ex.barcode) || (channel !== 'manuel' && !ex.channels.includes(channel)) || (ex.cost === null && c.cost !== null);
      if (needs) batch.push(...ensureProduct(env, it.pkey, c, channel));
      if (opts.overwrite && stock !== null && stock !== ex.qty) { batch.push(...setQty(env, it.pkey, stock, { type: 'count', channel, note: opts.note || 'Yedekten aktarım' })); st.setQty++; }
      else if (needs) st.updated++; else st.unchanged++;
    }
    if (opts.tyQty && stock !== null && it.barcode) batch.push(env.DB.prepare('UPDATE products SET ty_qty=?1 WHERE key=?2').bind(stock, it.pkey));
    if (opts.tyQty && (it.price !== undefined || it.comm !== undefined)) batch.push(env.DB.prepare('UPDATE products SET ty_price=COALESCE(?1,ty_price), ty_comm=COALESCE(?2,ty_comm), ty_vat=COALESCE(?3,ty_vat) WHERE key=?4').bind(numOrNull(it.price), numOrNull(it.comm), numOrNull(it.vat), it.pkey));
    if (batch.length > 60) await flush();
  }
  await flush();
  return st;
}

/* ---------- Trendyol ---------- */
function tyHeaders(env) {
  return { Authorization: 'Basic ' + btoa(`${env.TRENDYOL_API_KEY}:${env.TRENDYOL_API_SECRET}`), 'User-Agent': `${env.TRENDYOL_SELLER_ID} - SelfIntegration`, Accept: 'application/json' };
}
async function ty(env, path, params) {
  const url = new URL(TY_BASE + path);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url.toString(), { headers: tyHeaders(env) });
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    if (!r.ok) {
      const body = (await r.text()).slice(0, 240);
      const e = new Error(r.status === 401 ? 'Trendyol API anahtarı veya Satıcı ID hatalı (401).' : r.status === 403 ? `Trendyol isteği reddetti (403). ${body}` : `Trendyol ${r.status}: ${body}`);
      e.status = r.status; throw e;
    }
    return r.json();
  }
  const e = new Error('Trendyol çok fazla istek uyarısı verdi (429). Biraz sonra tekrar denenecek.'); e.status = 429; throw e;
}
const TY_ORDER_DATE_SHIFT = 3 * 3600000;
const trDay = (ms) => new Date(ms + TY_TZ).toISOString().slice(0, 10); // Türkiye takvim günü
// Sipariş teslimatı ve fatura kesimi için gereken alıcı bilgileri (sözleşme EK-4: yalnızca sözleşmesel yükümlülük amacıyla;
// e-posta / telefon / T.C. kimlik no saklanmaz, pazarlama için kullanılmaz)
async function recordCustomers(env, pkgs) {
  const st = [], now = iso(), byNo = new Map();
  for (const p of pkgs) {
    const ia = p.invoiceAddress || {}, sa = p.shipmentAddress || {};
    const t = (v) => String(v || '').trim().slice(0, 300);
    const d = { name: t([p.customerFirstName, p.customerLastName].filter(Boolean).join(' ')) || t(sa.fullName),
      ship: { fullName: t(sa.fullName), address: t(sa.fullAddress || [sa.address1, sa.address2].filter(Boolean).join(' ')), district: t(sa.district), city: t(sa.city) },
      inv: { fullName: t(ia.fullName), company: t(ia.company), address: t(ia.fullAddress || [ia.address1, ia.address2].filter(Boolean).join(' ')), district: t(ia.district), city: t(ia.city), postalCode: t(ia.postalCode), taxOffice: t(ia.taxOffice), taxNumber: t(ia.taxNumber) },
      commercial: !!p.commercial };
    if (!d.name && !d.inv.fullName && !d.ship.fullName) continue;
    byNo.set(String(p.orderNumber), d);
  }
  for (const [no, d] of byNo) { const sn = [d.name, d.inv.fullName, d.inv.company].filter(Boolean).join(' ').toLocaleLowerCase('tr-TR');
    st.push(env.DB.prepare(`INSERT INTO order_cust(order_no,channel,data,updated_at,sname) VALUES(?1,'trendyol',?2,?3,?4) ON CONFLICT(order_no) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, sname=excluded.sname WHERE order_cust.data IS NOT excluded.data OR order_cust.sname IS NOT excluded.sname`).bind(no, JSON.stringify(d), now, sn)); }
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
}
async function recordAuditPkgs(env, pkgs) {
  const now = iso(), st = [];
  for (const p of pkgs) {
    const status = p.shipmentPackageStatus || p.status || '';
    const cancelledPkg = TY_CANCELLED.has(status);
    let units = 0, revenue = 0, paid = 0;
    for (const l of (p.lines || [])) {
      if (cancelledPkg || /cancel|iptal/i.test(String(l.orderLineItemStatusName || ''))) continue;
      units += Number(l.quantity) || 0; const f = tyLineFin(l); if (f) { revenue += f.revenue; paid += f.paid; }
    }
    const day = p.orderDate ? trDay(Number(p.orderDate) - TY_ORDER_DATE_SHIFT) : null;
    st.push(env.DB.prepare(`INSERT INTO audit_pkg(pkg_id,order_no,day,units,revenue,paid,status,seen_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
      ON CONFLICT(pkg_id) DO UPDATE SET order_no=excluded.order_no, day=excluded.day, units=excluded.units, revenue=excluded.revenue, paid=excluded.paid, status=excluded.status, seen_at=excluded.seen_at
      WHERE audit_pkg.order_no IS NOT excluded.order_no OR audit_pkg.day IS NOT excluded.day OR audit_pkg.units IS NOT excluded.units OR audit_pkg.revenue IS NOT excluded.revenue OR audit_pkg.paid IS NOT excluded.paid OR audit_pkg.status IS NOT excluded.status`)
      .bind(String(p.shipmentPackageId || p.id), String(p.orderNumber), day, units, Math.round(revenue * 100) / 100, Math.round(paid * 100) / 100, status, now));
  }
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
}
const TY_CANCELLED = new Set(['Cancelled', 'UnSupplied', 'UnPacked']);
function tyLineFin(l) {
  const q = Math.max(1, Number(l.quantity) || 1);
  const gross = Number(l.lineGrossAmount), unit = Number(l.lineUnitPrice), sd = Number(l.lineSellerDiscount) || 0;
  if (!Number.isFinite(gross) && !Number.isFinite(unit)) return null;
  // lineGrossAmount satır toplamı mı birim mi belirsiz: birim fiyat × adetten küçükse birim kabul et
  const perUnit = Number.isFinite(gross) && Number.isFinite(unit) && q > 1 && gross < unit * q - 0.01;
  const grossTotal = Number.isFinite(gross) ? (perUnit ? gross * q : gross) : unit * q;
  const discTotal = perUnit ? sd * q : sd;
  const td = Number(l.lineTotalDiscount) || 0, tdTotal = perUnit ? td * q : td;
  return { gross: Math.round(grossTotal * 100) / 100, paid: Math.round((grossTotal - tdTotal) * 100) / 100, revenue: Math.round((grossTotal - discTotal) * 100) / 100, rate: Number.isFinite(Number(l.commission)) ? Number(l.commission) : null, vat: Number.isFinite(Number(l.vatRate)) ? Number(l.vatRate) : null };
}
function tyPackagesToOrders(pkgs, shift) {
  return pkgs.map(p => ({
    orderNo: String(p.orderNumber),
    date: p.orderDate ? iso(Number(p.orderDate) - TY_ORDER_DATE_SHIFT) : null,
    lines: (p.lines || []).map(l => ({
      key: `${p.shipmentPackageId || p.id}|${l.lineId ?? l.id ?? l.barcode}`,
      sku: l.stockCode || l.merchantSku || '', barcode: l.barcode || '', name: l.productName || '', qty: l.quantity,
      fin: Object.assign(tyLineFin(l) || {}, /sameday|bugun|bugün/i.test(String(p.fastDeliveryType || '')) ? { fast: true } : {}, { desi: Number(p.cargoDeci ?? p.deci ?? p.desi) > 0 ? Number(p.cargoDeci ?? p.deci ?? p.desi) : null, carrier: p.cargoProviderName || null }, /undeliver/i.test(String(p.shipmentPackageStatus || p.status || '')) ? { und: true } : {}, /unsupplied/i.test(String(p.shipmentPackageStatus || p.status || '')) ? { uns: true } : {}),
      status: (TY_CANCELLED.has(p.shipmentPackageStatus || p.status) || /cancel|iptal/i.test(String(l.orderLineItemStatusName || ''))) ? 'cancelled' : 'active'
    }))
  }));
}
async function fetchOrderPackages(env, start, end) {
  const sid = env.TRENDYOL_SELLER_ID;
  const mode = (await getSetting(env, 'ty_orders_mode')) || 'stream';
  if (mode === 'stream') {
    try {
      const out = []; let cursor = null;
      for (let page = 0; page < 8; page++) {
        if (page) await sleep(5100);
        const r = await ty(env, `order/sellers/${sid}/orders/stream`, { lastModifiedStartDate: start, lastModifiedEndDate: end, size: 200, nextCursor: cursor });
        out.push(...(r.content || []));
        if (!r.hasMore || !r.nextCursor) break;
        cursor = r.nextCursor;
      }
      return out;
    } catch (e) {
      if (e.status === 404 || e.status === 405) await setSetting(env, 'ty_orders_mode', 'v2');
      else throw e;
    }
  }
  const out = [];
  for (let page = 0; page < 10; page++) {
    const r = await ty(env, `order/sellers/${sid}/v2/orders`, { startDate: start, endDate: end, orderByField: 'PackageLastModifiedDate', orderByDirection: 'ASC', size: 200, page });
    out.push(...(r.content || []));
    if (page + 1 >= (r.totalPages || 0)) break;
  }
  return out;
}
const TY_TZ = 3 * 3600000;
function tyWindow(hwm, maxBackDays, now) {
  const end = now + TY_TZ + 10 * 60000;                       // Trendyol saatine göre "şimdi" + pay
  let start = hwm ? hwm - TY_TZ - 60 * 60000 : now - maxBackDays * 86400000; // 4 saat geriden başla
  if (end - start > 14 * 86400000 - 120000) start = end - 14 * 86400000 + 120000;
  return { start, end };
}
async function syncTrendyolOrders(env) {
  const now = Date.now();
  const s = await getSettings(env, ['ty_orders_hwm', 'ty_shift']);
  const hwm = Number(s.ty_orders_hwm) || 0;
  let { start, end } = tyWindow(hwm, 13, now);
  let pkgs;
  try { pkgs = await fetchOrderPackages(env, start, end); }
  catch (e) { if (e.status === 400) { end = now; pkgs = await fetchOrderPackages(env, start, end); } else throw e; }
  const latest = new Map();
  for (const p of pkgs) { const k = String(p.shipmentPackageId || p.id); const o = latest.get(k); if (!o || (p.lastModifiedDate || 0) >= (o.lastModifiedDate || 0)) latest.set(k, p); }
  const list = [...latest.values()];
  let maxMod = hwm;
  for (const p of list) if (p.lastModifiedDate && p.lastModifiedDate > maxMod) maxMod = p.lastModifiedDate;
  let shift = s.ty_shift !== null && s.ty_shift !== undefined ? Number(s.ty_shift) : null;
  if (list.length && shift === null) { shift = maxMod > now + 30 * 60000 ? 3 * 3600000 : 0; await setSetting(env, 'ty_shift', shift); }
  let stats = null;
  if (list.length) { stats = await ingestOrders(env, 'trendyol', tyPackagesToOrders(list, shift || 0), { source: 'trendyol' }); await recordAuditPkgs(env, list); try { await recordCustomers(env, list); } catch (e) {} }
  const desiSt = [];
  for (const p of list) { const d = Number(p.cargoDeci ?? p.deci ?? p.desi); const ls = p.lines || []; if (d > 0 && ls.length === 1 && ls[0].stockCode) desiSt.push(env.DB.prepare('UPDATE products SET desi=?1 WHERE key=?2 AND desi IS NOT ?1').bind(Math.round(d / Math.max(1, Number(ls[0].quantity) || 1) * 100) / 100, skuKey(ls[0].stockCode))); }
  for (let i = 0; i < desiSt.length; i += 90) await env.DB.batch(desiSt.slice(i, i + 90));
  await setSetting(env, 'ty_orders_hwm', String(list.length ? maxMod : (hwm || Math.min(end, now))));
  return { packages: list.length, stats };
}
async function backfillTrendyolOrders(env) {
  const v = await getSetting(env, 'fin_backfill_day');
  if (v === 'done') return null;
  const now = Date.now(), shift = Number(await getSetting(env, 'ty_shift')) || 0;
  let day = v === null ? 13 : Number(v);
  if (!(day > 0)) { await setSetting(env, 'fin_backfill_day', 'done'); return null; }
  const end = now + TY_TZ + 10 * 60000 - (day - 1) * 86400000, start = end - 86400000 - 3 * 3600000; // 27 saatlik, örtüşen günlük pencereler
  const pkgs = await fetchOrderPackages(env, start, end);
  const latest = new Map(); for (const p of pkgs) { const k = String(p.shipmentPackageId || p.id); const o = latest.get(k); if (!o || (p.lastModifiedDate || 0) >= (o.lastModifiedDate || 0)) latest.set(k, p); }
  const stats = latest.size ? await ingestOrders(env, 'trendyol', tyPackagesToOrders([...latest.values()], shift), { source: 'trendyol' }) : null;
  if (latest.size) { await recordAuditPkgs(env, [...latest.values()]); try { await recordCustomers(env, [...latest.values()]); } catch (e) {} }
  if (stats && stats.recon.length) await processReconQueue(env, stats.recon, 0);
  await setSetting(env, 'fin_backfill_day', day - 1 > 0 ? String(day - 1) : 'done');
  if (day - 1 <= 0 && (await getSetting(env, 'audit_state')) === 'running') await finishAudit(env);
  return { day, packages: latest.size, stats };
}
/* Trendyol bir paketi bozup yeni numarayla açtığında eski paket "aktif" kalabilir.
   Siparişi numarasıyla Trendyol'a sorup güncel paket listesinde olmayan eski paketleri kapatır (stok geri eklenir). */
async function fetchOrderByNumber(env, no, dateIso) {
  const sid = env.TRENDYOL_SELLER_ID, base = Date.parse(dateIso) || Date.now();
  const end = Math.min(base + TY_TZ + 12 * 86400000, Date.now() + TY_TZ + 10 * 60000), start = Math.max(end - 14 * 86400000 + 120000, base + TY_TZ - 2 * 86400000);
  for (const path of [`order/sellers/${sid}/v2/orders`, `order/sellers/${sid}/orders`]) {
    try { const r = await ty(env, path, { orderNumber: no, startDate: start, endDate: end, size: 50, page: 0 }); return r.content || []; }
    catch (e) { if (e.status !== 404 && e.status !== 405) throw e; }
  }
  return null;
}
async function reconcileTrendyolOrder(env, no) {
  const ord = await env.DB.prepare('SELECT * FROM orders WHERE id=?1').bind(orderId('trendyol', no)).first();
  if (!ord) {
    const a = await env.DB.prepare('SELECT day FROM audit_pkg WHERE order_no=?1 LIMIT 1').bind(String(no)).first();
    const pk = (await fetchOrderByNumber(env, no, a && a.day ? a.day + 'T12:00:00.000Z' : iso()) || []).filter(p => String(p.orderNumber) === String(no));
    if (!pk.length) return { no, skipped: true };
    await recordAuditPkgs(env, pk);
    const st = await ingestOrders(env, 'trendyol', tyPackagesToOrders(pk, 0), { source: 'trendyol' });
    return { no, added: true, sold: st.sold };
  }
  const pkgs = (await fetchOrderByNumber(env, no, ord.date) || []).filter(p => String(p.orderNumber) === String(no));
  if (pkgs.length) await recordAuditPkgs(env, pkgs);
  if (!pkgs.length) return { no, skipped: true };   // doğrulanamıyorsa dokunma
  const cur = new Set(pkgs.map(p => String(p.shipmentPackageId || p.id)));
  const conv = tyPackagesToOrders(pkgs, 0);
  const lines = conv.flatMap(o => o.lines);
  const stale = JSON.parse(ord.lines || '[]').filter(l => l.status !== 'cancelled' && String(l.key).split('|')[0] && !cur.has(String(l.key).split('|')[0]));
  for (const l of stale) lines.push({ key: l.key, sku: l.sku, name: l.name, qty: l.qty, status: 'cancelled', fin: l.fin });
  const st = await ingestOrders(env, 'trendyol', [{ orderNo: no, date: (conv[0] && conv[0].date) || ord.date, lines }], { source: 'trendyol' });
  return { no, stale: stale.length, restored: st.restored };
}
async function processReconQueue(env, add, max = 6) {
  let q = []; try { q = JSON.parse((await getSetting(env, 'recon_q')) || '[]'); } catch (e) {}
  for (const n of (add || [])) if (!q.includes(n)) q.push(n);
  const done = [];
  for (const no of q.slice(0, max)) { try { done.push(await reconcileTrendyolOrder(env, no)); } catch (e) { if (e.status === 429) break; done.push({ no, error: String(e.message || e).slice(0, 80) }); } }
  const rest = q.slice(done.length);
  await setSetting(env, 'recon_q', JSON.stringify(rest.slice(0, 500)));
  if (!rest.length && done.length && (await getSetting(env, 'audit_state')) === 'fixing') await setSetting(env, 'audit_state', 'done');
  return done.length ? done : null;
}
const AUDIT_FROM = '2026-10-01';
async function auditCompare(env, from) {
  from = from || AUDIT_FROM;
  const fromIso = new Date(Date.parse(from + 'T00:00:00.000Z') - TY_TZ).toISOString();
  const [a, o] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM audit_pkg WHERE day >= ?1').bind(from),
    env.DB.prepare(`SELECT order_no, date, lines FROM orders WHERE channel='trendyol' AND date >= ?1`).bind(fromIso)]);
  const ty = new Map(), bs = new Map();   // order_no → {day, units, revenue, paid, pkgs:Set}
  for (const r of a.results) { const x = ty.get(r.order_no) || { day: r.day, units: 0, revenue: 0, paid: 0, pkgs: new Set() }; x.units += r.units; x.revenue += r.revenue; x.paid += r.paid; if (r.units > 0) x.pkgs.add(r.pkg_id); ty.set(r.order_no, x); }
  for (const r of o.results) {
    const day = trDay(Date.parse(r.date)); if (day < from) continue;
    const x = { day, units: 0, revenue: 0, paid: 0, pkgs: new Set() };
    for (const l of JSON.parse(r.lines || '[]')) { if (l.status === 'cancelled' || !l.qty) continue; x.units += l.qty; if (l.fin) { x.revenue += Number(l.fin.revenue) || 0; x.paid += Number(l.fin.paid ?? l.fin.revenue) || 0; } x.pkgs.add(String(l.key).split('|')[0]); }
    bs.set(r.order_no, x);
  }
  const days = new Map(); const D = (d) => { let x = days.get(d); if (!x) { x = { day: d, tyOrders: 0, tyUnits: 0, tyRevenue: 0, tyPaid: 0, bsOrders: 0, bsUnits: 0, bsRevenue: 0, bsPaid: 0, diff: 0 }; days.set(d, x); } return x; };
  for (const [, x] of ty) if (x.units > 0) { const d = D(x.day); d.tyOrders++; d.tyUnits += x.units; d.tyRevenue += x.revenue; d.tyPaid += x.paid; }
  for (const [, x] of bs) if (x.units > 0) { const d = D(x.day); d.bsOrders++; d.bsUnits += x.units; d.bsRevenue += x.revenue; d.bsPaid += x.paid; }
  const mism = [];
  for (const no of new Set([...ty.keys(), ...bs.keys()])) {
    const t = ty.get(no) || { units: 0, revenue: 0, day: (bs.get(no) || {}).day }, b = bs.get(no) || { units: 0, revenue: 0, day: t.day };
    if (t.units !== b.units || Math.abs(t.revenue - b.revenue) > 0.05) { mism.push({ orderNo: no, day: t.day || b.day, tyUnits: t.units, bsUnits: b.units, tyRevenue: Math.round(t.revenue * 100) / 100, bsRevenue: Math.round(b.revenue * 100) / 100, reason: !b.units && t.units ? 'Backstage\'de eksik' : !t.units && b.units ? (ty.has(no) ? 'Trendyol\'da iptal' : 'Trendyol taramasında yok') : t.units !== b.units ? 'Adet farklı' : 'Tutar farklı' }); D(t.day || b.day).diff++; }
  }
  const R2 = (n) => Math.round(n * 100) / 100;
  const list = [...days.values()].map(d => ({ ...d, tyRevenue: R2(d.tyRevenue), tyPaid: R2(d.tyPaid), bsRevenue: R2(d.bsRevenue), bsPaid: R2(d.bsPaid) })).sort((x, y) => y.day.localeCompare(x.day));
  return { from, days: list, mismatches: mism.sort((x, y) => (y.day || '').localeCompare(x.day || '')).slice(0, 200), mismatchCount: mism.length };
}
async function finishAudit(env) {
  const c = await auditCompare(env);
  const nos = c.mismatches.filter(m => m.reason !== 'Trendyol taramasında yok' || m.bsUnits > 0).map(m => m.orderNo);
  await processReconQueue(env, nos, 0);
  await env.DB.batch([setStmt(env, 'audit_state', 'fixing'), setStmt(env, 'audit_at', iso()), setStmt(env, 'audit_found', String(c.mismatchCount))]);
}
async function queueSuspectOrders(env) {
  // tek seferlik tarama: son 14 günde birden fazla aktif paketi olan Trendyol siparişleri
  const since = iso(Date.now() - 14 * 86400000);
  const { results } = await env.DB.prepare(`SELECT order_no, lines FROM orders WHERE channel='trendyol' AND date >= ?1`).bind(since).all();
  const out = [];
  for (const r of results) { const pk = new Set(JSON.parse(r.lines || '[]').filter(l => l.status !== 'cancelled' && (Number(l.applied) || 0) > 0).map(l => String(l.key).split('|')[0]).filter(Boolean)); if (pk.size > 1) out.push(r.order_no); }
  return out;
}
const CLAIM_OPEN = new Set(['Created', 'WaitingInAction', 'WaitingFraudCheck', 'InAnalysis', 'Unresolved']);
async function syncTrendyolClaims(env) {
  const sid = env.TRENDYOL_SELLER_ID, now = Date.now();
  const s = await getSettings(env, ['ty_claims_hwm', 'auto_accept', 'started_at', 'ty_shift']);
  const hwm = Number(s.ty_claims_hwm) || 0, auto = s.auto_accept !== '0', shift = Number(s.ty_shift) || 0;
  const { start, end } = tyWindow(hwm, 13, now);
  const claims = []; let maxMod = hwm;
  for (let page = 0; page < 10; page++) {
    let r;
    try { r = await ty(env, `order/sellers/${sid}/claims`, { startDate: start, endDate: end, size: 200, page }); }
    catch (e) { if (e.status === 400 && page === 0) r = await ty(env, `order/sellers/${sid}/claims`, { startDate: start, endDate: now, size: 200, page }); else throw e; }
    claims.push(...(r.content || []));
    if (page + 1 >= (r.totalPages || 0)) break;
  }
  const items = [];
  for (const c of claims) {
    if (c.lastModifiedDate && c.lastModifiedDate > maxMod) maxMod = c.lastModifiedDate;
    for (const it of (c.items || [])) {
      const ol = it.orderLine || {};
      for (const ci of (it.claimItems || [])) {
        const stName = (ci.claimItemStatus && ci.claimItemStatus.name) || '';
        const mapped = stName === 'Accepted' ? 'accepted' : (stName === 'Rejected' || stName === 'Cancelled') ? 'rejected' : 'requested';
        items.push({ id: 'ty-' + safeSeg(String(ci.id)), orderNo: String(c.orderNumber || ''), sku: ol.merchantSku || '', barcode: ol.barcode || '', name: ol.productName || '', ext: stName, mapped, autoAcc: ci.autoAccepted === true, claimDate: c.claimDate ? iso(Number(c.claimDate)) : iso(), note: (ci.customerClaimItemReason && ci.customerClaimItemReason.name) || (ci.trendyolClaimItemReason && ci.trendyolClaimItemReason.name) || '' });
      }
    }
  }
  let added = 0, accepted = 0;
  if (items.length) {
    const bmap = await barcodeMap(env, items.filter(x => !x.sku).map(x => x.barcode));
    const existing = new Map((await selectIn(env, 'SELECT id, status, ext_status FROM returns', 'id', items.map(x => x.id))).map(r => [r.id, r]));
    for (const it of items) {
      const r = resolveLine(it, bmap); if (!r) continue;
      const sku = r.sku || it.sku || it.barcode;
      const ex = existing.get(it.id); const now2 = iso();
      const preStart = s.started_at && it.claimDate < s.started_at;
      const stmts = [];
      try {
        if (!ex) {
          // Trendyol iadeyi kendiliğinden onayladıysa (ör. 8 iş günü dolduğu için) ürün depoya ulaşmamış olabilir: stok elle onaylanır
          const finalStatus = it.mapped === 'accepted' ? (preStart || (auto && !it.autoAcc) ? 'accepted' : 'requested') : it.mapped;
          if (finalStatus === 'requested' && it.mapped === 'accepted' && it.autoAcc) it.note = AUTO_ACC_NOTE + (it.note ? ' · ' + it.note : '');
          stmts.push(...ensureProduct(env, r.pkey, { sku, name: it.name, barcode: it.barcode }, 'trendyol'));
          stmts.push(env.DB.prepare(`INSERT INTO returns(id,channel,order_no,order_id,line_key,pkey,sku,name,qty,status,source,note,ext_status,created_at,decided_at,ext_at) VALUES(?1,'trendyol',?2,?3,'',?4,?5,?6,1,?7,'trendyol',?8,?9,?10,?11,?12)`)
            .bind(it.id, it.orderNo, orderId('trendyol', it.orderNo), r.pkey, sku, it.name, finalStatus, preStart && finalStatus === 'accepted' ? 'Başlangıç öncesi; stok değişmedi' : it.note, it.ext, it.claimDate, finalStatus !== 'requested' ? now2 : null, now2));
          if (finalStatus === 'accepted' && !preStart) { stmts.push(...changeQty(env, r.pkey, 1, { type: 'ret', channel: 'trendyol', ref: it.orderNo, note: 'Trendyol iadesi kabul edildi' })); accepted++; }
          stmts.push(REV(env)); await env.DB.batch(stmts); added++;
        } else if (ex.status === 'requested' && (it.mapped !== 'requested' || ex.ext_status !== it.ext)) {
          if (it.mapped === 'accepted' && auto && !it.autoAcc) {
            stmts.push(guardStmt(env, `(SELECT status FROM returns WHERE id=?1)='requested'`, it.id),
              env.DB.prepare(`UPDATE returns SET status='accepted', ext_status=?2, decided_at=?3, ext_at=?3 WHERE id=?1`).bind(it.id, it.ext, now2),
              ...changeQty(env, r.pkey, 1, { type: 'ret', channel: 'trendyol', ref: it.orderNo, note: 'Trendyol iadesi kabul edildi' }), unguard(env), REV(env));
            accepted++;
          } else if (it.mapped === 'rejected') {
            stmts.push(env.DB.prepare(`UPDATE returns SET status='rejected', ext_status=?2, decided_at=?3 WHERE id=?1 AND status='requested'`).bind(it.id, it.ext, now2), REV(env));
          } else if (ex.ext_status !== it.ext) {
            const addNote = it.mapped === 'accepted' && it.autoAcc;
            stmts.push(env.DB.prepare(`UPDATE returns SET ext_status=?2, ext_at=?3${addNote ? ", note=CASE WHEN note LIKE 'Trendyol otomatik%' THEN note ELSE ?4 || CASE WHEN note<>'' THEN ' · ' || note ELSE '' END END" : ''} WHERE id=?1`).bind(...(addNote ? [it.id, it.ext, now2, AUTO_ACC_NOTE] : [it.id, it.ext, now2])), REV(env));
          }
          if (stmts.length) await env.DB.batch(stmts);
        }
      } catch (e) { /* yarış durumunda bir sonraki turda yeniden denenir */ }
    }
  }
  await setSetting(env, 'ty_claims_hwm', String(claims.length ? maxMod : (hwm || Math.min(end, now))));
  return { claims: claims.length, added, accepted };
}
async function syncTrendyolProducts(env, maxPages = 4) {
  const sid = env.TRENDYOL_SELLER_ID;
  const s = await getSettings(env, ['ty_prod_page', 'ty_prod_done', 'ty_prod_initial']);
  const done = s.ty_prod_done ? Date.parse(s.ty_prod_done) : 0;
  let page = Number(s.ty_prod_page) || 0;
  if (page === 0 && done && Date.now() - done < 6 * 3600000) return null;
  const useStock = s.ty_prod_initial !== '0';
  let total = 0, stats = { created: 0, updated: 0 };
  for (let i = 0; i < maxPages; i++) {
    const r = await ty(env, `product/sellers/${sid}/products/approved`, { page, size: 100 });
    const items = [];
    for (const c of (r.content || [])) {
      const img = (c.images && c.images[0] && c.images[0].url) || '';
      for (const v of (c.variants || [])) {
        const attrs = (v.attributes || []).map(a => a.attributeValue).filter(Boolean).join(' / ');
        items.push({ sku: v.stockCode || '', barcode: v.barcode || '', name: (c.title || '') + (attrs && (c.variants || []).length > 1 ? ' · ' + attrs : ''), image: img, stock: v.stock && Number.isFinite(v.stock.quantity) ? v.stock.quantity : null, price: v.price && Number.isFinite(Number(v.price.salePrice)) ? Number(v.price.salePrice) : null, comm: Number.isFinite(Number(v.commission)) ? Number(v.commission) : null, vat: Number.isFinite(Number(v.vatRate)) ? Number(v.vatRate) : null });
      }
    }
    if (items.length) { const st = await ingestProducts(env, 'trendyol', items, { useStock, tyQty: true }); stats.created += st.created; stats.updated += st.updated; }
    total += items.length;
    const pages = r.totalPages || 0;
    if (!r.content || !r.content.length || page + 1 >= pages) { page = 0; await env.DB.batch([setStmt(env, 'ty_prod_page', 0), setStmt(env, 'ty_prod_done', iso())]); return { variants: total, ...stats, finished: true }; }
    page++;
    await setSetting(env, 'ty_prod_page', page);
  }
  return { variants: total, ...stats, finished: false };
}
/* Ortak stok → Trendyol. Yalnızca değişen ürünler gönderilir (aynı istek 15 dk tekrarlanamaz). */
const TY_PUSH_SQL = `SELECT key, barcode, qty, ty_qty FROM products WHERE barcode<>'' AND EXISTS(SELECT 1 FROM json_each(products.channels) WHERE value='trendyol') AND (ty_qty IS NULL OR (ty_qty <> MIN(MAX(qty,0),20000) AND ty_qty <> -(MIN(MAX(qty,0),20000)+2))) LIMIT 1000`;
async function pushTrendyolStock(env) {
  if ((await getSetting(env, 'ty_push')) === '0') return null;
  const { results } = await env.DB.prepare(TY_PUSH_SQL).all();
  if (!results.length) return { sent: 0 };
  const items = results.map(r => ({ barcode: r.barcode, quantity: Math.min(Math.max(r.qty, 0), 20000) }));
  const url = `${TY_BASE}inventory/sellers/${env.TRENDYOL_SELLER_ID}/products/price-and-inventory`;
  const res = await fetch(url, { method: 'POST', headers: { ...tyHeaders(env), 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
  const text = await res.text();
  if (!res.ok) {
    await setSetting(env, 'ty_push_err', iso() + ' · Trendyol stok güncellemesi reddedildi (' + res.status + '): ' + text.slice(0, 200));
    return { sent: 0, error: res.status };
  }
  let batchId = ''; try { batchId = JSON.parse(text).batchRequestId || ''; } catch (e) {}
  const now = iso(); const st = results.map((r, i) => env.DB.prepare('UPDATE products SET ty_qty=?1 WHERE key=?2').bind(items[i].quantity, r.key));
  st.push(setStmt(env, 'ty_push_at', now), setStmt(env, 'ty_push_count', items.length), setStmt(env, 'ty_push_batch', batchId + '|' + Date.now()), setStmt(env, 'ty_push_err', ''), REV(env));
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  return { sent: items.length, batchId };
}
async function checkTrendyolPushBatch(env) {
  const v = await getSetting(env, 'ty_push_batch'); if (!v) return null;
  const [id, at] = v.split('|'); if (!id || Date.now() - Number(at) < 20000 || Date.now() - Number(at) > 3.5 * 3600000) return null;
  const r = await ty(env, `product/sellers/${env.TRENDYOL_SELLER_ID}/products/batch-requests/${id}`, {});
  const failed = (r.items || []).filter(x => x.status && x.status !== 'SUCCESS');
  const msg = failed.length ? `${failed.length} ürün güncellenemedi: ` + failed.slice(0, 3).map(x => `${(x.requestItem && x.requestItem.barcode) || '?'} (${(x.failureReasons || []).join(', ').slice(0, 80)})`).join('; ') : '';
  if (failed.length) await env.DB.batch(failed.map(x => env.DB.prepare('UPDATE products SET ty_qty=-(ty_qty+2) WHERE barcode=?1 AND ty_qty>=0').bind((x.requestItem && x.requestItem.barcode) || '')));
  await env.DB.batch([setStmt(env, 'ty_push_fail', msg), setStmt(env, 'ty_push_batch', '')]);
  return { failed: failed.length };
}
// Kayıp/hasarlı kargo tazmini: Trendyol satıcıya öder (gelir). Ceza faturalarındaki "tazmin bedelidir" ifadesi bunu tetiklemez.
function isCompensation(t) { const s = String(t || '').toLocaleLowerCase('tr-TR'); return /tazmin/.test(s) && !/yanlış|eksik|kusur|hasarlı ürün|ayıplı|tedarik|ceza/.test(s); }
const ESTIMATED_PEN_RE = /yanlış ürün|eksik ürün|kusurlu|hasarlı|ayıplı|tedarik/;
const AUTO_ACC_NOTE = 'Trendyol otomatik onayladı; ürün depoya ulaşınca stoğa eklemek için onayla';
// Kusurlu ürün iadesi hakkı kapsamındaki sebepler (müşteri memnuniyet kuponu satıcıya yansıtılır)
const DEFECT_RE = /yanlış ürün|eksik gönderil|parça|aksesuar|kusurlu|hasarlı|defolu|ayıplı|bozuk|kırık|çalışmıyor/;
// Sözleşme 9.2.5 / 9.2.2 cezai şart tablosu (27.07.2026)
const PENALTY_TABLE = [[200, 50], [350, 100], [600, 120], [1000, 180], [3000, 300], [10000, 600], [Infinity, 1200]];
const penaltyFor = (amount) => (PENALTY_TABLE.find(([lim]) => amount < lim) || [0, 0])[1];
// Başarısız teslimat ek bedeli: gönderi ücretinin yüzdesi (Kargo Fiyatları Tablosu, 10.08.2026)
function failPct(carrier) { const c = String(carrier || '').toLocaleLowerCase('tr-TR'); if (!c || /trendyol|express|tex/.test(c)) return 0; if (/ptt/.test(c)) return 0.3; if (/sürat|surat/.test(c)) return 0.25; if (/borusan|ceva|horoz/.test(c)) return 1; return 0.5; }
const UNDELIVERED_RE = /teslim\s*edile?me|ula[sş][ıi]lam|bulunamad|undeliver/;
const FIN_TYPES = 'Sale,Return,Discount,DiscountCancel,Coupon,CouponCancel,ManualRefund,ManualRefundCancel';
async function syncTrendyolFinance(env, force, deadline) {
  const s = await getSettings(env, ['fin_at', 'cargo_inv_done', 'desi_learned']);
  if (!force && s.fin_at && Date.now() - Date.parse(s.fin_at) < 6 * 3600000) return null;
  const sid = env.TRENDYOL_SELLER_ID, end = Date.now(), start = end - 15 * 86400000 + 60000;
  const agg = new Map(); const get = (no) => { let a = agg.get(no); if (!a) { a = { revenue: 0, commission: 0, net: 0, cargo: null, retCargo: null, service: null, sale: false }; agg.set(no, a); } return a; };
  let rows = 0; const stat = { at: iso(), types: {}, errors: [], cargoInvoices: 0, cargoItems: 0, retItems: 0 };
  // Trendyol: transactionType tekil; her istekte yalnızca bir tür
  for (const type of FIN_TYPES.split(',')) {
  let typeRows = 0;
  try {
  for (let page = 0; page < 20; page++) {
    const r = await ty(env, `finance/che/sellers/${sid}/settlements`, { transactionType: type, startDate: start, endDate: end, page, size: 1000, supplierId: sid });
    for (const x of (r.content || [])) { typeRows++;
      if (!x.orderNumber) continue; rows++;
      const a = get(String(x.orderNumber)); const credit = Number(x.credit) || 0, debt = Number(x.debt) || 0;
      a.revenue += credit - debt; if (x.transactionType === 'Sale') a.sale = true;
      const ca = Math.abs(Number(x.commissionAmount) || 0);
      if (x.transactionType === 'Sale' || x.transactionType === 'DiscountCancel' || x.transactionType === 'CouponCancel') a.commission += ca; else a.commission -= ca;
      a.net += Number(x.sellerRevenue) || 0;
    }
    if (page + 1 >= (r.totalPages || 0)) break;
  }
  } catch (e) { if (type === 'Sale') throw e; stat.errors.push(type + ': ' + String(e.message || e).slice(0, 80)); }
  stat.types[type] = typeRows;
  }
  // Paket numarasından sipariş numarasına (Trendyol bazı kayıtlarda yalnızca shipmentPackageId verir)
  const pkgOrder = async (pid) => { if (!pid) return null; const r = await env.DB.prepare('SELECT order_no FROM audit_pkg WHERE pkg_id=?1').bind(String(pid)).first(); return r ? r.order_no : null; };
  const orderOf = async (x) => x.orderNumber ? String(x.orderNumber) : await pkgOrder(x.shipmentPackageId);
  // Platform hizmet bedeli kayıtları ayrı filtreyle (transactionSubType=PlatformServiceFee) okunur; siparişe bağlanabilenler gerçek tutar olarak yazılır
  stat.svcRows = 0; stat.svcLinked = 0;
  try {
    const svc = new Map();
    for (let page = 0; page < 20; page++) {
      const r = await ty(env, `finance/che/sellers/${sid}/otherfinancials`, { transactionType: 'DeductionInvoices', transactionSubType: 'PlatformServiceFee', startDate: start, endDate: end, page, size: 500, supplierId: sid });
      for (const x of (r.content || [])) { stat.svcRows++; const no = await orderOf(x); if (!no) continue; stat.svcLinked++; svc.set(no, (svc.get(no) || 0) + Math.abs(Number(x.debt) || Number(x.credit) || 0)); }
      if (page + 1 >= (r.totalPages || 0)) break;
    }
    for (const [no, v] of svc) { const a = get(no); a.service = Math.round(v * 100) / 100; }
  } catch (e) { stat.errors.push('Hizmet bedeli: ' + String(e.message || e).slice(0, 120)); }
  // Kargo ve diğer kesinti faturaları
  const done = new Set(JSON.parse(s.cargo_inv_done || '[]')); let cargoInv = 0; const misc = [];
  const fees0 = await loadFees(env); const learned = {}; let partial = false;
  // Her kargo faturası okunur okunmaz tek atomik yazımla kaydedilir; süre biterse kalan faturalar bir sonraki turda okunur
  const flushCargo = async (invId) => {
    const ws = [];
    for (const [no, a] of agg) if (a.cargo !== null || a.retCargo !== null) {
      ws.push(env.DB.prepare(`INSERT INTO order_fin(order_no,cargo,ret_cargo,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(order_no) DO UPDATE SET
        cargo=CASE WHEN excluded.cargo IS NULL THEN order_fin.cargo ELSE COALESCE(order_fin.cargo,0)+excluded.cargo END,
        ret_cargo=CASE WHEN excluded.ret_cargo IS NULL THEN order_fin.ret_cargo ELSE COALESCE(order_fin.ret_cargo,0)+excluded.ret_cargo END, updated_at=excluded.updated_at`)
        .bind(no, a.cargo === null ? null : Math.round(a.cargo * 100) / 100, a.retCargo === null ? null : Math.round(a.retCargo * 100) / 100, iso()));
      a.cargo = null; a.retCargo = null;
    }
    done.add(invId); ws.push(setStmt(env, 'cargo_inv_done', JSON.stringify([...done].slice(-300))));
    await env.DB.batch(ws);
  };
  try {
    outer: for (let page = 0; page < 5; page++) {
      const r = await ty(env, `finance/che/sellers/${sid}/otherfinancials`, { transactionType: 'DeductionInvoices', startDate: start, endDate: end, page, size: 500, supplierId: sid });
      for (const x of (r.content || [])) {
        const t = String(x.transactionType || '') + ' ' + String(x.description || '');
        if (/kargo/i.test(t) && x.id && !done.has(String(x.id))) {
          if (deadline && Date.now() > deadline) { partial = true; break outer; }
          for (let p2 = 0; p2 < 20; p2++) {
            const it = await ty(env, `finance/che/sellers/${sid}/cargo-invoice/${encodeURIComponent(x.id)}/items`, { page: p2, size: 500 });
            for (const c of (it.content || [])) {
              const isRet = String(c.shipmentPackageType || '').toLocaleLowerCase('tr-TR').includes('iade');
              stat.cargoItems++; if (isRet) stat.retItems++;
              if (c.orderNumber) { const a = get(String(c.orderNumber)); if (isRet) a.retCargo = (a.retCargo || 0) + (Number(c.amount) || 0); else a.cargo = (a.cargo || 0) + (Number(c.amount) || 0); }
              const d = Math.ceil(Number(c.desi) || 0), amt = Number(c.amount) || 0;
              if (d > 0 && amt > 0 && !isRet) { (learned[d] = learned[d] || []).push(amt); }
            }
            if (p2 + 1 >= (it.totalPages || 0)) break;
          }
          await flushCargo(String(x.id)); cargoInv++;
        } else if (/platform hizmet|hizmet bedeli/i.test(t)) { /* yukarıda ayrı okunur */ }
        else if (!/kargo|platform|hizmet bedeli|komisyon/i.test(t)) {
          const amt = Math.round(((Math.abs(Number(x.debt) || 0)) - (Math.abs(Number(x.credit) || 0))) * 100) / 100;
          const comp = isCompensation(t); const amtS = comp ? -Math.abs(amt) : amt;
          const mno = await orderOf(x); if (mno) stat.miscLinked = (stat.miscLinked || 0) + 1;
          if (amt) misc.push({ id: String(x.id || (t + '|' + x.transactionDate + '|' + amt)).slice(0, 120), no: mno, date: x.transactionDate ? iso(Number(x.transactionDate)) : iso(), type: String(x.transactionType || x.description || 'Diğer kesinti').slice(0, 80), amt: amtS, descr: String(x.description || '').slice(0, 160) });
        }
      }
      if (page + 1 >= (r.totalPages || 0)) break;
    }
  } catch (e) { stat.errors.push('Kargo faturaları: ' + String(e.message || e).slice(0, 150)); await setSetting(env, 'fin_err', iso() + ' · Kargo faturaları okunamadı: ' + String(e.message || e).slice(0, 200)); }
  stat.cargoInvoices = cargoInv; stat.cargoDone = done.size; stat.orders = agg.size; stat.misc = misc.length; stat.partial = partial;
  const now = iso(); const st = [];
  for (const [no, a] of agg) st.push(env.DB.prepare(`INSERT INTO order_fin(order_no,revenue,commission,net,cargo,service,updated_at,ret_cargo) VALUES(?1,?2,?3,?4,?5,?6,?7,?9)
    ON CONFLICT(order_no) DO UPDATE SET revenue=CASE WHEN ?8 THEN excluded.revenue ELSE order_fin.revenue END, commission=CASE WHEN ?8 THEN excluded.commission ELSE order_fin.commission END, net=CASE WHEN ?8 THEN excluded.net ELSE order_fin.net END,
      cargo=CASE WHEN excluded.cargo IS NULL THEN order_fin.cargo ELSE COALESCE(order_fin.cargo,0)+excluded.cargo END,
      ret_cargo=CASE WHEN excluded.ret_cargo IS NULL THEN order_fin.ret_cargo ELSE COALESCE(order_fin.ret_cargo,0)+excluded.ret_cargo END,
      service=COALESCE(excluded.service, order_fin.service), updated_at=excluded.updated_at`)
    .bind(no, a.sale ? Math.round(a.revenue * 100) / 100 : null, a.sale ? Math.round(a.commission * 100) / 100 : null, a.sale ? Math.round(a.net * 100) / 100 : null, a.cargo === null ? null : Math.round(a.cargo * 100) / 100, a.service, now, a.sale ? 1 : 0, a.retCargo === null ? null : Math.round(a.retCargo * 100) / 100));
  // Barem ücretlerine (46,49 / 84,49) eşit olmayan faturalar desiye göre ücretlenmiştir → desi tablosunu öğren
  const prev = (() => { try { return JSON.parse((s.desi_learned) || '{}'); } catch (e) { return {}; } })();
  for (const [d, arr] of Object.entries(learned)) {
    const desiPriced = arr.filter(a => Math.abs(a - fees0.cargoT1) > 0.02 && Math.abs(a - fees0.cargoT2) > 0.02);
    if (!desiPriced.length) continue;
    const all = [...desiPriced, ...((prev[d] && prev[d].s) || [])].slice(0, 40).sort((a, b) => a - b);
    prev[d] = { s: all, price: all[Math.floor(all.length / 2)], at: now };
  }
  st.push(setStmt(env, 'desi_learned', JSON.stringify(prev)));
  for (const m of misc) st.push(env.DB.prepare(`INSERT INTO fin_misc(id,order_no,date,type,amount,descr) VALUES(?1,?2,?3,?4,?5,?6)
    ON CONFLICT(id) DO UPDATE SET order_no=excluded.order_no, date=excluded.date, type=excluded.type, amount=excluded.amount, descr=excluded.descr
    WHERE fin_misc.amount IS NOT excluded.amount OR fin_misc.type IS NOT excluded.type OR fin_misc.order_no IS NOT excluded.order_no`).bind(m.id, m.no, m.date, m.type, m.amt, m.descr));
  st.push(setStmt(env, 'fin_stat', JSON.stringify(stat)), REV(env));
  if (!partial) st.push(setStmt(env, 'fin_at', now));
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  return { orders: agg.size, rows, cargoInvoices: cargoInv, stat };
}
async function tryLock(env, ms) {
  const now = Date.now();
  const r = await env.DB.prepare(`UPDATE settings SET v=?1 WHERE k='lock_sync' AND CAST(v AS INTEGER) < ?2`).bind(String(now + ms), now).run();
  return r.meta && r.meta.changes === 1;
}
async function unlock(env) { await env.DB.prepare(`UPDATE settings SET v='0' WHERE k='lock_sync'`).run(); }
function tyConfigured(env) { return !!(env.TRENDYOL_SELLER_ID && env.TRENDYOL_API_KEY && env.TRENDYOL_API_SECRET); }
async function pollOnce(env, full, budget) {
  const t = Date.now(); const result = { steps: {} };
  const left = () => (budget || Infinity) - Date.now();
  // Her adım ayrı ölçülür ve ayrı hata yakalar: biri takılırsa sipariş eşitlemesi durmaz
  const step = async (name, fn, errKey) => {
    const s0 = Date.now();
    try { result[name] = await fn(); }
    catch (e) { result.steps[name + 'Err'] = String(e.message || e).slice(0, 200); if (errKey) await setSetting(env, errKey, iso() + ' · ' + String(e.message || e).slice(0, 250)); }
    result.steps[name] = Date.now() - s0;
  };
  try {
    // İlk kurulumda önce ürün listesi tamamen aktarılır; aksi halde siparişler stoğu olmayan ürünlerden düşer.
    if (!(await getSetting(env, 'ty_prod_done'))) {
      result.products = await syncTrendyolProducts(env, 6);
      if (result.products && result.products.finished && (await getSetting(env, 'started_at_auto')) !== '0') await setSetting(env, 'started_at', iso());
      if (!result.products || !result.products.finished) { await env.DB.batch([setStmt(env, 'ty_ok', iso()), setStmt(env, 'ty_err', '')]); return result; }
    }
    const s0 = Date.now();
    result.orders = await syncTrendyolOrders(env);
    result.steps.orders = Date.now() - s0;
    // Siparişler alındı: "son eşitleme" saati hemen güncellenir (ağır işler sonra)
    await env.DB.batch([setStmt(env, 'ty_ok', iso()), setStmt(env, 'ty_err', '')]);
  } catch (e) {
    await setSetting(env, 'ty_err', iso() + ' · ' + String(e.message || e).slice(0, 300));
    result.error = String(e.message || e);
    return result;
  }
  await step('recon', async () => {
    let add = (result.orders && result.orders.stats && result.orders.stats.recon) || [];
    if (!(await getSetting(env, 'mig_recon1'))) { try { await env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_recon1','1')`).run(); add = add.concat(await queueSuspectOrders(env)); } catch (e) {} }
    return processReconQueue(env, add);
  });
  await step('push', () => pushTrendyolStock(env), 'ty_push_err');
  if (full) {
    if (left() > 30000) await step('claims', () => syncTrendyolClaims(env));
    if (left() > 30000) await step('products', () => syncTrendyolProducts(env));
    if (left() > 30000) await step('pushCheck', () => checkTrendyolPushBatch(env), 'ty_push_err');
    if (left() > 35000) { await step('finance', () => syncTrendyolFinance(env, false, budget ? budget - 15000 : null), 'fin_err'); if (result.finance && !result.steps.financeErr) await setSetting(env, 'fin_err', ''); }
  }
  if (left() > 25000) await step('backfill', () => backfillTrendyolOrders(env), 'fin_err');
  result.ms = Date.now() - t;
  return result;
}
async function cronRun(env) {
  await init(env);
  if (!tyConfigured(env)) return;
  const t0 = Date.now();
  // Kesinti teşhisi: bir önceki turdan bu yana 2,5 dakikadan uzun geçtiyse kaydet
  try {
    const prev = Number(await getSetting(env, 'cron_at')) || 0;
    if (prev && t0 - prev > 150000) {
      const gaps = JSON.parse((await getSetting(env, 'cron_gaps')) || '[]');
      gaps.unshift({ from: iso(prev), to: iso(t0), min: Math.round((t0 - prev) / 60000) });
      await setSetting(env, 'cron_gaps', JSON.stringify(gaps.slice(0, 10)));
    }
  } catch (e) {}
  if (!(await tryLock(env, 90000))) { await setSetting(env, 'cron_busy', iso()); return; }
  await setSetting(env, 'cron_at', String(t0));
  const diag = { at: iso(t0), polls: 0, slow: {}, errs: {} };
  try {
    for (let i = 0; i < 6; i++) {
      const wait = t0 + i * 10000 - Date.now();
      if (wait > 0) await sleep(wait);
      if (Date.now() - t0 > 52000) break;
      const r = await pollOnce(env, i === 0, t0 + 55000);
      diag.polls++;
      for (const [k, v] of Object.entries(r.steps || {})) { if (typeof v === 'number') { if (!(diag.slow[k] >= v)) diag.slow[k] = v; } else diag.errs[k] = v; }
      if (r.error) diag.errs.orders = r.error;
    }
  } finally {
    diag.ms = Date.now() - t0;
    try { await env.DB.batch([setStmt(env, 'ty_diag', JSON.stringify(diag)), env.DB.prepare(`UPDATE settings SET v='0' WHERE k='lock_sync'`)]); } catch (e) { await unlock(env); }
  }
}

/* ---------- oturum ---------- */
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function authed(req, env) {
  const c = req.headers.get('cookie') || ''; const m = c.match(/(?:^|;\s*)lb=([^;]+)/); if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.'); if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sig === await hmac(env.APP_PASSWORD, 'lb:' + exp);
}
async function loginCookie(env) {
  const exp = Date.now() + 120 * 86400000;
  const v = exp + '.' + await hmac(env.APP_PASSWORD, 'lb:' + exp);
  return `lb=${encodeURIComponent(v)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${120 * 86400}`;
}

/* ---------- kâr hesabı ---------- */
const MARKETPLACES = new Set(['trendyol', 'hepsiburada', 'temu']);
/* 2026 Trendyol kargo fiyat listesi, KDV dahil, 350 TL ve üzeri; 20 desi üstü son farkla devam eder */
const DEFAULT_DESI_TABLES = {"tex":[{"desi":1,"price":98.34},{"desi":2,"price":98.34},{"desi":3,"price":120.24},{"desi":4,"price":128.64},{"desi":5,"price":136.92},{"desi":6,"price":150.72},{"desi":7,"price":160.09},{"desi":8,"price":170.78},{"desi":9,"price":180.77},{"desi":10,"price":197.02},{"desi":11,"price":208.1},{"desi":12,"price":218.64},{"desi":13,"price":228.55},{"desi":14,"price":237.72},{"desi":15,"price":247.24},{"desi":16,"price":256.58},{"desi":17,"price":269.18},{"desi":18,"price":280.58},{"desi":19,"price":291.94},{"desi":20,"price":303.32,"extra":11.38}],"ptt":[{"desi":1,"price":98.34},{"desi":2,"price":98.34},{"desi":3,"price":120.0},{"desi":4,"price":126.72},{"desi":5,"price":132.73},{"desi":6,"price":145.0},{"desi":7,"price":155.0},{"desi":8,"price":165.96},{"desi":9,"price":180.0},{"desi":10,"price":203.81},{"desi":11,"price":213.85},{"desi":12,"price":224.6},{"desi":13,"price":235.39},{"desi":14,"price":246.17},{"desi":15,"price":256.9},{"desi":16,"price":267.65},{"desi":17,"price":278.42},{"desi":18,"price":289.18},{"desi":19,"price":299.96},{"desi":20,"price":310.73,"extra":10.77}]};
const carrierKey = (name) => /ptt/i.test(String(name || '')) ? 'ptt' : 'tex';
const CARRIER_NAMES = { tex: 'Trendyol Express', ptt: 'PTT Kargo' };
function tyDesiPrice(fee, desi, carrier) { const c = tyCargo(fee, Infinity, desi, carrier); return c.noTable ? fee.cargoT3 : c.cost; }
function tyCargo(fee, amount, desi, carrier) {
  // Barem yalnızca küçük paketlerde: desi 10 ve üzeriyse tutar 350 TL altında olsa da desi fiyatı uygulanır
  const bigDesi = Math.ceil(Number(desi) || 0) >= (fee.baremMaxDesi || 10);
  if (!bigDesi && amount < 200) return { cost: fee.cargoT1, tier: 1 };
  if (!bigDesi && amount < 350) return { cost: fee.cargoT2, tier: 2 };
  if (!fee.desiMode) return { cost: fee.cargoT3, tier: 3, flat: true };
  const d = Math.max(1, Math.ceil(Number(desi) || 1));
  const ck = carrierKey(carrier);
  const t = (fee.desiTables && fee.desiTables[ck] && fee.desiTables[ck].length) ? fee.desiTables[ck] : fee.desiTable;
  if (!t.length) return { cost: fee.cargoT3, tier: 3, noTable: true };
  const row = t.find(x => d <= x.desi) || t[t.length - 1];
  const over = d > t[t.length - 1].desi && t[t.length - 1].extra ? (d - t[t.length - 1].desi) * t[t.length - 1].extra : 0;
  return { cost: Math.round((row.price + over) * 100) / 100, tier: 3, carrier: ck, desi: d };
}
function parseDesiTables(v) { let o = {}; try { o = JSON.parse(v || '{}') || {}; } catch (e) {} return { tex: parseDesiTable(JSON.stringify(o.tex || DEFAULT_DESI_TABLES.tex)), ptt: parseDesiTable(JSON.stringify(o.ptt || DEFAULT_DESI_TABLES.ptt)) }; }
function minQtyFor(price) { return price < 25 ? 6 : price < 35 ? 4 : price < 50 ? 3 : price < 75 ? 2 : 1; }
function parseDesiTable(v) { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.filter(x => x.desi > 0 && x.price >= 0).sort((a, b) => a.desi - b.desi) : []; } catch (e) { return []; } }
function learnedTable(v) {
  try { const o = JSON.parse(v || '{}'); return Object.entries(o).map(([d, x]) => ({ desi: Number(d), price: Number(x.price) })).filter(x => x.desi > 0 && x.price > 0).sort((a, b) => a.desi - b.desi); } catch (e) { return []; }
}
async function loadFees(env) {
  const s = await getSettings(env, ['fee_cargo_t1', 'fee_cargo_t2', 'fee_cargo_t3', 'cargo_desi_mode', 'desi_table', 'desi_tables', 'desi_learned', 'fee_service_ty', 'fee_cargo_sh', 'stopaj', 'fee_service_fast', 'service_cutoff', 'barem_max_desi']);
  const manual = parseDesiTable(s.desi_table), learned = learnedTable(s.desi_learned);
  // elle girilen satırlar öncelikli; eksik desiler faturalardan öğrenilenle tamamlanır
  const merged = [...manual]; for (const x of learned) if (!merged.some(m => m.desi === x.desi)) merged.push(x);
  merged.sort((a, b) => a.desi - b.desi);
  if (merged.length && manual.length && manual[manual.length - 1].extra && merged[merged.length - 1] !== manual[manual.length - 1]) merged[merged.length - 1] = { ...merged[merged.length - 1], extra: manual[manual.length - 1].extra };
  return { serviceFast: Number(s.fee_service_fast ?? 5.99), serviceCutoff: Number(s.service_cutoff ?? 15), baremMaxDesi: Number(s.barem_max_desi ?? 10), cargoT1: Number(s.fee_cargo_t1 ?? 46.49), cargoT2: Number(s.fee_cargo_t2 ?? 84.49), cargoT3: Number(s.fee_cargo_t3 ?? 98.35), desiMode: s.cargo_desi_mode === '1', desiTables: parseDesiTables(s.desi_tables), desiTable: merged, desiManual: manual, desiLearned: learned, serviceTy: Number(s.fee_service_ty ?? 13.19), serviceFast: Number(s.fee_service_fast ?? 5.99), serviceCutoff: Number(s.service_cutoff ?? 15), baremMaxDesi: Number(s.barem_max_desi ?? 10), cargoSh: Number(s.fee_cargo_sh ?? 0), stopaj: Number(s.stopaj ?? 1) };
}
async function computeProfit(env, from, to) {
  const fee = await loadFees(env);
  const [o, p, r] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM orders WHERE date >= ?1 AND date < ?2 ORDER BY date DESC').bind(from, to),
    env.DB.prepare('SELECT key, sku, name, image, cost, barcode, same_day FROM products'),
    env.DB.prepare(`SELECT order_id, pkey, status, ext_status, qty, note FROM returns WHERE order_id<>'' AND status<>'rejected'`)]);
  const prods = new Map(p.results.map(x => [x.key, x]));
  // İade, Trendyol'un onayladığı (para iadesi yapılan) ya da senin depoda kabul ettiğin anda kâra yansır
  const rets = new Map(), pend = new Map(), defQ = new Map(), undOrders = new Set();
  for (const x of r.results) {
    const k = x.order_id + '|' + x.pkey, counted = x.status === 'accepted' || x.ext_status === 'Accepted';
    const note = String(x.note || '').toLocaleLowerCase('tr-TR');
    if (counted) {
      rets.set(k, (rets.get(k) || 0) + (x.qty || 0));
      if (DEFECT_RE.test(note)) defQ.set(k, (defQ.get(k) || 0) + (x.qty || 0));
      // Teslim edilemeyip dönen siparişte dönüş kargosu Trendyol'a aittir
      if (UNDELIVERED_RE.test(note)) undOrders.add(x.order_id);
    } else if (x.status === 'requested') pend.set(k, (pend.get(k) || 0) + (x.qty || 0));
  }
  const orderNos = o.results.filter(x => x.channel === 'trendyol').map(x => x.order_no);
  const fin = new Map((await selectIn(env, 'SELECT * FROM order_fin', 'order_no', orderNos)).map(x => [x.order_no, x]));
  const cnames = new Map((await selectIn(env, "SELECT order_no, json_extract(data,'$.name') n FROM order_cust", 'order_no', orderNos)).map(x => [x.order_no, x.n || '']));
  // Trendyol'un ceza vb. kesinti faturaları: siparişe bağlı olanlar siparişe, bağlanamayanlar fatura tarihine göre döneme yazılır
  const miscByOrder = new Map();
  for (const m of await selectIn(env, 'SELECT order_no, type, amount FROM fin_misc', 'order_no', orderNos)) { if (isCompensation(m.type)) continue; const a = miscByOrder.get(m.order_no) || { amount: 0, types: [] }; a.amount += m.amount || 0; a.types.push(m.type); miscByOrder.set(m.order_no, a); }
  const { results: miscAll } = await env.DB.prepare('SELECT type, SUM(amount) amount, COUNT(*) n FROM fin_misc WHERE (order_no IS NULL OR type LIKE ?3) AND date >= ?1 AND date < ?2 GROUP BY type ORDER BY 2 DESC').bind(from, to, '%azmin%').all();
  // Kayıp kargo tazmini fatura tarihine göre gelir olarak eklenir; ceza türleri siparişe bağlıysa siparişte sayılır
  const miscFree = miscAll.filter(x => !isCompensation(x.type));
  const compensation = miscAll.filter(x => isCompensation(x.type)).reduce((a, x) => a + Math.abs(x.amount || 0), 0);
  // Reklam: harcandığı günün gideri (elle ya da Trendyol reklam raporundan girilen günlük harcama)
  const dayFrom = trDay(Date.parse(from)), dayTo = trDay(Date.parse(to) - 1);
  const { results: adRows } = await env.DB.prepare('SELECT day, channel, amount, source FROM ad_spend WHERE day >= ?1 AND day <= ?2 ORDER BY day DESC').bind(dayFrom, dayTo).all();
  const R2 = (n) => Math.round(n * 100) / 100;
  const blank = () => ({ revenue: 0, commission: 0, cargo: 0, retCargo: 0, penalty: 0, service: 0, stopaj: 0, cost: 0, profit: 0, units: 0, retUnits: 0 });
  const add = (a, b) => { for (const k in b) if (typeof b[k] === 'number' && k in a) a[k] += b[k]; };
  const sum = { ...blank(), retOrders: 0, retCargoEst: 0, undOrders: 0, unsOrders: 0, defOrders: 0, penaltyEst: 0, penaltyActual: 0, otherFees: 0, orders: 0, actualOrders: 0, missingCost: 0, missingPrice: 0, desiOrders: 0, desiMissing: 0, noDesiTable: false };
  const rep = { grossU: 0, grossTL: 0, cancelU: 0, cancelTL: 0, retU: 0, retTL: 0, pendU: 0, pendTL: 0, discTL: 0, netU: 0, netTL: 0, noGross: 0 };
  for (const ord of o.results) for (const l of JSON.parse(ord.lines || '[]')) {
    if (!l.qty) continue; const f = l.fin || {}; const unitG = (f.gross ?? f.revenue ?? 0) / l.qty, unitR = (f.revenue ?? 0) / l.qty;
    if (f.gross === null || f.gross === undefined) rep.noGross++;
    rep.grossU += l.qty; rep.grossTL += unitG * l.qty;
    if (l.status === 'cancelled') { rep.cancelU += l.qty; rep.cancelTL += unitG * l.qty; continue; }
    const rq = Math.min(l.qty, rets.get(ord.id + '|' + l.pkey) || 0), pq = Math.min(l.qty - rq, pend.get(ord.id + '|' + l.pkey) || 0);
    rep.retU += rq; rep.retTL += unitG * rq; rep.pendU += pq; rep.pendTL += unitG * pq;
    rep.discTL += (unitG - unitR) * (l.qty - rq);
    rep.netU += l.qty - rq; rep.netTL += unitR * (l.qty - rq);
  }
  for (const k in rep) rep[k] = Math.round(rep[k] * 100) / 100;
  const byProduct = new Map(), byOrder = [], missingCostSkus = new Set();
  for (const ord of o.results) {
    const allLines = JSON.parse(ord.lines || '[]');
    const lines = allLines.filter(l => l.status !== 'cancelled');
    // Tedarik edememe (satıcı iptali): gönderideki iptal edilen ürünlerin net tutarına göre ceza tahmini
    const unsPk = new Map();
    for (const l of allLines) if (l.status === 'cancelled' && l.fin && l.fin.uns) { const pk = String(l.key).split('|')[0]; unsPk.set(pk, (unsPk.get(pk) || 0) + (Number(l.fin.revenue) || 0)); }
    let unsPenalty = 0; for (const v of unsPk.values()) unsPenalty += penaltyFor(v);
    if (unsPenalty) sum.unsOrders = (sum.unsOrders || 0) + 1;
    if (!lines.length) {
      if (!unsPenalty) continue;
      const mo0 = miscByOrder.get(ord.order_no); const pen = mo0 ? mo0.amount : unsPenalty;
      sum.penalty += pen; sum.profit -= pen; if (mo0) sum.penaltyActual++; else sum.penaltyEst++;
      byOrder.push({ cname: cnames.get(ord.order_no) || "", q: allLines.map(l => l.sku + " " + (l.name || "")).join(" ").slice(0, 400), id: ord.id, orderNo: ord.order_no, channel: ord.channel, date: ord.date, actual: !!mo0, penaltyEst: !mo0, penaltyTypes: mo0 ? mo0.types.slice(0, 4) : ['Tedarik edememe'], cargoInfo: 'Tedarik edilemedi (iptal)', revenue: 0, commission: 0, cargo: 0, retCargo: 0, penalty: R2(pen), service: 0, stopaj: 0, cost: 0, profit: R2(-pen), units: 0, retUnits: 0 });
      const l0 = allLines.find(l => l.fin && l.fin.uns) || allLines[0];
      let bp = byProduct.get(l0.pkey); if (!bp) { const pr = prods.get(l0.pkey); bp = { key: l0.pkey, sku: l0.sku, name: (pr && pr.name) || l0.name, image: pr ? pr.image : '', costKnown: !!(pr && pr.cost !== null), ...blank(), orders: 0 }; byProduct.set(l0.pkey, bp); }
      bp.penalty += pen; bp.profit -= pen;
      continue;
    }
    const ch = ord.channel, mk = MARKETPLACES.has(ch);
    const rows = [];
    for (const l of lines) {
      const retQ = Math.min(l.qty, rets.get(ord.id + '|' + l.pkey) || 0); const qty = Math.max(0, l.qty - retQ);
      const pr = prods.get(l.pkey); const unitCost = pr && pr.cost !== null && pr.cost !== undefined ? pr.cost : null;
      const f = l.fin; const unitRev = f && Number.isFinite(f.revenue) && l.qty ? f.revenue / l.qty : null;
      if (unitRev === null) sum.missingPrice++;
      if (unitCost === null && qty) { sum.missingCost++; missingCostSkus.add(l.sku); }
      const revenue = (unitRev || 0) * qty;
      const commission = f && f.rate !== null && f.rate !== undefined ? revenue * f.rate / 100 : 0;
      const vat = f && f.vat !== null && f.vat !== undefined ? f.vat : 20;
      const stopaj = mk ? revenue / (1 + vat / 100) * fee.stopaj / 100 : 0;
      const dq = Math.min(retQ, defQ.get(ord.id + '|' + l.pkey) || 0);
      rows.push({ l, qty, retQ, dq, full: (unitRev || 0) * l.qty, revenue, commission, stopaj, cost: (unitCost || 0) * qty, pr });
    }
    const pkgs = new Map();
    for (const x of rows) { const pk = String(x.l.key).split('|')[0] || 'x'; const g = pkgs.get(pk) || { amount: 0, desi: null, carrier: null, ret: 0, und: false, defVal: 0, fast: true }; const f = x.l.fin || {}; g.amount += (f.paid !== null && f.paid !== undefined ? f.paid : (f.revenue || 0)); g.ret += x.retQ; if (x.dq && x.l.qty) g.defVal += x.full * x.dq / x.l.qty; if (f.und || undOrders.has(ord.id)) g.und = true; if (f.desi) g.desi = f.desi; if (f.carrier) g.carrier = f.carrier; pkgs.set(pk, g); }
    let cargo = 0, retCargo = 0, penalty = 0;
    const cargoInfo = [];
    if (ch === 'trendyol') for (const g of pkgs.values()) { const c = tyCargo(fee, g.amount, g.desi, g.carrier); cargo += c.cost;
      // İade paketleri barem desteğinden yararlanmaz: dönüş kargosu desi fiyatından; teslim edilemeyende yalnızca taşıyıcının başarısız teslimat ek bedeli (desi fiyatının yüzdesi, barem değil)
      if (g.ret) retCargo += g.und ? Math.round(tyDesiPrice(fee, g.desi, g.carrier) * failPct(g.carrier) * 100) / 100 : tyDesiPrice(fee, g.desi, g.carrier);
      if (g.defVal > 0) penalty += penaltyFor(g.defVal); cargoInfo.push(c.tier === 1 ? '0–199,99 TL baremi' : c.tier === 2 ? '200–349,99 TL baremi' : c.flat ? '350 TL üzeri sabit' : `${CARRIER_NAMES[c.carrier]} · ${c.desi} desi${g.desi ? '' : ' (desi yok, 1 sayıldı)'}`); if (c.tier === 3 && !c.flat) { sum.desiOrders++; if (!g.desi) sum.desiMissing++; if (c.noTable) sum.noDesiTable = true; } }
    else if (ch === 'shopify') cargo = fee.cargoSh;
    // Platform hizmet bedeli: sipariş saat <kesim> (15:00) öncesi geldiyse indirimli (Bugün Kargoda), sonrası normal. Fatura detayı gelince gerçeği yazılır.
    const ordHour = ord.date ? new Date(Date.parse(ord.date) + TY_TZ).getUTCHours() : 23;
    let service = 0, fastPk = 0;
    if (ch === 'trendyol') for (const g of pkgs.values()) { const f = g.fast && ordHour < fee.serviceCutoff; service += f ? fee.serviceFast : fee.serviceTy; if (f) fastPk++; }
    if (fastPk) sum.fastPkgs = (sum.fastPkgs || 0) + fastPk;
    const est = rows.reduce((a, x) => a + x.revenue, 0);
    let revenue = est, commission = rows.reduce((a, x) => a + x.commission, 0); let actual = false;
    const retUnits = rows.reduce((a, x) => a + x.retQ, 0);
    const fa = ch === 'trendyol' ? fin.get(ord.order_no) : null;
    const undelivered = retUnits > 0 && [...pkgs.values()].some(g => g.ret && g.und);
    let retCargoEst = retUnits > 0 && !undelivered;
    if (fa) {
      // İade onaylanan siparişte ciro/komisyon satır verisinden (iade düşülmüş) hesaplanır; Trendyol ekstresi iadeyi geç yansıtabilir.
      if (fa.revenue !== null && !retUnits) { revenue = fa.revenue; commission = fa.commission || 0; actual = true; }
      if (fa.cargo !== null) { cargo = fa.cargo; actual = true; }
      if (fa.ret_cargo !== null && fa.ret_cargo !== undefined && retUnits) { retCargo = fa.ret_cargo; retCargoEst = false; }
      if (fa.service !== null) service = fa.service;
    }
    if (!retUnits) retCargo = 0;
    penalty += unsPenalty;
    // Gerçek kesinti faturası (ceza, kupon vb.) varsa tahmin yerine o kullanılır
    const mo = ch === 'trendyol' ? miscByOrder.get(ord.order_no) : null;
    const penaltyEst = !mo && penalty > 0;
    if (mo) penalty = mo.amount;
    const stopaj = actual && est ? rows.reduce((a, x) => a + x.stopaj, 0) * (revenue / est) : rows.reduce((a, x) => a + x.stopaj, 0);
    const cost = rows.reduce((a, x) => a + x.cost, 0), units = rows.reduce((a, x) => a + x.qty, 0);
    const profit = revenue - commission - cargo - retCargo - penalty - service - stopaj - cost;
    const oRes = { revenue, commission, cargo, retCargo, penalty, service, stopaj, cost, profit, units, retUnits };
    add(sum, oRes); sum.orders++; if (actual) sum.actualOrders++; if (retUnits) { sum.retOrders++; if (retCargoEst && retCargo) sum.retCargoEst++; if (undelivered) sum.undOrders++; }
    if (penalty) { if (penaltyEst) sum.penaltyEst++; else sum.penaltyActual++; }
    if (rows.some(x => x.dq)) sum.defOrders++;
    byOrder.push({ cname: cnames.get(ord.order_no) || '', q: lines.map(l => { const pr = prods.get(l.pkey); return l.sku + ' ' + (l.name || '') + ' ' + ((pr && pr.barcode) || ''); }).join(' ').slice(0, 400), id: ord.id, orderNo: ord.order_no, channel: ch, date: ord.date, actual, retCargoEst, undelivered, penaltyEst, penaltyTypes: mo ? mo.types.slice(0, 4) : null, cargoInfo: fa && fa.cargo !== null ? 'Trendyol kargo faturası' : cargoInfo.join(', '), ...Object.fromEntries(Object.entries(oRes).map(([k, v]) => [k, R2(v)])) });
    // sipariş kesintilerini ürünlere satış payına göre dağıt
    // Kargo/hizmet gibi sipariş masrafları, iade edilenler dahil tüm sipariş üzerinden paylaştırılır (iade edilen ürün zararı kendisine yazılır)
    const fullTot = rows.reduce((a, x) => a + x.full, 0), qtyTot = rows.reduce((a, x) => a + x.l.qty, 0) || 1;
    const rv = (x) => x.l.qty ? x.full * x.retQ / x.l.qty : 0, retTot = rows.reduce((a, x) => a + rv(x), 0), retQTot = rows.reduce((a, x) => a + x.retQ, 0) || 1;
    const dv = (x) => x.l.qty ? x.full * x.dq / x.l.qty : 0, dTot = rows.reduce((a, x) => a + dv(x), 0);
    // Tedarik edilemeyen ürünün cezası o ürüne yazılır (tahminse)
    const unsAlloc = !mo && unsPenalty ? unsPenalty : 0;
    if (unsAlloc) { const l0 = allLines.find(l => l.status === 'cancelled' && l.fin && l.fin.uns); let bp = byProduct.get(l0.pkey); if (!bp) { const pr = prods.get(l0.pkey); bp = { key: l0.pkey, sku: l0.sku, name: (pr && pr.name) || l0.name, image: pr ? pr.image : '', costKnown: !!(pr && pr.cost !== null), ...blank(), orders: 0 }; byProduct.set(l0.pkey, bp); } bp.penalty += unsAlloc; bp.profit -= unsAlloc; }
    for (const x of rows) {
      const share = est ? x.revenue / est : 0, fshare = fullTot ? x.full / fullTot : x.l.qty / qtyTot;
      const k = x.l.pkey; let bp = byProduct.get(k);
      if (!bp) { bp = { key: k, sku: x.l.sku, barcode: (x.pr && x.pr.barcode) || '', name: (x.pr && x.pr.name) || x.l.name, image: x.pr ? x.pr.image : '', costKnown: !!(x.pr && x.pr.cost !== null), ...blank(), orders: 0 }; byProduct.set(k, bp); }
      const lr = revenue * share, lc = commission * share, ls = stopaj * share;
      const res = { revenue: lr, commission: lc, cargo: cargo * fshare, retCargo: retCargo * (retTot ? rv(x) / retTot : x.retQ / retQTot), penalty: (penalty - unsAlloc) * (dTot ? dv(x) / dTot : fshare), service: service * fshare, stopaj: ls, cost: x.cost, units: x.qty, retUnits: x.retQ };
      res.profit = lr - lc - res.cargo - res.retCargo - res.penalty - res.service - ls - x.cost;
      add(bp, res); bp.orders++;
    }
  }
  const isAd = (t) => /reklam|ads/i.test(String(t || ''));
  // Sistemin iade nedeninden / iptal durumundan zaten tahmin ettiği ceza türleri, siparişe bağlanamadıysa ikinci kez düşülmez
  const isEstPen = (t) => ESTIMATED_PEN_RE.test(String(t || '').toLocaleLowerCase('tr-TR'));
  const penInvoices = miscFree.filter(x => isEstPen(x.type)).reduce((a, x) => a + (x.amount || 0), 0);
  for (let i = miscFree.length - 1; i >= 0; i--) if (isEstPen(miscFree[i].type)) miscFree.splice(i, 1);
  sum.penInvoices = R2(penInvoices);
  sum.ads = adRows.reduce((a, x) => a + (x.amount || 0), 0); sum.adDays = adRows.length;
  // Günlük reklam girişi varsa reklam faturaları ayrıca düşülmez (çift sayılmasın); yoksa faturalar fatura tarihine göre düşülür
  const adInvoices = miscFree.filter(x => isAd(x.type)).reduce((a, x) => a + (x.amount || 0), 0);
  const otherFees = miscFree.filter(x => !(adRows.length && isAd(x.type))).map(x => ({ type: x.type, amount: R2(x.amount || 0), n: x.n }));
  sum.otherFees = otherFees.reduce((a, x) => a + x.amount, 0); sum.adInvoices = R2(adInvoices);
  sum.compensation = R2(Math.abs(compensation)); sum.profit -= sum.otherFees + sum.ads; sum.profit += sum.compensation;
  const round = (o) => { for (const k in o) if (typeof o[k] === 'number' && !Number.isInteger(o[k])) o[k] = R2(o[k]); return o; };
  const products = [...byProduct.values()].map(round).map(x => ({ ...x, margin: x.revenue ? R2(x.profit / x.revenue * 100) : null }));
  round(sum); sum.margin = sum.revenue ? R2(sum.profit / sum.revenue * 100) : null;
  return { from, to, fees: fee, summary: sum, report: rep, otherFees, ads: adRows.map(x => ({ day: x.day, channel: x.channel, amount: R2(x.amount || 0), source: x.source })), products, orders: byOrder.slice(0, 500), missingCostSkus: [...missingCostSkus].slice(0, 30) };
}

async function computePricing(env) {
  const fee = await loadFees(env);
  const { results } = await env.DB.prepare(`SELECT key, sku, name, image, cost, ty_price, ty_comm, ty_vat, desi, qty FROM products WHERE ty_price IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(products.channels) WHERE value='trendyol') ORDER BY name`).all();
  const R2 = (n) => Math.round(n * 100) / 100;
  const items = results.map(p => {
    const price = p.ty_price, minQ = minQtyFor(price), order = price * minQ;
    const desiTotal = (p.desi || 1) * minQ;
    const cg = tyCargo(fee, order, desiTotal);
    const commission = p.ty_comm !== null ? order * p.ty_comm / 100 : 0;
    const stopaj = order / (1 + (p.ty_vat ?? 20) / 100) * fee.stopaj / 100;
    const cost = p.cost !== null ? p.cost * minQ : null;
    const profit = cost === null ? null : order - commission - cg.cost - fee.serviceTy - stopaj - cost;
    return { key: p.key, sku: p.sku, name: p.name, image: p.image, qty: p.qty, price, minQty: minQ, order: R2(order), commRate: p.ty_comm, commission: R2(commission), cargo: R2(cg.cost), cargoTier: cg.tier, desi: p.desi, desiKnown: !!p.desi, service: fee.serviceTy, stopaj: R2(stopaj), cost: cost === null ? null : R2(cost), unitCost: p.cost, profit: profit === null ? null : R2(profit), perUnit: profit === null ? null : R2(profit / minQ), margin: profit === null || !order ? null : R2(profit / order * 100) };
  });
  return { fees: fee, items, noDesiTable: fee.desiMode && !fee.desiTable.length };
}

/* ---------- API ---------- */
function mapOrder(r) { return { cname: r.cname || '', id: r.id, channel: r.channel, orderNo: r.order_no, date: r.date, status: r.status, source: r.source, baseline: !!r.baseline, lines: JSON.parse(r.lines || '[]') }; }
function mapReturn(r) { return { extAt: r.ext_at || null, id: r.id, channel: r.channel, orderNo: r.order_no, orderId: r.order_id, lineKey: r.line_key, pkey: r.pkey, sku: r.sku, name: r.name, qty: r.qty, status: r.status, source: r.source, note: r.note, extStatus: r.ext_status, createdAt: r.created_at, decidedAt: r.decided_at }; }
function mapProduct(r) { return { sameDay: r.same_day === 1, id: r.key, sku: r.sku, name: r.name, barcode: r.barcode, image: r.image, channels: JSON.parse(r.channels || '[]'), qty: r.qty, cost: r.cost, min: r.min, tyQty: r.ty_qty === undefined ? null : r.ty_qty, createdAt: r.created_at, updatedAt: r.updated_at }; }
function mapMove(r) { return { id: r.id, t: r.t, key: r.pkey, sku: r.sku, name: r.name, delta: r.delta, after: r.after, type: r.type, channel: r.channel, ref: r.ref, note: r.note }; }
async function syncInfo(env) {
  const s = await getSettings(env, ['rev', 'started_at', 'auto_accept', 'ty_ok', 'ty_err', 'ty_prod_done', 'last_import', 'ty_prod_initial', 'ty_push', 'ty_push_at', 'ty_push_count', 'ty_push_err', 'ty_push_fail', 'fee_cargo_t1', 'fee_cargo_t2', 'fee_cargo_t3', 'cargo_desi_mode', 'desi_table', 'desi_tables', 'desi_learned', 'fee_service_ty', 'fee_cargo_sh', 'stopaj', 'fin_at', 'fin_err', 'fin_backfill_day', 'fin_stat', 'ty_diag', 'cron_gaps', 'fee_service_fast', 'service_cutoff', 'barem_max_desi']);
  return { rev: s.rev, settings: { startedAt: s.started_at, autoAccept: s.auto_accept !== '0', prodInitial: s.ty_prod_initial !== '0', pushStock: s.ty_push !== '0', fees: { cargoT1: Number(s.fee_cargo_t1 ?? 46.49), cargoT2: Number(s.fee_cargo_t2 ?? 84.49), cargoT3: Number(s.fee_cargo_t3 ?? 98.35), desiMode: s.cargo_desi_mode === '1', desiTables: parseDesiTables(s.desi_tables), desiTable: parseDesiTable(s.desi_table), desiLearned: learnedTable(s.desi_learned), serviceTy: Number(s.fee_service_ty ?? 13.19), serviceFast: Number(s.fee_service_fast ?? 5.99), serviceCutoff: Number(s.service_cutoff ?? 15), baremMaxDesi: Number(s.barem_max_desi ?? 10), cargoSh: Number(s.fee_cargo_sh ?? 0), stopaj: Number(s.stopaj ?? 1) }, lastImport: s.last_import ? JSON.parse(s.last_import) : null }, sync: { trendyol: { configured: tyConfigured(env), ok: s.ty_ok || null, err: s.ty_err || '', productsAt: s.ty_prod_done || null, pushAt: s.ty_push_at || null, pushCount: Number(s.ty_push_count) || 0, pushErr: s.ty_push_err || '', pushFail: s.ty_push_fail || '', finAt: s.fin_at || null, finErr: s.fin_err || '', finStat: (() => { try { return JSON.parse(s.fin_stat || 'null'); } catch (e) { return null; } })(), diag: (() => { try { return JSON.parse(s.ty_diag || 'null'); } catch (e) { return null; } })(), gaps: (() => { try { return JSON.parse(s.cron_gaps || '[]'); } catch (e) { return []; } })(), backfill: s.fin_backfill_day || null } }, now: iso(), version: APP_VERSION };
}
async function api(req, env, path) {
  const method = req.method;
  const body = method === 'POST' ? await req.json().catch(() => ({})) : {};
  if (path === '/api/state') {
    const info = await syncInfo(env);
    if (new URL(req.url).searchParams.get('rev') === info.rev) return json({ ...info, same: true });
    const [p, o, r, m] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM products ORDER BY name'),
      env.DB.prepare(`SELECT o.*, json_extract(c.data,'$.name') cname FROM orders o LEFT JOIN order_cust c ON c.order_no=o.order_no AND o.channel='trendyol' ORDER BY o.date DESC LIMIT 300`),
      env.DB.prepare('SELECT * FROM returns ORDER BY created_at DESC LIMIT 400'),
      env.DB.prepare('SELECT * FROM moves ORDER BY id DESC LIMIT 600')]);
    return json({ ...info, products: p.results.map(mapProduct), orders: o.results.map(mapOrder), returns: r.results.map(mapReturn), moves: m.results.map(mapMove) });
  }
  if (method !== 'POST' && path !== '/api/export') return bad('Yöntem desteklenmiyor', 405);

  if (path === '/api/products') {
    const name = String(body.name || '').trim(), sku = String(body.sku || '').trim();
    if (!name || !sku) return bad('Ürün adı ve stok kodu gerekli.');
    const key = skuKey(sku);
    if (await env.DB.prepare('SELECT 1 FROM products WHERE key=?1').bind(key).first()) return bad('Bu stok koduyla bir ürün zaten var.');
    const qty = intOr(body.qty, 0); if (qty < 0) return bad('Başlangıç stoğu eksi olamaz.');
    const st = [...ensureProduct(env, key, { sku, name, barcode: body.barcode, cost: body.cost, min: intOr(body.min, 5), channels: Array.isArray(body.channels) ? body.channels : [] }, null)];
    if (qty) st.push(...changeQty(env, key, qty, { type: 'initial', channel: 'manuel' }));
    st.push(REV(env)); await env.DB.batch(st); return json({ ok: true, key });
  }
  if (path === '/api/products/info') {
    const key = String(body.key || ''); const sets = [], vals = [];
    if (body.name !== undefined) { const n = String(body.name).trim(); if (!n) return bad('Ürün adı boş olamaz.'); sets.push('name'); vals.push(n); }
    if (body.barcode !== undefined) { sets.push('barcode'); vals.push(String(body.barcode).trim()); }
    if (body.cost !== undefined) { const c = numOrNull(body.cost); if (c !== null && c < 0) return bad('Alış fiyatı eksi olamaz.'); sets.push('cost'); vals.push(c); }
    if (body.min !== undefined) { const m = intOr(body.min, NaN); if (!(m >= 0)) return bad('Düşük stok sınırı geçersiz.'); sets.push('min'); vals.push(m); }
    if (Array.isArray(body.channels)) { sets.push('channels'); vals.push(JSON.stringify(body.channels.map(String))); }
    if (body.sameDay !== undefined) { sets.push('same_day'); vals.push(body.sameDay ? 1 : 0); }
    if (!sets.length) return json({ ok: true });
    const sql = `UPDATE products SET ${sets.map((c, i) => `${c}=?${i + 1}`).join(', ')}, updated_at=?${sets.length + 1} WHERE key=?${sets.length + 2}`;
    const r = await env.DB.batch([env.DB.prepare(sql).bind(...vals, iso(), key), REV(env)]);
    if (!r[0].meta.changes) return bad('Ürün bulunamadı.', 404);
    return json({ ok: true });
  }
  if (path === '/api/products/delete') { await env.DB.batch([env.DB.prepare('DELETE FROM products WHERE key=?1').bind(String(body.key || '')), REV(env)]); return json({ ok: true }); }
  if (path === '/api/stock') {
    const key = String(body.key || ''), mode = body.mode, n = intOr(body.n, NaN), note = String(body.note || '').slice(0, 300);
    const p = await env.DB.prepare('SELECT qty FROM products WHERE key=?1').bind(key).first(); if (!p) return bad('Ürün bulunamadı.', 404);
    if (!(n >= 0) || (mode !== 'count' && n === 0)) return bad('Adet geçersiz.');
    const st = mode === 'count' ? setQty(env, key, n, { type: 'count', channel: 'manuel', note }) : changeQty(env, key, mode === 'in' ? n : -n, { type: mode === 'in' ? 'in' : 'out', channel: 'manuel', note });
    await env.DB.batch([...st, REV(env)]);
    const after = await env.DB.prepare('SELECT qty FROM products WHERE key=?1').bind(key).first();
    return json({ ok: true, qty: after.qty });
  }
  if (path === '/api/orders/manual') {
    const channel = String(body.channel || 'manuel'), orderNo = String(body.orderNo || '').trim();
    if (!orderNo) return bad('Sipariş numarası gerekli.');
    const lines = (body.lines || []).filter(l => String(l.sku || '').trim() && intOr(l.qty, 0) > 0).map(l => ({ sku: String(l.sku).trim(), qty: intOr(l.qty, 0), status: 'active', name: '', price: numOrNull(l.price) }));
    if (!lines.length) return bad('En az bir kalem gerekli.');
    const known = new Map((await selectIn(env, 'SELECT key, name FROM products', 'key', lines.map(l => skuKey(l.sku)))).map(r => [r.key, r.name]));
    lines.forEach(l => { l.name = known.get(skuKey(l.sku)) || l.sku; });
    const st = await ingestOrders(env, channel, [{ orderNo, date: body.date || iso(), lines }], { source: 'manual', start: null });
    return json({ ok: true, stats: st });
  }
  if (path === '/api/orders/cancel') {
    const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?1').bind(String(body.id || '')).first(); if (!o) return bad('Sipariş bulunamadı.', 404);
    const lines = JSON.parse(o.lines || '[]').map(l => ({ ...l, status: 'cancelled' }));
    const st = await ingestOrders(env, o.channel, [{ orderNo: o.order_no, date: o.date, lines }], { source: o.source, start: null });
    return json({ ok: true, stats: st });
  }
  if (path === '/api/returns') {
    const sku = String(body.sku || '').trim(); const qty = intOr(body.qty, 0);
    if (!sku || qty <= 0) return bad('Stok kodu ve adet gerekli.');
    const pkey = body.pkey || skuKey(sku); const p = await env.DB.prepare('SELECT sku, name FROM products WHERE key=?1').bind(pkey).first();
    if (!p) return bad('Bu stok koduyla ürün bulunamadı.', 404);
    const id = uid('r-'); const st = [env.DB.prepare(`INSERT INTO returns(id,channel,order_no,order_id,line_key,pkey,sku,name,qty,status,source,note,ext_status,created_at,decided_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'requested','manual',?10,'',?11,NULL)`)
      .bind(id, String(body.channel || 'manuel'), String(body.orderNo || ''), String(body.orderId || ''), String(body.lineKey || ''), pkey, p.sku, p.name, qty, String(body.note || '').slice(0, 300), iso())];
    if (body.orderId && body.lineKey) {
      const o = await env.DB.prepare('SELECT lines FROM orders WHERE id=?1').bind(body.orderId).first();
      if (o) { const lines = JSON.parse(o.lines).map(l => l.key === body.lineKey ? { ...l, ret: true } : l); st.push(env.DB.prepare('UPDATE orders SET lines=?1, status=?2, version=version+1, updated_at=?3 WHERE id=?4').bind(JSON.stringify(lines), orderStatus(lines), iso(), body.orderId)); }
    }
    st.push(REV(env)); await env.DB.batch(st); return json({ ok: true, id });
  }
  if (path === '/api/returns/decide') {
    const r = await env.DB.prepare('SELECT * FROM returns WHERE id=?1').bind(String(body.id || '')).first();
    if (!r) return bad('İade bulunamadı.', 404);
    if (r.status !== 'requested') return bad('Bu iade zaten işlenmiş.', 409);
    const now = iso();
    const st = [guardStmt(env, `(SELECT status FROM returns WHERE id=?1)='requested'`, r.id), env.DB.prepare('UPDATE returns SET status=?1, decided_at=?2 WHERE id=?3').bind(body.accept ? 'accepted' : 'rejected', now, r.id)];
    if (body.accept) st.push(...ensureProduct(env, r.pkey, { sku: r.sku, name: r.name }, null), ...changeQty(env, r.pkey, r.qty, { type: 'ret', channel: r.channel, ref: r.order_no, note: 'Depoya ulaştı, kabul edildi' }));
    st.push(unguard(env), REV(env));
    try { await env.DB.batch(st); } catch (e) { return bad('Bu iade az önce başka bir yerden işlendi.', 409); }
    return json({ ok: true });
  }
  if (path === '/api/settings') {
    const st = [];
    if (body.startedAt) { const d = Date.parse(body.startedAt); if (!d) return bad('Tarih geçersiz.'); st.push(setStmt(env, 'started_at', iso(d)), setStmt(env, 'started_at_auto', '0')); }
    if (body.autoAccept !== undefined) st.push(setStmt(env, 'auto_accept', body.autoAccept ? '1' : '0'));
    if (body.prodInitial !== undefined) st.push(setStmt(env, 'ty_prod_initial', body.prodInitial ? '1' : '0'));
    if (body.desiTable !== undefined) { const t = parseDesiTable(JSON.stringify(body.desiTable)); st.push(setStmt(env, 'desi_table', JSON.stringify(t))); }
    if (body.desiTables !== undefined) { const t = { tex: parseDesiTable(JSON.stringify((body.desiTables || {}).tex || [])), ptt: parseDesiTable(JSON.stringify((body.desiTables || {}).ptt || [])) }; if (!t.tex.length || !t.ptt.length) return bad('İki desi tablosu da en az bir satır içermeli.'); st.push(setStmt(env, 'desi_tables', JSON.stringify(t))); }
    if (body.desiMode !== undefined) st.push(setStmt(env, 'cargo_desi_mode', body.desiMode ? '1' : '0'));
    for (const [k, f] of [['feeCargoT1', 'fee_cargo_t1'], ['feeCargoT2', 'fee_cargo_t2'], ['feeCargoT3', 'fee_cargo_t3'], ['feeServiceTy', 'fee_service_ty'], ['feeServiceFast', 'fee_service_fast'], ['serviceCutoff', 'service_cutoff'], ['baremMaxDesi', 'barem_max_desi'], ['feeCargoSh', 'fee_cargo_sh'], ['stopaj', 'stopaj']]) {
      if (body[k] !== undefined) { const n = numOrNull(body[k]); if (n === null || n < 0 || n > 100000) return bad('Gider değeri geçersiz.'); st.push(setStmt(env, f, n)); }
    }
    if (body.pushStock !== undefined) st.push(setStmt(env, 'ty_push', body.pushStock ? '1' : '0'));
    if (body.resyncProducts) st.push(setStmt(env, 'ty_prod_page', 0), setStmt(env, 'ty_prod_done', '1970-01-01T00:00:00.000Z'));
    if (st.length) { st.push(REV(env)); await env.DB.batch(st); }
    return json({ ok: true });
  }
  if (path === '/api/ingest/orders') {
    if (!Array.isArray(body.orders) || body.orders.length > 300) return bad('Sipariş listesi geçersiz.');
    const st = await ingestOrders(env, String(body.channel || 'manuel'), body.orders, { dry: !!body.dry, source: 'import' });
    if (!body.dry && body.label) await setSetting(env, 'last_import', JSON.stringify({ at: iso(), label: String(body.label).slice(0, 160) }));
    return json({ ok: true, stats: st });
  }
  if (path === '/api/ingest/products') {
    if (!Array.isArray(body.items) || body.items.length > 1000) return bad('Ürün listesi geçersiz.');
    const st = await ingestProducts(env, String(body.channel || 'manuel'), body.items, { dry: !!body.dry, useStock: !!body.useStock, overwrite: !!body.overwrite });
    if (!body.dry && body.label) await setSetting(env, 'last_import', JSON.stringify({ at: iso(), label: String(body.label).slice(0, 160) }));
    return json({ ok: true, stats: st });
  }
  if (path === '/api/profit') {
    const from = Date.parse(body.from), to = Date.parse(body.to);
    if (!from || !to || to <= from || to - from > 400 * 86400000) return bad('Tarih aralığı geçersiz.');
    return json(await computeProfit(env, iso(from), iso(to)));
  }
  if (path === '/api/pricing') return json(await computePricing(env));
  if (path === '/api/finance/details') {
    // Trendyol panelinden indirilen fatura "detay" Excel'leri: sipariş bazında gerçek hizmet bedeli ve ceza tutarları
    const rows = Array.isArray(body.rows) ? body.rows : null; if (!rows || rows.length > 20000) return bad('Detay satırları geçersiz.');
    const inv = String(body.invoice || 'x').replace(/[^0-9A-Za-z-]/g, '').slice(0, 40) || 'x'; const kind = body.kind; const st = []; const now = iso();
    if (kind === 'service') {
      const by = new Map(); for (const r of rows) { const no = String(r.orderNo || '').trim(); const a = Number(r.amount); if (!no || !Number.isFinite(a)) continue; by.set(no, Math.round(((by.get(no) || 0) + a) * 100) / 100); }
      for (const [no, a] of by) st.push(env.DB.prepare(`INSERT INTO order_fin(order_no,service,updated_at) VALUES(?1,?2,?3) ON CONFLICT(order_no) DO UPDATE SET service=excluded.service, updated_at=excluded.updated_at WHERE order_fin.service IS NOT excluded.service`).bind(no, a, now));
    } else if (kind === 'penalty') {
      rows.forEach((r, i) => { const no = String(r.orderNo || '').trim(); const a = Number(r.amount); if (!no || !Number.isFinite(a) || !a) return;
        st.push(env.DB.prepare(`INSERT INTO fin_misc(id,order_no,date,type,amount,descr) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET amount=excluded.amount, type=excluded.type, order_no=excluded.order_no`)
          .bind(('xl|' + inv + '|' + no + '|' + i).slice(0, 120), no, now, String(r.type || 'Ceza').slice(0, 80), Math.round(a * 100) / 100, 'Detay dosyasından')); });
    } else return bad('Bilinmeyen detay türü.');
    st.push(REV(env)); for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    return json({ ok: true, saved: st.length - 1 });
  }
  if (path === '/api/products/sameday') {
    const v = body.on ? 1 : 0; const keys = Array.isArray(body.keys) ? body.keys.map(String) : null;
    if (keys) { const st = keys.map(k => env.DB.prepare('UPDATE products SET same_day=?1 WHERE key=?2').bind(v, k)); st.push(REV(env)); for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90)); }
    else await env.DB.batch([env.DB.prepare('UPDATE products SET same_day=?1').bind(v), REV(env)]);
    return json({ ok: true });
  }
  if (path === '/api/orders/page') {
    // Sipariş ekranı: sayfa başına 100 sipariş; durum, kanal ve arama süzgeci sunucuda
    const size = 100, page = Math.max(1, intOr(body.page, 1));
    const where = [], args = [];
    const f = String(body.filter || 'all');
    if (f === 'active') where.push(`o.status='active'`); else if (f === 'cancelled') where.push(`o.status IN ('cancelled','partial')`); else if (f === 'returned') where.push(`o.status='returned'`);
    if (body.channel) { args.push(String(body.channel)); where.push(`o.channel=?${args.length}`); }
    const q = String(body.q || '').trim();
    if (q) {
      args.push('%' + q.replace(/[%_]/g, '') + '%'); const a1 = args.length;
      args.push('%' + q.toLocaleLowerCase('tr-TR').replace(/[%_]/g, '') + '%'); const a2 = args.length;
      const bc = await env.DB.prepare('SELECT sku FROM products WHERE barcode=?1').bind(q).first();
      let extra = ''; if (bc) { args.push('%' + bc.sku + '%'); extra = ` OR o.lines LIKE ?${args.length}`; }
      where.push(`(o.order_no LIKE ?${a1} OR c.sname LIKE ?${a2} OR o.lines LIKE ?${a1}${extra})`);
    }
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const J = `FROM orders o LEFT JOIN order_cust c ON c.order_no=o.order_no AND o.channel='trendyol' ${W}`;
    const tot = await env.DB.prepare(`SELECT COUNT(*) n ${J}`).bind(...args).first();
    const { results } = await env.DB.prepare(`SELECT o.*, json_extract(c.data,'$.name') cname ${J} ORDER BY o.date DESC LIMIT ${size} OFFSET ${(page - 1) * size}`).bind(...args).all();
    return json({ ok: true, page, size, total: tot ? tot.n : 0, orders: results.map(mapOrder) });
  }
  if (path === '/api/orders/search') {
    // Sipariş no, müşteri adı, ürün adı / stok kodu / barkod ile arama (son 300 siparişin dışındakiler dahil)
    const q = String(body.q || '').trim(); if (q.length < 2) return json({ ok: true, orders: [] });
    const ql = '%' + q.toLocaleLowerCase('tr-TR').replace(/[%_]/g, '') + '%', qr = '%' + q.replace(/[%_]/g, '') + '%';
    const bc = await env.DB.prepare('SELECT sku FROM products WHERE barcode=?1').bind(q).first();
    const { results } = await env.DB.prepare(`SELECT o.*, json_extract(c.data,'$.name') cname FROM orders o LEFT JOIN order_cust c ON c.order_no=o.order_no AND o.channel='trendyol'
      WHERE o.order_no LIKE ?1 OR c.sname LIKE ?2 OR o.lines LIKE ?1 ${bc ? 'OR o.lines LIKE ?3' : ''} ORDER BY o.date DESC LIMIT 100`).bind(...(bc ? [qr, ql, '%' + bc.sku + '%'] : [qr, ql])).all();
    return json({ ok: true, orders: results.map(mapOrder) });
  }
  if (path === '/api/orders/customer') {
    const r = await env.DB.prepare('SELECT data, updated_at FROM order_cust WHERE order_no=?1').bind(String(body.orderNo || '')).first();
    return json({ ok: true, customer: r ? JSON.parse(r.data) : null });
  }
  if (path === '/api/ads') {
    const items = Array.isArray(body.items) ? body.items : null; if (!items || items.length > 1000) return bad('Reklam listesi geçersiz.');
    const ch = ['trendyol', 'shopify', 'hepsiburada', 'temu', 'diger'].includes(body.channel) ? body.channel : 'trendyol';
    const st = []; let n = 0;
    for (const it of items) {
      const day = String(it.day || ''); const amt = Number(it.amount);
      if (!/^20\d\d-\d\d-\d\d$/.test(day) || !Number.isFinite(amt) || amt < 0) return bad('Geçersiz satır: ' + day + ' · ' + it.amount);
      if (amt === 0) st.push(env.DB.prepare('DELETE FROM ad_spend WHERE day=?1 AND channel=?2').bind(day, ch));
      else st.push(env.DB.prepare('INSERT INTO ad_spend(day,channel,amount,source,updated_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(day,channel) DO UPDATE SET amount=excluded.amount, source=excluded.source, updated_at=excluded.updated_at').bind(day, ch, Math.round(amt * 100) / 100, String(body.source || 'manuel').slice(0, 20), iso()));
      n++;
    }
    st.push(REV(env)); for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    return json({ ok: true, saved: n });
  }
  if (path === '/api/audit') {
    const s = await getSettings(env, ['audit_state', 'audit_at', 'audit_started', 'audit_found', 'fin_backfill_day', 'recon_q']);
    let q = 0; try { q = JSON.parse(s.recon_q || '[]').length; } catch (e) {}
    return json({ state: s.audit_state || 'idle', at: s.audit_at, started: s.audit_started, found: Number(s.audit_found) || 0, scanDay: s.fin_backfill_day, queue: q, ...(await auditCompare(env, body.from)) });
  }
  if (path === '/api/audit/start') {
    if (!tyConfigured(env)) return bad('Trendyol bilgileri girilmemiş.');
    await env.DB.batch([setStmt(env, 'fin_backfill_day', '13'), setStmt(env, 'audit_state', 'running'), setStmt(env, 'audit_started', iso()), REV(env)]);
    return json({ ok: true });
  }
  if (path === '/api/audit/fix') {
    const c = await auditCompare(env); const nos = c.mismatches.map(m => m.orderNo);
    await processReconQueue(env, nos, 0); await setSetting(env, 'audit_state', 'fixing');
    return json({ ok: true, queued: nos.length });
  }
  if (path === '/api/finance/sync') {
    if (!tyConfigured(env)) return bad('Trendyol bilgileri girilmemiş.');
    try { const r = await syncTrendyolFinance(env, true); await setSetting(env, 'fin_err', ''); return json({ ok: true, result: r }); }
    catch (e) { await setSetting(env, 'fin_err', iso() + ' · Cari hesap ekstresi: ' + String(e.message || e).slice(0, 200)); return bad('Trendyol cari hesap ekstresi okunamadı: ' + String(e.message || e).slice(0, 200), 502); }
  }
  if (path === '/api/costs') {
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items || items.length > 5000) return bad('Fiyat listesi geçersiz.');
    const bmap = await barcodeMap(env, items.filter(x => !String(x.sku || '').trim()).map(x => String(x.barcode || '').trim()));
    const want = new Map();
    for (const it of items) {
      let cost = numOrNull(it.cost); if (cost !== null && cost < 0) cost = null; if (cost === null && !body.setStock) continue;
      const r = resolveLine(it, bmap); if (!r) continue;
      const stock = body.setStock && it.stock !== null && it.stock !== undefined && it.stock !== '' && Number.isFinite(Number(it.stock)) && Number(it.stock) >= 0 ? Math.round(Number(it.stock)) : null;
      want.set(r.pkey, { cost: cost === null ? null : Math.round(cost * 100) / 100, stock, label: String(it.sku || it.barcode || '').trim() });
    }
    const rows = await selectIn(env, 'SELECT key, sku, name, cost, qty FROM products', 'key', [...want.keys()]);
    const found = new Map(rows.map(r => [r.key, r]));
    const stats = { updated: 0, unchanged: 0, notFound: 0, notFoundList: [], stockUpdated: 0, stockDelta: 0 };
    const changes = [], stockChanges = [];
    for (const [key, w] of want) {
      const p = found.get(key);
      if (!p) { stats.notFound++; if (stats.notFoundList.length < 20) stats.notFoundList.push(w.label); continue; }
      if (w.stock !== null && w.stock !== p.qty) { stats.stockUpdated++; stats.stockDelta += w.stock - p.qty; stockChanges.push({ key, sku: p.sku, name: p.name, oldQty: p.qty, qty: w.stock }); }
      if (w.cost === null) continue;
      if (p.cost !== null && Math.abs(p.cost - w.cost) < 0.005) { stats.unchanged++; continue; }
      stats.updated++; changes.push({ key, sku: p.sku, name: p.name, old: p.cost, cost: w.cost });
    }
    if (!body.dry && (changes.length || stockChanges.length)) {
      const now = iso();
      const all = [...changes.map(c => env.DB.prepare('UPDATE products SET cost=?1, updated_at=?2 WHERE key=?3').bind(c.cost, now, c.key)),
        ...stockChanges.flatMap(c => setQty(env, c.key, c.qty, { type: 'count', channel: 'manuel', note: 'Excel ile stok güncelleme' }))];
      for (let i = 0; i < all.length; i += 80) { const part = all.slice(i, i + 80); part.push(REV(env)); await env.DB.batch(part); }
    }
    return json({ ok: true, stats, sample: changes.slice(0, 8), stockSample: stockChanges.slice(0, 8) });
  }
  if (path === '/api/sync') {
    if (!tyConfigured(env)) return bad('Trendyol bilgileri girilmemiş.');
    if (!(await tryLock(env, 60000))) return json({ ok: true, busy: true });
    try { const r = await pollOnce(env, true); return json({ ok: !r.error, result: r, error: r.error }); } finally { await unlock(env); }
  }
  if (path === '/api/export') {
    const [p, o, r, m, s] = await env.DB.batch(['products', 'orders', 'returns', 'moves', 'settings'].map(t => env.DB.prepare(`SELECT * FROM ${t}`)));
    return new Response(JSON.stringify({ app: 'lilya-backstage', format: 'd1', version: 2, exportedAt: iso(), products: p.results, orders: o.results, returns: r.results, moves: m.results, settings: s.results.filter(x => !['lock_sync', 'rev'].includes(x.k)) }), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="lilya-backstage-yedek-${iso().slice(0, 10)}.json"` } });
  }
  if (path === '/api/restore') {
    const table = body.table, rows = body.rows;
    const cols = { products: ['key', 'sku', 'name', 'barcode', 'image', 'channels', 'qty', 'cost', 'min', 'created_at', 'updated_at'], orders: ['id', 'channel', 'order_no', 'date', 'status', 'source', 'baseline', 'lines', 'version', 'created_at', 'updated_at'], returns: ['id', 'channel', 'order_no', 'order_id', 'line_key', 'pkey', 'sku', 'name', 'qty', 'status', 'source', 'note', 'ext_status', 'created_at', 'decided_at'], moves: ['id', 't', 'pkey', 'sku', 'name', 'delta', 'after', 'type', 'channel', 'ref', 'note'], settings: ['k', 'v'] }[table];
    if (!cols || !Array.isArray(rows) || rows.length > 200) return bad('Geri yükleme verisi geçersiz.');
    const st = rows.filter(r => !(table === 'settings' && ['lock_sync', 'rev'].includes(r.k))).map(r => env.DB.prepare(`INSERT OR REPLACE INTO ${table}(${cols.join(',')}) VALUES(${cols.map((_, i) => '?' + (i + 1)).join(',')})`).bind(...cols.map(c => r[c] === undefined ? null : r[c])));
    st.push(REV(env)); await env.DB.batch(st); return json({ ok: true, n: rows.length });
  }
  return bad('Bulunamadı', 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url); const path = url.pathname;
    try {
      if (!env.APP_PASSWORD) return new Response('Kurulum eksik: APP_PASSWORD gizli değişkeni tanımlanmalı.', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      await init(env);
      if (path === '/manifest.webmanifest') return new Response(JSON.stringify({ name: 'Lilya Backstage', short_name: 'Backstage', start_url: '/', display: 'standalone', background_color: '#edf0ea', theme_color: '#1f3a30', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] }), { headers: { 'content-type': 'application/manifest+json' } });
      if (path === '/icon.svg' || path === '/apple-touch-icon.png') return new Response(ICON_SVG, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
      if (path === '/api/login' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const ok = typeof b.password === 'string' && (await hmac('cmp', b.password)) === (await hmac('cmp', env.APP_PASSWORD));
        if (!ok) { await sleep(900); return bad('Şifre hatalı.', 401); }
        return json({ ok: true }, 200, { 'set-cookie': await loginCookie(env) });
      }
      if (path === '/api/logout') return json({ ok: true }, 200, { 'set-cookie': 'lb=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
      if (path.startsWith('/api/')) {
        if (!(await authed(req, env))) return bad('Oturum gerekli.', 401);
        return await api(req, env, path);
      }
      return new Response(APP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
    } catch (e) {
      return bad('Sunucu hatası: ' + String(e && e.message || e).slice(0, 300), 500);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(cronRun(env)); }
};

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" rx="40" fill="#1f3a30"/><text x="90" y="128" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="112" fill="#f1eedf">L</text></svg>`;

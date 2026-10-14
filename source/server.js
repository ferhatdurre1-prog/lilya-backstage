/* Lilya Backstage — Cloudflare Worker
   Gerekli bağlamalar: D1 veritabanı "DB"
   Gizli değişkenler: APP_PASSWORD, TRENDYOL_SELLER_ID, TRENDYOL_API_KEY, TRENDYOL_API_SECRET
   Zamanlayıcı (Cron): "* * * * *"  → her dakika içinde 10 saniye arayla 6 eşitleme */

const APP_VERSION = '1.0.0';
const APP_BUILD = '__BUILD__';
const TY_BASE = 'https://apigw.trendyol.com/integration/';
let READY = false;
let PERF_LAST = null;

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

let COLD_MS = null;
async function init(env) {
  if (READY) return;
  const ti0 = Date.now();
  try {
    // Kurulum/geçiş kontrolleri bu sürüm için bir kez yapıldıysa tek sorguyla geçilir
    let done = false;
    try { const r = await env.DB.prepare(`SELECT v FROM settings WHERE k='schema_build'`).first(); done = !!(r && r.v === APP_BUILD); } catch (e) {}
    if (!done) { await init0(env); await env.DB.prepare(`INSERT INTO settings(k,v) VALUES('schema_build',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(APP_BUILD).run(); }
    READY = true;
  } finally { COLD_MS = Date.now() - ti0; }
}
async function init0(env) {
  if (!env.DB) throw new Error('D1 veritabanı bağlanmamış (DB).');
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  await env.DB.prepare(`INSERT OR IGNORE INTO settings(k,v) VALUES('started_at',?1)`).bind(iso()).run();
  try { await env.DB.prepare('ALTER TABLE products ADD COLUMN ty_qty INTEGER').run(); } catch (e) { /* sütun zaten var */ }
  let priceCol = false;
  try { await env.DB.prepare('ALTER TABLE products ADD COLUMN ty_price REAL').run(); priceCol = true; } catch (e) {}
  for (const c of ['ty_comm REAL', 'ty_vat REAL', 'desi REAL', 'same_day INTEGER', 'ty_passive INTEGER']) { try { await env.DB.prepare('ALTER TABLE products ADD COLUMN ' + c).run(); } catch (e) {} }
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
  try { await env.DB.prepare('ALTER TABLE order_fin ADD COLUMN ret_desi REAL').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE returns ADD COLUMN ext_at TEXT').run(); } catch (e) {}
  // Kargo faturaları bir kez baştan okunur (önceki okumalar yarıda kalmış olabilir); tutarlar sıfırlanıp yeniden yazılır, çift sayılmaz
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_cargo_reread3'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_cargo_reread3','1')`), env.DB.prepare('UPDATE order_fin SET cargo=NULL, ret_cargo=NULL'), setStmt(env, 'cargo_inv_done', '[]'), setStmt(env, 'fin_at', '')]); } catch (e) {} }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_passive1'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_passive1','1')`), setStmt(env, 'ty_prod_page', 0), setStmt(env, 'ty_prod_done', '1970-01-01T00:00:00.000Z')]); } catch (e) {} }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_ordslice1'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_ordslice1','1')`), setStmt(env, 'ty_orders_exact', '')]); } catch (e) {} }
  for (const c of ['auto_at TEXT', 'desi REAL', 'chk_at TEXT', 'claim_id TEXT', 'item_id TEXT', 'customer TEXT', 'amount REAL', 'reason TEXT', 'cnote TEXT', 'cargo TEXT', 'cargo_link TEXT']) { try { await env.DB.prepare('ALTER TABLE returns ADD COLUMN ' + c).run(); } catch (e) {} }
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS order_cust(order_no TEXT PRIMARY KEY, channel TEXT, data TEXT, updated_at TEXT)').run();
  try { await env.DB.prepare('ALTER TABLE order_cust ADD COLUMN sname TEXT').run(); } catch (e) {}
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS product_info(main_id TEXT PRIMARY KEY, title TEXT, descr TEXT, attrs TEXT, image TEXT, updated_at TEXT, note TEXT)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS qna(id TEXT PRIMARY KEY, main_id TEXT, product_name TEXT, image TEXT, web_url TEXT, text TEXT, created_at TEXT, status TEXT, answer TEXT, answered_at TEXT, draft TEXT, draft_flag INTEGER, draft_at TEXT, draft_err TEXT, updated_at TEXT)').run();
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_pinfo1'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_pinfo1','1')`), setStmt(env, 'ty_prod_page', 0), setStmt(env, 'ty_prod_done', '1970-01-01T00:00:00.000Z')]); } catch (e) {} }
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS daily_stats(day TEXT PRIMARY KEY, data TEXT, computed_at TEXT)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS product_daily(day TEXT, pkey TEXT, sku TEXT, name TEXT, units INTEGER, ret_units INTEGER, revenue REAL, profit REAL, PRIMARY KEY(day, pkey))').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(date)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT, name TEXT, amount REAL, created_at TEXT)').run();
  try { await env.DB.prepare("ALTER TABLE expenses ADD COLUMN kind TEXT NOT NULL DEFAULT 'gider'").run(); } catch (e) {}
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_creds(id TEXT PRIMARY KEY, jwk TEXT, counter INTEGER, created_at TEXT, used_at TEXT, label TEXT)').run();
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
  let start = hwm ? hwm - TY_TZ - 15 * 60000 : now - maxBackDays * 86400000; // son okunandan 15 dk geriden (geç işlenen değişiklikler için pay)
  if (end - start > 14 * 86400000 - 120000) start = end - 14 * 86400000 + 120000;
  return { start, end };
}
async function syncTrendyolOrders(env) {
  const now = Date.now();
  const s = await getSettings(env, ['ty_orders_hwm', 'ty_shift', 'ty_orders_exact']);
  const hwm = Number(s.ty_orders_hwm) || 0, exact = Number(s.ty_orders_exact) || 0;
  let { start, end } = tyWindow(hwm, 13, now);
  const fullEnd = end;
  // Trendyol'un lastModifiedDate değeri ile sorgu saati arasındaki fark (ty_shift: 0 ya da 3 saat). Dilim sınırları bununla çevrilir;
  // sabit 3 saat kullanılınca (fark 0 iken) dilim 3 saat ileri kayıyor ve yeni siparişler süzgeçte eleniyordu.
  const off = s.ty_shift !== null && s.ty_shift !== undefined && s.ty_shift !== '' ? Number(s.ty_shift) || 0 : TY_TZ;
  if (exact) { start = Math.max(start, exact - off - 1000); end = Math.min(end, start + 40 * 60000); } // yarım kalan işte kaldığı yerden, 40 dk'lık dilimlerle
  let pkgs;
  try { pkgs = await fetchOrderPackages(env, start, end); }
  catch (e) { if (e.status === 400) { end = now; pkgs = await fetchOrderPackages(env, start, end); } else throw e; }
  const latest = new Map();
  for (const p of pkgs) { const k = String(p.shipmentPackageId || p.id); const o = latest.get(k); if (!o || (p.lastModifiedDate || 0) >= (o.lastModifiedDate || 0)) latest.set(k, p); }
  // Bir çalışmada en fazla ORD_CHUNK paket işlenir (veritabanı sorgu sınırı); kalan sonraki turda kaldığı yerden
  const ORD_CHUNK = Math.max(5, Math.min(60, Math.floor((qLeft(env) - 90) / 6)));
  let all = [...latest.values()].sort((a, b) => (a.lastModifiedDate || 0) - (b.lastModifiedDate || 0));
  if (exact) all = all.filter(p => (p.lastModifiedDate || 0) >= exact);
  const truncated = all.length > ORD_CHUNK;
  const list = truncated ? all.slice(0, ORD_CHUNK) : all;
  let maxMod = hwm;
  for (const p of list) if (p.lastModifiedDate && p.lastModifiedDate > maxMod) maxMod = p.lastModifiedDate;
  let shift = s.ty_shift !== null && s.ty_shift !== undefined ? Number(s.ty_shift) : null;
  if (list.length && shift === null) { shift = maxMod > now + 30 * 60000 ? 3 * 3600000 : 0; await setSetting(env, 'ty_shift', shift); }
  let stats = null;
  // Paket durumları (bekleyen sipariş sayısı) siparişlerden ÖNCE yazılır; ekran yeni siparişi gördüğünde sayı da güncel olur
  if (list.length) { await recordAuditPkgs(env, list); stats = await ingestOrders(env, 'trendyol', tyPackagesToOrders(list, shift || 0), { source: 'trendyol' }); try { await recordCustomers(env, list); } catch (e) {} }
  const desiSt = [];
  for (const p of list) { const d = Number(p.cargoDeci ?? p.deci ?? p.desi); const ls = p.lines || []; if (d > 0 && ls.length === 1 && ls[0].stockCode) desiSt.push(env.DB.prepare('UPDATE products SET desi=?1 WHERE key=?2 AND desi IS NOT ?1').bind(Math.round(d / Math.max(1, Number(ls[0].quantity) || 1) * 100) / 100, skuKey(ls[0].stockCode))); }
  for (let i = 0; i < desiSt.length; i += 90) await env.DB.batch(desiSt.slice(i, i + 90));
  if (truncated) await env.DB.batch([setStmt(env, 'ty_orders_exact', String(list[list.length - 1].lastModifiedDate || 0)), setStmt(env, 'ty_orders_hwm', String(Math.max(hwm, Math.min(maxMod, list[list.length - 1].lastModifiedDate || maxMod))))]);
  else if (exact && end < fullEnd) await env.DB.batch([setStmt(env, 'ty_orders_exact', String(end + off)), setStmt(env, 'ty_orders_hwm', String(Math.max(hwm, maxMod)))]); // dilim bitti, sonraki dilime geç
  else await env.DB.batch([setStmt(env, 'ty_orders_exact', ''), setStmt(env, 'ty_orders_hwm', String(list.length ? maxMod : (hwm || Math.min(end, now))))]);
  return { packages: list.length, remaining: truncated ? all.length - list.length : 0, stats };
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
// Daha önce okunmuş kargo faturalarından yalnızca iade paketlerinin desisi bir kez geriye dönük alınır (tutarlara dokunulmaz)
async function backfillReturnDesi(env) {
  const s = await getSettings(env, ['ret_desi_bf', 'cargo_inv_done']);
  if (s.ret_desi_bf === 'done') return null;
  let todo = s.ret_desi_bf ? JSON.parse(s.ret_desi_bf) : JSON.parse(s.cargo_inv_done || '[]');
  if (!todo.length) { await setSetting(env, 'ret_desi_bf', 'done'); return null; }
  const sid = env.TRENDYOL_SELLER_ID; let n = 0, found = 0;
  for (const id of todo.slice(0, 1)) {
    const by = new Map();
    for (let p = 0; p < 20; p++) {
      const it = await ty(env, `finance/che/sellers/${sid}/cargo-invoice/${encodeURIComponent(id)}/items`, { page: p, size: 500 });
      for (const c of (it.content || [])) if (c.orderNumber && Number(c.desi) > 0 && String(c.shipmentPackageType || '').toLocaleLowerCase('tr-TR').includes('iade')) by.set(String(c.orderNumber), Math.max(by.get(String(c.orderNumber)) || 0, Number(c.desi)));
      if (p + 1 >= (it.totalPages || 0)) break;
    }
    const st = [...by].map(([no, d]) => env.DB.prepare(`INSERT INTO order_fin(order_no, ret_desi, updated_at) VALUES(?1,?2,?3) ON CONFLICT(order_no) DO UPDATE SET ret_desi=excluded.ret_desi WHERE order_fin.ret_desi IS NOT excluded.ret_desi`).bind(no, Math.round(d * 100) / 100, iso()));
    found += st.length; n++;
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  }
  todo = todo.slice(n);
  await setSetting(env, 'ret_desi_bf', todo.length ? JSON.stringify(todo) : 'done');
  if (found) await env.DB.batch([REV(env)]);
  return { invoices: n, returns: found, left: todo.length };
}
const CLAIM_OPEN = new Set(['Created', 'WaitingInAction', 'WaitingFraudCheck', 'InAnalysis', 'Unresolved']);
// Trendyol iade detayındaki "İade Desi" belgelenmemiş bir alanda gelir: adında desi/deci geçen ilk sayısal alan alınır
function findDesi(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(o)) if (/desi|deci/i.test(k) && Number(v) > 0 && Number(v) < 1000) return Number(v);
  for (const v of Object.values(o)) if (v && typeof v === 'object') { const d = findDesi(v, depth + 1); if (d) return d; }
  return null;
}
function keyPaths(o, pre = '', out = new Set(), depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return out;
  if (Array.isArray(o)) { if (o.length) keyPaths(o[0], pre + '[]', out, depth + 1); return out; }
  for (const [k, v] of Object.entries(o)) { out.add(pre + k + (v === null ? '=null' : typeof v !== 'object' ? '=' + String(v).slice(0, 24) : '')); if (v && typeof v === 'object') keyPaths(v, pre + k + '.', out, depth + 1); }
  return out;
}
let CLAIM_SHAPE = null;
function claimItems(claims) {
  const items = [];
  if (claims.length) CLAIM_SHAPE = [...keyPaths(claims[0])];
  for (const c of claims) {
    const desi = findDesi(c);
    const claimId = String(c.id || c.claimId || '');
    const customer = [c.customerFirstName, c.customerLastName].filter(Boolean).join(' ').trim().slice(0, 80);
    for (const it of (c.items || [])) {
      const ol = it.orderLine || {};
      for (const ci of (it.claimItems || [])) {
        const stName = (ci.claimItemStatus && ci.claimItemStatus.name) || '';
        const mapped = stName === 'Accepted' ? 'accepted' : (stName === 'Rejected' || stName === 'Cancelled') ? 'rejected' : 'requested';
        const reason = (ci.customerClaimItemReason && ci.customerClaimItemReason.name) || (ci.trendyolClaimItemReason && ci.trendyolClaimItemReason.name) || '';
        items.push({ autoAt: Number(ci.autoApproveDate) > 0 ? iso(Number(ci.autoApproveDate)) : null, desi, id: 'ty-' + safeSeg(String(ci.id)), itemId: String(ci.id), claimId, customer, amount: numOrNull(ol.price), reason, cnote: String(ci.customerNote || '').slice(0, 300), cargo: String(c.cargoProviderName || '').slice(0, 60), cargoLink: String(c.cargoTrackingLink || '').slice(0, 300), orderNo: String(c.orderNumber || ''), sku: ol.merchantSku || '', barcode: ol.barcode || '', name: ol.productName || '', ext: stName, mapped, autoAcc: ci.autoAccepted === true, claimDate: c.claimDate ? iso(Number(c.claimDate)) : iso(), note: reason });
      }
    }
  }
  return items;
}
async function applyClaimItems(env, items, s) {
  const auto = s.auto_accept !== '0';
  let added = 0, accepted = 0;
  if (!items.length) return { added, accepted };
  const bmap = await barcodeMap(env, items.filter(x => !x.sku).map(x => x.barcode));
  const existing = new Map((await selectIn(env, 'SELECT id, status, ext_status, claim_id, desi, auto_at FROM returns', 'id', items.map(x => x.id))).map(r => [r.id, r]));
  const meta = (it) => [it.claimId, it.itemId, it.customer, it.amount, it.reason, it.cnote, it.cargo, it.cargoLink, it.desi, it.autoAt];
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
        stmts.push(env.DB.prepare(`INSERT INTO returns(id,channel,order_no,order_id,line_key,pkey,sku,name,qty,status,source,note,ext_status,created_at,decided_at,ext_at,claim_id,item_id,customer,amount,reason,cnote,cargo,cargo_link,desi,auto_at) VALUES(?1,'trendyol',?2,?3,'',?4,?5,?6,1,?7,'trendyol',?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)`)
          .bind(it.id, it.orderNo, orderId('trendyol', it.orderNo), r.pkey, sku, it.name, finalStatus, preStart && finalStatus === 'accepted' ? 'Başlangıç öncesi; stok değişmedi' : it.note, it.ext, it.claimDate, finalStatus !== 'requested' ? now2 : null, now2, ...meta(it)));
        if (finalStatus === 'accepted' && !preStart) { stmts.push(...changeQty(env, r.pkey, 1, { type: 'ret', channel: 'trendyol', ref: it.orderNo, note: 'Trendyol iadesi kabul edildi' })); accepted++; }
        stmts.push(REV(env)); await env.DB.batch(stmts); added++;
        continue;
      }
      // Trendyol ayrıntıları (müşteri, tutar, sebep, kargo) eski kayıtlara bir kez eklenir
      if (!ex.claim_id || ex.claim_id === '-') stmts.push(env.DB.prepare(`UPDATE returns SET claim_id=?2, item_id=?3, customer=?4, amount=?5, reason=?6, cnote=?7, cargo=?8, cargo_link=?9, desi=?10, auto_at=?11 WHERE id=?1`).bind(it.id, ...meta(it)));
      else if ((it.desi && Number(ex.desi) !== it.desi) || (it.autoAt || null) !== (ex.auto_at || null)) stmts.push(env.DB.prepare(`UPDATE returns SET desi=COALESCE(?2, desi), auto_at=?3 WHERE id=?1`).bind(it.id, it.desi, it.autoAt));
      if (ex.status === 'requested' && (it.mapped !== 'requested' || ex.ext_status !== it.ext)) {
        if (it.mapped === 'accepted' && auto && !it.autoAcc) {
          stmts.push(guardStmt(env, `(SELECT status FROM returns WHERE id=?1)='requested'`, it.id),
            env.DB.prepare(`UPDATE returns SET status='accepted', ext_status=?2, decided_at=?3, ext_at=?3 WHERE id=?1`).bind(it.id, it.ext, now2),
            ...changeQty(env, r.pkey, 1, { type: 'ret', channel: 'trendyol', ref: it.orderNo, note: 'Trendyol iadesi kabul edildi' }), unguard(env));
          accepted++;
        } else if (it.mapped === 'rejected') {
          stmts.push(env.DB.prepare(`UPDATE returns SET status='rejected', ext_status=?2, decided_at=?3, ext_at=?3 WHERE id=?1 AND status='requested'`).bind(it.id, it.ext, now2));
        } else if (ex.ext_status !== it.ext) {
          const addNote = it.mapped === 'accepted' && it.autoAcc;
          stmts.push(env.DB.prepare(`UPDATE returns SET ext_status=?2, ext_at=?3${addNote ? ", note=CASE WHEN note LIKE 'Trendyol otomatik%' THEN note ELSE ?4 || CASE WHEN note<>'' THEN ' · ' || note ELSE '' END END" : ''} WHERE id=?1`).bind(...(addNote ? [it.id, it.ext, now2, AUTO_ACC_NOTE] : [it.id, it.ext, now2])));
        }
      } else if (ex.status !== 'requested' && ex.ext_status !== it.ext) {
        // burada karar verilmiş iadenin Trendyol durumu da güncel görünsün (stok değişmez)
        stmts.push(env.DB.prepare(`UPDATE returns SET ext_status=?2, ext_at=?3 WHERE id=?1`).bind(it.id, it.ext, now2));
      }
      if (stmts.length) { stmts.push(REV(env)); await env.DB.batch(stmts); }
    } catch (e) { /* yarış durumunda bir sonraki turda yeniden denenir */ }
  }
  return { added, accepted };
}
async function syncTrendyolClaims(env) {
  const sid = env.TRENDYOL_SELLER_ID, now = Date.now();
  const s = await getSettings(env, ['ty_claims_hwm', 'auto_accept', 'started_at', 'ty_shift']);
  const hwm = Number(s.ty_claims_hwm) || 0;
  const { start, end } = tyWindow(hwm, 13, now);
  const claims = []; let maxMod = hwm;
  for (let page = 0; page < 10; page++) {
    let r;
    try { r = await ty(env, `order/sellers/${sid}/claims`, { startDate: start, endDate: end, size: 200, page }); }
    catch (e) { if (e.status === 400 && page === 0) r = await ty(env, `order/sellers/${sid}/claims`, { startDate: start, endDate: now, size: 200, page }); else throw e; }
    claims.push(...(r.content || []));
    if (page + 1 >= (r.totalPages || 0)) break;
  }
  for (const c of claims) if (c.lastModifiedDate && c.lastModifiedDate > maxMod) maxMod = c.lastModifiedDate;
  const res = await applyClaimItems(env, claimItems(claims), s);
  await setSetting(env, 'ty_claims_hwm', String(claims.length ? maxMod : (hwm || Math.min(end, now))));
  return { claims: claims.length, added: res.added, accepted: res.accepted };
}
async function reconcileTrendyolClaims(env, deadline) {
  const sid = env.TRENDYOL_SELLER_ID, now = Date.now();
  const s = await getSettings(env, ['auto_accept', 'started_at']);
  // Açık iadeler Trendyol'la tek tek karşılaştırılır: değişikliği kaçırılmış (iptal, onay, kargoya verildi vb.) talepler burada düzelir.
  // Her açık iade en geç 30 dakikada bir kontrol edilir; turda en fazla 10 talep.
  let filled = 0, checked = 0;
  const lookup = async (cid, orderNo, createdAt) => {
    if (cid && cid !== '-') { const r = await ty(env, `order/sellers/${sid}/claims`, { claimIds: cid, size: 50, page: 0 }); return r.content || []; }
    let r = await ty(env, `order/sellers/${sid}/claims`, { orderNumber: orderNo, size: 50, page: 0 });
    if ((r.content || []).length) return r.content;
    const c = Date.parse(createdAt) || now, st = c - 86400000, en = Math.min(st + 13 * 86400000, now);
    r = await ty(env, `order/sellers/${sid}/claims`, { orderNumber: orderNo, startDate: st, endDate: en, size: 50, page: 0 });
    return r.content || [];
  };
  try {
    const cut = iso(now - 30 * 60000);
    const { results } = await env.DB.prepare(`SELECT COALESCE(NULLIF(claim_id,'-'), '') cid, order_no, MIN(created_at) created_at FROM returns
      WHERE channel='trendyol' AND id LIKE 'ty-%' AND order_no<>'' AND (status='requested' OR claim_id IS NULL) AND (chk_at IS NULL OR chk_at < ?1)
      GROUP BY cid, order_no ORDER BY MAX(status='requested') DESC, MIN(COALESCE(chk_at,'')) ASC LIMIT 10`).bind(cut).all();
    for (const g of results) {
      if (deadline && Date.now() > deadline) break;
      let list;
      try { list = await lookup(g.cid, g.order_no, g.created_at); } catch (e) { if (e.status === 429) break; continue; }
      if (g.cid) list = list.filter(c => String(c.id || c.claimId) === g.cid);
      const its = claimItems(list);
      if (its.length) { await applyClaimItems(env, its, s); filled++; }
      const stamp = iso();
      if (g.cid) await env.DB.prepare(`UPDATE returns SET chk_at=?2 WHERE claim_id=?1`).bind(g.cid, stamp).run();
      else await env.DB.prepare(`UPDATE returns SET chk_at=?2, claim_id=COALESCE(claim_id,'-') WHERE channel='trendyol' AND id LIKE 'ty-%' AND order_no=?1 AND (claim_id IS NULL OR claim_id='-')`).bind(g.order_no, stamp).run();
      checked++;
    }
  } catch (e) {}
  return { filled, checked };
}
/* Trendyol'da iade onayı / ret talebi (yalnızca "Aksiyon bekliyor" durumundakiler) */
async function tySend(env, method, path, params, body) {
  const url = new URL(TY_BASE + path);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const h = tyHeaders(env); const init = { method, headers: { ...h } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(url.toString(), init);
  const txt = await r.text();
  if (!r.ok) {
    let msg = txt; try { const j = JSON.parse(txt); msg = (j.errors && j.errors.map(x => x.message).join(' · ')) || j.message || j.exception || txt; } catch (e) {}
    const e = new Error(`Trendyol ${r.status}: ${String(msg).slice(0, 240)}`); e.status = r.status; throw e;
  }
  return txt;
}
let CLAIM_REASONS = null;
async function claimIssueReasons(env) {
  if (CLAIM_REASONS && Date.now() - CLAIM_REASONS.t < 6 * 3600000) return CLAIM_REASONS.v;
  const r = await ty(env, 'order/claim-issue-reasons', {});
  const list = (Array.isArray(r) ? r : (r.content || r.claimIssueReasons || [])).map(x => ({ id: Number(x.id), name: String(x.name || '') })).filter(x => x.id && x.name);
  CLAIM_REASONS = { t: Date.now(), v: list }; return list;
}
const CLAIM_NOFILE = new Set([451, 1651, 2101]);
async function loadClaimGroup(env, ids) {
  ids = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String))].slice(0, 50);
  if (!ids.length) return { err: 'İade seçilmedi.' };
  const rows = await selectIn(env, 'SELECT * FROM returns', 'id', ids);
  if (rows.length !== ids.length) return { err: 'İade bulunamadı.', code: 404 };
  if (rows.some(r => r.status !== 'requested')) return { err: 'Bu iade zaten işlenmiş.', code: 409 };
  return { rows };
}
// Soru cevaplama için ürün bilgisi (açıklama + özellikler), ana ürün koduna göre
const stripHtml = (h) => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
async function storeProductInfo(env, content) {
  const now = iso(), st = [];
  for (const c of content) {
    const mid = String(c.productMainId || '').trim(); if (!mid) continue;
    const attrs = [...(c.attributes || []), ...((c.variants || [])[0] ? ((c.variants[0].attributes) || []) : [])].map(a => `${a.attributeName || ''}: ${a.attributeValue || ''}`).filter(x => !/^: |: $/.test(x));
    const extra = []; const v0 = (c.variants || [])[0] || {};
    if (c.brand) extra.push('Marka: ' + (c.brand.name || c.brand)); if (c.categoryName) extra.push('Kategori: ' + c.categoryName);
    if (v0.dimensionalWeight) extra.push('Desi: ' + v0.dimensionalWeight); if (c.dimensionalWeight) extra.push('Desi: ' + c.dimensionalWeight);
    if (Array.isArray(c.variants) && c.variants.length > 1) extra.push('Seçenekler: ' + c.variants.map(v => (v.attributes || []).map(a => a.attributeValue).join(' ')).filter(Boolean).join(' | '));
    st.push(env.DB.prepare(`INSERT INTO product_info(main_id, title, descr, attrs, image, updated_at) VALUES(?1,?2,?3,?4,?5,?6)
      ON CONFLICT(main_id) DO UPDATE SET title=excluded.title, descr=excluded.descr, attrs=excluded.attrs, image=excluded.image, updated_at=excluded.updated_at
      WHERE product_info.title IS NOT excluded.title OR product_info.descr IS NOT excluded.descr OR product_info.attrs IS NOT excluded.attrs OR product_info.image IS NOT excluded.image`)
      .bind(mid, c.title || '', stripHtml(c.description).slice(0, 6000), [...new Set([...attrs, ...extra])].join('\n').slice(0, 3000), (c.images && c.images[0] && c.images[0].url) || '', now));
  }
  for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
}
/* ---------- Müşteri soruları (Trendyol Soru-Cevap) ---------- */
async function qnaCount(env) { const c = await env.DB.prepare(`SELECT COUNT(*) n FROM qna WHERE status='waiting'`).first(); await setSetting(env, 'qna_waiting', String((c && c.n) || 0)); }
async function syncTrendyolQna(env) {
  const sid = env.TRENDYOL_SELLER_ID, now = Date.now(), seen = new Set(); let n = 0;
  for (let page = 0; page < 5; page++) {
    let r;
    try { r = await ty(env, `qna/sellers/${sid}/questions/filter`, { status: 'WAITING_FOR_ANSWER', page, size: 50, orderByField: 'CreatedDate', orderByDirection: 'DESC' }); }
    catch (e) { if (page === 0 && e.status === 400) r = await ty(env, `qna/sellers/${sid}/questions/filter`, { status: 'WAITING_FOR_ANSWER', page, size: 50, startDate: now - 14 * 86400000, endDate: now }); else throw e; }
    const list = r.content || [];
    const st = list.map(q => { seen.add(String(q.id)); return env.DB.prepare(`INSERT INTO qna(id, main_id, product_name, image, web_url, text, created_at, status, updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'waiting',?8)
      ON CONFLICT(id) DO UPDATE SET main_id=excluded.main_id, product_name=excluded.product_name, image=excluded.image, web_url=excluded.web_url, text=excluded.text, updated_at=excluded.updated_at, status=CASE WHEN qna.status IN ('sent') THEN qna.status ELSE 'waiting' END
      WHERE qna.text IS NOT excluded.text OR qna.status NOT IN ('waiting','sent')`).bind(String(q.id), String(q.productMainId || ''), q.productName || '', q.imageUrl || '', q.webUrl || '', String(q.text || ''), iso(Number(q.creationDate) || now), iso()); });
    for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
    n += list.length;
    if (!list.length || page + 1 >= (r.totalPages || 1)) break;
  }
  // Trendyol'da bekleyenlerden çıkan (panelden cevaplanan) sorular
  const { results } = await env.DB.prepare(`SELECT id FROM qna WHERE status='waiting'`).all();
  const gone = results.filter(x => !seen.has(x.id));
  if (gone.length) await env.DB.batch(gone.map(x => env.DB.prepare(`UPDATE qna SET status='answered_elsewhere', updated_at=?2 WHERE id=?1`).bind(x.id, iso())));
  await qnaCount(env);
  return { waiting: n, closed: gone.length };
}
const QA_SYSTEM = `Sen Lilya Home'un (ev ve mutfak ürünleri) Trendyol mağazasına gelen müşteri sorularına cevap TASLAĞI yazan yardımcısın. Taslağı mağaza sahibi okuyup onaylayacak.
Kurallar:
- Türkçe, sıcak ve kibar yaz. "Merhaba," ile başla, kısa bir teşekkür ya da "İyi alışverişler dileriz." ile bitir.
- Kısa ol: genelde 1-3 cümle, en fazla 500 karakter.
- YALNIZCA verilen ürün bilgisine, mağaza notlarına ve önceki cevaplara dayan. Ölçü, malzeme, adet, uyumluluk gibi bilgileri ASLA uydurma.
- Sorunun cevabı verilen bilgilerde yoksa dürüst ve genel bir cevap yaz ve cevabın EN BAŞINA tek başına [KONTROL] yaz (mağaza sahibi bunu görüp düzeltecek).
- Telefon, e-posta, web adresi, sosyal medya, WhatsApp, başka mağaza ya da siteye yönlendirme YAZMA (Trendyol kuralı).
- Fiyat, indirim, kampanya, kargo ücreti ya da teslim tarihi için söz verme; mağaza notunda yazmıyorsa bunlara girme.
- Müşteriden kişisel bilgi, sipariş numarası isteme.
- Çıktı olarak SADECE cevap metnini yaz; açıklama, başlık, tırnak ekleme.`;
async function draftQna(env, id, hint) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('Yapay zekâ anahtarı (ANTHROPIC_API_KEY) Cloudflare\'e eklenmemiş.');
  const q = await env.DB.prepare('SELECT * FROM qna WHERE id=?1').bind(String(id)).first(); if (!q) throw new Error('Soru bulunamadı');
  const [pi, prev, gen] = await Promise.all([
    q.main_id ? env.DB.prepare('SELECT * FROM product_info WHERE main_id=?1').bind(q.main_id).first() : null,
    env.DB.prepare(`SELECT text, answer FROM qna WHERE main_id=?1 AND id<>?2 AND answer IS NOT NULL AND answer<>'' ORDER BY answered_at DESC LIMIT 6`).bind(q.main_id || '-', q.id).all(),
    getSetting(env, 'qa_general')]);
  const parts = [`ÜRÜN: ${(pi && pi.title) || q.product_name || '-'}`];
  if (pi && pi.attrs) parts.push(`ÖZELLİKLER:\n${pi.attrs}`);
  if (pi && pi.descr) parts.push(`ÜRÜN AÇIKLAMASI:\n${pi.descr.slice(0, 3500)}`);
  if (pi && pi.note) parts.push(`MAĞAZA SAHİBİNİN BU ÜRÜN İÇİN NOTU (en güvenilir bilgi):\n${pi.note}`);
  if (gen) parts.push(`MAĞAZANIN GENEL BİLGİLERİ (kargo, iade vb.):\n${gen}`);
  if (prev.results.length) parts.push(`BU ÜRÜNE DAHA ÖNCE VERİLEN CEVAPLAR (üslup ve bilgi için örnek):\n${prev.results.map(x => `S: ${x.text}\nC: ${x.answer}`).join('\n---\n')}`);
  parts.push(`MÜŞTERİNİN SORUSU:\n${q.text}`);
  if (hint) parts.push(`MAĞAZA SAHİBİNİN İSTEĞİ (taslağı buna göre yaz): ${String(hint).slice(0, 300)}`);
  const model = (await getSetting(env, 'qa_model')) || 'claude-haiku-5-5';
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 700, system: QA_SYSTEM, messages: [{ role: 'user', content: parts.join('\n\n') }] }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const msg = (data.error && data.error.message) || ('Yapay zekâ hatası ' + r.status); await env.DB.prepare('UPDATE qna SET draft_err=?2 WHERE id=?1').bind(q.id, msg.slice(0, 200)).run(); throw new Error(msg); }
  let text = ((data.content || []).filter(c => c.type === 'text').map(c => c.text).join('') || '').trim();
  const flag = /^\[KONTROL\]/i.test(text) ? 1 : 0; text = text.replace(/^\[KONTROL\]\s*/i, '').trim().slice(0, 2000);
  await env.DB.prepare('UPDATE qna SET draft=?2, draft_flag=?3, draft_at=?4, draft_err=NULL WHERE id=?1').bind(q.id, text, flag, iso()).run();
  return { draft: text, flag: !!flag };
}
async function draftPendingQna(env, max = 4) {
  if (!env.ANTHROPIC_API_KEY) return { n: 0 };
  const { results } = await env.DB.prepare(`SELECT id FROM qna WHERE status='waiting' AND (draft IS NULL OR draft='') AND (draft_err IS NULL) ORDER BY created_at LIMIT ?1`).bind(max).all();
  let n = 0; for (const x of results) { try { await draftQna(env, x.id); n++; } catch (e) {} }
  return { n };
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
        items.push({ passive: v.archived === true || v.blacklisted === true, sku: v.stockCode || '', barcode: v.barcode || '', name: (c.title || '') + (attrs && (c.variants || []).length > 1 ? ' · ' + attrs : ''), image: img, stock: v.stock && Number.isFinite(v.stock.quantity) ? v.stock.quantity : null, price: v.price && Number.isFinite(Number(v.price.salePrice)) ? Number(v.price.salePrice) : null, comm: Number.isFinite(Number(v.commission)) ? Number(v.commission) : null, vat: Number.isFinite(Number(v.vatRate)) ? Number(v.vatRate) : null });
      }
    }
    if (items.length) { const st = await ingestProducts(env, 'trendyol', items, { useStock, tyQty: true }); stats.created += st.created; stats.updated += st.updated;
      // Trendyol'da pasif (arşivlenmiş / kara listede) ürünler işaretlenir; listelerde gizlenir, tekrar aktif olunca kendiliğinden görünür
      const ps = items.filter(x => x.sku || x.barcode).map(x => env.DB.prepare('UPDATE products SET ty_passive=?1 WHERE key=?2 AND ty_passive IS NOT ?1').bind(x.passive ? 1 : 0, skuKey(x.sku || x.barcode)));
      for (let j = 0; j < ps.length; j += 90) await env.DB.batch(ps.slice(j, j + 90));
      if (items.some(x => x.passive)) await env.DB.batch([REV(env)]); }
    try { await storeProductInfo(env, r.content || []); } catch (e) {}
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
      // Trendyol yanıtta türü Türkçe yazıyor ("Satış", "İade"…); türü istekte gönderdiğimiz değerden alıyoruz
      a.revenue += credit - debt; if (type === 'Sale') a.sale = true;
      const ca = Math.abs(Number(x.commissionAmount) || 0);
      if (type === 'Sale' || type === 'DiscountCancel' || type === 'CouponCancel') a.commission += ca; else a.commission -= ca;
      a.net += Number(x.sellerRevenue) || 0;
    }
    if (page + 1 >= (r.totalPages || 0)) break;
  }
  } catch (e) { if (type === 'Sale') throw e; stat.errors.push(type + ': ' + String(e.message || e).slice(0, 80)); }
  stat.types[type] = typeRows;
  }
  const aggStmts = (now) => { const st = [];
  for (const [no, a] of agg) st.push(env.DB.prepare(`INSERT INTO order_fin(order_no,revenue,commission,net,cargo,service,updated_at,ret_cargo) VALUES(?1,?2,?3,?4,?5,?6,?7,?9)
    ON CONFLICT(order_no) DO UPDATE SET revenue=CASE WHEN ?8 THEN excluded.revenue ELSE order_fin.revenue END, commission=CASE WHEN ?8 THEN excluded.commission ELSE order_fin.commission END, net=CASE WHEN ?8 THEN excluded.net ELSE order_fin.net END,
      cargo=CASE WHEN excluded.cargo IS NULL THEN order_fin.cargo ELSE COALESCE(order_fin.cargo,0)+excluded.cargo END,
      ret_cargo=CASE WHEN excluded.ret_cargo IS NULL THEN order_fin.ret_cargo ELSE COALESCE(order_fin.ret_cargo,0)+excluded.ret_cargo END,
      service=COALESCE(excluded.service, order_fin.service), updated_at=excluded.updated_at`)
    .bind(no, a.sale ? Math.round(a.revenue * 100) / 100 : null, a.sale ? Math.round(a.commission * 100) / 100 : null, a.sale ? Math.round(a.net * 100) / 100 : null, a.cargo === null ? null : Math.round(a.cargo * 100) / 100, a.service, now, a.sale ? 1 : 0, a.retCargo === null ? null : Math.round(a.retCargo * 100) / 100));
    return st; };
  // Satış/komisyon gerçek değerleri hemen kaydedilir; sonraki adımlar (hizmet bedeli, kargo faturaları) hata verse de kaybolmaz
  { const w = aggStmts(iso()); for (let i = 0; i < w.length; i += 90) await env.DB.batch(w.slice(i, i + 90)); stat.early = w.length; }
  // Paket numarasından sipariş numarasına (Trendyol bazı kayıtlarda yalnızca shipmentPackageId verir)
  // Satır başına sorgu yerine sayfa başına tek toplu sorgu (çalışma başına veritabanı sorgu sınırı aşılmasın)
  const pkgMap = new Map();
  const prefetch = async (list) => { const ids = [...new Set(list.filter(x => !x.orderNumber && x.shipmentPackageId).map(x => String(x.shipmentPackageId)).filter(id => !pkgMap.has(id)))]; if (!ids.length) return; for (const id of ids) pkgMap.set(id, null); for (const r of await selectIn(env, 'SELECT pkg_id, order_no FROM audit_pkg', 'pkg_id', ids)) pkgMap.set(String(r.pkg_id), r.order_no); };
  const orderOf = async (x) => x.orderNumber ? String(x.orderNumber) : (x.shipmentPackageId ? pkgMap.get(String(x.shipmentPackageId)) || null : null);
  // Platform hizmet bedeli kayıtları ayrı filtreyle (transactionSubType=PlatformServiceFee) okunur; siparişe bağlanabilenler gerçek tutar olarak yazılır
  stat.svcRows = 0; stat.svcLinked = 0;
  try {
    const svc = new Map();
    for (let page = 0; page < 20; page++) {
      const r = await ty(env, `finance/che/sellers/${sid}/otherfinancials`, { transactionType: 'DeductionInvoices', transactionSubType: 'PlatformServiceFee', startDate: start, endDate: end, page, size: 500, supplierId: sid });
      await prefetch(r.content || []);
      for (const x of (r.content || [])) { stat.svcRows++; const no = await orderOf(x); if (!no) continue; stat.svcLinked++; svc.set(no, (svc.get(no) || 0) + Math.abs(Number(x.debt) || Number(x.credit) || 0)); }
      if (page + 1 >= (r.totalPages || 0)) break;
    }
    for (const [no, v] of svc) { if (!(v > 0)) continue; const a = get(no); a.service = Math.round(v * 100) / 100; }
  } catch (e) { stat.errors.push('Hizmet bedeli: ' + String(e.message || e).slice(0, 120)); }
  // Kargo ve diğer kesinti faturaları
  const done = new Set(JSON.parse(s.cargo_inv_done || '[]')); let cargoInv = 0; const misc = [];
  const fees0 = await loadFees(env); const learned = {}; let partial = false;
  // Her kargo faturası okunur okunmaz tek atomik yazımla kaydedilir; süre biterse kalan faturalar bir sonraki turda okunur
  const flushCargo = async (invId) => {
    const ws = [];
    for (const [no, a] of agg) if (a.cargo !== null || a.retCargo !== null) {
      ws.push(env.DB.prepare(`INSERT INTO order_fin(order_no,cargo,ret_cargo,updated_at,ret_desi) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(order_no) DO UPDATE SET
        cargo=CASE WHEN excluded.cargo IS NULL THEN order_fin.cargo ELSE COALESCE(order_fin.cargo,0)+excluded.cargo END,
        ret_cargo=CASE WHEN excluded.ret_cargo IS NULL THEN order_fin.ret_cargo ELSE COALESCE(order_fin.ret_cargo,0)+excluded.ret_cargo END,
        ret_desi=COALESCE(excluded.ret_desi, order_fin.ret_desi), updated_at=excluded.updated_at`)
        .bind(no, a.cargo === null ? null : Math.round(a.cargo * 100) / 100, a.retCargo === null ? null : Math.round(a.retCargo * 100) / 100, iso(), a.retDesi ? Math.round(a.retDesi * 100) / 100 : null));
      a.cargo = null; a.retCargo = null; a.retDesi = null;
    }
    done.add(invId); ws.push(setStmt(env, 'cargo_inv_done', JSON.stringify([...done].slice(-300))));
    await env.DB.batch(ws);
  };
  try {
    outer: for (let page = 0; page < 5; page++) {
      const r = await ty(env, `finance/che/sellers/${sid}/otherfinancials`, { transactionType: 'DeductionInvoices', startDate: start, endDate: end, page, size: 500, supplierId: sid });
      await prefetch(r.content || []);
      for (const x of (r.content || [])) {
        const t = String(x.transactionType || '') + ' ' + String(x.description || '');
        { const k = String(x.transactionType || '?').slice(0, 30); stat.ded = stat.ded || {}; stat.ded[k] = (stat.ded[k] || 0) + 1; }
        if (/kargo/i.test(t) && x.id && !done.has(String(x.id))) {
          if (deadline && Date.now() > deadline) { partial = true; break outer; }
          for (let p2 = 0; p2 < 20; p2++) {
            const it = await ty(env, `finance/che/sellers/${sid}/cargo-invoice/${encodeURIComponent(x.id)}/items`, { page: p2, size: 500 });
            for (const c of (it.content || [])) {
              const isRet = String(c.shipmentPackageType || '').toLocaleLowerCase('tr-TR').includes('iade');
              stat.cargoItems++; if (isRet) stat.retItems++;
              if (c.orderNumber && (stat.cargoNos = stat.cargoNos || []).length < 2000) stat.cargoNos.push(String(c.orderNumber));
              if (c.orderNumber) { const a = get(String(c.orderNumber)); if (isRet) { a.retCargo = (a.retCargo || 0) + (Number(c.amount) || 0); if (Number(c.desi) > 0) a.retDesi = Math.max(a.retDesi || 0, Number(c.desi)); } else a.cargo = (a.cargo || 0) + (Number(c.amount) || 0); }
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
  // Teşhis: faturadaki sipariş numaraları bizim siparişlerle eşleşiyor mu, eşleşenler hangi tarihlerde
  if (stat.cargoNos && stat.cargoNos.length) {
    const nos = [...new Set(stat.cargoNos)];
    const m = await selectIn(env, 'SELECT order_no, date FROM orders', 'order_no', nos);
    const ds = m.map(x => x.date).filter(Boolean).sort();
    stat.cargoCheck = { nos: nos.length, matched: m.length, from: ds[0] || null, to: ds[ds.length - 1] || null, sample: nos.slice(0, 3) };
  }
  delete stat.cargoNos;
  stat.cargoInvoices = cargoInv; stat.cargoDone = done.size; stat.orders = agg.size; stat.misc = misc.length; stat.partial = partial;
  const now = iso(); const st = aggStmts(now);
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
// Bir çalışmada veritabanına en fazla ~1000 sorgu atılabilir (Cloudflare D1). Sayaç ile her işten önce kalan bütçe kontrol edilir.
const Q_LIMIT = 880;
function countingDB(db, counter) {
  const m = (res) => { const a = Array.isArray(res) ? res : [res]; for (const x of a) if (x && x.meta) { counter.w = (counter.w || 0) + (x.meta.rows_written || 0); counter.r = (counter.r || 0) + (x.meta.rows_read || 0); } return res; };
  const wrap = (st) => ({ __raw: st, bind: (...a) => wrap(st.bind(...a)), first: (...a) => { counter.n++; return st.first(...a); }, all: () => { counter.n++; return st.all().then(m); }, run: () => { counter.n++; return st.run().then(m); }, raw: (...a) => { counter.n++; return st.raw(...a); } });
  return { prepare: (sql) => wrap(db.prepare(sql)), batch: (list) => { counter.n += list.length; return db.batch(list.map(x => (x && x.__raw) || x)).then(m); }, exec: (q) => { counter.n++; return db.exec(q); } };
}
const qLeft = (env) => env.__q ? Q_LIMIT - env.__q.n : Infinity;
async function heavySteps(env, budget, result, step, left, t) {
  {
    // Ağır işler seyrek çalışır; veritabanını sürekli meşgul edip ekranları yavaşlatmasın
    const due = await getSettings(env, ['run_prod_at', 'run_fin_at', 'run_bf_at', 'run_qna_at']); const now = Date.now();
    const lvl = (GUARD_CACHE && GUARD_CACHE.v && GUARD_CACHE.v.level) || 0, mult = lvl >= 2 ? 6 : lvl === 1 ? 3 : 1;
    const isDue = (k, ms) => now - (Number(due[k]) || 0) >= ms * mult;
    const ok = (need) => qLeft(env) > need;
    // Sıra önemli: seyrek ama kritik işler (kesintiler = gerçek kâr, ürün listesi) önce; sık ve küçük işler kalan sürede
    if (left() > 28000 && ok(350) && isDue('run_fin_at', 5 * 60000)) { await setSetting(env, 'run_fin_at', String(now)); await step('finance', () => syncTrendyolFinance(env, false, Math.min(budget ? budget - 15000 : Infinity, Date.now() + 20000)), 'fin_err'); if (result.finance && !result.steps.financeErr) await setSetting(env, 'fin_err', ''); }
    if (left() > 20000 && ok(350) && isDue('run_prod_at', 5 * 60000)) { await setSetting(env, 'run_prod_at', String(now)); await step('products', () => syncTrendyolProducts(env, 1)); }
    if (left() > 15000 && ok(300) && isDue('run_bf_at', 3 * 60000)) { await setSetting(env, 'run_bf_at', String(now)); await step('backfill', () => backfillTrendyolOrders(env), 'fin_err'); }
    if (left() > 8000 && ok(50)) await step('pushCheck', () => checkTrendyolPushBatch(env), 'ty_push_err');
    if (left() > 8000 && ok(150)) await step('claimsCheck', () => reconcileTrendyolClaims(env, Date.now() + Math.min(15000, left() - 5000)));
    if (left() > 8000 && ok(100)) await step('retDesi', () => backfillReturnDesi(env));
  }
  result.ms = Date.now() - t;
  return result;
}
async function pollOnce(env, full, budget, mode) {
  const t = Date.now(); const result = { steps: {} };
  const left = () => (budget || Infinity) - Date.now();
  // Her adım ayrı ölçülür ve ayrı hata yakalar: biri takılırsa sipariş eşitlemesi durmaz
  const step = async (name, fn, errKey) => {
    const s0 = Date.now();
    try { result[name] = await fn(); }
    catch (e) { result.steps[name + 'Err'] = String(e.message || e).slice(0, 200); if (errKey) await setSetting(env, errKey, iso() + ' · ' + String(e.message || e).slice(0, 250)); }
    result.steps[name] = Date.now() - s0;
  };
  if (mode === 'heavy') return heavySteps(env, budget, result, step, left, t);
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
  // İadeler ve sorular da siparişlerle birlikte sık kontrol edilir (iadeler her turda, sorular 30 sn'de bir)
  if (mode !== 'heavy' && qLeft(env) > 160) {
    await step('claims', () => syncTrendyolClaims(env));
    if ((env.__poll || 0) % 3 === 0) { await step('qna', () => syncTrendyolQna(env), 'qna_err'); if (result.qna && !result.steps.qnaErr && !env.__poll) await setSetting(env, 'qna_err', ''); }
  }
  if (full && mode !== 'light') await heavySteps(env, budget, result, step, left, t);
  result.ms = Date.now() - t;
  return result;
}
/* ---------- Maliyet koruması: aylık kullanım sayacı + otomatik tasarruf ----------
   Workers Paid (5 $) dahil kullanım: 10 milyon istek, 30 milyon ms işlemci, D1 50 milyon satır yazma, 25 milyar satır okuma.
   Kullanım ay sonuna göre öngörülür; dahil miktarı aşacak gibiyse uygulama kendini yavaşlatır, %95'te neredeyse durur. */
const INCLUDED = { req: 10e6, cpu: 30e6, wr: 50e6, rd: 25e9 };
const USE = { req: 0, wr: 0, rd: 0, at: Date.now() };
let GUARD_CACHE = null;
const monthKey = () => trDay(Date.now()).slice(0, 7);
async function flushUsage(env, extra) {
  const add = { req: USE.req + ((extra && extra.req) || 0), wr: USE.wr + ((extra && extra.wr) || 0), rd: USE.rd + ((extra && extra.rd) || 0) };
  USE.req = 0; USE.wr = 0; USE.rd = 0; USE.at = Date.now();
  const m = monthKey(), st = [env.DB.prepare(`INSERT OR IGNORE INTO settings(k,v) VALUES(?1,?2)`).bind(`u:${m}:since`, String(Date.now()))];
  for (const k of ['req', 'wr', 'rd']) { if (!add[k]) continue; const key = `u:${m}:${k}`; st.push(env.DB.prepare(`INSERT OR IGNORE INTO settings(k,v) VALUES(?1,'0')`).bind(key), env.DB.prepare(`UPDATE settings SET v=CAST(CAST(v AS INTEGER)+?2 AS TEXT) WHERE k=?1`).bind(key, Math.round(add[k]))); }
  if (st.length) await env.DB.batch(st);
}
// Cloudflare'in gerçek kullanım verisi (isteğe bağlı: CF_API_TOKEN + CF_ACCOUNT_ID gizli değişkenleri). Saatte bir.
async function fetchCfUsage(env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return null;
  const now = new Date(), m0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const q = `query($a:String!,$s:Time!,$e:Time!,$sd:Date!,$ed:Date!){viewer{accounts(filter:{accountTag:$a}){w:workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){sum{requests cpuTimeUs}} d:d1AnalyticsAdaptiveGroups(limit:10000,filter:{date_geq:$sd,date_leq:$ed}){sum{rowsRead rowsWritten}}}}}`;
  const vars = { a: env.CF_ACCOUNT_ID, s: m0.toISOString(), e: now.toISOString(), sd: m0.toISOString().slice(0, 10), ed: now.toISOString().slice(0, 10) };
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ query: q, variables: vars }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.errors && j.errors.length)) throw new Error(((j.errors && j.errors[0] && j.errors[0].message) || ('HTTP ' + r.status)).slice(0, 200));
  const acc = (((j.data || {}).viewer || {}).accounts || [])[0] || {};
  const sum = (arr, k) => (arr || []).reduce((a, x) => a + (Number((x.sum || {})[k]) || 0), 0);
  return { month: monthKey(), at: iso(), req: sum(acc.w, 'requests'), cpu: Math.round(sum(acc.w, 'cpuTimeUs') / 1000), rd: sum(acc.d, 'rowsRead'), wr: sum(acc.d, 'rowsWritten') };
}
// Kullanım durumu ve tasarruf seviyesi: 0 normal, 1 tasarruf (%60+ öngörü), 2 sıkı (%85+), 3 durdurma (%95 kullanıldı)
async function usageGuard(env, fresh) {
  if (!fresh && GUARD_CACHE && Date.now() - GUARD_CACHE.t < 60000) return GUARD_CACHE.v;
  const m = monthKey();
  const g = await getSettings(env, [`u:${m}:req`, `u:${m}:wr`, `u:${m}:rd`, `u:${m}:since`, 'cf_usage', 'cf_usage_err', 'usage_avg']);
  const now = new Date(Date.now() + TY_TZ); const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const frac = Math.max(1 / 48, ((now.getUTCDate() - 1) + (now.getUTCHours() * 60 + now.getUTCMinutes()) / 1440) / dim);
  const est = { req: Number(g[`u:${m}:req`]) || 0, wr: Number(g[`u:${m}:wr`]) || 0, rd: Number(g[`u:${m}:rd`]) || 0, cpu: null };
  // Sayaç ayın ortasında başladıysa: başlangıçtan beri görülen hızla ayın başından bugüne tahmin (gerçek veri yoksa)
  const since = Number(g[`u:${m}:since`]) || 0, monthStart = Date.now() - frac * dim * 86400000;
  if (since > monthStart + 3600000 && Date.now() - since > 600000) { const k = (Date.now() - monthStart) / (Date.now() - since); for (const x of ['req', 'wr', 'rd']) est[x] = Math.round(est[x] * k); }
  let cf = null; try { cf = JSON.parse(g.cf_usage || 'null'); } catch (e) {}
  if (cf && cf.month !== m) cf = null;
  const used = { req: Math.max(est.req, cf ? cf.req : 0), wr: Math.max(est.wr, cf ? cf.wr : 0), rd: Math.max(est.rd, cf ? cf.rd : 0), cpu: cf ? cf.cpu : null };
  const metrics = {}; let level = 0;
  for (const k of ['req', 'cpu', 'wr', 'rd']) {
    if (used[k] === null) { metrics[k] = { used: null, included: INCLUDED[k] }; continue; }
    const proj = used[k] / frac, pctUsed = used[k] / INCLUDED[k], pctProj = proj / INCLUDED[k];
    metrics[k] = { used: used[k], proj: Math.round(proj), included: INCLUDED[k], pctUsed, pctProj };
    const lv = pctUsed >= 0.95 ? 3 : pctProj >= 0.85 ? 2 : pctProj >= 0.6 ? 1 : 0; if (lv > level) level = lv;
  }
  const v = { month: m, level, metrics, cf: cf ? { at: cf.at } : null, cfErr: g.cf_usage_err || '', hasToken: !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID) };
  GUARD_CACHE = { t: Date.now(), v }; return v;
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
  // Maliyet koruması: seviye 3'te yalnızca 5 dakikada bir, tek sipariş kontrolü
  const guard = await usageGuard(env, true);
  if (guard.level >= 3 && new Date().getUTCMinutes() % 5 !== 0) { await flushUsage(env, { req: 1 }); return; }
  if (!(await tryLock(env, 90000))) { await setSetting(env, 'cron_busy', iso()); return; }
  await setSetting(env, 'cron_at', String(t0));
  const diag = { at: iso(t0), polls: 0, slow: {}, errs: {} };
  try {
    // Tek çalışma, sorgu sayacıyla: önce siparişler (her 10 sn), ağır işler bütçe kalırsa; hiçbir iş sınırı aşamaz
    const counter = { n: 0 }; const envc = { ...env, DB: countingDB(env.DB, counter), __q: counter };
    const absorb = (r) => { for (const [k, v] of Object.entries((r && r.steps) || {})) { if (typeof v === 'number') { if (!(diag.slow[k] >= v)) diag.slow[k] = v; } else diag.errs[k] = v; } if (r && r.error) diag.errs.orders = r.error; };
    const POLLS = guard.level >= 2 ? 1 : guard.level === 1 ? 3 : 6, GAP = 60000 / POLLS;
    diag.level = guard.level;
    // Ağır işler (kesintiler, ürün listesi, iade kontrolü…) siparişlerle AYNI ANDA ayrı kolda çalışır; sipariş turlarını bekletmez
    let heavyP = null;
    if (guard.level < 2 || new Date().getUTCMinutes() % 15 === 0) {
      const reserve = POLLS * 60;
      const envh = { ...envc, __q: { get n() { return counter.n + reserve; } } };
      heavyP = sleep(1500).then(() => pollOnce(envh, true, t0 + 50000, 'heavy')).then(absorb).catch(e => { diag.errs.heavy = String(e.message || e).slice(0, 150); });
    }
    for (let i = 0; i < POLLS; i++) {
      const wait = t0 + i * GAP - Date.now();
      if (wait > 0) await sleep(wait);
      if (Date.now() - t0 > 52000) break;
      if (qLeft(envc) < 130) { diag.errs.budget = 'sorgu bütçesi doldu (' + counter.n + ')'; break; }
      try { absorb(await pollOnce({ ...envc, __poll: i }, false, Date.now() + 9000, 'light')); } catch (e) { diag.errs.orders = String(e.message || e).slice(0, 150); }
      diag.polls++;
    }
    if (heavyP) await heavyP;
    // Raporlar: kalan bütçeyle birkaç gün
    // Raporlar 5 dakikada bir, az sayıda gün (eksik gün varken daha fazla); değişmeyen gün yazılmaz
    const sAt = Number(await envc.DB.prepare(`SELECT v FROM settings WHERE k='run_stats_at'`).first().then(r => r && r.v)) || 0;
    const statsEvery = guard.level >= 2 ? 60 : guard.level === 1 ? 20 : 5;
    if (guard.level < 3 && qLeft(envc) > 150 && Date.now() - t0 < 56000 && Date.now() - sAt >= statsEvery * 60000) { try { await setSetting(envc, 'run_stats_at', String(Date.now())); const r = await refreshStats(envc, Date.now() + 4000, Math.max(1, Math.min(6, Math.floor((qLeft(envc) - 60) / 35)))); diag.slow.stats = r.n; } catch (e) { diag.errs.stats = String(e.message || e).slice(0, 150); } }
    diag.queries = counter.n; diag.wr = counter.w || 0; diag.rd = counter.r || 0;
    try { await flushUsage(env, { req: 1, wr: diag.wr, rd: diag.rd }); } catch (e) {}
    // Cloudflare gerçek kullanım verisi saatte bir (anahtar varsa)
    try { const last = Number(await getSetting(env, 'cf_usage_run')) || 0; if (Date.now() - last > 3600000 && env.CF_API_TOKEN && env.CF_ACCOUNT_ID) { await setSetting(env, 'cf_usage_run', String(Date.now())); try { const u = await fetchCfUsage(env); if (u) await env.DB.batch([setStmt(env, 'cf_usage', JSON.stringify(u)), setStmt(env, 'cf_usage_err', '')]); } catch (e) { await setSetting(env, 'cf_usage_err', iso() + ' · ' + String(e.message || e)); } } } catch (e) {}
    // Aylık kullanım tahmini için son 60 turun ortalaması
    try { const u = JSON.parse((await getSetting(env, 'usage_avg')) || '{"w":0,"r":0,"n":0}'); const k = Math.min(60, u.n + 1); u.w = u.w + (diag.wr - u.w) / k; u.r = u.r + (diag.rd - u.r) / k; u.n = k; u.at = iso(); await setSetting(env, 'usage_avg', JSON.stringify(u)); } catch (e) {}
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
// Oturum: bir kez giriş yapılan cihazda 120 gün açık kalır; kullandıkça kendiliğinden uzar
const SESSION_MS = 120 * 86400000;
async function authed(req, env) {
  const c = req.headers.get('cookie') || ''; const m = c.match(/(?:^|;\s*)lb=([^;]+)/); if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.'); if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sig === await hmac(env.APP_PASSWORD, 'lb2:' + exp) ? Number(exp) : false;
}
async function loginCookie(env) {
  const exp = Date.now() + SESSION_MS;
  const v = exp + '.' + await hmac(env.APP_PASSWORD, 'lb2:' + exp);
  return `lb=${encodeURIComponent(v)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.round(SESSION_MS / 1000)}`;
}
/* ---------- Face ID / Touch ID: WebAuthn (passkey) ---------- */
const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (str) => { const s2 = String(str).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s2 + '==='.slice((s2.length + 3) % 4)); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
};
function cborDecode(bytes) {
  let pos = 0; const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = (ai) => { if (ai < 24) return ai; if (ai === 24) return dv.getUint8(pos++); if (ai === 25) { const v = dv.getUint16(pos); pos += 2; return v; } if (ai === 26) { const v = dv.getUint32(pos); pos += 4; return v; } if (ai === 27) { const v = Number(dv.getBigUint64(pos)); pos += 8; return v; } throw new Error('CBOR'); };
  const item = () => {
    const ib = dv.getUint8(pos++), mt = ib >> 5, ai = ib & 31;
    if (mt === 0) return len(ai); if (mt === 1) return -1 - len(ai);
    if (mt === 2) { const n = len(ai); const v = bytes.slice(pos, pos + n); pos += n; return v; }
    if (mt === 3) { const n = len(ai); const v = new TextDecoder().decode(bytes.slice(pos, pos + n)); pos += n; return v; }
    if (mt === 4) { const n = len(ai), a = []; for (let i = 0; i < n; i++) a.push(item()); return a; }
    if (mt === 5) { const n = len(ai), o = new Map(); for (let i = 0; i < n; i++) { const k = item(); o.set(k, item()); } return o; }
    if (mt === 7) return ai === 20 ? false : ai === 21 ? true : null;
    throw new Error('CBOR');
  };
  const v = item(); return { value: v, end: pos };
}
const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', data));
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function derToRaw(der) {
  let p = 2; if (der[1] & 0x80) p = 2 + (der[1] & 0x7f);
  const part = () => { p++; const l = der[p++]; let v = der.slice(p, p + l); p += l; while (v.length > 32 && v[0] === 0) v = v.slice(1); const o = new Uint8Array(32); o.set(v, 32 - v.length); return o; };
  const r = part(), sg = part(); const out = new Uint8Array(64); out.set(r); out.set(sg, 32); return out;
}
async function waChallenge(env, kind) {
  const ch = b64u.enc(crypto.getRandomValues(new Uint8Array(32)));
  await setSetting(env, 'wa_ch_' + kind, JSON.stringify({ ch, exp: Date.now() + 120000 }));
  return ch;
}
async function waTakeChallenge(env, kind, got) {
  const c = JSON.parse((await getSetting(env, 'wa_ch_' + kind)) || 'null');
  await setSetting(env, 'wa_ch_' + kind, '');
  return !!(c && c.exp > Date.now() && c.ch === got);
}
async function waCheckClient(env, url, cdjB64, type, kind) {
  const cdjBytes = b64u.dec(cdjB64); const cd = JSON.parse(new TextDecoder().decode(cdjBytes));
  if (cd.type !== type) throw new Error('Geçersiz istek türü');
  if (cd.origin !== url.origin) throw new Error('Geçersiz kaynak');
  if (!(await waTakeChallenge(env, kind, cd.challenge))) throw new Error('Süre doldu, tekrar dene');
  return cdjBytes;
}
function parseAuthData(ad) {
  const flags = ad[32], counter = new DataView(ad.buffer, ad.byteOffset + 33, 4).getUint32(0);
  const out = { rpIdHash: ad.slice(0, 32), up: !!(flags & 1), uv: !!(flags & 4), at: !!(flags & 0x40), counter };
  if (out.at) { const l = (ad[53] << 8) | ad[54]; out.credId = ad.slice(55, 55 + l); out.cose = cborDecode(ad.slice(55 + l)).value; }
  return out;
}
// Kullanıcı adı, belirlendiği andaki uygulama şifresine bağlıdır: Cloudflare'de APP_PASSWORD değiştirilirse
// (şifremi unuttum) kullanıcı adı da sıfırlanır ve bir sonraki girişte yeniden belirlenir.
async function authUser(env) {
  const g = await getSettings(env, ['auth_user', 'auth_user_tag']); if (!g.auth_user) return '';
  if (g.auth_user_tag && g.auth_user_tag !== await hmac(env.APP_PASSWORD, 'user-tag')) return '';
  return g.auth_user;
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
  const T0 = Date.now(), TM = {}; const mark = (k) => { TM[k] = Date.now() - T0; };
  // Tüm okumalar tek gidiş-dönüşte (veritabanına her sorgu ayrı yolculuk demek)
  const dayFrom = trDay(Date.parse(from)), dayTo = trDay(Date.parse(to) - 1);
  const SUBQ = `SELECT order_no FROM orders WHERE channel='trendyol' AND date >= ?1 AND date < ?2`;
  const [fee, [o, p, r, finR, custR, miscR, miscAllR, adR, adAnyR, expR]] = await Promise.all([loadFees(env), env.DB.batch([
    env.DB.prepare('SELECT * FROM orders WHERE date >= ?1 AND date < ?2 ORDER BY date DESC').bind(from, to),
    env.DB.prepare('SELECT key, sku, name, image, cost, barcode, same_day FROM products'),
    env.DB.prepare(`SELECT order_id, pkey, status, ext_status, qty, note FROM returns WHERE order_id<>'' AND status<>'rejected'`),
    env.DB.prepare(`SELECT * FROM order_fin WHERE order_no IN (${SUBQ})`).bind(from, to),
    env.DB.prepare(`SELECT order_no, json_extract(data,'$.name') n FROM order_cust WHERE order_no IN (${SUBQ})`).bind(from, to),
    env.DB.prepare(`SELECT order_no, type, amount FROM fin_misc WHERE order_no IN (${SUBQ})`).bind(from, to),
    env.DB.prepare('SELECT type, SUM(amount) amount, COUNT(*) n FROM fin_misc WHERE (order_no IS NULL OR type LIKE ?3) AND date >= ?1 AND date < ?2 GROUP BY type ORDER BY 2 DESC').bind(from, to, '%azmin%'),
    env.DB.prepare('SELECT day, channel, amount, source FROM ad_spend WHERE day >= ?1 AND day <= ?2 ORDER BY day DESC').bind(dayFrom, dayTo),
    env.DB.prepare('SELECT COUNT(*) n FROM ad_spend'),
    env.DB.prepare('SELECT id, day, name, amount, created_at, kind FROM expenses WHERE day >= ?1 AND day <= ?2 ORDER BY day DESC, id DESC').bind(dayFrom, dayTo)])]);
  mark('batch'); const prods = new Map(p.results.map(x => [x.key, x]));
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
  const fin = new Map(finR.results.map(x => [x.order_no, x]));
  const cnames = new Map(custR.results.map(x => [x.order_no, x.n || '']));
  // Trendyol'un ceza vb. kesinti faturaları: siparişe bağlı olanlar siparişe, bağlanamayanlar fatura tarihine göre döneme yazılır
  mark('cust'); const miscByOrder = new Map();
  for (const m of miscR.results) { if (isCompensation(m.type)) continue; const a = miscByOrder.get(m.order_no) || { amount: 0, types: [] }; a.amount += m.amount || 0; a.types.push(m.type); miscByOrder.set(m.order_no, a); }
  const miscAll = miscAllR.results;
  // Kayıp kargo tazmini fatura tarihine göre gelir olarak eklenir; ceza türleri siparişe bağlıysa siparişte sayılır
  const miscFree = miscAll.filter(x => !isCompensation(x.type));
  const compensation = miscAll.filter(x => isCompensation(x.type)).reduce((a, x) => a + Math.abs(x.amount || 0), 0);
  // Reklam: harcandığı günün gideri (elle ya da Trendyol reklam raporundan girilen günlük harcama)
  const adRows = adR.results;
  mark('misc'); const R2 = (n) => Math.round(n * 100) / 100;
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
      byOrder.push({ pkeys: [...new Set(allLines.map(l => l.pkey))].slice(0, 5), cname: cnames.get(ord.order_no) || "", q: allLines.map(l => l.sku + " " + (l.name || "")).join(" ").slice(0, 400), id: ord.id, orderNo: ord.order_no, channel: ord.channel, date: ord.date, actual: !!mo0, penaltyEst: !mo0, penaltyTypes: mo0 ? mo0.types.slice(0, 4) : ['Tedarik edememe'], cargoInfo: 'Tedarik edilemedi (iptal)', revenue: 0, commission: 0, cargo: 0, retCargo: 0, penalty: R2(pen), service: 0, stopaj: 0, cost: 0, profit: R2(-pen), units: 0, retUnits: 0 });
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
    let revenue = est, commission = rows.reduce((a, x) => a + x.commission, 0); let actual = false, svcActual = false;
    const retUnits = rows.reduce((a, x) => a + x.retQ, 0);
    const fa = ch === 'trendyol' ? fin.get(ord.order_no) : null;
    const undelivered = retUnits > 0 && [...pkgs.values()].some(g => g.ret && g.und);
    let retCargoEst = retUnits > 0 && !undelivered;
    if (fa) {
      // İade onaylanan siparişte ciro/komisyon satır verisinden (iade düşülmüş) hesaplanır; Trendyol ekstresi iadeyi geç yansıtabilir.
      if (fa.revenue !== null && !retUnits) { revenue = fa.revenue; commission = fa.commission || 0; actual = true; }
      if (fa.cargo !== null) { cargo = fa.cargo; actual = true; }
      if (fa.ret_cargo !== null && fa.ret_cargo !== undefined && retUnits) { retCargo = fa.ret_cargo; retCargoEst = false; }
      if (fa.service !== null) { service = fa.service; svcActual = true; }
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
    byOrder.push({ pkeys: [...new Set(lines.map(l => l.pkey))].slice(0, 5), cname: cnames.get(ord.order_no) || '', q: lines.map(l => { const pr = prods.get(l.pkey); return l.sku + ' ' + (l.name || '') + ' ' + ((pr && pr.barcode) || ''); }).join(' ').slice(0, 400), id: ord.id, orderNo: ord.order_no, channel: ch, date: ord.date, actual, svcActual, retCargoEst, undelivered, penaltyEst, penaltyTypes: mo ? mo.types.slice(0, 4) : null, cargoInfo: fa && fa.cargo !== null ? 'Trendyol kargo faturası' : cargoInfo.join(', '), ...Object.fromEntries(Object.entries(oRes).map(([k, v]) => [k, R2(v)])) });
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
  const adTracked = ((adAnyR.results[0] || {}).n || 0) > 0; // günlük reklam takibi varsa faturalar hiçbir dönemde ayrıca düşülmez (günler toplamı = ay)
  const otherFees = miscFree.filter(x => !(adTracked && isAd(x.type))).map(x => ({ type: x.type, amount: R2(x.amount || 0), n: x.n }));
  sum.otherFees = otherFees.reduce((a, x) => a + x.amount, 0); sum.adInvoices = R2(adInvoices);
  // Elle girilen işletme giderleri (paketleme malzemesi vb.): girildiği günün gideri
  const expenses = expR.results.map(x => ({ id: x.id, day: x.day, name: x.name, amount: R2(x.amount || 0), kind: x.kind === 'gelir' ? 'gelir' : 'gider' }));
  sum.expenses = expenses.filter(x => x.kind === 'gider').reduce((a, x) => a + x.amount, 0);
  sum.extraIncome = R2(expenses.filter(x => x.kind === 'gelir').reduce((a, x) => a + x.amount, 0));
  sum.compensation = R2(Math.abs(compensation)); sum.profit -= sum.otherFees + sum.ads + sum.expenses; sum.profit += sum.compensation + sum.extraIncome;
  const round = (o) => { for (const k in o) if (typeof o[k] === 'number' && !Number.isInteger(o[k])) o[k] = R2(o[k]); return o; };
  const products = [...byProduct.values()].map(round).map(x => ({ ...x, margin: x.revenue ? R2(x.profit / x.revenue * 100) : null }));
  round(sum); sum.margin = sum.revenue ? R2(sum.profit / sum.revenue * 100) : null;
  mark('cpu'); PERF_LAST = { ...TM, orders: o.results.length };
  return { from, to, fees: fee, summary: sum, report: rep, otherFees, expenses, ads: adRows.map(x => ({ day: x.day, channel: x.channel, amount: R2(x.amount || 0), source: x.source })), products, orders: byOrder, missingCostSkus: [...missingCostSkus].slice(0, 30) };
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
function mapReturn(r) { return { outDesi: Number(r.o_desi) > 0 ? Number(r.o_desi) : null, autoAt: r.auto_at || null, retDesi: r.desi || r.f_ret_desi || null, retCargo: r.f_ret_cargo ?? null, claimId: r.claim_id && r.claim_id !== '-' ? r.claim_id : null, canTy: !!(r.item_id && r.claim_id && r.claim_id !== '-'), customer: r.customer || '', amount: r.amount === null || r.amount === undefined ? null : r.amount, reason: r.reason || '', cnote: r.cnote || '', cargo: r.cargo || '', cargoLink: r.cargo_link || '', extAt: r.ext_at || null, id: r.id, channel: r.channel, orderNo: r.order_no, orderId: r.order_id, lineKey: r.line_key, pkey: r.pkey, sku: r.sku, name: r.name, qty: r.qty, status: r.status, source: r.source, note: r.note, extStatus: r.ext_status, createdAt: r.created_at, decidedAt: r.decided_at }; }
function mapProduct(r) { return { passive: r.ty_passive === 1 && !JSON.parse(r.channels || '[]').some(c => c !== 'trendyol'), sameDay: r.same_day === 1, id: r.key, sku: r.sku, name: r.name, barcode: r.barcode, image: r.image, channels: JSON.parse(r.channels || '[]'), qty: r.qty, cost: r.cost, min: r.min, tyQty: r.ty_qty === undefined ? null : r.ty_qty, createdAt: r.created_at, updatedAt: r.updated_at }; }
function mapMove(r) { return { id: r.id, t: r.t, key: r.pkey, sku: r.sku, name: r.name, delta: r.delta, after: r.after, type: r.type, channel: r.channel, ref: r.ref, note: r.note }; }
async function syncInfo(env) {
  const s = await getSettings(env, ['rev', 'started_at', 'auto_accept', 'ty_ok', 'ty_err', 'ty_prod_done', 'last_import', 'ty_prod_initial', 'ty_push', 'ty_push_at', 'ty_push_count', 'ty_push_err', 'ty_push_fail', 'fee_cargo_t1', 'fee_cargo_t2', 'fee_cargo_t3', 'cargo_desi_mode', 'desi_table', 'desi_tables', 'desi_learned', 'fee_service_ty', 'fee_cargo_sh', 'stopaj', 'fin_at', 'fin_err', 'fin_backfill_day', 'fin_stat', 'ty_diag', 'cron_gaps', 'fee_service_fast', 'service_cutoff', 'barem_max_desi', 'perf_profit', 'qna_waiting', 'qna_err', 'usage_avg']);
  let usage = null; try { usage = await usageGuard(env, false); } catch (e) {}
  // Trendyol'da yeni (Created) ve işleme alınan (Picking) paketler
  let newOrders = { n: 0, u: 0 };
  try { const r = await env.DB.prepare(`SELECT COUNT(DISTINCT order_no) n, COALESCE(SUM(units),0) u FROM audit_pkg WHERE status IN ('Created','Picking') AND day >= ?1`).bind(trDay(Date.now() - 30 * 86400000)).first(); if (r) newOrders = { n: r.n || 0, u: r.u || 0 }; } catch (e) {}
  return { usage, rev: s.rev, settings: { startedAt: s.started_at, autoAccept: s.auto_accept !== '0', prodInitial: s.ty_prod_initial !== '0', pushStock: s.ty_push !== '0', fees: { cargoT1: Number(s.fee_cargo_t1 ?? 46.49), cargoT2: Number(s.fee_cargo_t2 ?? 84.49), cargoT3: Number(s.fee_cargo_t3 ?? 98.35), desiMode: s.cargo_desi_mode === '1', desiTables: parseDesiTables(s.desi_tables), desiTable: parseDesiTable(s.desi_table), desiLearned: learnedTable(s.desi_learned), serviceTy: Number(s.fee_service_ty ?? 13.19), serviceFast: Number(s.fee_service_fast ?? 5.99), serviceCutoff: Number(s.service_cutoff ?? 15), baremMaxDesi: Number(s.barem_max_desi ?? 10), cargoSh: Number(s.fee_cargo_sh ?? 0), stopaj: Number(s.stopaj ?? 1) }, lastImport: s.last_import ? JSON.parse(s.last_import) : null }, sync: { trendyol: { configured: tyConfigured(env), ok: s.ty_ok || null, err: s.ty_err || '', productsAt: s.ty_prod_done || null, pushAt: s.ty_push_at || null, pushCount: Number(s.ty_push_count) || 0, pushErr: s.ty_push_err || '', pushFail: s.ty_push_fail || '', finAt: s.fin_at || null, finErr: s.fin_err || '', finStat: (() => { try { return JSON.parse(s.fin_stat || 'null'); } catch (e) { return null; } })(), diag: (() => { try { return JSON.parse(s.ty_diag || 'null'); } catch (e) { return null; } })(), gaps: (() => { try { return JSON.parse(s.cron_gaps || '[]'); } catch (e) { return []; } })(), backfill: s.fin_backfill_day || null, newOrders, qnaWaiting: Number(s.qna_waiting) || 0, usage: (() => { try { return JSON.parse(s.usage_avg || 'null'); } catch (e) { return null; } })(), qnaErr: s.qna_err || '', perf: (() => { try { return JSON.parse(s.perf_profit || 'null'); } catch (e) { return null; } })() } }, now: iso(), version: APP_VERSION, build: APP_BUILD };
}
/* ---------- piyasa bandı (döviz, borsa, emtia) ---------- */
const MKT_SYMS = { USD: 'USDTRY=X', EUR: 'EURTRY=X', BIST: 'XU100.IS', GOLD: 'GC=F', SILVER: 'SI=F', BRENT: 'BZ=F' };
async function yahooQuote(sym) {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=15m`, { headers: { 'user-agent': 'Mozilla/5.0 (LilyaBackstage)', accept: 'application/json' }, cf: { cacheTtl: 120 } });
      if (!r.ok) continue;
      const m = (((await r.json()).chart || {}).result || [])[0]?.meta; if (!m || !(m.regularMarketPrice > 0)) continue;
      const prev = m.chartPreviousClose || m.previousClose || null;
      return { price: m.regularMarketPrice, prev, t: m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now() };
    } catch (e) {}
  }
  return null;
}
async function tcmbRates() {
  try {
    const x = await (await fetch('https://www.tcmb.gov.tr/kurlar/today.xml')).text();
    const one = (c) => { const b = x.match(new RegExp(`CurrencyCode="${c}"[\\s\\S]*?<ForexSelling>([\\d.]+)<`)); return b ? Number(b[1]) : null; };
    return { USD: one('USD'), EUR: one('EUR') };
  } catch (e) { return {}; }
}
async function marketData(env) {
  const cached = JSON.parse((await getSetting(env, 'market2')) || 'null');
  if (cached && Date.now() - cached.at < 4 * 60000) return cached;
  const keys = Object.keys(MKT_SYMS), qs = await Promise.all(keys.map(k => yahooQuote(MKT_SYMS[k])));
  const q = {}; keys.forEach((k, i) => { if (qs[i]) q[k] = qs[i]; });
  if (!q.USD || !q.EUR) { const t = await tcmbRates(); for (const c of ['USD', 'EUR']) if (!q[c] && t[c]) q[c] = { price: t[c], prev: null, t: Date.now(), src: 'tcmb' }; }
  const OZ = 31.1035, items = [];
  const add = (id, label, x, unit, dec) => { if (x && x.price > 0) items.push({ id, label, price: x.price, chg: x.prev ? (x.price / x.prev - 1) * 100 : null, unit, dec }); };
  add('usd', 'Dolar', q.USD, '₺', 4); add('eur', 'Euro', q.EUR, '₺', 4);
  if (q.GOLD && q.USD) add('gram', 'Gram altın', { price: q.GOLD.price * q.USD.price / OZ, prev: q.GOLD.prev && q.USD.prev ? q.GOLD.prev * q.USD.prev / OZ : null }, '₺', 2);
  add('bist', 'BIST 100', q.BIST, '', 2); add('gold', 'Ons altın', q.GOLD, '$', 2);
  if (q.SILVER && q.USD) add('gs', 'Gram gümüş', { price: q.SILVER.price * q.USD.price / OZ, prev: q.SILVER.prev && q.USD.prev ? q.SILVER.prev * q.USD.prev / OZ : null }, '₺', 2);
  add('brent', 'Brent petrol', q.BRENT, '$', 2);
  const out = { at: Date.now(), items };
  if (items.length) await setSetting(env, 'market2', JSON.stringify(out));
  else if (cached) return cached;
  return out;
}
/* ---------- raporlar: her günün kesin sonucu ayrı tabloda saklanır (yıl sonu toplamları için) ---------- */
const STAT_KEYS = ['revenue', 'commission', 'cargo', 'retCargo', 'penalty', 'service', 'stopaj', 'cost', 'ads', 'expenses', 'extraIncome', 'otherFees', 'compensation', 'profit', 'orders', 'units', 'retUnits', 'retOrders'];
const dayStartTR = (d) => Date.parse(d + 'T00:00:00+03:00');
const addDay = (d, n) => trDay(dayStartTR(d) + n * 86400000 + 12 * 3600000);
async function snapshotDay(env, day) {
  const a = dayStartTR(day); const r = await computeProfit(env, iso(a), iso(a + 86400000));
  const data = {}; for (const k of STAT_KEYS) data[k] = Math.round((Number(r.summary[k]) || 0) * 100) / 100;
  // Değişmediyse hiçbir şey yazılmaz (yazılan satır = maliyet)
  const prev = await env.DB.prepare('SELECT data FROM daily_stats WHERE day=?1').bind(day).first();
  if (prev && prev.data === JSON.stringify(data)) { const pc = await env.DB.prepare('SELECT COUNT(*) n FROM product_daily WHERE day=?1').bind(day).first(); if (pc && pc.n === r.products.filter(x => x.units || x.retUnits || x.revenue || x.profit).length) { await env.DB.prepare('UPDATE daily_stats SET computed_at=?2 WHERE day=?1').bind(day, iso()).run(); return false; } }
  const st = [env.DB.prepare('INSERT INTO daily_stats(day, data, computed_at) VALUES(?1,?2,?3) ON CONFLICT(day) DO UPDATE SET data=excluded.data, computed_at=excluded.computed_at').bind(day, JSON.stringify(data), iso()),
    env.DB.prepare('DELETE FROM product_daily WHERE day=?1').bind(day)];
  const prs = r.products.filter(x => x.units || x.retUnits || x.revenue || x.profit);
  for (let i = 0; i < prs.length; i += 12) { const part = prs.slice(i, i + 12), args = [];
    for (const x of part) args.push(day, x.key, x.sku || '', String(x.name || '').slice(0, 120), x.units || 0, x.retUnits || 0, x.revenue || 0, x.profit || 0);
    st.push(env.DB.prepare('INSERT INTO product_daily(day, pkey, sku, name, units, ret_units, revenue, profit) VALUES ' + part.map((_, j) => '(' + [1,2,3,4,5,6,7,8].map(k => '?' + (j * 8 + k)).join(',') + ')').join(',')).bind(...args)); }
  await env.DB.batch(st);
  return true;
}
// Her dakika: bugün + dün; son 70 gün sırayla yeniden (geç gelen iade/fatura için); daha eski eksik günler bir kez
async function refreshStats(env, deadline, maxDays) {
  const today = trDay(Date.now()); const g = await getSettings(env, ['stats_cursor', 'stats_first']);
  let first = g.stats_first;
  if (!first) { const r = await env.DB.prepare('SELECT MIN(date) d FROM orders').first(); if (!r || !r.d) return { n: 0 }; first = trDay(Date.parse(r.d)); await setSetting(env, 'stats_first', first); }
  const todo = [today, addDay(today, -1)], LIM = Math.min(15, maxDays || 15);
  // Sonradan değişen günler (Trendyol gerçek kesintisi, iade, geç gelen sipariş) hemen yeniden hesaplanır;
  // böylece ana ekrandaki hafta/ay kârı ile Kâr ekranının canlı hesabı aynı kalır.
  try {
    const since = addDay(today, -70);
    const [chg, snap] = await env.DB.batch([
      env.DB.prepare(`SELECT substr(datetime(o.date,'+3 hours'),1,10) day, MAX(MAX(COALESCE(o.updated_at,'')), MAX(COALESCE(f.updated_at,''))) u FROM orders o LEFT JOIN order_fin f ON f.order_no=o.order_no WHERE o.date >= ?1 GROUP BY day`).bind(iso(dayStartTR(since))),
      env.DB.prepare('SELECT day, computed_at FROM daily_stats WHERE day >= ?1').bind(since)]);
    const at = new Map(snap.results.map(x => [x.day, x.computed_at || '']));
    const extra = await env.DB.batch([
      env.DB.prepare(`SELECT substr(datetime(o.date,'+3 hours'),1,10) day, MAX(MAX(COALESCE(r.decided_at,'')), MAX(COALESCE(r.ext_at,''))) u FROM returns r JOIN orders o ON o.order_no=r.order_no AND o.channel=r.channel WHERE o.date >= ?1 GROUP BY day`).bind(iso(dayStartTR(since))),
      env.DB.prepare(`SELECT day, MAX(created_at) u FROM expenses WHERE day >= ?1 GROUP BY day`).bind(since)]).catch(() => [{ results: [] }, { results: [] }]);
    for (const x of [...extra[0].results, ...extra[1].results]) chg.results.push(x);
    const dirty = chg.results.filter(x => x.day && x.day < addDay(today, -1) && at.has(x.day) && x.u > at.get(x.day)).map(x => x.day).sort().reverse();
    for (const d of dirty) if (todo.length < LIM && !todo.includes(d)) todo.push(d);
  } catch (e) {}
  // eksik günler: en yeniden eskiye (önce son günler dolsun)
  const { results } = await env.DB.prepare('SELECT day FROM daily_stats WHERE day >= ?1').bind(first).all(); const have = new Set(results.map(x => x.day));
  for (let d = addDay(today, -2); d >= first && todo.length < LIM; d = addDay(d, -1)) if (!have.has(d)) todo.push(d);
  // son 70 gün dönüşümlü
  let cur = g.stats_cursor && g.stats_cursor >= addDay(today, -70) && g.stats_cursor < today ? g.stats_cursor : addDay(today, -70);
  if (cur < first) cur = first;
  for (let k = 0; k < 2 && todo.length < LIM && cur < today; ) { if (!todo.includes(cur)) { todo.push(cur); k++; } cur = addDay(cur, 1); }
  todo.length = Math.min(todo.length, LIM);
  const busy = Number(await getSetting(env, 'stats_busy')) || 0; if (Date.now() - busy < 60000) return { n: 0, busy: true };
  await setSetting(env, 'stats_busy', String(Date.now()));
  let n = 0;
  try { for (const d of todo) { if (deadline && Date.now() > deadline) break; await snapshotDay(env, d); n++; } }
  finally { await env.DB.batch([setStmt(env, 'stats_cursor', cur >= today ? addDay(today, -70) : cur), setStmt(env, 'stats_busy', '0')]); }
  return { n };
}
/* ---------- ana ekran özeti: küçük cevap, 90 sn önbellek ---------- */
// Hesap arka planda yapılır; istek hiç beklemez, varsa son hesaplanan değer hemen döner.
async function homeData(env, ctx, force) {
  const today = trDay(Date.now());
  const cached = JSON.parse((await getSetting(env, 'home_cache')) || 'null');
  const fresh = cached && cached.day === today && Date.now() - cached.at < 90000;
  if ((!fresh || force) && cached && cached.day === today) {
    const busy = Number(await getSetting(env, 'home_busy')) || 0;
    if (Date.now() - busy > 180000) { await setSetting(env, 'home_busy', String(Date.now())); const job = computeHome(env).catch(async e => { try { await setSetting(env, 'home_err', String(e && e.message || e).slice(0, 300)); } catch (x) {} }).finally(() => setSetting(env, 'home_busy', '0').catch(() => {})); if (ctx && ctx.waitUntil) ctx.waitUntil(job); }
  }
  if (cached && cached.day === today) return cached;
  try { return await computeHome(env); } catch (e) { return { pending: true, err: String(e.message || e).slice(0, 200) }; }
}
// Hızlı: geçmiş günler kayıtlı günlük sonuçlardan (raporlar), sadece bugün ve "dün bu saate kadar" canlı hesaplanır
async function computeHome(env) {
  const t00 = Date.now(), today = trDay(t00);
  const t0 = dayStartTR(today), m0d = today.slice(0, 8) + '01', w0d = addDay(today, -6);
  const fromD = m0d < w0d ? m0d : w0d, yday = addDay(today, -1);
  const ySame = Math.max(t0 - 86400000 + 1, t00 - 86400000);
  // Ay toplamı Kâr ekranıyla birebir aynı olsun diye kayıtlı günlerden toplanmaz, aynı hesapla canlı alınır
  const [T, YS, statsR, pdR, M] = await Promise.all([
    computeProfit(env, iso(t0), iso(t0 + 86400000)),
    computeProfit(env, iso(t0 - 86400000), iso(ySame)),
    env.DB.prepare('SELECT day, data FROM daily_stats WHERE day >= ?1 AND day < ?2').bind(fromD, today).all(),
    env.DB.prepare('SELECT pkey, SUM(profit) p FROM product_daily WHERE day >= ?1 AND day < ?2 GROUP BY pkey').bind(m0d, today).all(),
    computeProfit(env, iso(dayStartTR(m0d)), iso(t0 + 86400000))]);
  const byDay = new Map(statsR.results.map(x => [x.day, JSON.parse(x.data || '{}')]));
  // Kaydı olmayan geçmiş gün varsa canlı hesaplanıp kaydedilir
  for (let d = fromD; d < today; d = addDay(d, 1)) if (!byDay.has(d)) { try { await snapshotDay(env, d); const r = await env.DB.prepare('SELECT data FROM daily_stats WHERE day=?1').bind(d).first(); if (r) byDay.set(d, JSON.parse(r.data)); } catch (e) {} }
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = addDay(today, -i); const x = i === 0 ? T.summary : (byDay.get(d) || {}); days.push({ d, rev: Number(x.revenue) || 0, prof: Number(x.profit) || 0, n: Number(x.orders) || 0, u: Number(x.units) || 0 }); }
  const mRev = M.summary.revenue, mProf = M.summary.profit;
  const pp = new Map(pdR.results.map(x => [x.pkey, x.p || 0])); for (const x of T.products) pp.set(x.key, (pp.get(x.key) || 0) + (x.profit || 0));
  const R2 = (n) => Math.round(n * 100) / 100;
  const out = { day: today, at: Date.now(), ms: Date.now() - t00, ySame: { at: ySame, rev: YS.summary.revenue, prof: YS.summary.profit, n: YS.summary.orders, u: YS.summary.units }, days,
    month: { revenue: R2(mRev), profit: R2(mProf), margin: mRev ? R2(mProf / mRev * 100) : null }, losers: [...pp.values()].filter(v => v < 0).length };
  await setSetting(env, 'home_cache', JSON.stringify(out)); await setSetting(env, 'home_err', '');
  return out;
}
/* ---------- hava durumu (Open-Meteo, anahtar gerektirmez) ---------- */
async function weatherData(req, body) {
  const cf = req.cf || {}; let lat = Number(body.lat), lon = Number(body.lon), city = '';
  const precise = isFinite(lat) && isFinite(lon) && body.lat !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  if (!precise) { lat = Number(cf.latitude); lon = Number(cf.longitude); city = cf.city || ''; }
  if (!isFinite(lat) || !isFinite(lon)) { lat = 41.01; lon = 28.98; city = 'İstanbul'; }
  lat = Math.round(lat * 100) / 100; lon = Math.round(lon * 100) / 100;
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`;
  const [w, g] = await Promise.all([
    fetch(u, { cf: { cacheTtl: 600 } }).then(r => r.ok ? r.json() : null).catch(() => null),
    precise ? fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&accept-language=tr&lat=${lat}&lon=${lon}`, { headers: { 'user-agent': 'LilyaBackstage/1.0' }, cf: { cacheTtl: 86400 } }).then(r => r.ok ? r.json() : null).catch(() => null) : null]);
  if (g && g.address) { const a = g.address; city = [a.town || a.city_district || a.district || a.county || a.suburb, a.province || a.city || a.state].filter(Boolean).filter((x, i, l) => l.indexOf(x) === i).join(', '); }
  if (!w || !w.current) return { temp: null };
  return { city, temp: w.current.temperature_2m, code: w.current.weather_code, wind: w.current.wind_speed_10m, max: w.daily.temperature_2m_max[0], min: w.daily.temperature_2m_min[0], rain: (w.daily.precipitation_probability_max || [null])[0] };
}
async function api(req, env, path, ctx) {
  const method = req.method;
  const multipart = (req.headers.get('content-type') || '').includes('multipart/form-data');
  const body = method === 'POST' && !multipart ? await req.json().catch(() => ({})) : {};
  if (path === '/api/state') {
    const info = await syncInfo(env);
    if (new URL(req.url).searchParams.get('rev') === info.rev) return json({ ...info, same: true });
    const [p, o, r, m] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM products ORDER BY name'),
      env.DB.prepare(`SELECT o.*, json_extract(c.data,'$.name') cname FROM orders o LEFT JOIN order_cust c ON c.order_no=o.order_no AND o.channel='trendyol' ORDER BY o.date DESC LIMIT 300`),
      env.DB.prepare(`SELECT r.*, f.ret_desi f_ret_desi, f.ret_cargo f_ret_cargo, (SELECT json_extract(j.value,'$.fin.desi') FROM orders o, json_each(o.lines) j WHERE o.order_no=r.order_no AND o.channel='trendyol' AND json_extract(j.value,'$.fin.desi') > 0 LIMIT 1) o_desi FROM returns r LEFT JOIN order_fin f ON f.order_no=r.order_no AND r.channel='trendyol' ORDER BY r.created_at DESC LIMIT 400`),
      env.DB.prepare('SELECT * FROM moves ORDER BY id DESC LIMIT 600')]);
    return json({ ...info, products: p.results.map(mapProduct), orders: o.results.map(mapOrder), returns: r.results.map(mapReturn), moves: m.results.map(mapMove) });
  }
  if (path === '/api/passkey/register-options') {
    const user = await authUser(env) || 'lilya';
    return json({ challenge: await waChallenge(env, 'reg'), rp: { name: 'Lilya Backstage', id: new URL(req.url).hostname }, user: { id: b64u.enc(new TextEncoder().encode('lb-' + user)), name: user, displayName: user }, exclude: (await env.DB.prepare('SELECT id FROM wa_creds').all()).results.map(r => r.id) });
  }
  if (path === '/api/passkey/register') {
    try {
      const url = new URL(req.url);
      await waCheckClient(env, url, body.clientDataJSON, 'webauthn.create', 'reg');
      const att = cborDecode(b64u.dec(body.attestationObject)).value; const ad = att.get('authData'); const info = parseAuthData(ad);
      if (!sameBytes(info.rpIdHash, await sha256(new TextEncoder().encode(url.hostname)))) throw new Error('Geçersiz alan adı');
      if (!info.uv || !info.at || !info.cose) throw new Error('Cihaz kilidi doğrulanmadı');
      const k = info.cose; if (k.get(1) !== 2 || k.get(3) !== -7 || k.get(-1) !== 1) throw new Error('Bu cihazın anahtar türü desteklenmiyor');
      const jwk = { kty: 'EC', crv: 'P-256', x: b64u.enc(k.get(-2)), y: b64u.enc(k.get(-3)), ext: true };
      await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const id = b64u.enc(info.credId);
      await env.DB.prepare('INSERT OR REPLACE INTO wa_creds(id, jwk, counter, created_at, used_at, label) VALUES(?1,?2,?3,?4,NULL,?5)').bind(id, JSON.stringify(jwk), info.counter, iso(), String(body.label || 'iPhone').slice(0, 60)).run();
      return json({ ok: true, id });
    } catch (e) { return bad('Face ID kurulamadı: ' + (e.message || e)); }
  }
  if (path === '/api/passkey/list') return json({ user: await authUser(env), items: (await env.DB.prepare('SELECT id, label, created_at, used_at FROM wa_creds ORDER BY created_at DESC').all()).results });
  if (path === '/api/passkey/delete') { if (body.all) await env.DB.prepare('DELETE FROM wa_creds').run(); else await env.DB.prepare('DELETE FROM wa_creds WHERE id=?1').bind(String(body.id || '')).run(); return json({ ok: true }); }
  if (path === '/api/expenses/add' || path === '/api/expenses/update') {
    const name = String(body.name || '').trim().slice(0, 80), amount = Number(body.amount), day = String(body.day || trDay(Date.now())), kind = body.kind === 'gelir' ? 'gelir' : 'gider';
    if (!name) return bad(kind === 'gelir' ? 'Gelir adını yaz.' : 'Gider adını yaz.');
    if (!isFinite(amount) || amount <= 0 || amount > 1e8) return bad('Geçerli bir tutar yaz.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return bad('Tarih geçersiz.');
    const st = path === '/api/expenses/update'
      ? env.DB.prepare('UPDATE expenses SET day=?1, name=?2, amount=?3, kind=?5 WHERE id=?4').bind(day, name, Math.round(amount * 100) / 100, Number(body.id) || 0, kind)
      : env.DB.prepare('INSERT INTO expenses(day, name, amount, created_at, kind) VALUES(?1,?2,?3,?4,?5)').bind(day, name, Math.round(amount * 100) / 100, iso(), kind);
    const old = path === '/api/expenses/update' ? await env.DB.prepare('SELECT day FROM expenses WHERE id=?1').bind(Number(body.id) || 0).first() : null;
    await env.DB.batch([st, setStmt(env, 'home_cache', ''), REV(env)]);
    // Raporlar ve ana ekran hemen güncel olsun
    try { await snapshotDay(env, day); if (old && old.day && old.day !== day) await snapshotDay(env, old.day); } catch (e) {}
    return json({ ok: true });
  }
  if (path === '/api/expenses/delete') { const old = await env.DB.prepare('SELECT day FROM expenses WHERE id=?1').bind(Number(body.id) || 0).first(); await env.DB.batch([env.DB.prepare('DELETE FROM expenses WHERE id=?1').bind(Number(body.id) || 0), setStmt(env, 'home_cache', ''), REV(env)]); try { if (old && old.day) await snapshotDay(env, old.day); } catch (e) {} return json({ ok: true }); }
  if (path === '/api/reports') {
    const { results } = await env.DB.prepare('SELECT day, data, computed_at FROM daily_stats ORDER BY day').all();
    const first = await getSetting(env, 'stats_first'), today = trDay(Date.now());
    let expected = 0; if (first) expected = Math.round((dayStartTR(today) - dayStartTR(first)) / 86400000) + 1;
    const have = results.filter(x => x.day >= (first || '')).length;
    // Eksik gün varsa beklemeden arka planda hesaplamaya başla
    if (!first || have < expected) { const job = refreshStats(env, Date.now() + 25000).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(job); }
    return json({ first, expected, have, days: results.map(x => ({ day: x.day, at: x.computed_at, ...JSON.parse(x.data || '{}') })) });
  }
  if (path === '/api/reports/products') {
    const from = String(body.from || ''), to = String(body.to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return bad('Tarih geçersiz.');
    const q = `SELECT pd.pkey, MAX(pd.sku) sku, MAX(pd.name) name, MAX(p.image) image, SUM(pd.units) units, SUM(pd.ret_units) ret, SUM(pd.revenue) revenue, SUM(pd.profit) profit FROM product_daily pd LEFT JOIN products p ON p.key=pd.pkey WHERE pd.day >= ?1 AND pd.day <= ?2 GROUP BY pd.pkey`;
    const [best, worst, top] = await env.DB.batch([env.DB.prepare(q + ' ORDER BY profit DESC LIMIT 10').bind(from, to), env.DB.prepare(q + ' HAVING SUM(pd.profit) < 0 ORDER BY profit ASC LIMIT 10').bind(from, to), env.DB.prepare(q + ' ORDER BY units DESC LIMIT 10').bind(from, to)]);
    return json({ best: best.results, worst: worst.results, top: top.results });
  }
  if (path === '/api/reports/rebuild') { await env.DB.batch([env.DB.prepare('DELETE FROM daily_stats'), env.DB.prepare('DELETE FROM product_daily'), setStmt(env, 'stats_first', ''), setStmt(env, 'stats_cursor', ''), setStmt(env, 'stats_busy', '0')]); const job = refreshStats(env, Date.now() + 25000).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(job); return json({ ok: true }); }
  if (path === '/api/qna/list') {
    const st = body.status === 'answered' ? `status IN ('answered','answered_elsewhere')` : `status IN ('waiting','sent_failed')`;
    const { results } = await env.DB.prepare(`SELECT q.*, p.note pnote, (p.descr IS NOT NULL AND p.descr<>'') has_info FROM qna q LEFT JOIN product_info p ON p.main_id=q.main_id WHERE ${st} ORDER BY ${body.status === 'answered' ? 'COALESCE(q.answered_at,q.updated_at) DESC LIMIT 100' : 'q.created_at ASC LIMIT 200'}`).all();
    return json({ ai: !!env.ANTHROPIC_API_KEY, general: (await getSetting(env, 'qa_general')) || '', items: results });
  }
  if (path === '/api/qna/draft') { try { return json(await draftQna(env, body.id, body.hint)); } catch (e) { return bad(e.message || String(e)); } }
  if (path === '/api/qna/answer') {
    const text = String(body.text || '').trim(), id = String(body.id || '');
    if (text.length < 10) return bad('Cevap en az 10 karakter olmalı.'); if (text.length > 2000) return bad('Cevap en fazla 2000 karakter olabilir.');
    if (/(https?:\/\/|www\.|@[a-z0-9-]+\.|\b0?5\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b)/i.test(text)) return bad('Cevapta web adresi, e-posta ya da telefon numarası olmamalı (Trendyol kuralı).');
    const r = await fetch(`${TY_BASE}qna/sellers/${env.TRENDYOL_SELLER_ID}/questions/${encodeURIComponent(id)}/answers`, { method: 'POST', headers: { ...tyHeaders(env), 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) { const t = (await r.text()).slice(0, 300); return bad(`Trendyol cevabı kabul etmedi (${r.status}): ${t}`); }
    await env.DB.prepare(`UPDATE qna SET status='answered', answer=?2, answered_at=?3, updated_at=?3 WHERE id=?1`).bind(id, text, iso()).run();
    await qnaCount(env);
    return json({ ok: true });
  }
  if (path === '/api/qna/note') {
    const mid = String(body.mainId || ''); if (!mid) return bad('Ürün bulunamadı.');
    await env.DB.prepare(`INSERT INTO product_info(main_id, title, note, updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(main_id) DO UPDATE SET note=excluded.note`).bind(mid, String(body.title || ''), String(body.note || '').slice(0, 3000), iso()).run();
    return json({ ok: true });
  }
  if (path === '/api/qna/general') { await setSetting(env, 'qa_general', String(body.text || '').slice(0, 4000)); return json({ ok: true }); }
  if (path === '/api/qna/sync') { try { const r = await syncTrendyolQna(env); return json(r); } catch (e) { return bad(e.message || String(e)); } }
  if (path === '/api/home') return json(await homeData(env, ctx, !!body.force));
  if (path === '/api/weather') { try { return json(await weatherData(req, body)); } catch (e) { return json({ temp: null }); } }
  if (path === '/api/market') { try { return json(await marketData(env)); } catch (e) { return json({ at: Date.now(), items: [] }); } }
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
    const g = await loadClaimGroup(env, body.ids || body.id); if (g.err) return bad(g.err, g.code || 400);
    const rows = g.rows, now = iso();
    // Trendyol'da "Aksiyon bekliyor" olanlar önce Trendyol'da onaylanır; Trendyol kabul etmezse burada hiçbir şey değişmez
    let tyApproved = 0;
    if (body.accept && body.trendyol) {
      const byClaim = new Map();
      for (const r of rows) if (r.channel === 'trendyol' && r.ext_status === 'WaitingInAction' && r.claim_id && r.claim_id !== '-' && r.item_id) { const l = byClaim.get(r.claim_id) || []; l.push(r.item_id); byClaim.set(r.claim_id, l); }
      if (!byClaim.size) return bad('Bu iade Trendyol\'da onaylanabilir durumda değil.', 409);
      if (!tyConfigured(env)) return bad('Trendyol bağlı değil.');
      for (const [cid, list] of byClaim) {
        try { await tySend(env, 'PUT', `order/sellers/${env.TRENDYOL_SELLER_ID}/claims/${encodeURIComponent(cid)}/items/approve`, null, { claimLineItemIdList: list, params: {} }); tyApproved += list.length; }
        catch (e) { return bad((tyApproved ? `${tyApproved} kalem onaylandı, kalanında hata: ` : 'Trendyol onayı başarısız: ') + e.message, 502); }
      }
    }
    const st = [];
    for (const r of rows) {
      st.push(guardStmt(env, `(SELECT status FROM returns WHERE id=?1)='requested'`, r.id),
        env.DB.prepare(`UPDATE returns SET status=?1, decided_at=?2${tyApproved && r.ext_status === 'WaitingInAction' ? ", ext_status='WaitingFraudCheck', ext_at=?2" : ''} WHERE id=?3`).bind(body.accept ? 'accepted' : 'rejected', now, r.id));
      if (body.accept) st.push(...ensureProduct(env, r.pkey, { sku: r.sku, name: r.name }, null), ...changeQty(env, r.pkey, r.qty, { type: 'ret', channel: r.channel, ref: r.order_no, note: tyApproved ? 'Depoya ulaştı, Trendyol\'da onaylandı' : 'Depoya ulaştı, kabul edildi' }));
      st.push(unguard(env));
    }
    st.push(REV(env));
    try { await env.DB.batch(st); } catch (e) { return bad(tyApproved ? 'Trendyol\'da onaylandı ama stok güncellenemedi; sayfayı yenileyip "Depoya ulaştı" ile stoğu ekle.' : 'Bu iade az önce başka bir yerden işlendi.', 409); }
    return json({ ok: true, tyApproved });
  }
  if (path === '/api/returns/shape') {
    // Teşhis: açık bir Trendyol iadesinin kaydında ve geçmişinde gelen alan adları (müşteri bilgisi çıkarılır)
    if (!tyConfigured(env)) return bad('Trendyol bağlı değil.');
    const row = await env.DB.prepare(`SELECT order_no, claim_id, item_id FROM returns WHERE channel='trendyol' AND claim_id IS NOT NULL AND claim_id<>'-' AND item_id IS NOT NULL ORDER BY (ext_status='WaitingInAction') DESC, created_at DESC LIMIT 1`).first();
    if (!row) return bad('Kontrol edilecek iade bulunamadı.');
    const clean = (l) => l.filter(k => !/customer|address|firstName|lastName|phone|email|fullName|sellerOtp/i.test(k));
    const out = { orderNo: row.order_no, claim: [], audit: [], errors: [] };
    try { const r = await ty(env, `order/sellers/${env.TRENDYOL_SELLER_ID}/claims`, { claimIds: row.claim_id, size: 5, page: 0 }); out.claim = clean([...keyPaths((r.content || [])[0] || {})]); } catch (e) { out.errors.push('claim: ' + e.message); }
    out.pkgs = [];
    try { const n = Date.now(); const r = await ty(env, `order/sellers/${env.TRENDYOL_SELLER_ID}/v2/orders`, { orderNumber: row.order_no, startDate: n - 30 * 86400000, endDate: n + TY_TZ, size: 20, page: 0 });
      for (const p of (r.content || [])) out.pkgs.push(['id=' + (p.shipmentPackageId || p.id), 'status=' + (p.shipmentPackageStatus || p.status), ...Object.entries(p).filter(([k, v]) => /desi|deci|type|return|claim/i.test(k) && (v === null || typeof v !== 'object')).map(([k, v]) => k + '=' + String(v).slice(0, 30))].join(' · ')); } catch (e) { out.errors.push('orders: ' + e.message); }
    try { const r = await ty(env, `order/sellers/${env.TRENDYOL_SELLER_ID}/claims/items/${encodeURIComponent(row.item_id)}/audit`, {}); out.audit = clean([...keyPaths(Array.isArray(r) ? r : r)]).slice(0, 80); } catch (e) { out.errors.push('audit: ' + e.message); }
    return json(out);
  }
  if (path === '/api/returns/reasons') {
    if (!tyConfigured(env)) return bad('Trendyol bağlı değil.');
    try { return json({ reasons: await claimIssueReasons(env), noFile: [...CLAIM_NOFILE] }); } catch (e) { return bad('Ret sebepleri alınamadı: ' + e.message, 502); }
  }
  if (path === '/api/returns/ty-reject') {
    if (!multipart) return bad('Geçersiz istek.');
    const fd = await req.formData();
    let ids = []; try { ids = JSON.parse(String(fd.get('ids') || '[]')); } catch (e) {}
    const g = await loadClaimGroup(env, ids); if (g.err) return bad(g.err, g.code || 400);
    const rows = g.rows; const cid = rows[0].claim_id;
    if (!cid || cid === '-' || rows.some(r => r.claim_id !== cid || r.ext_status !== 'WaitingInAction' || !r.item_id)) return bad('Ret talebi yalnızca Trendyol\'da "Aksiyon bekliyor" durumundaki iadeler için gönderilebilir.', 409);
    const reasonId = Number(fd.get('reasonId')); const desc = String(fd.get('description') || '').trim().slice(0, 500);
    if (!reasonId) return bad('Ret sebebini seç.');
    if (!desc) return bad('Açıklama yaz.');
    const files = fd.getAll('files').filter(f => f && typeof f === 'object' && f.size > 0);
    if (!files.length && !CLAIM_NOFILE.has(reasonId)) return bad('Bu ret sebebi için fotoğraf ya da belge eklemen gerekiyor.');
    if (files.some(f => f.size > 5 * 1024 * 1024)) return bad('Her dosya en fazla 5 MB olabilir.');
    const out = new FormData(); for (const f of files.slice(0, 5)) out.append('files', f, f.name || 'ek');
    let reasonName = String(reasonId); try { const l = await claimIssueReasons(env); const m = l.find(x => x.id === reasonId); if (m) reasonName = m.name; } catch (e) {}
    try { await tySend(env, 'POST', `order/sellers/${env.TRENDYOL_SELLER_ID}/claims/${encodeURIComponent(cid)}/issue`, { claimIssueReasonId: reasonId, claimItemIdList: rows.map(r => r.item_id).join(','), description: desc }, out); }
    catch (e) { return bad('Trendyol ret talebi başarısız: ' + e.message, 502); }
    const now = iso(), note = ('Ret talebi gönderildi: ' + reasonName).slice(0, 300);
    // Stok değişmez; Trendyol talebi sonuçlandırınca (Reddedildi / Onaylandı) durum eşitlemeyle güncellenir
    await env.DB.batch([...rows.map(r => env.DB.prepare(`UPDATE returns SET ext_status='InAnalysis', ext_at=?2, note=?3 WHERE id=?1 AND status='requested'`).bind(r.id, now, note)), REV(env)]);
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
    // Hız ölçümü: veritabanı bekleme süresi (ping) ve toplam süre Bağlantılar'da görünür
    const t0 = Date.now(); await env.DB.prepare('SELECT 1').first(); const ping = Date.now() - t0;
    const out = await computeProfit(env, iso(from), iso(to)); const ms = Date.now() - t0;
    try { await setSetting(env, 'perf_profit', JSON.stringify({ at: iso(), days: Math.round((to - from) / 86400000), orders: out.orders.length, ms, ping, ph: PERF_LAST, cold: COLD_MS })); } catch (e) {}
    return json(out);
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
    if (f === 'delivered') where.push(`o.channel='trendyol' AND o.order_no IN (SELECT order_no FROM audit_pkg WHERE status='Delivered')`); else if (f === 'new') where.push(`o.channel='trendyol' AND o.order_no IN (SELECT order_no FROM audit_pkg WHERE status IN ('Created','Picking') AND day >= '${trDay(Date.now() - 30 * 86400000)}')`); else if (f === 'active') where.push(`o.status='active'`); else if (f === 'cancelled') where.push(`o.status IN ('cancelled','partial')`); else if (f === 'returned') where.push(`o.status='returned'`);
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
    // Her siparişin kârı: Kâr ekranıyla aynı hesap, bu sayfadaki siparişlerin tarih aralığı için
    const prof = {};
    try {
      const ds = results.map(r => Date.parse(r.date)).filter(Number.isFinite);
      if (ds.length) {
        const pr = await computeProfit(env, iso(Math.min(...ds)), iso(Math.max(...ds) + 1));
        const ids = new Set(results.map(r => r.id));
        for (const x of pr.orders) if (ids.has(x.id)) prof[x.id] = { p: x.profit, r: x.revenue, a: !!x.actual };
      }
    } catch (e) {}
    return json({ ok: true, page, size, total: tot ? tot.n : 0, orders: results.map(r => ({ ...mapOrder(r), prof: prof[r.id] || null })) });
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
      // Sayfa ve simgeler veritabanını beklemeden hemen gönderilir
      if (!path.startsWith('/api/') && path !== '/perf' && path !== '/__stats' && path !== '/__run' && path !== '/manifest.webmanifest' && path !== '/icon.svg' && path !== '/apple-touch-icon.png' && path !== '/icon-192.png' && path !== '/icon-512.png')
        { USE.req++; return new Response(APP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } }); }
      if (path.startsWith('/api/') && path !== '/api/logout' || path === '/perf' || path === '/__stats' || path === '/__run') await init(env);
      if (path === '/manifest.webmanifest') return new Response(JSON.stringify({ name: 'Lilya Backstage', short_name: 'Backstage', start_url: '/', display: 'standalone', background_color: '#f5f6f8', theme_color: '#0a0b10', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] }), { headers: { 'content-type': 'application/manifest+json' } });
      if (path === '/icon.svg' || path === '/apple-touch-icon.png') return new Response(ICON_SVG, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
      // Giriş ekranı bilgisi: kullanıcı adı belirlenmiş mi, Face ID kurulu mu
      if (path === '/api/auth/info') {
        const user = await authUser(env); const n = await env.DB.prepare('SELECT COUNT(*) n FROM wa_creds').first();
        return json({ hasUser: !!user, passkeys: (n && n.n) || 0, authed: !!(await authed(req, env)) });
      }
      if (path === '/api/login' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const name = String(b.username || '').trim().toLocaleLowerCase('tr-TR');
        const passOk = typeof b.password === 'string' && (await hmac('cmp', b.password)) === (await hmac('cmp', env.APP_PASSWORD));
        const user = await authUser(env);
        if (!name) return bad('Kullanıcı adını yaz.');
        if (!passOk || (user && user !== name)) { await sleep(900); return bad('Kullanıcı adı ya da şifre hatalı.', 401); }
        if (!user) { if (!/^[a-z0-9çğıöşü._-]{3,32}$/.test(name)) return bad('Kullanıcı adı 3-32 karakter olmalı; harf, rakam, nokta, tire kullanılabilir.'); await setSetting(env, 'auth_user', name); }
        await setSetting(env, 'auth_user_tag', await hmac(env.APP_PASSWORD, 'user-tag'));
        return json({ ok: true }, 200, { 'set-cookie': await loginCookie(env) });
      }
      if (path === '/api/passkey/login-options' && req.method === 'POST') {
        const { results } = await env.DB.prepare('SELECT id FROM wa_creds').all();
        if (!results.length) return bad('Face ID kurulu değil.', 404);
        return json({ challenge: await waChallenge(env, 'login'), rpId: url.hostname, allow: results.map(r => r.id) });
      }
      if (path === '/api/passkey/login' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        try {
          const cred = await env.DB.prepare('SELECT * FROM wa_creds WHERE id=?1').bind(String(b.id || '')).first();
          if (!cred) throw new Error('Bu cihazın Face ID kaydı bulunamadı');
          const cdj = await waCheckClient(env, url, b.clientDataJSON, 'webauthn.get', 'login');
          const ad = b64u.dec(b.authenticatorData), info = parseAuthData(ad);
          if (!sameBytes(info.rpIdHash, await sha256(new TextEncoder().encode(url.hostname)))) throw new Error('Geçersiz alan adı');
          if (!info.up || !info.uv) throw new Error('Kimlik doğrulanmadı');
          const key = await crypto.subtle.importKey('jwk', JSON.parse(cred.jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
          const signed = new Uint8Array(ad.length + 32); signed.set(ad); signed.set(await sha256(cdj), ad.length);
          const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(b64u.dec(b.signature)), signed);
          if (!ok) throw new Error('İmza doğrulanamadı');
          if (info.counter && cred.counter && info.counter <= cred.counter) throw new Error('Kayıt kopyalanmış olabilir');
          await env.DB.prepare('UPDATE wa_creds SET counter=?2, used_at=?3 WHERE id=?1').bind(cred.id, info.counter, iso()).run();
          return json({ ok: true }, 200, { 'set-cookie': await loginCookie(env) });
        } catch (e) { await sleep(600); return bad('Face ID girişi olmadı: ' + (e.message || e), 401); }
      }
      if (path === '/__run' && req.method === 'POST') {
        if (req.headers.get('x-run') !== await hmac(env.APP_PASSWORD, 'stats-run')) return bad('Yetkisiz', 403);
        const b = await req.json().catch(() => ({}));
        try { return json(await pollOnce(env, b.mode === 'heavy', Number(b.budget) || Date.now() + 9000, b.mode === 'heavy' ? 'heavy' : 'light')); }
        catch (e) { return json({ error: String(e.message || e).slice(0, 200), steps: {} }); }
      }
      if (path === '/__stats' && req.method === 'POST') {
        if (req.headers.get('x-run') !== await hmac(env.APP_PASSWORD, 'stats-run')) return bad('Yetkisiz', 403);
        let qd = null; try { qd = await draftPendingQna(env, 4); } catch (e) {}
        try { const r = await refreshStats(env, Date.now() + 25000); await setSetting(env, 'stats_run', iso() + ' · ' + (r.busy ? 'meşgul' : r.n + ' gün') + (qd && qd.n ? ` · ${qd.n} soru taslağı` : '')); return json(r); }
        catch (e) { await setSetting(env, 'stats_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); return bad(String(e.message || e), 500); }
      }
      if (path === '/perf') {
        const t0 = Date.now(); await env.DB.prepare('SELECT 1').first(); const ping = Date.now() - t0;
        const g = await getSettings(env, ['perf_profit', 'ty_diag', 'cron_busy', 'cron_at', 'stats_run', 'stats_err', 'run_err', 'ty_orders_exact', 'ty_orders_hwm', 'ty_ok', 'usage_avg']);
        const pp = JSON.parse(g.perf_profit || 'null'), dg = JSON.parse(g.ty_diag || 'null');
        return json({ now: iso(), ping, cold: COLD_MS, profit: pp && { at: pp.at, days: pp.days, ms: pp.ms, ping: pp.ping, ph: pp.ph, cold: pp.cold }, cron: dg && { at: dg.at, polls: dg.polls, ms: dg.ms, queries: dg.queries, wr: dg.wr, rd: dg.rd, slow: dg.slow, errs: dg.errs || {} }, usage: g.usage_avg ? JSON.parse(g.usage_avg) : null, guard: await usageGuard(env, true), runErr: g.run_err || null, exact: g.ty_orders_exact || null, hwm: g.ty_orders_hwm ? iso(Number(g.ty_orders_hwm)) : null, tyOk: g.ty_ok || null, cronBusy: g.cron_busy || null, cronAt: g.cron_at ? iso(Number(g.cron_at)) : null, statsRun: g.stats_run || null, statsErr: g.stats_err || null });
      }
      if (path === '/api/logout') return json({ ok: true }, 200, { 'set-cookie': 'lb=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
      if (path.startsWith('/api/')) {
        const exp = await authed(req, env);
        if (!exp) return bad('Oturum gerekli.', 401);
        const uc = { n: 0 }; const envU = { ...env, DB: countingDB(env.DB, uc) };
        const res = await api(req, envU, path, ctx);
        USE.req++; USE.wr += uc.w || 0; USE.rd += uc.r || 0;
        if (Date.now() - USE.at > 60000) ctx.waitUntil(flushUsage(env).catch(() => {}));
        // Kullandıkça oturum uzar
        if (exp - Date.now() < SESSION_MS - 86400000) { try { res.headers.append('set-cookie', await loginCookie(env)); } catch (e) {} }
        return res;
      }
      return new Response(APP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
    } catch (e) {
      return bad('Sunucu hatası: ' + String(e && e.message || e).slice(0, 300), 500);
    }
  },
  // Ana eşitleme her dakika; raporlar 2 dakikada bir ayrı çalışmada (sorgu sınırı ayrı sayılsın, eşitlemeyi yavaşlatmasın)
  async scheduled(event, env, ctx) { ctx.waitUntil(cronRun(env)); }
};

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d2235"/><stop offset=".55" stop-color="#0f121c"/><stop offset="1" stop-color="#06070b"/></linearGradient><radialGradient id="g1" cx="860" cy="140" r="640" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6366f1" stop-opacity=".62"/><stop offset="1" stop-color="#6366f1" stop-opacity="0"/></radialGradient><radialGradient id="g2" cx="120" cy="980" r="560" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#22d3ee" stop-opacity=".22"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></radialGradient><linearGradient id="ac" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a5b4fc"/><stop offset=".5" stop-color="#818cf8"/><stop offset="1" stop-color="#22d3ee"/></linearGradient><clipPath id="r"><rect width="1024" height="1024" rx="230"/></clipPath></defs><g clip-path="url(#r)"><rect width="1024" height="1024" fill="url(#bg)"/><rect width="1024" height="1024" fill="url(#g1)"/><rect width="1024" height="1024" fill="url(#g2)"/><g fill="#fff"><rect x="262" y="236" width="156" height="548" rx="40"/><rect x="262" y="628" width="392" height="156" rx="40"/></g><circle cx="742" cy="706" r="78" fill="url(#ac)"/></g></svg>`;

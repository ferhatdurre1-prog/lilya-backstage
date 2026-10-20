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
  `CREATE TABLE IF NOT EXISTS bundles(pkey TEXT NOT NULL, comp TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(pkey, comp))`,
  `CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS purchases(id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, supplier_id INTEGER, supplier TEXT, doc_no TEXT, doc_date TEXT, items TEXT NOT NULL DEFAULT '[]', units INTEGER, total REAL, status TEXT NOT NULL DEFAULT 'active', reverted_at TEXT, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS pt_payout(day TEXT PRIMARY KEY, sales REAL, ret REAL, net REAL, detailed INTEGER NOT NULL DEFAULT 0, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sr_rows(takip TEXT PRIMARY KEY, day TEXT, alici TEXT, fee REAL, cod REAL, collected INTEGER, coll_amt REAL, iade TEXT, durum TEXT, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sr_mov(id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT, kind TEXT, amount REAL, note TEXT, at TEXT, deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS paytr_tx(k TEXT PRIMARY KEY, siparis_no TEXT, tip TEXT, tutar REAL, kesinti REAL, net REAL, oran REAL, tarih TEXT, odeme_tipi TEXT, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sr_cost(no TEXT PRIMARY KEY, tracking TEXT, cost REAL, desi REAL, cod_amount REAL, undelivered INTEGER, durum TEXT, teslim TEXT, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sh_ret(id INTEGER PRIMARY KEY AUTOINCREMENT, no TEXT NOT NULL, tracking TEXT, desi REAL, cost REAL, note TEXT, at TEXT, deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sh_pay(no TEXT PRIMARY KEY, gateway TEXT, cod INTEGER, card INTEGER, subtotal REAL, ship REAL, total REAL, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS bk_ship(no TEXT PRIMARY KEY, bk_id TEXT, created TEXT, handler TEXT, status TEXT, fee REAL, cod INTEGER, cod_type TEXT, cod_amount REAL, cod_fee REAL, cod_status TEXT, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sup_mov(id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, supplier TEXT NOT NULL COLLATE NOCASE, date TEXT, kind TEXT, amount REAL NOT NULL, note TEXT, deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sup_pay(id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, supplier TEXT NOT NULL COLLATE NOCASE, date TEXT, amount REAL NOT NULL, method TEXT, note TEXT, deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sup_map(supplier TEXT NOT NULL, k TEXT NOT NULL, pkey TEXT NOT NULL, PRIMARY KEY(supplier, k))`,
  `CREATE TABLE IF NOT EXISTS out_lists(id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, reason TEXT, note TEXT, markup REAL, disc REAL, items TEXT NOT NULL DEFAULT '[]', units INTEGER, total REAL, status TEXT NOT NULL DEFAULT 'active', reverted_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS guard(x INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ty_set(id TEXT PRIMARY KEY, order_no TEXT, type TEXT, tx_ms INTEGER, due_ms INTEGER, net REAL, amt REAL, po TEXT, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ty_early_inv(id TEXT PRIMARY KEY, amount REAL, matched INTEGER, po TEXT, day TEXT, n INTEGER, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ty_po(id TEXT PRIMARY KEY, day TEXT, amount REAL, descr TEXT, at TEXT)`,
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
// Set ürünler: set ilanı satılınca stok setin içindeki ürünlerden düşer (pkey → [[parça, adet]]); her isolate'te dakikada bir tazelenir
let BUNDLES = new Map(), BUNDLES_AT = 0;
async function loadBundles(env) { try { const { results } = await env.DB.prepare('SELECT pkey, comp, n FROM bundles').all(); const m = new Map(); for (const r of results) { if (!m.has(r.pkey)) m.set(r.pkey, []); m.get(r.pkey).push([r.comp, Number(r.n) || 1]); } BUNDLES = m; BUNDLES_AT = Date.now(); } catch (e) {} }
const MTO_QTY = 10; // stoksuz satış ürünlerinde kanallara gönderilen en az adet (stok yokken de satılabilsin)
const SET_QTY_SQL = (alias) => `COALESCE((SELECT MIN(cp.qty / b.n) FROM bundles b JOIN products cp ON cp.key=b.comp WHERE b.pkey=${alias}.key), ${alias}.qty)`;
async function init(env) {
  if (READY) { if (Date.now() - BUNDLES_AT > 60000) await loadBundles(env); return; }
  const ti0 = Date.now();
  try {
    // Kurulum/geçiş kontrolleri bu sürüm için bir kez yapıldıysa tek sorguyla geçilir
    let done = false;
    try { const r = await env.DB.prepare(`SELECT v FROM settings WHERE k='schema_build'`).first(); done = !!(r && r.v === APP_BUILD); } catch (e) {}
    if (!done) { await init0(env); await env.DB.prepare(`INSERT INTO settings(k,v) VALUES('schema_build',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(APP_BUILD).run(); }
    READY = true; await loadBundles(env);
  } finally { COLD_MS = Date.now() - ti0; }
}
async function init0(env) {
  if (!env.DB) throw new Error('D1 veritabanı bağlanmamış (DB).');
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  await env.DB.prepare(`INSERT OR IGNORE INTO settings(k,v) VALUES('started_at',?1)`).bind(iso()).run();
  try { await env.DB.prepare('ALTER TABLE products ADD COLUMN ty_qty INTEGER').run(); } catch (e) { /* sütun zaten var */ }
  let priceCol = false;
  try { await env.DB.prepare('ALTER TABLE products ADD COLUMN ty_price REAL').run(); priceCol = true; } catch (e) {}
  // Set ürünlerin kendi stoğu tutulmaz: set yapılmadan önce girilmiş adet sıfırlanır (hareket kaydıyla)
  try { const now = iso(); await env.DB.batch([
    env.DB.prepare(`INSERT INTO moves(t,pkey,sku,name,delta,after,type,channel,ref,note) SELECT ?1,key,sku,name,-qty,0,'count','manuel','','Set ürün: setin kendi stoğu sıfırlandı (stok içindeki ürünlerden hesaplanır)' FROM products WHERE qty<>0 AND key IN (SELECT pkey FROM bundles)`).bind(now),
    env.DB.prepare(`UPDATE products SET qty=0, updated_at=?1 WHERE qty<>0 AND key IN (SELECT pkey FROM bundles)`).bind(now)]); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE suppliers ADD COLUMN terms TEXT').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE products ADD COLUMN cost_date TEXT').run(); } catch (e) {} // maliyetin geldiği fiş tarihi // cari ödeme şekli (vade)
  try { await env.DB.prepare('ALTER TABLE sh_pay ADD COLUMN tx TEXT').run(); } catch (e) {} // Shopify ödeme işlem kimlikleri (PayTR eşleşmesi)
  try { await env.DB.prepare('ALTER TABLE paytr_tx ADD COLUMN paid_day TEXT').run(); } catch (e) {} // PayTR parayı hangi gün yatırdı
  try { await env.DB.prepare('ALTER TABLE qna ADD COLUMN sent_draft TEXT').run(); } catch (e) {} // gönderilen cevabın yapay zekâ taslağı (düzeltmelerden öğrenmek için)
  try { await env.DB.prepare('ALTER TABLE qna ADD COLUMN draft_n INTEGER').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE ty_set ADD COLUMN period INTEGER').run(); } catch (e) {} // Trendyol vade süresi (gün, kategoriye göre)
  try { await env.DB.prepare('ALTER TABLE suppliers ADD COLUMN manual INTEGER').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE suppliers ADD COLUMN currency TEXT').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE sup_mov ADD COLUMN src TEXT').run(); } catch (e) {} // 'xls' = Excel'den yüklendi (toplu silinebilir)
  try { await env.DB.prepare('ALTER TABLE sup_pay ADD COLUMN src TEXT').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE sup_mov ADD COLUMN batch TEXT').run(); } catch (e) {} // hangi Excel yüklemesinden geldi (geri alma için)
  try { await env.DB.prepare('ALTER TABLE sup_pay ADD COLUMN batch TEXT').run(); } catch (e) {}
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS cari_imp(batch TEXT PRIMARY KEY, at TEXT, file TEXT, n INTEGER, skipped INTEGER, undone_at TEXT)').run(); } catch (e) {} // döviz cari: USD / EUR (boş = TL) // elle açılan cari (hareketi olmasa da listede görünür)
  try { await env.DB.prepare('ALTER TABLE audit_pkg ADD COLUMN delivered TEXT').run(); } catch (e) {} // Trendyol paketinin teslim günü
  try { await env.DB.prepare('ALTER TABLE sr_cost ADD COLUMN planned TEXT').run(); } catch (e) {} // Sürat planlanan teslim tarihi
  try { await env.DB.prepare('ALTER TABLE sh_pay ADD COLUMN delivered TEXT').run(); } catch (e) {} // Shopify gönderisinin teslim günü
  try { await env.DB.prepare('ALTER TABLE bk_ship ADD COLUMN delivered TEXT').run(); } catch (e) {} // Basit Kargo teslim günü
  for (const c of ['stocked_at TEXT', 'cari_at TEXT']) { try { await env.DB.prepare('ALTER TABLE purchases ADD COLUMN ' + c).run(); } catch (e) {} }
  try { await env.DB.prepare('ALTER TABLE products ADD COLUMN mto INTEGER').run(); } catch (e) {} // stoksuz satış (sipariş üzerine)
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
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_cargo_reread5'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_cargo_reread5','1')`), env.DB.prepare('UPDATE order_fin SET cargo=NULL, ret_cargo=NULL'), setStmt(env, 'cargo_inv_done', '[]'), setStmt(env, 'fin_at', '')]); } catch (e) {} }
  // Paketleme maliyeti eklendi: kayıtlı günler yeniden hesaplansın
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_pack1'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_pack1','1')`), env.DB.prepare('DELETE FROM daily_stats'), env.DB.prepare('DELETE FROM product_daily'), setStmt(env, 'home_cache', '')]); } catch (e) {} }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_passive1'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_passive1','1')`), setStmt(env, 'ty_prod_page', 0), setStmt(env, 'ty_prod_done', '1970-01-01T00:00:00.000Z')]); } catch (e) {} }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_ordslice1'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_ordslice1','1')`), setStmt(env, 'ty_orders_exact', '')]); } catch (e) {} }
  for (const c of ['auto_at TEXT', 'desi REAL', 'chk_at TEXT', 'claim_id TEXT', 'item_id TEXT', 'customer TEXT', 'amount REAL', 'reason TEXT', 'cnote TEXT', 'cargo TEXT', 'cargo_link TEXT', 'kept INTEGER', 'inspect TEXT', 'insp_ok INTEGER', 'insp_at TEXT']) { try { await env.DB.prepare('ALTER TABLE returns ADD COLUMN ' + c).run(); } catch (e) {} }
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS order_cust(order_no TEXT PRIMARY KEY, channel TEXT, data TEXT, updated_at TEXT)').run();
  // Lilya ürün kodu: her ürünün uygulama içi kodu (LH-0001); kanal ilanları (Trendyol barkodu, Shopify varyantı) bu ürüne bağlanır
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS listings(channel TEXT, ext TEXT, pkey TEXT, orig_pkey TEXT, factor INTEGER DEFAULT 1, sku TEXT, barcode TEXT, name TEXT, image TEXT, ext_qty INTEGER, passive INTEGER, updated_at TEXT, PRIMARY KEY(channel, ext))').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS listings_pkey ON listings(pkey)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS match_skip(a TEXT, b TEXT, PRIMARY KEY(a, b))').run();
  // Shopify siparişlerinde henüz kargolanmamış adetler (varyant → adet); sayımda raftaki ama satılmış ürünü ayırmak için
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS sh_unf(order_no TEXT PRIMARY KEY, data TEXT, updated_at TEXT)').run();
  // Shopify adres düzeltmeleri: eski / yeni adres saklanır (geri alma için)
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS sh_addr_log(id INTEGER PRIMARY KEY AUTOINCREMENT, gid TEXT, order_no TEXT, before TEXT, after TEXT, at TEXT)').run();
  // Sürat Kargo gönderileri: kendi barkodumuz (OzelKargoTakipNo) ve Sürat'a bildirilen adres
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS sr_ship(ref TEXT PRIMARY KEY, gid TEXT, order_no TEXT, adet INTEGER, desi REAL, addr TEXT, lines TEXT, msg TEXT, at TEXT)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS sr_ship_gid ON sr_ship(gid)').run();
  for (const c of ['tracking TEXT', 'track_at TEXT', 'track_msg TEXT', 'fulfilled_at TEXT', 'fulfill_err TEXT', 'exported_at TEXT', 'mode TEXT']) { try { await env.DB.prepare('ALTER TABLE sr_ship ADD COLUMN ' + c).run(); } catch (e) {} }
  for (const c of ['code TEXT', 'merged_into TEXT', 'name_manual INTEGER']) { try { await env.DB.prepare('ALTER TABLE products ADD COLUMN ' + c).run(); } catch (e) {} }
  try { await env.DB.prepare('ALTER TABLE listings ADD COLUMN inv_item TEXT').run(); } catch (e) {}
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_costreset1'`).first())) {
    // Kullanıcı isteği (19.10.2026): bütün ürün maliyetleri silinir, fişlerle baştan girilecek (sessiz yedek settings'te kalır)
    try { const { results } = await env.DB.prepare('SELECT key, cost FROM products WHERE cost IS NOT NULL').all(), at = iso();
      await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_costreset1','1')`), setStmt(env, 'cost_backup_mig1', JSON.stringify({ at, rows: results.map(r => [r.key, r.cost]) })),
        env.DB.prepare('UPDATE products SET cost=NULL, cost_date=NULL, updated_at=?1 WHERE cost IS NOT NULL').bind(at), REV(env)]); } catch (e) {}
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_typer1'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_typer1','1')`), setStmt(env, 'ty_settle_cur', '')]); } catch (e) {} } // vade süresini okumak için ekstre baştan
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_early_off'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_early_off','1')`), env.DB.prepare('DROP TABLE IF EXISTS ty_early'), env.DB.prepare(`DELETE FROM daily_stats WHERE day >= '2026-10-01'`), setStmt(env, 'home_cache', ''), setStmt(env, 'ty_early_sig', '')]); } catch (e) {} }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_dlv1'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_dlv1','1')`), setStmt(env, 'sh_pay_done', ''), setStmt(env, 'sh_pay_after', ''), setStmt(env, 'bk_sync_at', '')]); } catch (e) {} }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_ptdet2'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_ptdet2','1')`), env.DB.prepare('UPDATE pt_payout SET detailed=0')]); } catch (e) {} }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_shtx1'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_shtx1','1')`), setStmt(env, 'sh_pay_done', ''), setStmt(env, 'sh_pay_after', '')]); } catch (e) {} }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_shpack2'`).first())) {
    // Shopify kuralları ve ayrı paketleme ücreti (sipariş başı 4 TL + ürün başı 1 TL): kayıtlı rapor günleri yeniden hesaplanır
    try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_shpack2','1')`), setStmt(env, 'fee_sh_comm', '3'), env.DB.prepare('DELETE FROM daily_stats'), env.DB.prepare('DELETE FROM product_daily'), setStmt(env, 'stats_first', ''), setStmt(env, 'stats_cursor', ''), setStmt(env, 'home_cache', ''), REV(env)]); } catch (e) {}
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_rs1'`).first())) {
    // Kullanıcı isteği (20.10.2026): raporlar 1 Ekim 2026'dan başlar, Eylül verileri hesaba girmez (silinmez)
    try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_rs1','1')`), setStmt(env, 'report_start', '2026-10-01'), env.DB.prepare('DELETE FROM daily_stats'), env.DB.prepare('DELETE FROM product_daily'), setStmt(env, 'stats_first', ''), setStmt(env, 'stats_cursor', ''), setStmt(env, 'home_cache', ''), REV(env)]); } catch (e) {}
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_missing1'`).first())) {
    try { const { results } = await env.DB.prepare(`SELECT * FROM returns WHERE kept=1 AND status='accepted'`).all();
      const st = [env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_missing1','1')`)];
      for (const r of results) if (isMissing(r.reason, r.cnote, r.note)) st.push(env.DB.prepare('UPDATE returns SET kept=0 WHERE id=?1').bind(r.id), ...changeQty(env, r.pkey, Number(r.qty) || 1, { type: 'ret', channel: r.channel, ref: r.order_no, note: 'Eksik gönderilmiş: ürün depoda kalmıştı, stoğa eklendi (düzeltme)' }));
      st.push(env.DB.prepare('DELETE FROM daily_stats'), REV(env)); await env.DB.batch(st); } catch (e) {}
  }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_listing1'`).first())) {
    try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_listing1','1')`),
      env.DB.prepare(`INSERT OR IGNORE INTO listings(channel,ext,pkey,orig_pkey,factor,sku,barcode,name,image,ext_qty,passive,updated_at) SELECT 'trendyol', barcode, key, key, 1, sku, barcode, name, image, ty_qty, ty_passive, ?1 FROM products WHERE barcode<>'' AND EXISTS(SELECT 1 FROM json_each(products.channels) WHERE value='trendyol') ORDER BY created_at`).bind(iso()),
      env.DB.prepare(`UPDATE products SET code = t.c FROM (SELECT key, 'LH-' || printf('%04d', ROW_NUMBER() OVER (ORDER BY created_at, key)) c FROM products) t WHERE products.key = t.key AND products.code IS NULL`),
      env.DB.prepare(`UPDATE settings SET v='' WHERE k='sh_prod'`), REV(env)]); } catch (e) {}
  }
  try { await env.DB.prepare('ALTER TABLE order_cust ADD COLUMN sname TEXT').run(); } catch (e) {}
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS product_info(main_id TEXT PRIMARY KEY, title TEXT, descr TEXT, attrs TEXT, image TEXT, updated_at TEXT, note TEXT)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS qna(id TEXT PRIMARY KEY, main_id TEXT, product_name TEXT, image TEXT, web_url TEXT, text TEXT, created_at TEXT, status TEXT, answer TEXT, answered_at TEXT, draft TEXT, draft_flag INTEGER, draft_at TEXT, draft_err TEXT, updated_at TEXT)').run();
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_pinfo1'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_pinfo1','1')`), setStmt(env, 'ty_prod_page', 0), setStmt(env, 'ty_prod_done', '1970-01-01T00:00:00.000Z')]); } catch (e) {} }
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS daily_stats(day TEXT PRIMARY KEY, data TEXT, computed_at TEXT)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS product_daily(day TEXT, pkey TEXT, sku TEXT, name TEXT, units INTEGER, ret_units INTEGER, revenue REAL, profit REAL, PRIMARY KEY(day, pkey))').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(date)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT, name TEXT, amount REAL, created_at TEXT)').run();
  try { await env.DB.prepare("ALTER TABLE expenses ADD COLUMN kind TEXT NOT NULL DEFAULT 'gider'").run(); } catch (e) {}
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS label_printed(pkg_id TEXT PRIMARY KEY, order_no TEXT, printed_at TEXT)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS recurring(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, amount REAL, kind TEXT, start_day TEXT, end_day TEXT, created_at TEXT)').run();
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
  // Shopify ilanları pasif sayılmaz (kısa süre taslaklar pasif işaretlenmişti)
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_shtok2'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_shtok2','1')`), setStmt(env, 'sh_token', ''), setStmt(env, 'sh_token_exp', '0'), setStmt(env, 'run_shp_at', '0')]); } catch (e) {} }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_follow1'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_follow1','1')`), followMergedStmt(env), followMergedStmt(env), REV(env)]); } catch (e) {} }
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_shpass0'`).first())) { try { await env.DB.batch([env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_shpass0','1')`), env.DB.prepare(`UPDATE listings SET passive=0 WHERE channel='shopify'`), REV(env)]); } catch (e) {} }
  // Lilya kodları yeniden: listede görünen ürünler A→Z sırasıyla LH-0001'den boşluksuz; gizliler (birleştirilmiş / pasif) sonra
  if (!(await env.DB.prepare(`SELECT 1 FROM settings WHERE k='mig_code3'`).first())) {
    try {
      await env.DB.prepare(`INSERT OR IGNORE INTO settings(k,v) VALUES('mig_code2','1')`).run();
      const { results } = await env.DB.prepare(`SELECT key, name, CASE WHEN merged_into IS NULL AND (CASE WHEN EXISTS(SELECT 1 FROM listings l WHERE l.pkey=p.key) THEN EXISTS(SELECT 1 FROM listings l WHERE l.pkey=p.key AND COALESCE(l.passive,0)=0) ELSE NOT (p.ty_passive=1 AND p.channels='["trendyol"]') END) THEN 1 ELSE 0 END vis FROM products p`).all();
      results.sort((a, b) => (b.vis - a.vis) || String(a.name || '').localeCompare(String(b.name || ''), 'tr') || String(a.key).localeCompare(String(b.key)));
      const st = [env.DB.prepare(`INSERT INTO settings(k,v) VALUES('mig_code3','1')`), env.DB.prepare(`UPDATE products SET code=NULL`)];
      results.forEach((r, i) => st.push(env.DB.prepare('UPDATE products SET code=?2 WHERE key=?1').bind(r.key, 'LH-' + String(i + 1).padStart(4, '0'))));
      st.push(REV(env));
      for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    } catch (e) {}
  }
  READY = true;
}
async function getSetting(env, k) { const r = await env.DB.prepare('SELECT v FROM settings WHERE k=?1').bind(k).first(); return r ? r.v : null; }
async function getSettings(env, keys) { const out = {}; const { results } = await env.DB.prepare(`SELECT k,v FROM settings WHERE k IN (${keys.map((_, i) => '?' + (i + 1)).join(',')})`).bind(...keys).all(); for (const r of results) out[r.k] = r.v; return out; }
const setStmt = (env, k, v) => env.DB.prepare('INSERT INTO settings(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v WHERE settings.v IS NOT excluded.v').bind(k, String(v));
async function setSetting(env, k, v) { await setStmt(env, k, v).run(); }
const REV = (env) => env.DB.prepare(`UPDATE settings SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT) WHERE k='rev'`);
const guardStmt = (env, sql, ...b) => env.DB.prepare(`INSERT INTO guard(x) SELECT CASE WHEN ${sql} THEN 1 ELSE NULL END`).bind(...b);
const unguard = (env) => env.DB.prepare('DELETE FROM guard');
/* ---------- Cari: ödeme şekli (vade) ve ödeme planı ---------- */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const trToday = () => iso(Date.now() + 3 * 3600000).slice(0, 10);
function addDayStr(d, n) { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function addMonthStr(d, n) { const [y, m, dd] = d.split('-').map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1, 12)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0, 12)).getUTCDate(); t.setUTCDate(Math.min(dd, last)); return t.toISOString().slice(0, 10); }
function cariTerms(raw) {
  let t = raw; if (typeof t === 'string') { try { t = JSON.parse(t); } catch (e) { t = null; } } t = t || {};
  const kind = ['cash', 'days', 'split', 'pct'].includes(t.kind) ? t.kind : 'cash', I = (v, d, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v)) || d));
  return { kind, n: I(t.n, 30, 1, 720), unit: t.unit === 'ay' ? 'ay' : 'gün', parts: I(t.parts, 4, 2, 52), every: I(t.every, 7, 1, 120), first: I(t.first ?? t.every, 7, 0, 365), pct: I(t.pct, 25, 1, 100), wday: I(t.wday, 1, 1, 7), note: String(t.note || '').slice(0, 120) };
}
// "40.500,25" / "40500.25" / "-1.200" → sayı (2 basamak)
function cariAmt(v) { if (typeof v === 'number') return r2(v); let t = String(v ?? '').replace(/[^\d,.\-]/g, ''); if (!t) return 0; if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.'); else if ((t.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(t)) t = t.replace(/\./g, ''); return r2(Number(t) || 0); }
const cariCur = (c) => ['USD', 'EUR'].includes(String(c || '').toUpperCase()) ? String(c).toUpperCase() : 'TL';
// Güncel kur (piyasa bandıyla aynı kaynak): 1 USD / 1 EUR kaç TL
async function fxRates(env) { const r = { TL: 1, USD: null, EUR: null }; try { const m = await marketData(env); for (const x of m.items || []) { if (x.id === 'usd') r.USD = x.price; if (x.id === 'eur') r.EUR = x.price; } } catch (e) {} return r; }
async function cariLoad(env, only) {
  const w = only ? ' AND supplier=?1 COLLATE NOCASE' : '', B = (st) => only ? st.bind(only) : st;
  const pur = (await B(env.DB.prepare(`SELECT id, supplier, doc_no, doc_date, t, total, units FROM purchases WHERE cari_at IS NOT NULL AND status<>'deleted'${w}`)).all()).results;
  const pay = (await B(env.DB.prepare(`SELECT id, supplier, date, t, amount, method, note FROM sup_pay WHERE deleted=0${w}`)).all()).results;
  const mov = (await B(env.DB.prepare(`SELECT id, supplier, date, t, kind, amount, note, src FROM sup_mov WHERE deleted=0${w}`)).all()).results;
  const sups = (await env.DB.prepare('SELECT name, terms, manual, currency FROM suppliers').all()).results, K = (x) => String(x || '').toLocaleLowerCase('tr-TR'), sm = new Map(sups.map(x => [K(x.name), x]));
  const m = new Map(), get = (n) => { const k = K(n); if (!m.has(k)) { const s0 = sm.get(k); m.set(k, { supplier: s0 ? s0.name : n, cur: cariCur(s0 && s0.currency), terms: cariTerms(s0 && s0.terms), buys: [], pays: [] }); } return m.get(k); };
  for (const r of pur) get(r.supplier).buys.push({ id: r.id, doc_no: r.doc_no, units: r.units, date: r.doc_date || String(r.t || '').slice(0, 10), t: r.t || '', amount: r2(r.total) });
  for (const r of pay) get(r.supplier).pays.push({ id: r.id, method: r.method, note: r.note, date: r.date || String(r.t || '').slice(0, 10), t: r.t || '', amount: r2(r.amount) });
  // Elle girilen hareketler: devir bakiye / borç (+ borç, − alacak) ve alacak (iade, indirim)
  const MK = { open: 'Devir bakiye', debt: 'Borç', credit: 'Alacak' };
  for (const r of mov) { const a = r2(r.amount), x = { id: 'm' + r.id, mov: true, label: r.src === 'xls' && r.note ? r.note : [MK[r.kind] || 'Hareket', r.note].filter(Boolean).join(' · '), date: r.date || String(r.t || '').slice(0, 10), t: r.t || '' };
    if (r.kind === 'credit' || a < 0) get(r.supplier).pays.push({ ...x, method: MK[r.kind] || 'Alacak', note: r.note, amount: Math.abs(a) }); else get(r.supplier).buys.push({ ...x, amount: a }); }
  if (!only) for (const s0 of sups) if (s0.manual) get(s0.name);
  return [...m.values()].map(c => { c.buy = r2(c.buys.reduce((a, x) => a + x.amount, 0)); c.paid = r2(c.pays.reduce((a, x) => a + x.amount, 0)); c.bal = r2(c.buy - c.paid);
    c.last = [...c.buys, ...c.pays].reduce((a, x) => x.date > a ? x.date : a, ''); return c; });
}
// Ödeme planı: her taksitin vadesi, tutarı ve kalanı (ödemeler en eski vadeden başlayarak düşülür). Haftalık % şeklinde her hafta kalan borcun yüzdesi istenir.
function nextWday(d, wd) { let t = Date.parse(d + 'T12:00:00Z'); if (!t) return d; while (new Date(t).getUTCDay() !== wd) t += 86400000; return new Date(t).toISOString().slice(0, 10); }
function cariSchedule(c, today) {
  const T = c.terms, items = [];
  if (T.kind === 'pct') {
    // Her hafta (seçilen gün) o güne kadarki kalan borcun %'si istenir; ödemeler en eski haftadan başlayarak düşülür
    const wdOf = (d) => { const x = new Date(d + 'T12:00:00Z').getUTCDay(); return x === 0 ? 7 : x; };
    const b0 = c.buys.reduce((a, x) => !a || x.date < a ? x.date : a, '');
    if (b0) { let D = addDayStr(b0, 1); while (wdOf(D) !== T.wday) D = addDayStr(D, 1);
      const bs = c.buys.slice().sort((x, y) => x.date.localeCompare(y.date)); let R = 0, n = 0;
      const inst = [];
      while (n++ < 520) { const owed = r2(bs.filter(x => x.date <= D).reduce((a, x) => a + x.amount, 0)), amt = r2((owed - R) * T.pct / 100);
        if (amt > 0.004) { inst.push({ due: D, amount: amt, label: `Haftalık %${T.pct} ödeme` }); R = r2(R + amt); }
        if (D >= today) break; D = addDayStr(D, 7); }
      let pool = c.paid; for (const x of inst) { const p = Math.min(pool, x.amount); pool = r2(pool - p); x.paid = r2(p); x.left = r2(Math.min(x.amount - p, Math.max(0, c.bal))); items.push(x); }
    }
  } else {
    const inst = [];
    for (const b of c.buys.slice().sort((x, y) => x.date.localeCompare(y.date) || x.t.localeCompare(y.t))) {
      const tag = b.mov ? b.label : `Alış #${b.id}${b.doc_no ? ' · ' + b.doc_no : ''}`;
      if (T.kind === 'split') { const per = r2(b.amount / T.parts); for (let i = 0; i < T.parts; i++) inst.push({ due: addDayStr(b.date, T.first + i * T.every), amount: i === T.parts - 1 ? r2(b.amount - per * (T.parts - 1)) : per, label: `${tag} · ${i + 1}/${T.parts}. taksit` }); }
      else if (T.kind === 'days') inst.push({ due: T.unit === 'ay' ? addMonthStr(b.date, T.n) : addDayStr(b.date, T.n), amount: b.amount, label: `${tag} · ${T.n} ${T.unit} vade` });
      else inst.push({ due: b.date, amount: b.amount, label: `${tag} · peşin` });
    }
    // Ödeme günü: vade dolduktan sonraki ilk cuma (vade cumaya denk gelirse o gün)
    for (const x of inst) { x.vade = x.due; x.due = nextWday(x.due, 5); }
    inst.sort((a, b) => a.due.localeCompare(b.due));
    let pool = c.paid; for (const x of inst) { const p = Math.min(pool, x.amount); pool = r2(pool - p); x.paid = r2(p); x.left = r2(x.amount - p); items.push(x); }
  }
  const wk = addDayStr(today, 7), open = items.filter(x => x.left > 0.004);
  for (const x of items) x.st = x.left <= 0.004 ? 'paid' : x.due < today ? 'late' : x.due === today ? 'today' : x.due <= wk ? 'week' : 'later';
  const sum = (f) => r2(open.filter(f).reduce((a, x) => a + x.left, 0));
  return { items, next: open[0] ? { due: open[0].due, amount: open[0].left, st: open[0].st } : null, overdue: sum(x => x.due < today), today: sum(x => x.due === today), week: sum(x => x.due > today && x.due <= wk) };
}
// Fiş fiyatı maliyete yazılsın mı: eski tarihli fiş yenisinin maliyetini ezmez; aynı tarihte (aynı yüklemede) yüksek fiyat kazanır
function costPick(p, unit, date) {
  const u = Math.round((Number(unit) || 0) * 100) / 100; if (!(u > 0)) return null;
  const c0 = p.cost === null || p.cost === undefined ? null : Number(p.cost), d0 = p.cost_date || '';
  if (c0 !== null && d0 && date && d0 > date) return null;          // mevcut maliyet daha yeni fişten
  if (c0 !== null && d0 && date && d0 === date && c0 >= u) return null; // aynı tarih: yüksek olan kalır
  return u;
}
/* ---------- Shopify kargo / kapıda ödeme kuralları (kullanıcının verdiği, 20.10.2026) ---------- */
const SH_FREE_SHIP = 700, SH_SHIP_FEE = 100, SH_COD_CASH = 50, SH_COD_CARD = 100;
const SURAT_DIRECT_FROM = '2026-10-17T07:00:00.000Z', SURAT_POST_TAX = 0.0235; // 17.10.2026 10:00 (TR) sonrası anlaşmalı Sürat
const suratDirectPrice = (d) => d <= 5 ? 102 : d <= 10 ? 144 : d <= 15 ? 168 : 192; // KDV dahil; 20 desi üstü şimdilik 192
const srSmsFor = (fee, dateIso) => { const u = fee.srSmsUntil; return (!u || trDay(Date.parse(dateIso)) < u) ? (Number(fee.srSms) || 0) : 0; }; // SMS iptal tarihine kadar gönderi başı
const suratDirectCod = (t) => r2(30 + Math.max(0, Math.ceil((t - 1000) / 100 - 1e-9)) * 1.5); // 0–1000 TL 30 TL, üzerindeki her 100 TL +1,50
/* ---------- PayTR (Shopify online ödemelerin komisyonu): Satış ve İade İşlem Dökümü servisi ---------- */
async function ptCreds(env) { const s = await getSettings(env, ['pt_id', 'pt_key', 'pt_salt']); return { id: env.PAYTR_MERCHANT_ID || s.pt_id || '', key: env.PAYTR_MERCHANT_KEY || s.pt_key || '', salt: env.PAYTR_MERCHANT_SALT || s.pt_salt || '' }; }
const ptTime = (ms) => new Date(ms + 3 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
async function ptList(env, cr, fromMs, toMs) {
  const start = ptTime(fromMs), end = ptTime(toMs);
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(cr.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(cr.id + start + end + cr.salt)));
  const token = btoa(String.fromCharCode(...sig));
  const r = await fetch('https://www.paytr.com/rapor/islem-dokumu', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ merchant_id: cr.id, start_date: start, end_date: end, paytr_token: token }) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  if (!d) throw new Error(`PayTR ${r.status}: ${t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  if (d.status === 'failed') return [];
  if (d.status !== 'success') throw new Error('PayTR: ' + (d.err_msg || d.reason || JSON.stringify(d).slice(0, 160)));
  const arr = Array.isArray(d.data) ? d.data : Array.isArray(d.transactions) ? d.transactions : Array.isArray(d.islemler) ? d.islemler : Object.values(d).find(v => Array.isArray(v)) || [];
  return arr;
}
const ptNum = (v) => { const t = String(v ?? '').trim(); if (!t) return null; const n = Number(/,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const ptDay = (t) => { const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(String(t || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : String(t || '').slice(0, 10); };
async function ptPost(cr, url, fields, hashStr) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(cr.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(hashStr)));
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ merchant_id: cr.id, ...fields, paytr_token: btoa(String.fromCharCode(...sig)) }) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  if (!d) throw new Error(`PayTR ${r.status}: ${t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  if (d.status === 'failed') return { list: [], raw: d };
  if (d.status !== 'success') throw new Error('PayTR: ' + (d.err_msg || JSON.stringify(d).slice(0, 160)));
  const list = Array.isArray(d.data) ? d.data : Object.values(d).filter(v => v && typeof v === 'object').flatMap(v => Array.isArray(v) ? v : Object.values(v).every(x => x && typeof x === 'object') ? Object.values(v) : [v]);
  return { list, raw: d };
}
// Ödeme dökümü (hangi gün ne kadar yattı) + ödeme detayı (o gün yatan para hangi siparişlerin): işlemlere ödeme günü yazılır
// Ödeme detayı satırındaki sipariş no: alan adı merchant_oid / siparis_no / oid; yoksa 32 haneli kod içeren ilk alan
function ptOid(x) { if (!x || typeof x !== 'object') return ''; for (const k of ['merchant_oid', 'siparis_no', 'oid', 'merchant_order_id', 'order_id']) if (x[k]) return String(x[k]).trim();
  for (const v of Object.values(x)) if (typeof v === 'string' && /^[0-9a-z]{20,64}$/i.test(v.trim())) return v.trim(); return ''; }
async function ptPayoutSync(env, cr, maxDetail = 10) {
  const startDay = (await reportStart(env)) || '2026-10-01', today = trToday();
  for (let a = startDay; a <= today; a = addDayStr(a, 31)) { const b = addDayStr(a, 30) > today ? today : addDayStr(a, 30);
    const { list } = await ptPost(cr, 'https://www.paytr.com/rapor/odeme-dokumu/', { start_date: a, end_date: b }, cr.id + a + b + cr.salt);
    const st = list.filter(x => x && (x.date_paid || x.tarih)).map(x => env.DB.prepare('INSERT INTO pt_payout(day, sales, ret, net, at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(day) DO UPDATE SET sales=excluded.sales, ret=excluded.ret, net=excluded.net, at=excluded.at').bind(ptDay(String(x.date_paid || x.tarih)).slice(0, 10), ptNum(x.sales), ptNum(x.return), ptNum(x.net), iso()));
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90)); }
  const days = (await env.DB.prepare('SELECT day FROM pt_payout WHERE detailed=0 ORDER BY day LIMIT ?1').bind(maxDetail).all()).results; let linked = 0;
  for (const { day } of days) { const { list } = await ptPost(cr, 'https://www.paytr.com/rapor/odeme-detayi/', { date: day }, cr.id + day + cr.salt);
    const oids = [...new Set(list.flat(4).map(ptOid).filter(Boolean))]; // detay iç içe liste olarak geliyor: [[{merchant_oid…}]]
    const st = oids.map(id => env.DB.prepare('UPDATE paytr_tx SET paid_day=?2 WHERE siparis_no=?1').bind(id, day)); linked += st.length;
    // detay boş geldiyse (PayTR henüz hazırlamamış) gün tekrar denenir; 5 günden eskiyse bırakılır
    if (oids.length || day < addDayStr(today, -5)) st.push(env.DB.prepare('UPDATE pt_payout SET detailed=1 WHERE day=?1').bind(day)); for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90)); }
  return { linked };
}
async function ptSync(env, maxWin = 8) {
  const cr = await ptCreds(env); if (!cr.id || !cr.key || !cr.salt) return null;
  const s0 = await getSettings(env, ['pt_cursor', 'report_start']); const startDay = /^\d{4}-\d{2}-\d{2}$/.test(s0.report_start || '') ? s0.report_start : '2026-10-01';
  let cur = Number(s0.pt_cursor) || Date.parse(startDay + 'T00:00:00+03:00'); const now = Date.now(); let n = 0, w = 0;
  cur = Math.min(cur, now - 2 * 86400000); // son 2 gün her seferinde yeniden okunur (geç düşen işlemler)
  while (cur < now && w < maxWin) { const to = Math.min(cur + 3 * 86400000 - 1000, now);
    const L = await ptList(env, cr, cur, to); w++;
    const st = L.map(x => { const sn = String(x.siparis_no ?? x.merchant_oid ?? '').trim(), tip = String(x.islem_tipi || '').trim(), tutar = ptNum(x.islem_tutari), tarih = ptDay(x.islem_tarihi);
      return env.DB.prepare('INSERT INTO paytr_tx(k, siparis_no, tip, tutar, kesinti, net, oran, tarih, odeme_tipi, at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(k) DO UPDATE SET kesinti=excluded.kesinti, net=excluded.net, oran=excluded.oran, at=excluded.at')
        .bind([sn, tip, tutar, tarih].join('|'), sn, tip, tutar, ptNum(x.kesinti_tutari), ptNum(x.net_tutar), ptNum(x.kesinti_orani), tarih, String(x.odeme_tipi || ''), iso()); });
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90)); n += st.length; cur = to + 1000; }
  let pay = null; try { pay = await ptPayoutSync(env, cr); } catch (e) { await setSetting(env, 'pt_pay_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); }
  await env.DB.batch([setStmt(env, 'pt_cursor', String(cur)), setStmt(env, 'pt_sync_at', iso()), setStmt(env, 'pt_err', ''), ...(n ? [env.DB.prepare('DELETE FROM daily_stats WHERE day >= ?1').bind(startDay), setStmt(env, 'home_cache', ''), REV(env)] : [])]);
  return { n, windows: w, done: cur >= now, pay };
}
/* ---------- Basit Kargo (17.10.2026 10:00'a kadarki Shopify gönderileri) ---------- */
const BK_CUTOFF = '2026-10-17T10:00', BK_CUTOFF_MS = Date.parse('2026-10-17T07:00:00Z');
const bkTime = (ms) => new Date(ms + 3 * 3600000).toISOString().slice(0, 19); // Türkiye saati, YYYY-MM-DDTHH:mm:ss
async function bkCall(env, method, path, body) {
  const tok = env.BASIT_KARGO_TOKEN || (await getSetting(env, 'bk_token')); if (!tok) throw new Error('Basit Kargo bağlı değil.');
  const r = await fetch('https://basitkargo.com/api' + path, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let data = null; try { data = JSON.parse(txt); } catch (e) {}
  if (!r.ok) throw new Error((data && (data.message || data.error || data.detail)) || `HTTP ${r.status} ${txt.slice(0, 120)}`);
  return { list: data, pages: Number(r.headers.get('X-Total-Pages')) || null, total: Number(r.headers.get('X-Total-Count')) || null };
}
// Teslim tarihi metnini/sayısını Türkiye günü (YYYY-MM-DD) yapar: '20.10.2026 14:30', '2026-10-20 14:30', ISO, epoch ms/sn, Excel seri no
function dlvDay(v) { if (v === null || v === undefined || v === '') return null; if (typeof v === 'bigint') v = Number(v);
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v).trim())) { const n = Number(v); if (n > 1e12) return trDay(n); if (n > 1e9) return trDay(n * 1000); if (n > 40000 && n < 60000) return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10); return null; }
  const t = String(v).trim(); let m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(t); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) || /^\d{4}-\d{2}-\d{2}[ ]\d/.test(t)) return t.slice(0, 10); const ms = Date.parse(t); return ms > 1e12 ? trDay(ms) : null; }
// Basit Kargo gönderisinde teslim zamanı: 'deliver…' adlı tarih alanı ya da durum geçmişinde TESLİM/DELIVERED satırının zamanı
function bkDelivered(o) { const out = []; const walk = (x, d) => { if (!x || typeof x !== 'object' || d > 4) return; if (Array.isArray(x)) { x.forEach(y => walk(y, d + 1)); return; }
    const stt = Object.entries(x).find(([k, v]) => /status|durum|state/i.test(k) && typeof v === 'string' && /DELIVERED|TESL[İI]M ?ED[İI]LD[İI]|TESLIM_EDILDI|COMPLETED/i.test(v));
    for (const [k, v] of Object.entries(x)) { if (v && typeof v === 'object') { walk(v, d + 1); continue; }
      if (/deliver/i.test(k) && !/address|adres|type|fee|price|estimat|plan|expect|count|method/i.test(k)) { const dd = dlvDay(v); if (dd) out.push(dd); }
      else if (stt && /time|date|tarih|created/i.test(k)) { const dd = dlvDay(v); if (dd) out.push(dd); } } };
  walk(o, 0); return out.sort().pop() || null; }
// Sürat kapıda tahsilatı: perşembe–çarşamba haftası; çarşambaya kadar (dahil) teslim edilenler 8 gün sonraki perşembe yatar
// (ör. 21.10 çarşambaya kadar → 29.10; 22.10'dan sonra → 5.11). Ödeme günü resmi tatile denk gelirse önceki iş günü (29 Ekim → 28 Ekim)
const TR_HOLI = new Set(['01-01', '04-23', '05-01', '05-19', '07-15', '08-30', '10-29', '2026-03-20', '2026-05-27', '2026-05-28', '2026-05-29', '2027-03-09', '2027-03-10', '2027-05-16', '2027-05-17', '2027-05-18', '2027-05-19']);
function srPayDay(d) { if (!d) return null; let t = Date.parse(d + 'T12:00:00Z'); if (!t) return null; const D = 86400000;
  const wed = t + ((3 - new Date(t).getUTCDay() + 7) % 7) * D; t = wed + 8 * D;
  while (trOff(t)) t -= D; return new Date(t).toISOString().slice(0, 10); }
function trOff(ms) { const x = new Date(ms), k = x.toISOString().slice(0, 10); return x.getUTCDay() === 0 || x.getUTCDay() === 6 || TR_HOLI.has(k) || TR_HOLI.has(k.slice(5)); }
// PayTR: teslimden 7 gün geçtikten sonraki ilk iş günü (22.10 teslim → 30.10; 23.10 teslim → 31.10 cumartesi → 2.11)
function ptPayDay(d) { if (!d) return null; let t = Date.parse(d + 'T12:00:00Z'); if (!t) return null; t += 8 * 86400000; while (trOff(t)) t += 86400000; return new Date(t).toISOString().slice(0, 10); }
// Trendyol: vade teslimden 28 gün; ödeme vadeden sonraki ilk pazartesi ya da perşembe. O gün resmi tatilse sonraki ilk iş günü.
// (Erken ödeme alınan siparişler salı/cuma yatar; onların günü Trendyol ekstresinden gelir.)
function tyPayDay(d) { if (!d) return null; const t = Date.parse(d + 'T12:00:00Z'); return t ? tyPayout(new Date(t + 28 * 86400000).toISOString().slice(0, 10)) : null; }
// Vade tarihinden ödeme gününe: vadeye denk gelen ya da sonraki ilk pazartesi/perşembe; tatilse sonraki iş günü
function tyPayout(d) { if (!d) return null; let t = Date.parse(d + 'T12:00:00Z'); if (!t) return null; for (let i = 0; i < 7; i++) { const w = new Date(t).getUTCDay(); if (w === 1 || w === 4) break; t += 86400000; } while (trOff(t)) t += 86400000; return new Date(t).toISOString().slice(0, 10); }
// Erken ödeme bedeli faturaları: fatura tarihine en yakın (±3, yoksa ±7 gün) erken ödemeye (ödeme emri) bağlanır.
// Yalnızca hakediş mutabakatında o ödeme gününün yanında gösterilir; kâr hesabı değişmez (fatura, fatura tarihine göre "Diğer Trendyol kesintileri"nde kalır).
const EARLY_RE = /erken|early/i;
async function tyEarlyAlloc(env) {
  const rs = (await reportStart(env)) || '2026-10-01', D = 86400000;
  const [iR, sR, aR] = await env.DB.batch([env.DB.prepare(`SELECT id, date, amount, type, descr FROM fin_misc WHERE order_no IS NULL AND amount > 0 AND date >= ?1 ORDER BY date`).bind(iso(Date.parse(rs + 'T00:00:00+03:00') - 45 * D)),
    env.DB.prepare('SELECT order_no, type, tx_ms, due_ms, net, po FROM ty_set'), env.DB.prepare('SELECT order_no, MIN(delivered) d FROM audit_pkg WHERE delivered IS NOT NULL GROUP BY order_no')]);
  const inv = iR.results.filter(x => EARLY_RE.test(String(x.type || '') + ' ' + String(x.descr || ''))), dl = new Map(aR.results.map(x => [x.order_no, x.d]));
  const O = new Map(); for (const x of sR.results) { const g = O.get(x.order_no) || { no: x.order_no, net: 0, po: null, sale: null, due: null }; g.net += x.net || 0; if (x.po) g.po = x.po; if (x.type === 'Sale') { if (x.tx_ms && (!g.sale || x.tx_ms < g.sale)) g.sale = x.tx_ms; if (x.due_ms && (!g.due || x.due_ms > g.due)) g.due = x.due_ms; } O.set(x.order_no, g); }
  const G = new Map(); for (const g of O.values()) { if (!g.po || g.net <= 0) continue; const tyDue = g.due ? trDay(g.due) : null, rule = tyPayDay(dl.get(g.no) || (g.sale ? trDay(g.sale) : null));
    const e = G.get(g.po) || { po: g.po, day: null, n: 0, early: 0 }; if (tyDue && (!e.day || tyDue > e.day)) e.day = tyDue; e.n++; if (tyDue && rule && tyDue < rule) e.early++; G.set(g.po, e); }
  const groups = [...G.values()].filter(g => g.day && g.early), used = new Set(), rows = [];
  for (const x of inv) { const d0 = Date.parse(String(x.date).slice(0, 10) + 'T12:00:00Z'); let best = null;
    for (const lim of [3, 7]) { for (const g of groups) { if (used.has(g.po)) continue; const dd = Math.abs(Date.parse(g.day + 'T12:00:00Z') - d0) / D; if (dd > lim) continue; if (!best || dd < best.dd || (dd === best.dd && g.early > best.g.early)) best = { g, dd }; } if (best) break; }
    if (best) used.add(best.g.po); rows.push([x.id, x.amount, best ? 1 : 0, best ? best.g.po : null, best ? best.g.day : String(x.date).slice(0, 10), best ? best.g.early : 0]); }
  const st = [env.DB.prepare('DELETE FROM ty_early_inv'), ...rows.map(a => env.DB.prepare('INSERT OR REPLACE INTO ty_early_inv(id, amount, matched, po, day, n, at) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(...a, iso()))];
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  return { invoices: inv.length, matched: rows.filter(a => a[2]).length };
}
// Trendyol cari ekstresi (satış/iade/indirim satırları, vade tarihi) ve hakediş ödemeleri rapor başlangıcından itibaren 14 günlük dilimlerle okunur
async function tySettleSync(env, maxWin = 2) {
  const sid = env.TRENDYOL_SELLER_ID; if (!sid) return null; const rs = (await reportStart(env)) || '2026-10-01', now = Date.now(), D = 86400000;
  let cur = Number(await getSetting(env, 'ty_settle_cur')) || Date.parse(rs + 'T00:00:00+03:00') - 3 * D; let w = 0, n = 0, po = 0;
  while (cur < now && w < maxWin) { const to = Math.min(cur + 14 * D, now); w++; const st = [];
    for (const type of FIN_TYPES.split(',')) { for (let page = 0; page < 20; page++) {
      const r = await ty(env, `finance/che/sellers/${sid}/settlements`, { transactionType: type, startDate: cur, endDate: to, page, size: 1000, supplierId: sid });
      for (const x of (r.content || [])) { if (!x.orderNumber) continue; n++; const amt = (Number(x.credit) || 0) - (Number(x.debt) || 0);
        st.push(env.DB.prepare('INSERT INTO ty_set(id, order_no, type, tx_ms, due_ms, net, amt, po, at, period) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET due_ms=excluded.due_ms, net=excluded.net, amt=excluded.amt, po=excluded.po, at=excluded.at, period=excluded.period')
          .bind(String(x.id || [type, x.orderNumber, x.transactionDate, x.barcode, amt].join('|')), String(x.orderNumber), type, Number(x.transactionDate) || null, Number(x.paymentDate) || null, Number(x.sellerRevenue) || 0, amt, x.paymentOrderId ? String(x.paymentOrderId) : null, iso(), Number(x.paymentPeriod) || null)); }
      if (page + 1 >= (r.totalPages || 0)) break; } }
    try { for (let page = 0; page < 10; page++) { const r = await ty(env, `finance/che/sellers/${sid}/otherfinancials`, { transactionType: 'PaymentOrder', startDate: cur, endDate: to, page, size: 500, supplierId: sid });
      for (const x of (r.content || [])) { po++; st.push(env.DB.prepare('INSERT INTO ty_po(id, day, amount, descr, at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET day=excluded.day, amount=excluded.amount, descr=excluded.descr, at=excluded.at')
        .bind(String(x.id || x.paymentOrderId || [x.transactionDate, x.debt, x.credit].join('|')), trDay(Number(x.transactionDate) || now), r2(Math.abs((Number(x.debt) || 0) - (Number(x.credit) || 0))), String(x.description || x.transactionType || '').slice(0, 120), iso())); }
      if (page + 1 >= (r.totalPages || 0)) break; } } catch (e) { await setSetting(env, 'ty_po_err', iso() + ' · ' + String(e.message || e).slice(0, 160)); }
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    cur = to >= now ? now - 15 * D : to + 1; if (to >= now) break; }
  await env.DB.batch([setStmt(env, 'ty_settle_cur', String(cur)), setStmt(env, 'ty_settle_at', iso())]);
  let early = null; try { early = await tyEarlyAlloc(env); } catch (e) { await setSetting(env, 'ty_early_err', iso() + ' · ' + String(e.message || e).slice(0, 160)); }
  return { windows: w, rows: n, po, early };
}
function bkRow(o) {
  const c = o.content || {}, pi = o.priceInfo || {}, ci = o.codInfo || {}, sh = o.shipmentInfo || {}, N = (v) => v === null || v === undefined || v === '' ? null : Number(v);
  const no = String(o.orderNumber || c.code || o.foreignCode || o.code || '').replace(/\D/g, ''); // orderNumber = Shopify sipariş no (2002); content.code Shopify'ın iç kimliği
  const tc = N(pi.totalCost), fee = tc !== null ? tc + (N(pi.extraFee) || 0) : N(pi.shipmentFee) !== null ? (N(pi.shipmentFee) || 0) + (N(pi.extraFee) || 0) + (N(pi.returnFee) || 0) + (N(pi.extraServicesFee) || 0) : null;
  const cod = ci.collectOnDelivery || ci.collect || /COD|DOOR|KAPI/i.test(String(o.orderPaymentType || '')) ? 1 : 0;
  return { no, id: String(o.id || ''), created: String(o.createdTime || o.createdDate || '').slice(0, 10), handler: (sh.handler && (sh.handler.name || sh.handler.code)) || '', hcode: (sh.handler && sh.handler.code) || '', status: String(o.status || ''),
    fee: fee === null ? null : r2(fee), cod, codType: ci.type || '', codAmount: N(ci.amount), codFee: N(ci.fee), codStatus: ci.collectionStatusText || ci.collectionStatus || '', delivered: bkDelivered(o) };
}
async function bkSync(env) {
  const T0 = Date.now(), rows = [], seenId = new Set(); let page = 0, pages = 1;
  while (page < pages && page < 60 && Date.now() - T0 < 20000) {
    const r = await bkCall(env, 'POST', '/v2/order/filter', { startDate: '2024-01-01T00:00:00', endDate: bkTime(BK_CUTOFF_MS), page, size: 100, sortBy: 'CREATED_TIME' });
    const L = Array.isArray(r.list) ? r.list : (r.list && (r.list.content || r.list.data || r.list.items)) || [];
    for (const o of L) { const x = bkRow(o); if (x.no && !(x.id && seenId.has(x.id))) { if (x.id) seenId.add(x.id); rows.push(x); } } // sayfalar arası tekrar eden gönderi bir kez
    pages = r.pages || (L.length === 100 ? page + 2 : page + 1); page++;
  }
  // Aynı siparişin birden fazla gönderisi (iade, tekrar gönderim) varsa iptal/taslak olmayanların ücreti toplanır
  const DEAD = /CANCEL|IPTAL|İPTAL|DRAFT|TASLAK|DELETED/i, grp = new Map();
  for (const x of rows) { const g = grp.get(x.no); if (!g) { grp.set(x.no, { ...x, n: 1, live: DEAD.test(x.status) ? 0 : 1, fee: DEAD.test(x.status) ? null : x.fee }); continue; }
    g.n++; const dead = DEAD.test(x.status); if (!dead) { g.live++; g.fee = r2((g.fee || 0) + (x.fee || 0)); if (x.cod) { g.cod = 1; g.id = x.id; g.hcode = x.hcode; g.handler = x.handler; g.codType = x.codType; g.codAmount = x.codAmount; g.codFee = x.codFee ?? g.codFee; g.codStatus = x.codStatus; } if (x.created < g.created) g.created = x.created; } if (x.delivered && (!g.delivered || x.delivered > g.delivered)) g.delivered = x.delivered; }
  for (const g of grp.values()) if (g.live === 0) g.fee = null; // hepsi iptal: sabit ücret kullanılır
  const uniq = [...grp.values()];
  const st = uniq.map(x => env.DB.prepare(`INSERT INTO bk_ship(no, bk_id, created, handler, status, fee, cod, cod_type, cod_amount, cod_fee, cod_status, at, delivered) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
    ON CONFLICT(no) DO UPDATE SET bk_id=excluded.bk_id, created=excluded.created, handler=excluded.handler, status=excluded.status, fee=excluded.fee, cod=excluded.cod, cod_type=excluded.cod_type, cod_amount=excluded.cod_amount, cod_fee=COALESCE(excluded.cod_fee, bk_ship.cod_fee), cod_status=excluded.cod_status, at=excluded.at, delivered=COALESCE(excluded.delivered, bk_ship.delivered)`)
    .bind(x.no, x.id, x.created, x.handler, x.status, x.fee, x.cod, x.codType, x.codAmount, x.codFee, x.codStatus, iso(), x.delivered || null));
  const runAt = iso(); for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90).map(x => x));
  // Tam okuma bittiyse bu turda görülmeyen eski kayıtlar (ör. yanlış numarayla kaydedilenler) silinir
  if (page >= pages && uniq.length) await env.DB.prepare('DELETE FROM bk_ship WHERE at < ?1').bind(new Date(T0).toISOString()).run();
  // Kapıda ödeme bedeli siparişte yazmıyorsa, gönderen kargo firmasının ücret listesinden alınır
  const hc = new Map(uniq.map(x => [x.no, x.hcode]));
  const need = (await env.DB.prepare('SELECT no, bk_id, handler FROM bk_ship WHERE cod=1 AND cod_fee IS NULL LIMIT 400').all()).results; let filled = 0;
  for (let i = 0; i < need.length && Date.now() - T0 < 26000; i += 6) {
    const part = need.slice(i, i + 6), res = await Promise.all(part.map(x => bkCall(env, 'GET', `/v2/order/${encodeURIComponent(x.bk_id)}/fee`).then(r => r.list).catch(() => null)));
    const up = [];
    part.forEach((x, j) => { const L = Array.isArray(res[j]) ? res[j] : []; const code = hc.get(x.no) || ''; const m = L.find(f => f.handlerCode === code) || L.find(f => String(f.handler || '') === x.handler) || null;
      if (m && m.codFee !== undefined) { up.push(env.DB.prepare('UPDATE bk_ship SET cod_fee=?2 WHERE no=?1').bind(x.no, r2(m.codFee))); filled++; } });
    if (up.length) await env.DB.batch(up);
  }
  const left = (await env.DB.prepare('SELECT COUNT(*) n FROM bk_ship WHERE cod=1 AND cod_fee IS NULL').first()).n;
  const msg = `${rows.length} gönderi okundu (${uniq.length} sipariş${rows.length > uniq.length ? `; ${rows.length - uniq.length} ek gönderi ücreti siparişine eklendi` : ''})${page < pages ? ` (${page}/${pages} sayfa, devam için tekrar eşitle)` : ''} · ${filled} kapıda ödeme bedeli eklendi${left ? ` · ${left} kapıda ödeme bedeli bekliyor` : ''}`;
  const first = rows.reduce((a, x) => !a || (x.created && x.created < a) ? x.created : a, '');
  await env.DB.batch([setStmt(env, 'bk_sync_at', iso()), setStmt(env, 'bk_sync_msg', msg), ...(first ? [env.DB.prepare('DELETE FROM daily_stats WHERE day >= ?1').bind(first)] : []), setStmt(env, 'home_cache', ''), REV(env)]);
  return { n: rows.length, filled, left, more: page < pages, msg };
}
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
  const stmts = [env.DB.prepare(`INSERT INTO products(key,sku,name,barcode,image,channels,qty,cost,min,created_at,updated_at,code) VALUES(?1,?2,?3,?4,?5,?6,0,?7,?8,?9,?9,(SELECT 'LH-' || printf('%04d', COALESCE(MAX(CAST(substr(code,4) AS INTEGER)),0)+1) FROM products WHERE code LIKE 'LH-%'))
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
  const set = BUNDLES.get(key);
  if (set && set.length) return set.flatMap(([comp, n]) => changeQty(env, comp, d * n, { ...m, note: (m.note ? m.note + ' · ' : '') + 'set içeriği' }));
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
  if (l.pkey) return { pkey: l.pkey, sku: l.sku || null }; // kanal ilanından bağlı ürün
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
// Aynı siparişi iki iş (Trendyol bildirimi + eşitleme) aynı anda işlemesin: stok iki kez düşmesin
async function ingestLock(env) {
  for (let i = 0; i < 25; i++) {
    const now = Date.now();
    const r = await env.DB.prepare(`UPDATE settings SET v=?1 WHERE k='lock_ingest' AND CAST(v AS INTEGER) < ?2`).bind(String(now + 20000), now).run();
    if (r.meta && r.meta.changes === 1) return true;
    if (i === 0) { const x = await env.DB.prepare(`INSERT OR IGNORE INTO settings(k,v) VALUES('lock_ingest',?1)`).bind(String(now + 20000)).run(); if (x.meta && x.meta.changes === 1) return true; }
    await sleep(300);
  }
  return false;
}
async function ingestOrders(env, channel, input, opts = {}) {
  if (opts.dry || opts.noLock) return ingestOrdersRaw(env, channel, input, opts);
  if (!(await ingestLock(env))) { const e = new Error('Siparişler şu an başka bir işte işleniyor; birkaç saniye sonra tekrar denenecek.'); e.status = 409; throw e; }
  try { return await ingestOrdersRaw(env, channel, input, opts); }
  finally { try { await env.DB.prepare(`UPDATE settings SET v='0' WHERE k='lock_ingest'`).run(); } catch (e) {} }
}
// Ürün adı tek ilanı varsa o ilanın adını izler (kanalda ad değişince burada da değişir); adı elle değiştirilmiş ya da birden çok ilanı olan ürüne dokunulmaz
const followNameStmt = (env, channel) => env.DB.prepare(`UPDATE products SET name=(SELECT l.name FROM listings l WHERE l.pkey=products.key), updated_at=?2 WHERE COALESCE(name_manual,0)=0 AND merged_into IS NULL AND (SELECT COUNT(*) FROM listings l WHERE l.pkey=products.key)=1 AND EXISTS(SELECT 1 FROM listings l WHERE l.pkey=products.key AND l.channel=?1 AND l.name<>'' AND l.name<>products.name)`).bind(channel, iso());
// Birleştirilmiş (gizli) ürüne bağlanan ilan, birleştirildiği ürüne taşınır
const followMergedStmt = (env) => env.DB.prepare(`UPDATE listings SET pkey=(SELECT merged_into FROM products WHERE key=listings.pkey) WHERE pkey IN (SELECT key FROM products WHERE merged_into IS NOT NULL AND merged_into<>'')`);
// Kanal ilanı → Lilya ürünü (ve kaç adet düşeceği: 2'li paket ilanı = 2)
async function listingMap(env, channel, exts) {
  const ids = [...new Set(exts.map(String).filter(Boolean))]; if (!ids.length) return new Map();
  return new Map((await selectIn(env, `SELECT l.ext, l.pkey, l.factor, p.sku FROM listings l LEFT JOIN products p ON p.key=l.pkey`, `l.channel='${channel === 'shopify' ? 'shopify' : 'trendyol'}' AND l.ext`, ids)).map(r => [String(r.ext), { pkey: r.pkey, factor: Math.max(1, Number(r.factor) || 1), sku: r.sku || '' }]));
}
async function ingestOrdersRaw(env, channel, input, opts = {}) {
  await loadBundles(env); // set içerikleri her zaman güncel olsun (başka isolate'te yeni kaydedilmiş olabilir)
  const dry = !!opts.dry, source = opts.source || 'import';
  // İlanı bilinen satırlar doğrudan bağlı ürüne düşer (stok kodu değişse de); paket ilanında adet çarpanla
  if (channel === 'trendyol' || channel === 'shopify') {
    const lm = await listingMap(env, channel, input.flatMap(o => (o.lines || []).map(l => l.ext || (channel === 'trendyol' ? l.barcode : ''))));
    for (const o of input) for (const l of (o.lines || [])) { const e = lm.get(String(l.ext || (channel === 'trendyol' ? l.barcode : '') || '')); if (e && e.pkey) { l.pkey = e.pkey; l.sku = e.sku || l.sku; if (e.factor > 1) l.qty = (Number(l.qty) || 0) * e.factor; } }
  }
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
      // Satır başka ürüne bağlandıysa (ürün birleştirme) eski siparişin stoğu yeniden düşülmez
      const remap = !!(prev && prev.pkey && prev.pkey !== fl.pkey);
      const d = remap ? 0 : applied0 - desired;
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
    // Teslim günü: paket geçmişindeki Delivered satırı; yoksa durum Delivered iken son değişiklik saati
    const dh = (p.packageHistories || []).filter(h => /^delivered$/i.test(String(h.status || ''))).map(h => Number(h.createdDate)).filter(x => x > 0).sort((a, b) => a - b)[0];
    const deliv = dh ? trDay(dh - TY_ORDER_DATE_SHIFT) : /^delivered$/i.test(status) && Number(p.lastModifiedDate) > 0 ? trDay(Number(p.lastModifiedDate) - TY_ORDER_DATE_SHIFT) : null;
    st.push(env.DB.prepare(`INSERT INTO audit_pkg(pkg_id,order_no,day,units,revenue,paid,status,seen_at,delivered) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
      ON CONFLICT(pkg_id) DO UPDATE SET order_no=excluded.order_no, day=excluded.day, units=excluded.units, revenue=excluded.revenue, paid=excluded.paid, status=excluded.status, seen_at=excluded.seen_at, delivered=COALESCE(audit_pkg.delivered, excluded.delivered)
      WHERE audit_pkg.order_no IS NOT excluded.order_no OR audit_pkg.day IS NOT excluded.day OR audit_pkg.units IS NOT excluded.units OR audit_pkg.revenue IS NOT excluded.revenue OR audit_pkg.paid IS NOT excluded.paid OR audit_pkg.status IS NOT excluded.status OR (audit_pkg.delivered IS NULL AND excluded.delivered IS NOT NULL)`)
      .bind(String(p.shipmentPackageId || p.id), String(p.orderNumber), day, units, Math.round(revenue * 100) / 100, Math.round(paid * 100) / 100, status, now, deliv));
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
      sku: l.stockCode || l.merchantSku || '', barcode: l.barcode || '', ext: l.barcode || '', name: l.productName || '', qty: l.quantity,
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
  // Trendyol bazen ileri tarihli değişiklik saati döndürebilir; okuma noktası şimdiden ileri kaçarsa yeni siparişler atlanmasın
  const hwm = Math.min(Number(s.ty_orders_hwm) || 0, now + TY_TZ + 5 * 60000), exact = Number(s.ty_orders_exact) || 0;
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
/* ---------- Trendyol anlık sipariş bildirimi (webhook) ----------
   Trendyol yeni sipariş olduğu anda uygulamaya haber verir; sipariş 10 saniyelik turu beklemeden düşer.
   Yalnızca henüz kayıtlı olmayan siparişler bildirimden işlenir; durum değişiklikleri (iptal, kargo, teslim) her zamanki eşitlemeyle gelir
   (bildirimler sırasız/tekrarlı gelebildiği için eski bir durum yenisinin üstüne yazılmasın). */
async function handleTyHook(env, pkgsIn) {
  const pkgs = pkgsIn.filter(p => p && (p.shipmentPackageId || p.id) && p.orderNumber && Array.isArray(p.lines));
  if (!pkgs.length) return { n: 0 };
  const nos = [...new Set(pkgs.map(p => String(p.orderNumber)))];
  const have = new Set((await selectIn(env, 'SELECT order_no FROM orders', 'id', nos.map(n => orderId('trendyol', n)))).map(r => String(r.order_no)));
  const fresh = pkgs.filter(p => !have.has(String(p.orderNumber)));
  if (!fresh.length) return { n: 0, known: pkgs.length };
  const shift = Number(await getSetting(env, 'ty_shift')) || 0;
  await recordAuditPkgs(env, fresh);
  const stats = await ingestOrders(env, 'trendyol', tyPackagesToOrders(fresh, shift), { source: 'trendyol' });
  try { await recordCustomers(env, fresh); } catch (e) {}
  return { n: fresh.length, stats };
}
async function tyHookApi(env, method, path, body) {
  const r = await fetch(`https://apigw.trendyol.com/integration/webhook/sellers/${env.TRENDYOL_SELLER_ID}/webhooks${path}`, { method, headers: { ...tyHeaders(env), storeFrontCode: 'TR', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  if (!r.ok) { const e = new Error(`Trendyol bildirim ${r.status}: ${txt.slice(0, 200)}`); e.status = r.status; throw e; }
  try { return JSON.parse(txt); } catch (e) { return txt; }
}
// Bildirim adresini Trendyol'a bir kez kaydeder (uygulamanın adresi ilk girişte öğrenilir); kapanmışsa yeniden kurar
async function ensureTyWebhook(env, force) {
  const s = await getSettings(env, ['hook_id', 'hook_key', 'hook_try', 'hook_at', 'self_origin']);
  if (!s.self_origin) return null;
  const now = Date.now();
  if (!force && now - (Number(s.hook_try) || 0) < (s.hook_id ? 6 * 3600000 : 3600000)) return null;
  await setSetting(env, 'hook_try', String(now));
  const url = s.self_origin + '/hook/ty';
  let list = []; try { const r = await tyHookApi(env, 'GET', ''); list = Array.isArray(r) ? r : (r && (r.content || r.webhooks)) || []; } catch (e) { await setSetting(env, 'hook_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); return null; }
  const mine = list.filter(w => w && w.url === url);
  if (s.hook_id && s.hook_key && mine.some(w => w.id === s.hook_id && w.status !== 'PASSIVE')) return { ok: true };
  for (const w of mine) { try { await tyHookApi(env, 'DELETE', '/' + encodeURIComponent(w.id)); } catch (e) {} }
  const key = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
  try {
    const r = await tyHookApi(env, 'POST', '', { url, authenticationType: 'API_KEY', apiKey: key, subscribedStatuses: ['CREATED'] });
    await env.DB.batch([setStmt(env, 'hook_id', String((r && r.id) || 'ok')), setStmt(env, 'hook_key', key), setStmt(env, 'hook_err', '')]);
    return { ok: true, created: true };
  } catch (e) { await setSetting(env, 'hook_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); return null; }
}
/* ---------- Shopify: siparişler ortak stoktan düşer ----------
   Kimlik: Shopify Dev Dashboard uygulamasının Client ID / Client secret'ı (mağazayla aynı organizasyonda); 24 saatlik erişim anahtarı
   client_credentials ile alınıp saklanır. Siparişler GraphQL Admin API'den güncellenme saatine göre okunur; bildirim (webhook) gelince hemen. */
const SH_API = '2026-07';
// Adres düzeltme: kargolanmamış siparişlerin teslimat adresi okunur ve orderUpdate ile düzeltilir.
// Gerekli: write_orders yetkisi + korunan müşteri verisi (ad, adres, telefon, e-posta) izni.
const SH_ADDR_F = 'firstName lastName company address1 address2 city province provinceCode zip country countryCodeV2 phone';
const SH_ADDR_Q = `query($q:String,$after:String){orders(first:25,after:$after,sortKey:CREATED_AT,reverse:true,query:$q){pageInfo{hasNextPage endCursor}nodes{id name createdAt cancelledAt closed test displayFulfillmentStatus note email phone
  totalPriceSet{shopMoney{amount}} lineItems(first:20){pageInfo{hasNextPage}nodes{name quantity unfulfilledQuantity}} shippingAddress{${SH_ADDR_F}}}}}`;
/* ---------- Sürat Kargo: ön kabul (kendi barkodumuzla gönderi bildirimi) ----------
   Gönderi, cari kodu + şifreyle web servisine OzelKargoTakipNo (bizim barkodumuz) ile kaydedilir; şube barkodu okutunca adres Sürat'ta çıkar.
   İstek, Sürat'ın kendi WSDL tanımından okunan alan adı ve sırasıyla kurulur (ASMX alan sırasına duyarlı). */
const SR_URL = 'https://webservices.suratkargo.com.tr/services.asmx';
// Sürat'ın önündeki Cloudflare, kimliksiz istekleri bot sayıp 403 verebiliyor: .NET web servis istemcisi gibi tanıtılır, 403'te bir kez tarayıcı kimliğiyle tekrar denenir
const SR_UA = ['Mozilla/4.0 (compatible; MSIE 6.0; MS Web Services Client Protocol 4.0.30319.42000)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'];
async function srFetch(url, init = {}) {
  let r;
  for (const ua of SR_UA) { r = await fetch(url, { ...init, headers: { 'user-agent': ua, accept: 'text/xml, application/xml, */*', 'accept-language': 'tr-TR,tr;q=0.9', ...(init.headers || {}) } });
    if (r.status !== 403) return r; const t = await r.clone().text().catch(() => ''); if (!/cloudflare|attention/i.test(t)) return r; }
  return r;
}
// Sıra: Sürat barkodu ve takip no'yu hemen veren işlem (Trendyol'un kullandığı), sonra ön kabul işlemleri
const SR_METHODS = ['GonderiyiKargoyaGonderYeniSiparisBarkodOlustur', 'GonderiyiKargoyaGonderYeni', 'GonderiyiKargoyaGonder'];
const xmlEsc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const xmlAttrs = (tag) => { const o = {}; for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) o[m[1]] = m[2]; return o; };
async function srSchema(env, force) {
  const s = await getSettings(env, ['sr_schema', 'sr_schema_at']);
  if (!force && s.sr_schema && Date.now() - (Number(s.sr_schema_at) || 0) < 86400000) { try { const c = JSON.parse(s.sr_schema); if (c.v === 7) return c; } catch (e) {} }
  const r = await srFetch(SR_URL + '?WSDL');
  if (!r.ok) throw new Error(`Sürat web servisine ulaşılamadı (${r.status}).`);
  const w = await r.text();
  const ns = (/targetNamespace="([^"]+)"/.exec(w) || [])[1] || 'http://tempuri.org/';
  // Yalnız kendi kapanış etiketi olan (işlem tanımı) eleman aranır; aynı ada sahip tek satırlık alan tanımları (<element name="X" ... />) atlanır
  const elBlock = (name) => { const re = new RegExp(`<(?:\\w+:)?element\\b[^>/]*\\bname="${name}"[^>/]*>([\\s\\S]*?)</(?:\\w+:)?element>`); const m = re.exec(w); return m ? m[1] : null; };
  const fields = (block) => [...block.matchAll(/<(?:\w+:)?element\b[^>]*\/?>/g)].map(m => xmlAttrs(m[0])).filter(a => a.name).map(a => ({ name: a.name, type: String(a.type || '').replace(/^\w+:/, ''), tns: /^tns:/.test(a.type || ''), min: a.minOccurs == null ? 1 : Number(a.minOccurs) }));
  let method = null, params = null; const alts = [];
  const ctOf = (type) => { const x = new RegExp(`<(?:\\w+:)?complexType[^>]*name="${type}"[^>]*>([\\s\\S]*?)</(?:\\w+:)?complexType>`).exec(w); return x ? fields(x[1]) : null; };
  for (const m of SR_METHODS) { const b = elBlock(m); if (b) { const ps = fields(b), gpa = ps.find(p => p.tns), gf = gpa && ctOf(gpa.type); alts.push({ method: m, params: ps, gonderi: gf ? { param: gpa.name, type: gpa.type, fields: gf } : null }); if (!method) { method = m; params = ps; } } }
  const ops = [...w.matchAll(/<(?:\w+:)?element[^>]*name="(\w+)Response"/g)].map(m => m[1]);
  if (!method) throw new Error('Sürat web servisinde gönderi kaydetme işlemi bulunamadı.');
  const gp = params.find(p => p.tns); if (!gp) throw new Error('Sürat gönderi tanımı okunamadı.');
  const ct = new RegExp(`<(?:\\w+:)?complexType[^>]*name="${gp.type}"[^>]*>([\\s\\S]*?)</(?:\\w+:)?complexType>`).exec(w);
  if (!ct) throw new Error('Sürat gönderi alanları okunamadı.');
  let query = null; for (const m of ['WebSiparisKodu', 'WebSiparisKoduToplu']) { const b = elBlock(m); if (b) { query = { method: m, params: fields(b) }; break; } }
  const lists = {}; for (const m of ['CariKoduveSifre', 'KargoTakipHareketDetayliV2', 'WebSiparisKodundanKargoTeslimatBilgisi', 'KargoBarkoduSiparis', 'KargoBarkodu', 'Barkod', 'WebSiparisKoduAlicidan']) { const b = elBlock(m); if (b) lists[m] = fields(b); }
  const sc = { v: 7, ns, method, params, alts, ops, lists, gonderi: { param: gp.name, type: gp.type, fields: fields(ct[1]) }, query, at: iso() };
  await env.DB.batch([setStmt(env, 'sr_schema', JSON.stringify(sc)), setStmt(env, 'sr_schema_at', String(Date.now()))]);
  return sc;
}
// Alan değeri: bilinen alanlara siparişten, bilinmeyen zorunlu alanlara türüne göre boş/0
function srValue(f, g) {
  const k = f.name.toLowerCase();
  if (k in g) return g[k];
  if (f.min === 0) return undefined; // isteğe bağlı bilinmeyen alan gönderilmez
  return /int|short|long|byte|decimal|double|float/i.test(f.type) ? 0 : /boolean/i.test(f.type) ? 'false' : '';
}
function srEnvelope(sc, creds, g) {
  const gx = sc.gonderi.fields.map(f => { const v = srValue(f, g); return v === undefined ? '' : `<${f.name}>${xmlEsc(v)}</${f.name}>`; }).join('');
  const px = sc.params.map(p => p.tns ? `<${p.name}>${gx}</${p.name}>` : /kullanici/i.test(p.name) ? `<${p.name}>${xmlEsc(creds.user || creds.cari)}</${p.name}>` : /cari/i.test(p.name) ? `<${p.name}>${xmlEsc(creds.cari)}</${p.name}>` : /sifre|password/i.test(p.name) ? `<${p.name}>${xmlEsc(creds.pass)}</${p.name}>` : '').join('');
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${sc.method} xmlns="${sc.ns}">${px}</${sc.method}></soap:Body></soap:Envelope>`;
}
const SR_FAIL = /hata|error|exception|ge[cç]ersiz|hatal|yetki|bulunamad|ba[sş]ar[iı]s[iı]z|zorunlu|eksik|invalid|fault|tan[iı]ml[iı] de[gğ]il|kay[iı]tl[iı]/i;
async function srSend(env, creds, g, alt) {
  let sc = await srSchema(env, false);
  const a0 = alt ? (sc.alts || []).find(x => x.method === alt) : (sc.alts || [])[0]; if (alt && !a0) throw new Error('Sürat: ' + alt + ' yok');
  if (a0) sc = { ...sc, method: a0.method, params: a0.params, gonderi: a0.gonderi || sc.gonderi };
  const body = srEnvelope(sc, creds, g);
  const r = await srFetch(SR_URL, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: `"${sc.ns.replace(/\/?$/, '/')}${sc.method}"` }, body });
  const t = await r.text();
  const fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(t);
  if (fault) throw new Error('Sürat: ' + fault[1].replace(/\s+/g, ' ').slice(0, 300));
  const res = new RegExp(`<${sc.method}Result>([\\s\\S]*?)</${sc.method}Result>`).exec(t);
  const inner = (res ? res[1] : t).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const msg = srText(inner).slice(0, 300);
  // Sürat barkodu / takip no: Barkod, KargoTakipNo, TakipNo… alanından (XML ya da JSON)
  const bc = ((/<(\w*(?:Barkod|Takip)\w*)>\s*(\d{8,20})\s*</i.exec(inner) || [])[2]) || ((/"\w*(?:Barkod|Takip)\w*"\s*:\s*"?(\d{8,20})/i.exec(inner) || [])[1]) || (/^\s*(\d{10,20})\s*$/.exec(msg) || [])[1] || '';
  if (!r.ok) throw new Error(`Sürat ${r.status}: ${msg || 'cevap okunamadı'}`);
  if (!bc && (!res || SR_FAIL.test(msg))) throw new Error('Sürat kabul etmedi: ' + (msg || 'boş cevap'));
  return { msg: msg || 'Tamam', method: sc.method, barcode: bc, raw: srText(inner).slice(0, 400) };
}
// Gönderinin Sürat barkodunu iste: barkod işlemleri sırayla (kullanıcı/şifre + bizim referansımız)
async function srFetchBarcode(env, cr, ref) {
  const sc = await srSchema(env, false), L = sc.lists || {}, log = [];
  for (const m of ['KargoBarkoduSiparis', 'KargoBarkodu', 'Barkod', 'WebSiparisKoduAlicidan']) { const ps = L[m]; if (!ps) continue;
    try { const t = await srCall(env, m, ps, p => p.tns ? null : /cari/i.test(p.name) ? cr.cari : /kullanici/i.test(p.name) ? (cr.user || cr.cari) : /sifre|password|parola/i.test(p.name) ? cr.pass : /siparis|referans|ozel|webtakip|kod/i.test(p.name) ? ref : /bool/i.test(p.type) ? 'false' : null);
      const body = t.replace(/<xs:schema[\s\S]*?<\/xs:schema>/g, '');
      const bc = ((/<(\w*(?:Barkod|Takip)\w*)>\s*(\d{8,20})\s*</i.exec(body) || [])[2]) || ((/"\w*(?:Barkod|Takip)\w*"\s*:\s*"?(\d{8,20})/i.exec(body) || [])[1]) || '';
      log.push(m + ': ' + srText(body).slice(0, 120)); if (bc) return { barcode: bc, log };
    } catch (e) { log.push(m + ': ' + String(e.message || e).slice(0, 120)); } }
  return { barcode: '', log };
}
// Takip: bizim barkodumuzla (WebSiparisKodu) Sürat'ın takip numarası sorulur; şube okutunca dolar
const SR_TRACK_URL = (no) => `https://suratkargo.com.tr/KargoTakip/?kargotakipno=${encodeURIComponent(no)}`;
async function srQuery(env, creds, ref) {
  const sc = await srSchema(env, false); const q = sc.query; if (!q) throw new Error('Sürat web servisinde gönderi sorgulama bulunamadı.');
  const px = q.params.map(p => { const n = p.name;
    const v = /cari|kullanici/i.test(n) ? creds.cari : /sifre|password|parola/i.test(n) ? (creds.pass || creds.web) : /siparis|referans|ozel|kod/i.test(n) ? ref : null;
    return v == null ? '' : `<${n}>${xmlEsc(v)}</${n}>`; }).join('');
  const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${q.method} xmlns="${sc.ns}">${px}</${q.method}></soap:Body></soap:Envelope>`;
  const r = await srFetch(SR_URL, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: `"${sc.ns.replace(/\/?$/, '/')}${q.method}"` }, body });
  const raw = await r.text(), fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(raw);
  if (fault) throw new Error('Sürat: ' + fault[1].replace(/\s+/g, ' ').slice(0, 200));
  const t = raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  // Takip no: KargoTakipNo / TakipNo / KargoTakipNumarasi / Barkod… adlı herhangi bir alandan (JSON ya da XML)
  const no = (/<KargoTakipNo>\s*(\d{6,20})\s*</i.exec(t) || /KargoTakipNo["'\s:=]*(\d{6,20})/i.exec(t) || /<(\w*Takip\w*)>\s*(\d{8,20})\s*</i.exec(t) && [0, /<(\w*Takip\w*)>\s*(\d{8,20})\s*</i.exec(t)[2]] || /"\w*(?:Takip|Barkod)\w*"\s*:\s*"?(\d{8,20})/i.exec(t) || /<(?:\w*Barkod\w*)>\s*(\d{8,20})\s*</i.exec(t) || [])[1] || '';
  const durum = ((/<(?:Son)?Durum>([^<]{1,120})</i.exec(t) || /<Mesaj>([^<]{1,160})</i.exec(t) || [])[1] || '').trim();
  if (!r.ok) throw new Error(`Sürat ${r.status}: ${durum || t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  return { no, durum, raw: srText(t).slice(0, 600) };
}
// DataSet cevabı: şema atılır, satırlar (<Table diffgr:id=…>) alan → değer olarak okunur
const srText = (t) => String(t).replace(/<xs:schema[\s\S]*?<\/xs:schema>/g, '').replace(/<\?xml[^>]*>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
function srRows(t) {
  const body = String(t).replace(/<xs:schema[\s\S]*?<\/xs:schema>/g, ''), out = [];
  for (const m of body.matchAll(/<(\w+)\s[^>]*diffgr:id="[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)) { const o = {}; for (const f of m[2].matchAll(/<(\w+)(?:\s[^>]*)?>([^<]*)<\/\1>/g)) o[f[1]] = f[2].trim(); out.push(o); }
  return out;
}
async function srCall(env, method, params, val) {
  const sc = await srSchema(env, false);
  const px = params.map(p => { const v = val(p); return v == null ? '' : `<${p.name}>${xmlEsc(v)}</${p.name}>`; }).join('');
  const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="${sc.ns}">${px}</${method}></soap:Body></soap:Envelope>`;
  const r = await srFetch(SR_URL, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: `"${sc.ns.replace(/\/?$/, '/')}${method}"` }, body });
  const raw = await r.text(), fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(raw);
  if (fault) throw new Error('Sürat: ' + fault[1].replace(/\s+/g, ' ').slice(0, 200));
  return raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
// Cari koduna ait gönderiler (Sürat en çok 7 günlük aralık verir)
async function srList(env, cr, days) {
  const sc = await srSchema(env, false), ps = (sc.lists || {}).CariKoduveSifre; if (!ps) return null;
  const d0 = new Date(Date.now() - (days || 6) * 86400000), d1 = new Date(Date.now() + 86400000);
  const fmt = (d, p) => /date/i.test(p.type) ? d.toISOString().slice(0, 10) + 'T00:00:00' : `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
  const call = (pw) => srCall(env, 'CariKoduveSifre', ps, p => /websiparis\w*olsun/i.test(p.name) ? 'true' : /cari|kullanici/i.test(p.name) ? cr.cari : /sifre|password|parola/i.test(p.name) ? pw : /bas|ilk|start|from/i.test(p.name) ? fmt(d0, p) : /bit|son|end|to$/i.test(p.name) ? fmt(d1, p) : null);
  let t = await call(cr.pass); if (cr.web && cr.web !== cr.pass && /hatal/i.test((/<Mesaj>([^<]{1,200})</i.exec(t) || [])[1] || '')) t = await call(cr.web);
  const rows = srRows(t), mesaj = ((/<Mesaj>([^<]{1,200})</i.exec(t) || [])[1] || '').trim();
  return { rows, mesaj, text: rows.length ? '' : srText(t).slice(0, 300) };
}
const srNorm = (x) => String(x || '').toLocaleUpperCase('tr').replace(/İ/g, 'I').replace(/Ç/g, 'C').replace(/Ğ/g, 'G').replace(/Ö/g, 'O').replace(/Ş/g, 'S').replace(/Ü/g, 'U').replace(/Â/g, 'A').replace(/Î/g, 'I').replace(/Û/g, 'U').replace(/[^A-Z0-9]/g, ''); // Türkçe harfler sadeleşir: Müjgan = MUJGAN
const srToks = (x) => String(x || '').split(/\s+/).map(srNorm).filter(t => t.length > 1).sort().join(' ');
// Listeden bizim gönderiyi bul: barkodumuz (LH…), sipariş no ya da alıcı adı
function srMatch(rows, ship) {
  const ref = srNorm(ship.ref), no = String(ship.order_no || '').replace(/\D/g, ''); let a = {}; try { a = JSON.parse(ship.addr || '{}'); } catch (e) {}
  const nm = srNorm(a.name), tk = srToks(a.name), byName = [];
  for (const r of rows) { const vals = Object.entries(r);
    if (vals.some(([, v]) => srNorm(v) === ref || srNorm(v).includes(ref))) return r;
    if (no && vals.some(([k, v]) => /referans|siparis|irsaliye/i.test(k) && String(v).replace(/\D/g, '') === no)) return r;
    if (nm && vals.some(([k, v]) => /alici|unvan|kisi/i.test(k) && !/adres|tel|gonderen/i.test(k) && (srNorm(v) === nm || (tk && srToks(v) === tk)))) byName.push(r); }
  if (byName.length > 1 && (a.ilce || a.il)) { const il = srNorm(a.il), ilce = srNorm(a.ilce); // aynı ad birden çok satırda: il/ilçeyle ayır
    const f = byName.filter(r => Object.entries(r).some(([k, v]) => /ilce/i.test(srNorm(k).toLowerCase()) && ilce && srNorm(v) === ilce) || Object.entries(r).some(([k, v]) => /il$/i.test(k) && il && srNorm(v) === il)); if (f.length === 1) return f[0]; }
  return byName.length === 1 ? byName[0] : null;
}
// Takip no sütunu: önce "Kargo Takip No" benzeri, sonra diğer takip/barkod sütunları; bizim/müşterinin referans sütunları (web, özel, müşteri, sipariş) kullanılmaz. Excel'de sayı 1,23E+12 / 123.0 gibi gelebilir
const srCellNo = (v) => { let t = String(v ?? '').trim().replace(/\s/g, ''); if (/^\d+(\.0+)?$/.test(t)) t = t.replace(/\.0+$/, ''); t = t.toLocaleUpperCase('tr').replace(/[^A-Z0-9]/g, ''); return t.length >= 8 && t.length <= 30 && (t.match(/\d/g) || []).length >= 6 && !/^LH/.test(t) ? t : ''; }; // harfli takip no da kabul (ör. SRT…); bizim LH barkodumuz hariç
const srRowTrack = (r) => { const E = Object.entries(r), K = (k) => srNorm(k), bad = /WEB|OZEL|ÖZEL|MUSTERI|MÜŞTERI|SIPARIS|SİPARİŞ|REFERANS|IRSALIYE/;
  for (const re of [/KARGOTAKIP|^TAKIPNO|^TAKIPNUMARA/, /TAKIP/, /BARKOD/]) for (const [k, v] of E) { const kk = K(k); if (re.test(kk) && !bad.test(kk)) { const n = srCellNo(v); if (n) return n; } }
  return ''; };
// Sürat raporu satırından gerçek ücret (Tutar: KDV ve posta vergisi dahil), desi, kapıda tahsilat ve teslim edilemedi bilgisi
const srPick = (r) => { const E = Object.entries(r).map(([k, v]) => [srNorm(k), String(v ?? '').trim()]), get = (re) => { const x = E.find(([k]) => re.test(k)); return x ? x[1] : ''; };
  const num = (t) => { if (!t) return null; const n = Number(/,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
  const iade = get(/^IADEDURUM$/), tes = get(/^TESLIMATDURUM$/), yer = get(/^BULUNDUGUYER$/);
  const undelivered = /^(EVET|E|1|TRUE)$/i.test(srNorm(iade)) || /IADE|TESLIMEDILEMEDI|GERIDON/.test(srNorm(tes + ' ' + yer));
  return { cost: num(get(/^TUTAR$/)), desi: num(get(/^TOPLAMDESI$/)), cod: num(get(/^KAPIDANTAHSILATTUTARI$/)) || 0, undelivered, durum: (tes || yer || '').slice(0, 80), teslim: get(/^TESLIMTARIHI$/).slice(0, 30), planned: get(/^PLANLANANTESLIMTARIHI$/).slice(0, 30) }; };
const srRowState = (r) => { for (const [k, v] of Object.entries(r)) if (/durum|islem|hareket/i.test(k) && v) return String(v).slice(0, 120); return ''; };
// Shopify'da siparişi "kargolandı" yapar ve takip numarasını müşteriye bildirir
// Gerekli yetkiler: read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders
async function shFulfill(env, c, gid, number) {
  let d; try { d = await shGql(env, c, `query($id:ID!){order(id:$id){fulfillmentOrders(first:10){nodes{id status}}}}`, { id: gid }); }
  catch (e) { throw new Error(/access|scope|denied/i.test(String(e.message)) ? 'Shopify uygulamasına read_merchant_managed_fulfillment_orders ve write_merchant_managed_fulfillment_orders yetkilerini ekleyip yeni sürüm yayınla, mağazada onayla.' : String(e.message || e)); }
  const open = (((d.order || {}).fulfillmentOrders || {}).nodes || []).filter(f => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(f.status));
  if (!open.length) return { already: true };
  const r = await shGql(env, c, `mutation($f:FulfillmentInput!){fulfillmentCreate(fulfillment:$f){fulfillment{id status}userErrors{field message}}}`,
    { f: { lineItemsByFulfillmentOrder: open.map(f => ({ fulfillmentOrderId: f.id })), notifyCustomer: true, trackingInfo: { company: 'Sürat Kargo', number, url: SR_TRACK_URL(number) } } })
    .catch(e => { throw new Error(/access|scope|denied/i.test(String(e.message)) ? 'Shopify uygulamasına write_merchant_managed_fulfillment_orders yetkisini ekleyip yeni sürüm yayınla, mağazada onayla.' : String(e.message || e)); });
  const ue = r.fulfillmentCreate.userErrors || []; if (ue.length) throw new Error('Shopify: ' + ue.map(e => e.message).join(' · '));
  return { ok: true };
}
// Daha önce yanlış numarayla "kargolandı" yapılmış siparişin takip numarasını Shopify'da düzeltir (müşteriye yeni bildirim gider)
async function shFixTracking(env, c, gid, number) {
  const d = await shGql(env, c, `query($id:ID!){order(id:$id){fulfillments(first:10){id status trackingInfo{number company}}}}`, { id: gid });
  const fs = ((d.order || {}).fulfillments || []).filter(f => f.status !== 'CANCELLED'); if (!fs.length) return { none: true };
  for (const f of fs) { if ((f.trackingInfo || []).some(t => t.number === number)) continue;
    const r = await shGql(env, c, `mutation($id:ID!,$t:FulfillmentTrackingInput!){fulfillmentTrackingInfoUpdate(fulfillmentId:$id,trackingInfoInput:$t,notifyCustomer:true){fulfillment{id}userErrors{field message}}}`, { id: f.id, t: { company: 'Sürat Kargo', number, url: SR_TRACK_URL(number) } });
    const ue = r.fulfillmentTrackingInfoUpdate.userErrors || []; if (ue.length) throw new Error('Shopify: ' + ue.map(e => e.message).join(' · ')); }
  return { ok: true };
}
// Bir gönderinin takip numarasını sor; geldiyse Shopify'a işle
async function srTrackOne(env, row, cr, c) {
  let tr = row.tracking || '', msg = row.track_msg || '';
  // Önce bizim barkodumuz (Web Takip No), bulunamazsa sipariş numarası (Referans No) ile sorulur
  if (!tr) { let q = await srQuery(env, cr, row.ref); const alt = String(row.order_no || '').replace(/\D/g, '');
    if (!q.no && alt && /bulunamad|yok|kay[ıi]t/i.test(q.durum || q.raw)) { const q2 = await srQuery(env, cr, alt); if (q2.no || !/bulunamad/i.test(q2.durum || q2.raw)) q = q2; }
    tr = q.no; msg = q.no ? (q.durum || q.raw) : q.raw; }
  const st = [env.DB.prepare('UPDATE sr_ship SET tracking=?2, track_at=?3, track_msg=?4 WHERE ref=?1').bind(row.ref, tr || null, iso(), String(msg || '').slice(0, 600))];
  let fulfilled = false, ferr = '';
  if (tr && !row.fulfilled_at && shConfigured(c)) { try { const fr = await shFulfill(env, c, row.gid, tr); if (fr && fr.already) await shFixTracking(env, c, row.gid, tr); fulfilled = true; } catch (e) { ferr = String(e.message || e).slice(0, 300); } } // Shopify'da zaten kargolanmışsa takip no güncellenir
  if (fulfilled) st.push(env.DB.prepare('UPDATE sr_ship SET fulfilled_at=?2, fulfill_err=NULL WHERE gid=?1').bind(row.gid, iso()));
  else if (ferr) st.push(env.DB.prepare('UPDATE sr_ship SET fulfill_err=?2 WHERE ref=?1').bind(row.ref, ferr));
  await env.DB.batch(st);
  return { ref: row.ref, tracking: tr, msg, fulfilled, err: ferr };
}
async function srTrackPending(env, limit) {
  const cr = await srCreds(env); if (!cr.cari || !cr.pass) return null;
  if (!limit && Date.now() < (Number(await getSetting(env, 'sr_block_until')) || 0)) return { checked: 0, tracked: 0, fulfilled: 0, items: [], paused: true };
  const c = await shCreds(env);
  const { results } = await env.DB.prepare(`SELECT * FROM sr_ship s WHERE fulfilled_at IS NULL AND at > ?1 AND at = (SELECT MAX(at) FROM sr_ship t WHERE t.gid = s.gid) ORDER BY COALESCE(track_at, '') LIMIT ${Math.min(60, limit || 15)}`).bind(iso(Date.now() - 21 * 86400000)).all();
  let rows = null; try { const L = results.length ? await srList(env, cr, 6) : null; rows = L && L.rows; } catch (e) {}
  for (const r of results) if (rows && rows.length && !r.tracking) { const m = srMatch(rows, r), tn = m && srRowTrack(m); if (tn) { r.tracking = tn; r.track_msg = srRowState(m) || 'Sürat listesinden'; } }
  let solo = 0; const out = []; for (const r of results) { if (!r.tracking && rows && rows.length && solo >= 6) continue; if (!r.tracking) solo++; try { out.push(await srTrackOne(env, r, cr, c)); } catch (e) { out.push({ ref: r.ref, err: String(e.message || e) }); await setSetting(env, 'sr_track_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); if (/403|cloudflare|attention/i.test(String(e.message))) await setSetting(env, 'sr_block_until', String(Date.now() + 90 * 60000)); break; } }
  if (out.length && !out.some(x => x.err && /403|cloudflare|attention/i.test(x.err))) await setSetting(env, 'sr_track_err', '');
  return { checked: out.length, tracked: out.filter(x => x.tracking).length, fulfilled: out.filter(x => x.fulfilled).length, items: out };
}
async function srCreds(env) { const s = await getSettings(env, ['sr_cari', 'sr_user', 'sr_pass', 'sr_web', 'sr_desi']); const cari = env.SURAT_CARI_KODU || s.sr_cari || ''; return { cari, user: env.SURAT_KULLANICI || s.sr_user || cari, pass: env.SURAT_SIFRE || s.sr_pass || '', web: env.SURAT_WEB_SIFRE || s.sr_web || '', desi: Number(s.sr_desi) || 2 }; }
const SR_ORDER_Q = `query($id:ID!){order(id:$id){id name email phone cancelledAt displayFulfillmentStatus shippingAddress{${'firstName lastName company address1 address2 city province provinceCode zip country countryCodeV2 phone'}} totalPriceSet{shopMoney{amount}}
  lineItems(first:50){nodes{name sku quantity unfulfilledQuantity variant{id} discountedUnitPriceAfterAllDiscountsSet{shopMoney{amount}} image{url}}}}}`;
function shAddrErr(e) {
  const m = String((e && e.message) || e);
  if (/write_orders|access denied.*order|required access/i.test(m)) return 'Shopify uygulamasında adres değiştirme izni yok. Dev Dashboard → Lilya Backstage → yeni sürüm (Version) → Access scopes\'a write_orders ekle → Release, sonra mağazada uygulamayı güncelle. Ayrıntı: ' + m.slice(0, 160);
  if (/protected customer data|not approved to access|customer data/i.test(m)) return 'Shopify, müşteri adres bilgisini bu uygulamaya henüz açmıyor. Dev Dashboard → Lilya Backstage → API access / Protected customer data bölümünde Ad, Adres, Telefon ve E-posta alanlarını seçip kaydet. Ayrıntı: ' + m.slice(0, 160);
  return m;
}
async function shCreds(env) {
  const s = await getSettings(env, ['sh_shop', 'sh_cid', 'sh_secret', 'sh_token', 'sh_token_exp']);
  const shop = String(env.SHOPIFY_SHOP || s.sh_shop || '').trim().replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '').replace(/\/.*$/, '');
  return { shop, cid: env.SHOPIFY_CLIENT_ID || s.sh_cid || '', secret: env.SHOPIFY_CLIENT_SECRET || s.sh_secret || '', token: s.sh_token || '', exp: Number(s.sh_token_exp) || 0 };
}
const shConfigured = (c) => !!(c.shop && c.cid && c.secret);
async function shToken(env, c, force) {
  if (!force && c.token && c.exp - Date.now() > 10 * 60000) return c.token;
  const r = await fetch(`https://${c.shop}.myshopify.com/admin/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.cid, client_secret: c.secret }).toString() });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  if (!r.ok || !j || !j.access_token) {
    const msg = (j && (j.error_description || j.error || (j.errors && JSON.stringify(j.errors)))) || t.slice(0, 160);
    throw new Error(r.status === 404 ? 'Mağaza adresi bulunamadı (xxx.myshopify.com adresini kontrol et).' : /shop_not_permitted/.test(t) ? 'Uygulama bu mağazayla aynı Shopify organizasyonunda değil (shop_not_permitted).' : /invalid_client|client/i.test(String(msg)) ? 'Client ID ya da Client secret hatalı.' : 'Shopify anahtarı alınamadı: ' + msg);
  }
  c.token = j.access_token; c.exp = Date.now() + (Number(j.expires_in) || 86399) * 1000;
  await env.DB.batch([setStmt(env, 'sh_token', c.token), setStmt(env, 'sh_token_exp', String(c.exp))]);
  return c.token;
}
async function shGql(env, c, query, variables) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await shToken(env, c, false);
    const r = await fetch(`https://${c.shop}.myshopify.com/admin/api/${SH_API}/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }) });
    if (r.status === 401 && attempt === 0) { c.token = ''; c.exp = 0; continue; } // anahtar geçersiz: yenisi alınır
    if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error(`Shopify ${r.status}`);
    if (j.errors && j.errors.length) { const m = j.errors.map(e => e.message).join(' · '); if (/throttl/i.test(m) && attempt < 2) { await sleep(2000); continue; }
      // Yetki yeni eklendiyse eski anahtar eski izinleri taşır: bir kez yeni anahtar alınıp tekrar denenir
      if (/access denied|access scope|required access/i.test(m) && attempt === 0 && !c._refreshed) { c._refreshed = true; c.token = ''; c.exp = 0; await shToken(env, c, true); continue; }
      throw new Error('Shopify: ' + m.slice(0, 200)); }
    return j.data;
  }
  throw new Error('Shopify isteği tamamlanamadı.');
}
const SH_ORDERS_Q = `query($q:String!,$after:String){orders(first:40,after:$after,sortKey:UPDATED_AT,query:$q){pageInfo{hasNextPage endCursor}nodes{id name createdAt updatedAt cancelledAt test displayFulfillmentStatus paymentGatewayNames subtotalPriceSet{shopMoney{amount}} totalShippingPriceSet{shopMoney{amount}} totalPriceSet{shopMoney{amount}} transactions(first:5){paymentId authorizationCode} fulfillments(first:5){deliveredAt}
  lineItems(first:60){nodes{id sku name quantity currentQuantity unfulfilledQuantity variant{id sku barcode image{url}} image{url} discountedUnitPriceAfterAllDiscountsSet{shopMoney{amount}} originalUnitPriceSet{shopMoney{amount}}}}
  refunds{refundLineItems(first:60){nodes{quantity restockType lineItem{id}}}}}}}`;
const shId = (gid) => { const m = /(\d+)\s*$/.exec(String(gid || '')); return m ? m[1] : ''; };
function shOrdersToInput(nodes) {
  const out = [];
  for (const o of nodes) {
    if (o.test) continue;
    const restocked = new Map(), refunded = new Map();
    for (const rf of (o.refunds || [])) for (const x of ((rf.refundLineItems || {}).nodes || [])) if (x.lineItem) { const n = Number(x.quantity) || 0; refunded.set(x.lineItem.id, (refunded.get(x.lineItem.id) || 0) + n); if (/RETURN|CANCEL|LEGACY_RESTOCK/.test(String(x.restockType || ''))) restocked.set(x.lineItem.id, (restocked.get(x.lineItem.id) || 0) + n); }
    const bySku = new Map();
    for (const l of ((o.lineItems || {}).nodes || [])) {
      const sku = String(l.sku || (l.variant && l.variant.sku) || '').trim(), barcode = String((l.variant && l.variant.barcode) || '').trim(), vid = shId(l.variant && l.variant.id);
      if (!sku && !barcode && !vid) continue;
      const q = Number(l.quantity) || 0; if (q <= 0) continue;
      let want = o.cancelledAt ? 0 : Math.max(0, q - (restocked.get(l.id) || 0));
      if (Number(l.currentQuantity) === 0 && !restocked.get(l.id)) want = 0; // sipariş düzenlemesiyle çıkarılan satır
      const unit = Number(((l.discountedUnitPriceAfterAllDiscountsSet || l.originalUnitPriceSet || {}).shopMoney || {}).amount);
      const k = vid || sku || barcode; const a = bySku.get(k) || { vid, sku, barcode, name: l.name || '', image: ((l.variant && l.variant.image) || l.image || {}).url || '', q: 0, want: 0, rev: 0 };
      a.q += q; a.want += want; if (Number.isFinite(unit) && !o.cancelledAt) a.rev += unit * Math.max(0, q - (refunded.get(l.id) || 0)); bySku.set(k, a); // para iadesi yapılan adetler ciroya girmez
    }
    const lines = [...bySku.values()].map(a => ({ ...(a.vid ? { key: 'v' + a.vid, ext: a.vid } : {}), sku: a.sku, barcode: a.barcode, name: a.name, image: a.image, qty: a.want > 0 ? a.want : a.q, status: a.want > 0 ? 'active' : 'cancelled', fin: { revenue: Math.round(a.rev * 100) / 100, rate: 0, vat: 20 } }));
    if (lines.length) out.push({ orderNo: String(o.name || '').trim(), date: o.createdAt, lines });
  }
  return out;
}
// Stok kodu eşleştirmesi Türkçe İ/ı ve büyük-küçük harf farkını önemsemez (Trendyol'da "LİLYAHOME1652", Shopify'da "LILYAHOME1652" olabilir)
const skuFold = (x) => String(x || '').trim().replace(/İ/g, 'I').replace(/ı/g, 'i').toUpperCase();
async function skuFoldMap(env) { const { results } = await env.DB.prepare('SELECT key, sku FROM products').all(); const m = new Map(); for (const r of results) { const f = skuFold(r.sku); if (f && !m.has(f)) m.set(f, r); } return m; }
// Shopify ödeme yöntemi: kapıda nakit / kapıda kart / online (kâr hesabında kargo ve kapıda ödeme kuralları için)
function shPayRow(o) {
  const g = (o.paymentGatewayNames || []).join(' | '), gl = g.toLocaleLowerCase('tr-TR');
  const cod = /kap[ıi]da|cash on delivery|\bcod\b|teslimatta|nakit/.test(gl) ? 1 : 0;
  const card = cod && /kart|card|pos|kredi/.test(gl) ? 1 : 0;
  const M = (x) => x && x.shopMoney ? Number(x.shopMoney.amount) || 0 : null;
  const tx = (o.transactions || []).flatMap(t => [t.paymentId, t.authorizationCode]).filter(Boolean).map(String).join(' ').slice(0, 400);
  const dl = (o.fulfillments || []).map(f => f && f.deliveredAt).filter(Boolean).sort().pop();
  return { no: String(o.name || '').replace(/\D/g, ''), gateway: g.slice(0, 200), cod, card, subtotal: M(o.subtotalPriceSet), ship: M(o.totalShippingPriceSet), total: M(o.totalPriceSet), tx, delivered: dl ? trDay(Date.parse(dl)) : null };
}
async function shPaySave(env, nodes) {
  const st = nodes.filter(o => o && o.name && Array.isArray(o.paymentGatewayNames)).map(o => { const x = shPayRow(o); return env.DB.prepare('INSERT INTO sh_pay(no, gateway, cod, card, subtotal, ship, total, at, tx, delivered) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(no) DO UPDATE SET gateway=excluded.gateway, cod=excluded.cod, card=excluded.card, subtotal=excluded.subtotal, ship=excluded.ship, total=excluded.total, at=excluded.at, tx=excluded.tx, delivered=COALESCE(excluded.delivered, sh_pay.delivered)').bind(x.no, x.gateway, x.cod, x.card, x.subtotal, x.ship, x.total, iso(), x.tx || '', x.delivered); });
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
}
// Geçmiş siparişlerin ödeme yöntemi bir kez (rapor başlangıcından bu yana) sayfa sayfa okunur
const SH_PAY_Q = `query($q:String!,$after:String){orders(first:100,after:$after,sortKey:CREATED_AT,query:$q){pageInfo{hasNextPage endCursor}nodes{name paymentGatewayNames subtotalPriceSet{shopMoney{amount}} totalShippingPriceSet{shopMoney{amount}} totalPriceSet{shopMoney{amount}} transactions(first:5){paymentId authorizationCode} fulfillments(first:5){deliveredAt}}}}`;
async function shPayBackfill(env, maxPages = 4) {
  const s = await getSettings(env, ['sh_pay_done', 'sh_pay_after', 'report_start']); if (s.sh_pay_done === '1') return null;
  const c = await shCreds(env); if (!shConfigured(c)) return null;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(s.report_start || '') ? s.report_start : '2026-09-01';
  let after = s.sh_pay_after || null, n = 0, done = false;
  for (let p = 0; p < maxPages; p++) { const d = await shGql(env, c, SH_PAY_Q, { q: `created_at:>='${from}T00:00:00+03:00'`, after }); await shPaySave(env, d.orders.nodes); n += d.orders.nodes.length;
    if (!d.orders.pageInfo.hasNextPage) { done = true; break; } after = d.orders.pageInfo.endCursor; }
  await env.DB.batch([setStmt(env, 'sh_pay_after', done ? '' : after || ''), ...(done ? [setStmt(env, 'sh_pay_done', '1'), env.DB.prepare('DELETE FROM daily_stats WHERE day >= ?1').bind(from), setStmt(env, 'home_cache', ''), REV(env)] : [])]);
  return { n, done };
}
async function syncShopifyOrders(env, opts = {}) {
  const c = await shCreds(env); if (!shConfigured(c)) return null;
  const s = await getSettings(env, ['sh_hwm', 'sh_start', 'sh_paused', 'sh_unf_init']);
  if (s.sh_paused === '1' && !opts.force) return { paused: true, orders: 0 }; // duraklatıldı: kaldığı yer saklanır, açılınca aradaki siparişler de işlenir
  const start = s.sh_start || iso();
  // İlk kez: son 14 günün siparişleri bir kez okunur (kargolanmamış adetler için); eski siparişler stoktan düşmez (başlangıç öncesi)
  const unfInit = !s.sh_unf_init;
  const since = unfInit ? iso(Date.now() - 14 * 86400000) : (s.sh_hwm || start);
  if (unfInit) opts = { ...opts, pages: Math.max(opts.pages || 3, 8) };
  const q = `updated_at:>='${new Date(Date.parse(since) - 5 * 60000).toISOString()}'`;
  let after = null, maxUp = since, nodes = [];
  for (let page = 0; page < (opts.pages || 3); page++) {
    const d = await shGql(env, c, SH_ORDERS_Q, { q, after });
    const ord = d.orders; nodes.push(...ord.nodes);
    for (const o of ord.nodes) if (o.updatedAt > maxUp) maxUp = o.updatedAt;
    if (!ord.pageInfo.hasNextPage) { after = null; break; }
    after = ord.pageInfo.endCursor;
  }
  try { await shPaySave(env, nodes); } catch (e) {}
  const input = shOrdersToInput(nodes);
  // Kargolanmamış adetler (iptal edilmemiş siparişlerde)
  const unf = nodes.filter(o => !o.test).map(o => { const m = {}; if (!o.cancelledAt) for (const l of ((o.lineItems || {}).nodes || [])) { const v = shId(l.variant && l.variant.id), q = Number(l.unfulfilledQuantity) || 0; if (v && q > 0) m[v] = (m[v] || 0) + q; } return [String(o.name || '').trim(), m]; });
  const us = unf.map(([no, m]) => Object.keys(m).length ? env.DB.prepare('INSERT INTO sh_unf(order_no,data,updated_at) VALUES(?1,?2,?3) ON CONFLICT(order_no) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at').bind(no, JSON.stringify(m), iso()) : env.DB.prepare('DELETE FROM sh_unf WHERE order_no=?1').bind(no));
  for (let i = 0; i < us.length; i += 90) await env.DB.batch(us.slice(i, i + 90));
  if (input.length) { const fm = await skuFoldMap(env); for (const o of input) for (const l of o.lines) { const e = l.sku && fm.get(skuFold(l.sku)); if (e) l.sku = e.sku; } }
  const stats = input.length ? await ingestOrders(env, 'shopify', input, { source: 'shopify', start }) : null;
  await env.DB.batch([setStmt(env, 'sh_hwm', unfInit && s.sh_hwm && s.sh_hwm > maxUp ? s.sh_hwm : maxUp), setStmt(env, 'sh_ok', iso()), setStmt(env, 'sh_err', ''), ...(unfInit && !after ? [setStmt(env, 'sh_unf_init', '1')] : [])]);
  return { orders: input.length, more: !!after, stats };
}
// Shopify ürünleri (her varyant ayrı ürün): stok koduyla mevcut ürünlerle eşleşir; uygulamada olmayanlar eklenir ve
// ilk eklenişte Shopify'daki stok adedi başlangıç stoğu olur (Trendyol'daki gibi). Var olan ürünün stoğuna dokunulmaz.
async function syncShopifyProducts(env, force) {
  const c = await shCreds(env); if (!shConfigured(c)) return null;
  if (!force && (await getSetting(env, 'sh_paused')) === '1') return { paused: true };
  const Q = (inv) => `query($after:String){productVariants(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id sku barcode title ${inv ? 'inventoryQuantity inventoryItem{id}' : ''} image{url} product{title status featuredMedia{preview{image{url}}}}}}}`;
  let inv = true, after = null; const vs = [];
  for (let page = 0; page < 30; page++) {
    let d; try { d = await shGql(env, c, Q(inv), { after }); } catch (e) { if (inv && /inventory|access|scope/i.test(String(e.message))) { inv = false; page--; continue; } throw e; }
    vs.push(...d.productVariants.nodes);
    if (!d.productVariants.pageInfo.hasNextPage) break; after = d.productVariants.pageInfo.endCursor;
  }
  const list = vs.filter(v => v.product); // Shopify: aktif, taslak ve arşivdeki bütün ürünler entegre
  const vname = (v) => String(v.product.title || '') + (v.title && !/^default title$/i.test(String(v.title)) ? ' · ' + v.title : '');
  const vimg = (v) => (v.image && v.image.url) || (((v.product.featuredMedia || {}).preview || {}).image || {}).url || '';
  const lm = await listingMap(env, 'shopify', list.map(v => shId(v.id)));
  const fm = await skuFoldMap(env), bmap = await barcodeMap(env, list.map(v => String(v.barcode || '').trim()).filter(Boolean));
  const st = []; let added = 0, matched = 0, linked = 0; const newKeys = new Map();
  // Yeni ilanlar: stok koduyla (İ/I farkı gözetmeden) ya da barkodla mevcut ürüne bağlanır; yoksa yeni ürün (kodsuzlar da) açılır
  const fresh = list.filter(v => !lm.has(shId(v.id)));
  const cand = new Map(); for (const v of fresh) { const sku = String(v.sku || '').trim(), bc = String(v.barcode || '').trim(); const fe = sku && fm.get(skuFold(sku)); cand.set(v.id, fe ? fe.key : (!sku && bc && bmap.has(bc)) ? bmap.get(bc) : sku ? skuKey(sku) : bc ? skuKey(bc) : 'shv-' + shId(v.id)); }
  const exist = new Set((await selectIn(env, 'SELECT key FROM products', 'key', [...new Set(cand.values())])).map(r => r.key));
  for (const v of fresh) {
    const pkey = cand.get(v.id), q = inv && Number.isFinite(Number(v.inventoryQuantity)) ? Math.max(0, Number(v.inventoryQuantity)) : 0;
    if (exist.has(pkey)) { matched++; st.push(env.DB.prepare(`UPDATE products SET channels=json_insert(channels,'$[#]','shopify'), image=CASE WHEN image='' THEN ?2 ELSE image END WHERE key=?1 AND NOT EXISTS(SELECT 1 FROM json_each(products.channels) WHERE value='shopify')`).bind(pkey, vimg(v))); }
    else if (!newKeys.has(pkey)) { added++; newKeys.set(pkey, q); st.push(...ensureProduct(env, pkey, { sku: String(v.sku || '').trim(), name: vname(v), barcode: String(v.barcode || '').trim(), image: vimg(v) }, 'shopify')); }
    else newKeys.set(pkey, newKeys.get(pkey) + q);
    st.push(env.DB.prepare(`INSERT OR IGNORE INTO listings(channel,ext,pkey,orig_pkey,factor,sku,barcode,name,image,ext_qty,passive,updated_at,inv_item) VALUES('shopify',?1,?2,?2,1,?3,?4,?5,?6,?7,?8,?9,?10)`).bind(shId(v.id), pkey, String(v.sku || ''), String(v.barcode || ''), vname(v), vimg(v), inv ? q : null, 0, iso(), (v.inventoryItem && v.inventoryItem.id) || null));
  }
  for (const [k, q] of newKeys) if (q > 0) st.push(...setQty(env, k, q, { type: 'count', channel: 'shopify', note: 'Shopify başlangıç stoğu' }));
  for (const v of list.filter(v => lm.has(shId(v.id)))) { linked++; st.push(env.DB.prepare(`UPDATE listings SET sku=?2, barcode=?3, name=?4, image=?5, ext_qty=COALESCE(?6, ext_qty), passive=?7, updated_at=?8, inv_item=COALESCE(?9, inv_item) WHERE channel='shopify' AND ext=?1`).bind(shId(v.id), String(v.sku || ''), String(v.barcode || ''), vname(v), vimg(v), inv && Number.isFinite(Number(v.inventoryQuantity)) ? Number(v.inventoryQuantity) : null, 0, iso(), (v.inventoryItem && v.inventoryItem.id) || null)); }
  if (st.length) { for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90)); }
  await env.DB.batch([followMergedStmt(env), followMergedStmt(env), followNameStmt(env, 'shopify'), REV(env)]);
  const noCode = list.filter(v => !String(v.sku || '').trim() && !String(v.barcode || '').trim());
  const res = { at: iso(), variants: list.length, added, matched, linked, noCode: noCode.length, inv };
  await setSetting(env, 'sh_prod', JSON.stringify(res));
  return res;
}
/* Ortak stok → Shopify: her Shopify ilanına bağlı ürünün stoğu (paket ilanında stok / paket adedi) mağazanın ana konumuna yazılır.
   Gerekli yetkiler: read_inventory, write_inventory, read_locations. Shopify'ın kendi satışı zaten kendi stoğunu düşürür; burada eşitlenir. */
const SH_PUSH_SQL = `SELECT l.ext, l.inv_item, t.q FROM listings l JOIN (SELECT l2.ext e, MIN(CASE WHEN COALESCE(p.mto,0)=1 THEN MAX(${SET_QTY_SQL('p')} / MAX(COALESCE(l2.factor,1),1), ${MTO_QTY}) ELSE MAX(${SET_QTY_SQL('p')} / MAX(COALESCE(l2.factor,1),1), 0) END, 1000000) q FROM listings l2 JOIN products p ON p.key=l2.pkey WHERE l2.channel='shopify') t ON t.e=l.ext WHERE l.channel='shopify' AND l.inv_item IS NOT NULL AND (l.ext_qty IS NULL OR (l.ext_qty <> t.q AND l.ext_qty <> -(t.q+2))) LIMIT 250`;
async function pushShopifyStock(env) {
  const s = await getSettings(env, ['sh_push', 'sh_paused', 'sh_loc']);
  if (s.sh_push === '0' || s.sh_paused === '1') return null;
  const c = await shCreds(env); if (!shConfigured(c)) return null;
  const { results } = await env.DB.prepare(SH_PUSH_SQL).all(); if (!results.length) return { sent: 0 };
  let loc = s.sh_loc;
  if (!loc) {
    try { const d = await shGql(env, c, `{locations(first:10){nodes{id isActive fulfillsOnlineOrders}}}`); const ls = d.locations.nodes.filter(x => x.isActive); const l0 = ls.find(x => x.fulfillsOnlineOrders) || ls[0]; if (l0) loc = l0.id; }
    catch (e) { // konum izni yoksa: ürünün stok kaydının bulunduğu konum
      const d = await shGql(env, c, `query($id:ID!){inventoryItem(id:$id){inventoryLevels(first:1){nodes{location{id}}}}}`, { id: results[0].inv_item });
      const n = d.inventoryItem && d.inventoryItem.inventoryLevels.nodes[0]; if (n && n.location) loc = n.location.id; else throw e; }
    if (!loc) throw new Error('Shopify konumu bulunamadı.'); await setSetting(env, 'sh_loc', loc); }
  const qs = results.map(r => ({ inventoryItemId: r.inv_item, locationId: loc, quantity: Number(r.q) || 0 }));
  const M1 = `mutation($q:[InventoryQuantityInput!]!){inventorySetQuantities(input:{name:"available",reason:"correction",ignoreCompareQuantity:true,quantities:$q}){userErrors{message field}}}`;
  const M2 = `mutation($q:[InventoryQuantityInput!]!){inventorySetQuantities(input:{name:"available",reason:"correction",quantities:$q}) @idempotent(key:"${crypto.randomUUID()}"){userErrors{message field}}}`;
  let d; try { d = await shGql(env, c, M1, { q: qs }); }
  catch (e) { d = await shGql(env, c, M2, { q: qs.map(x => ({ ...x, changeFromQuantity: null })) }); }
  const ue = (d.inventorySetQuantities && d.inventorySetQuantities.userErrors) || [];
  if (ue.length) { await setSetting(env, 'sh_push_err', iso() + ' · ' + ue.slice(0, 3).map(x => x.message).join(' · ').slice(0, 200)); if (ue.length >= qs.length) return { sent: 0, error: true }; }
  const st = results.map(r => env.DB.prepare(`UPDATE listings SET ext_qty=?2 WHERE channel='shopify' AND ext=?1`).bind(r.ext, Number(r.q) || 0));
  st.push(setStmt(env, 'sh_push_at', iso()), setStmt(env, 'sh_push_count', String(results.length)), ...(ue.length ? [] : [setStmt(env, 'sh_push_err', '')]), REV(env));
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  return { sent: results.length };
}
// Anlık bildirim: yeni sipariş, iptal ve iade olunca Shopify haber verir (imza Client secret ile doğrulanır)
async function ensureShopifyHooks(env, force) {
  const c = await shCreds(env); if (!shConfigured(c)) return null;
  const s = await getSettings(env, ['sh_hook_ok', 'sh_hook_try', 'self_origin']);
  if (!s.self_origin) return null;
  const url = s.self_origin + '/hook/shopify';
  if (!force && (s.sh_hook_ok === url || Date.now() - (Number(s.sh_hook_try) || 0) < 3600000)) return null;
  await setSetting(env, 'sh_hook_try', String(Date.now()));
  // Yeni API sürümlerinde adres alanı "uri"; eskilerde "callbackUrl" (ikisi de denenir)
  let mode = 'uri', d;
  try { d = await shGql(env, c, `{webhookSubscriptions(first:50){nodes{id topic uri}}}`); }
  catch (e) { mode = 'cb'; d = await shGql(env, c, `{webhookSubscriptions(first:50){nodes{id topic endpoint{__typename ... on WebhookHttpEndpoint{callbackUrl}}}}}`); }
  const have = new Set(d.webhookSubscriptions.nodes.filter(w => (mode === 'uri' ? w.uri : w.endpoint && w.endpoint.callbackUrl) === url).map(w => w.topic));
  for (const topic of ['ORDERS_CREATE', 'ORDERS_CANCELLED', 'ORDERS_EDITED', 'REFUNDS_CREATE']) {
    if (have.has(topic)) continue;
    const r = await shGql(env, c, `mutation($t:WebhookSubscriptionTopic!,$u:${mode === 'uri' ? 'String' : 'URL'}!){webhookSubscriptionCreate(topic:$t,webhookSubscription:{${mode === 'uri' ? 'uri' : 'callbackUrl'}:$u,format:JSON}){userErrors{message}}}`, { t: topic, u: url });
    const ue = r.webhookSubscriptionCreate.userErrors; if (ue && ue.length && !/already|taken|zaten/i.test(ue.map(e => e.message).join(' '))) throw new Error('Shopify bildirimi: ' + ue.map(e => e.message).join(' · '));
  }
  await setSetting(env, 'sh_hook_ok', url);
  return { ok: true };
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
    // Ücret iadesi yapılıp ürün müşteride bırakıldıysa (ör. kusurlu ürün talebinde "ürün müşteride kalsın"): talep iade kargosu olmadan,
    // açıldığı anda Trendyol tarafından (satıcı onayı değil) kabul edilmiş olarak gelir
    const noCargo = !c.cargoTrackingNumber && !c.cargoProviderName && !c.cargoTrackingLink;
    const instant = Number(c.claimDate) > 0 && Number(c.lastModifiedDate) > 0 && Math.abs(Number(c.lastModifiedDate) - Number(c.claimDate)) < 2 * 3600000;
    for (const it of (c.items || [])) {
      const ol = it.orderLine || {};
      for (const ci of (it.claimItems || [])) {
        const stName = (ci.claimItemStatus && ci.claimItemStatus.name) || '';
        const mapped = stName === 'Accepted' ? 'accepted' : (stName === 'Rejected' || stName === 'Cancelled') ? 'rejected' : 'requested';
        const reason = (ci.customerClaimItemReason && ci.customerClaimItemReason.name) || (ci.trendyolClaimItemReason && ci.trendyolClaimItemReason.name) || '';
        items.push({ autoAt: Number(ci.autoApproveDate) > 0 ? iso(Number(ci.autoApproveDate)) : null, desi, id: 'ty-' + safeSeg(String(ci.id)), itemId: String(ci.id), claimId, customer, amount: numOrNull(ol.price), reason, cnote: String(ci.customerNote || '').slice(0, 300), cargo: String(c.cargoProviderName || '').slice(0, 60), cargoLink: String(c.cargoTrackingLink || '').slice(0, 300), orderNo: String(c.orderNumber || ''), sku: ol.merchantSku || '', barcode: ol.barcode || '', name: ol.productName || '', ext: stName, mapped, autoAcc: ci.autoAccepted === true, kept: mapped === 'accepted' && noCargo && instant && ci.acceptedBySeller !== true && !UNDELIVERED_RE.test(reason.toLocaleLowerCase('tr-TR')) && !isMissing(reason, ci.customerNote), claimDate: c.claimDate ? iso(Number(c.claimDate)) : iso(), note: reason });
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
  const lmc = await listingMap(env, 'trendyol', items.map(x => x.barcode)); // iade, ilanın bağlı olduğu ürüne (paket ilanında paket adedi kadar) döner
  const existing = new Map((await selectIn(env, 'SELECT id, status, ext_status, claim_id, desi, auto_at, kept, order_no, pkey, qty FROM returns', 'id', items.map(x => x.id))).map(r => [r.id, r]));
  const meta = (it) => [it.claimId, it.itemId, it.customer, it.amount, it.reason, it.cnote, it.cargo, it.cargoLink, it.desi, it.autoAt];
  for (const it of items) {
    const le = lmc.get(String(it.barcode || '')), fq = le ? le.factor : 1;
    const r = le && le.pkey ? { pkey: le.pkey, sku: le.sku || null } : resolveLine(it, bmap); if (!r) continue;
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
        stmts.push(env.DB.prepare(`INSERT INTO returns(id,channel,order_no,order_id,line_key,pkey,sku,name,qty,status,source,note,ext_status,created_at,decided_at,ext_at,claim_id,item_id,customer,amount,reason,cnote,cargo,cargo_link,desi,auto_at,kept) VALUES(?1,'trendyol',?2,?3,'',?4,?5,?6,?24,?7,'trendyol',?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)`)
          .bind(it.id, it.orderNo, orderId('trendyol', it.orderNo), r.pkey, sku, it.name, it.kept ? 'accepted' : finalStatus, preStart && finalStatus === 'accepted' ? 'Başlangıç öncesi; stok değişmedi' : it.note, it.ext, it.claimDate, finalStatus !== 'requested' || it.kept ? now2 : null, now2, ...meta(it), it.kept ? 1 : null, fq));
        if (finalStatus === 'accepted' && !preStart && !it.kept) { stmts.push(...retStock(env, it.id, r.pkey, fq, needsInspect(it.reason, it.cnote, it.note), { type: 'ret', channel: 'trendyol', ref: it.orderNo, note: isMissing(it.reason, it.cnote) ? 'Eksik gönderilmiş: ürün depoda kalmıştı, stoğa eklendi' : 'Trendyol iadesi kabul edildi' })); accepted++; }
        stmts.push(REV(env)); await env.DB.batch(stmts); added++;
        continue;
      }
      if (it.kept && (ex.kept === null || ex.kept === undefined)) {
        // Ürün müşteride kaldı: kabul edilmiş say, stoğa eklendiyse geri al (bir kez; elle değiştirildiyse dokunulmaz)
        const mv = ex.status === 'accepted' ? await env.DB.prepare(`SELECT COALESCE(SUM(delta),0) n FROM moves WHERE ref=?1 AND pkey=?2 AND (type='ret' OR note LIKE 'Ürün müşteride kaldı%')`).bind(ex.order_no, ex.pkey).first() : null;
        const added = Number(mv && mv.n) || 0;
        stmts.push(env.DB.prepare(`UPDATE returns SET kept=1, status='accepted', ext_status=?2, decided_at=COALESCE(decided_at, ?3), ext_at=?3 WHERE id=?1`).bind(ex.id, it.ext, now2));
        if (added > 0) stmts.push(...changeQty(env, ex.pkey, -Math.min(added, ex.qty || 1), { type: 'adjust', channel: 'trendyol', ref: ex.order_no, note: 'Ürün müşteride kaldı; iade stoğu geri alındı' }));
        stmts.push(REV(env)); await env.DB.batch(stmts); continue;
      }
      // Trendyol ayrıntıları (müşteri, tutar, sebep, kargo) eski kayıtlara bir kez eklenir
      if (!ex.claim_id || ex.claim_id === '-') stmts.push(env.DB.prepare(`UPDATE returns SET claim_id=?2, item_id=?3, customer=?4, amount=?5, reason=?6, cnote=?7, cargo=?8, cargo_link=?9, desi=?10, auto_at=?11 WHERE id=?1`).bind(it.id, ...meta(it)));
      else if ((it.desi && Number(ex.desi) !== it.desi) || (it.autoAt || null) !== (ex.auto_at || null)) stmts.push(env.DB.prepare(`UPDATE returns SET desi=COALESCE(?2, desi), auto_at=?3 WHERE id=?1`).bind(it.id, it.desi, it.autoAt));
      if (ex.status === 'requested' && (it.mapped !== 'requested' || ex.ext_status !== it.ext)) {
        if (it.mapped === 'accepted' && auto && !it.autoAcc) {
          stmts.push(guardStmt(env, `(SELECT status FROM returns WHERE id=?1)='requested'`, it.id),
            env.DB.prepare(`UPDATE returns SET status='accepted', ext_status=?2, decided_at=?3, ext_at=?3 WHERE id=?1`).bind(it.id, it.ext, now2),
            ...(ex.kept ? [] : retStock(env, ex.id, ex.pkey || r.pkey, Number(ex.qty) || fq, needsInspect(ex.reason, ex.cnote, ex.note, it.reason, it.cnote), { type: 'ret', channel: 'trendyol', ref: it.orderNo, note: 'Trendyol iadesi kabul edildi' })), unguard(env));
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
// Geçmişte (Trendyol panelinden de) verilmiş cevaplar: yapay zekâ mağaza sahibinin üslubunu ve kararlarını bunlardan öğrenir.
// İlk seferde geriye doğru sayfa sayfa okunur (her turda en fazla 4 sayfa), sonra yalnızca yeni cevaplananlar.
async function syncQnaHistory(env, maxPages = 4) {
  const sid = env.TRENDYOL_SELLER_ID; if (!sid) return null; const s0 = await getSettings(env, ['qna_hist_page', 'qna_hist_done']); const done = s0.qna_hist_done === '1';
  let page = done ? 0 : Number(s0.qna_hist_page) || 0, n = 0, end = false;
  for (let i = 0; i < maxPages; i++, page++) { let r;
    try { r = await ty(env, `qna/sellers/${sid}/questions/filter`, { status: 'ANSWERED', page, size: 50, orderByField: 'CreatedDate', orderByDirection: 'DESC' }); } catch (e) { if (e.status === 400) { end = true; break; } throw e; }
    const list = (r.content || []).filter(q => q && q.id && q.answer && (q.answer.text || '').trim());
    const st = list.map(q => env.DB.prepare(`INSERT INTO qna(id, main_id, product_name, image, web_url, text, created_at, status, answer, answered_at, updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'answered_elsewhere',?8,?9,?10)
      ON CONFLICT(id) DO UPDATE SET answer=COALESCE(NULLIF(qna.answer,''), excluded.answer), answered_at=COALESCE(qna.answered_at, excluded.answered_at), status=CASE WHEN qna.status IN ('waiting','sent_failed') THEN 'answered_elsewhere' ELSE qna.status END`)
      .bind(String(q.id), String(q.productMainId || ''), q.productName || '', q.imageUrl || '', q.webUrl || '', String(q.text || ''), iso(Number(q.creationDate) || Date.now()), String(q.answer.text).slice(0, 2000), iso(Number(q.answer.creationDate) || Number(q.creationDate) || Date.now()), iso()));
    for (let k = 0; k < st.length; k += 50) await env.DB.batch(st.slice(k, k + 50)); n += list.length;
    if (!(r.content || []).length || page + 1 >= (r.totalPages || 1)) { end = true; break; } if (done) break; }
  await env.DB.batch([setStmt(env, 'qna_hist_page', String(end ? 0 : page)), ...(end && !done ? [setStmt(env, 'qna_hist_done', '1')] : []), setStmt(env, 'qna_hist_at', iso())]);
  return { n, done: done || end };
}
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
  const [pi, prev, gen, hist] = await Promise.all([
    q.main_id ? env.DB.prepare('SELECT * FROM product_info WHERE main_id=?1').bind(q.main_id).first() : null,
    env.DB.prepare(`SELECT text, answer FROM qna WHERE main_id=?1 AND id<>?2 AND answer IS NOT NULL AND answer<>'' ORDER BY answered_at DESC LIMIT 6`).bind(q.main_id || '-', q.id).all(),
    getSetting(env, 'qa_general'),
    // Mağaza sahibinin son cevapları (her üründe): üslubunu ve karar mantığını öğrenmek için; taslağı düzelttiyse taslak → gönderilen
    env.DB.prepare(`SELECT product_name, text, answer, sent_draft FROM qna WHERE id<>?1 AND (main_id IS NULL OR main_id<>?2) AND status IN ('answered','answered_elsewhere') AND answer IS NOT NULL AND answer<>'' ORDER BY answered_at DESC LIMIT 20`).bind(q.id, q.main_id || '-').all()]);
  const parts = [`ÜRÜN: ${(pi && pi.title) || q.product_name || '-'}`];
  if (pi && pi.attrs) parts.push(`ÖZELLİKLER:\n${pi.attrs}`);
  if (pi && pi.descr) parts.push(`ÜRÜN AÇIKLAMASI:\n${pi.descr.slice(0, 3500)}`);
  if (pi && pi.note) parts.push(`MAĞAZA SAHİBİNİN BU ÜRÜN İÇİN NOTU (en güvenilir bilgi):\n${pi.note}`);
  if (gen) parts.push(`MAĞAZANIN GENEL BİLGİLERİ (kargo, iade vb.):\n${gen}`);
  if (prev.results.length) parts.push(`BU ÜRÜNE DAHA ÖNCE VERİLEN CEVAPLAR (üslup ve bilgi için örnek):\n${prev.results.map(x => `S: ${x.text}\nC: ${x.answer}`).join('\n---\n')}`);
  const H = hist.results || [], edited = H.filter(x => x.sent_draft && x.sent_draft.trim() !== x.answer.trim());
  if (H.length) parts.push(`MAĞAZA SAHİBİNİN SON CEVAPLARI (başka ürünler). Bunlardan onun üslubunu ve karar mantığını öğren: hangi durumda ne öneriyor (iade, değişim, ölçü, adet, kargo, iptal), neyi söylüyor, neyi söylemiyor. Benzer soruda onun vereceği kararı ver:\n${H.map(x => `Ürün: ${(x.product_name || '').slice(0, 80)}\nS: ${x.text}\nC: ${x.answer}`).join('\n---\n')}`);
  if (edited.length) parts.push(`MAĞAZA SAHİBİNİN SENİN TASLAKLARINDA YAPTIĞI DÜZELTMELER (en önemli kısım; aynı hataları tekrarlama, onun düzelttiği gibi yaz):\n${edited.slice(0, 8).map(x => `S: ${x.text}\nSenin taslağın: ${x.sent_draft}\nOnun gönderdiği: ${x.answer}`).join('\n---\n')}`);
  parts.push(`MÜŞTERİNİN SORUSU:\n${q.text}`);
  if (hint) parts.push(`MAĞAZA SAHİBİNİN İSTEĞİ (taslağı buna göre yaz): ${String(hint).slice(0, 300)}`);
  const model = (await getSetting(env, 'qa_model')) || 'claude-haiku-5-5';
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 700, system: QA_SYSTEM, messages: [{ role: 'user', content: parts.join('\n\n') }] }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const msg = (data.error && data.error.message) || ('Yapay zekâ hatası ' + r.status); await env.DB.prepare('UPDATE qna SET draft_err=?2 WHERE id=?1').bind(q.id, msg.slice(0, 200)).run(); throw new Error(msg); }
  let text = ((data.content || []).filter(c => c.type === 'text').map(c => c.text).join('') || '').trim();
  const flag = /^\[KONTROL\]/i.test(text) ? 1 : 0; text = text.replace(/^\[KONTROL\]\s*/i, '').trim().slice(0, 2000);
  const learned = (prev.results || []).length + H.length;
  await env.DB.prepare('UPDATE qna SET draft=?2, draft_flag=?3, draft_at=?4, draft_err=NULL, draft_n=?5 WHERE id=?1').bind(q.id, text, flag, iso(), learned).run();
  return { draft: text, flag: !!flag, learned, edits: edited.length };
}
async function draftPendingQna(env, max = 4) {
  if (!env.ANTHROPIC_API_KEY) return { n: 0 };
  const { results } = await env.DB.prepare(`SELECT id FROM qna WHERE status='waiting' AND (draft IS NULL OR draft='') AND (draft_err IS NULL) ORDER BY created_at LIMIT ?1`).bind(max).all();
  let n = 0; for (const x of results) { try { await draftQna(env, x.id); n++; } catch (e) {} }
  return { n };
}
// Trendyol ilanları (barkod) önce bağlı oldukları Lilya ürününe yazılır; stok kodu değişse de ürün değişmez.
// Bilinmeyen barkod: stok koduyla (İ/I farkı gözetmeden) mevcut ürüne bağlanır, yoksa yeni ürün açılır.
async function syncTyListings(env, items, useStock) {
  const withBc = items.filter(x => x.barcode);
  const lm = await listingMap(env, 'trendyol', withBc.map(x => x.barcode));
  // Pasif (arşivlenmiş / kara listedeki) ilanlar entegre edilmez: yeni ürün açılmaz; satışa dönünce eklenir
  const known = withBc.filter(x => lm.has(String(x.barcode))), fresh = items.filter(x => (!x.barcode || !lm.has(String(x.barcode))) && !x.passive);
  let created = 0, updated = 0;
  if (fresh.length) {
    const fm = await skuFoldMap(env);
    for (const x of fresh) { const e = x.sku && fm.get(skuFold(x.sku)); if (e) x.sku = e.sku; }
    const st = await ingestProducts(env, 'trendyol', fresh, { useStock, tyQty: true }); created += st.created; updated += st.updated;
    const bmap = await barcodeMap(env, fresh.filter(x => !String(x.sku || '').trim()).map(x => String(x.barcode || '').trim()));
    const ins = fresh.filter(x => x.barcode).map(x => { const r = resolveLine({ sku: x.sku, barcode: x.barcode }, bmap); return r ? env.DB.prepare(`INSERT OR IGNORE INTO listings(channel,ext,pkey,orig_pkey,factor,sku,barcode,name,image,ext_qty,passive,updated_at) VALUES('trendyol',?1,?2,?2,1,?3,?1,?4,?5,?6,?7,?8)`).bind(String(x.barcode), r.pkey, x.sku || '', x.name || '', x.image || '', x.stock, x.passive ? 1 : 0, iso()) : null; }).filter(Boolean);
    for (let j = 0; j < ins.length; j += 90) await env.DB.batch(ins.slice(j, j + 90));
  }
  const st = [];
  for (const x of known) { const e = lm.get(String(x.barcode));
    st.push(env.DB.prepare(`UPDATE listings SET sku=?2, name=?3, image=?4, ext_qty=COALESCE(?5, ext_qty), passive=?6, updated_at=?7 WHERE channel='trendyol' AND ext=?1`).bind(String(x.barcode), x.sku || '', x.name || '', x.image || '', x.stock, x.passive ? 1 : 0, iso()));
    if (e.factor === 1 && (x.price !== null || x.comm !== null)) st.push(env.DB.prepare('UPDATE products SET ty_price=COALESCE(?1,ty_price), ty_comm=COALESCE(?2,ty_comm), ty_vat=COALESCE(?3,ty_vat), image=CASE WHEN image=\'\' THEN ?5 ELSE image END WHERE key=?4').bind(x.price, x.comm, x.vat, e.pkey, x.image || ''));
  }
  // Ürün pasif: bağlı bütün Trendyol ilanları pasifse (biri satıştaysa ürün aktif)
  const keys = [...new Set([...known.map(x => lm.get(String(x.barcode)).pkey), ...fresh.map(x => skuKey(x.sku || x.barcode))])];
  for (let j = 0; j < keys.length; j += 80) { const part = keys.slice(j, j + 80);
    st.push(env.DB.prepare(`UPDATE products SET ty_passive = CASE WHEN EXISTS(SELECT 1 FROM listings l WHERE l.pkey=products.key AND l.channel='trendyol' AND COALESCE(l.passive,0)=0) THEN 0 ELSE 1 END WHERE key IN (${part.map((_, i) => '?' + (i + 1)).join(',')}) AND EXISTS(SELECT 1 FROM listings l WHERE l.pkey=products.key AND l.channel='trendyol')`).bind(...part)); }
  for (let j = 0; j < st.length; j += 90) await env.DB.batch(st.slice(j, j + 90));
  await env.DB.batch([followMergedStmt(env), followNameStmt(env, 'trendyol'), REV(env)]);
  return { created, updated };
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
    if (items.length) { const st = await syncTyListings(env, items, useStock); stats.created += st.created; stats.updated += st.updated; }
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
// Her Trendyol ilanına bağlı ürünün stoğu gider; paket ilanında stok / paket adedi (ör. 7 adet stok, 2'li ilan → 3)
const TY_PUSH_SQL = `SELECT l.ext barcode, t.q FROM listings l JOIN (SELECT l2.ext e, MIN(CASE WHEN COALESCE(p.mto,0)=1 THEN MAX(${SET_QTY_SQL('p')} / MAX(COALESCE(l2.factor,1),1), ${MTO_QTY}) ELSE MAX(${SET_QTY_SQL('p')} / MAX(COALESCE(l2.factor,1),1), 0) END, 20000) q FROM listings l2 JOIN products p ON p.key=l2.pkey WHERE l2.channel='trendyol') t ON t.e=l.ext WHERE l.channel='trendyol' AND COALESCE(l.passive,0)=0 AND (l.ext_qty IS NULL OR (l.ext_qty <> t.q AND l.ext_qty <> -(t.q+2))) LIMIT 1000`;
async function pushTrendyolStock(env) {
  if ((await getSetting(env, 'ty_push')) === '0') return null;
  const { results } = await env.DB.prepare(TY_PUSH_SQL).all();
  if (!results.length) return { sent: 0 };
  const items = results.map(r => ({ barcode: r.barcode, quantity: Math.min(Math.max(Number(r.q) || 0, 0), 20000) }));
  const url = `${TY_BASE}inventory/sellers/${env.TRENDYOL_SELLER_ID}/products/price-and-inventory`;
  const res = await fetch(url, { method: 'POST', headers: { ...tyHeaders(env), 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
  const text = await res.text();
  if (!res.ok) {
    await setSetting(env, 'ty_push_err', iso() + ' · Trendyol stok güncellemesi reddedildi (' + res.status + '): ' + text.slice(0, 200));
    return { sent: 0, error: res.status };
  }
  let batchId = ''; try { batchId = JSON.parse(text).batchRequestId || ''; } catch (e) {}
  const now = iso(); const st = results.map((r, i) => env.DB.prepare(`UPDATE listings SET ext_qty=?1 WHERE channel='trendyol' AND ext=?2`).bind(items[i].quantity, r.barcode));
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
  if (failed.length) await env.DB.batch(failed.map(x => env.DB.prepare(`UPDATE listings SET ext_qty=-(ext_qty+2) WHERE channel='trendyol' AND ext=?1 AND ext_qty>=0`).bind((x.requestItem && x.requestItem.barcode) || '')));
  await env.DB.batch([setStmt(env, 'ty_push_fail', msg), setStmt(env, 'ty_push_batch', '')]);
  return { failed: failed.length };
}
// Kayıp/hasarlı kargo tazmini: Trendyol satıcıya öder (gelir). Ceza faturalarındaki "tazmin bedelidir" ifadesi bunu tetiklemez.
function isCompensation(t) { const s = String(t || '').toLocaleLowerCase('tr-TR'); return /tazmin/.test(s) && !/yanlış|eksik|kusur|hasarlı ürün|ayıplı|tedarik|ceza/.test(s); }
const ESTIMATED_PEN_RE = /yanlış ürün|eksik ürün|kusurlu|hasarlı|ayıplı|tedarik/;
const AUTO_ACC_NOTE = 'Trendyol otomatik onayladı; ürün depoya ulaşınca stoğa eklemek için onayla';
// Eksik gönderim: ürün hiç kargoya çıkmadı, depoda duruyor; iade kabul edilince stoğa eklenir, 'müşteride kaldı' sayılmaz, dönüş kargosu ve ürün zararı yok
const MISSING_RE = /eksik ürün|eksik gönderil|ürün eksik|eksik geldi|ürün gelmedi|paketten çıkmadı|pakette yok/;
const isMissing = (...t) => MISSING_RE.test(t.filter(Boolean).join(' ').toLocaleLowerCase('tr-TR'));
// Kusurlu iade: kabul edilince stoğa eklenmez, "Kusurlu iadeler" panelinde sağlam/kırık kontrolüne düşer
const INSPECT_RE = /kusurlu|hasarl[ıi]|defolu|ay[ıi]pl[ıi]|bozuk|k[ıi]r[ıi]k|[çc]al[ıi][şs]m[ıi]yor|çizik|yırtık|eksik parça|parça eksik/;
const needsInspect = (...t) => INSPECT_RE.test(t.filter(Boolean).join(' ').toLocaleLowerCase('tr-TR'));
function retStock(env, id, key, qty, defect, m) {
  defect = false; // iadeler sebep ne olursa olsun stoğa girer; kusurlu ürün 'Kusurlu ürün düş' panelinden düşülür
  if (defect) return [env.DB.prepare(`UPDATE returns SET inspect='pending', insp_ok=NULL, insp_at=NULL WHERE id=?1`).bind(id)];
  return changeQty(env, key, qty, m);
}
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
  const s = await getSettings(env, ['fin_at', 'cargo_inv_done', 'desi_learned', 'inv_detail_tried']);
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
  // Hizmet bedeli / ceza faturalarının sipariş satırları: kargo faturasıyla aynı uç nokta deneniyor (Trendyol belgelemiyor).
  // Satır gelirse sipariş bazında gerçek tutar yazılır; gelmezse fatura toplu kesinti olarak kalır. Her fatura bir kez denenir.
  const detTried = new Set(JSON.parse(s.inv_detail_tried || '[]')); const svcDet = new Map(); const detDel = [];
  stat.detail = { tried: 0, ok: 0, lines: 0 };
  const tryInvoiceDetail = async (x, t) => {
    const id = String(x.id); detTried.add(id); stat.detail.tried++;
    const lines = [];
    try {
      for (let p2 = 0; p2 < 10; p2++) {
        const it = await ty(env, `finance/che/sellers/${sid}/cargo-invoice/${encodeURIComponent(id)}/items`, { page: p2, size: 500 });
        for (const c of (it.content || [])) if (c.orderNumber && Number(c.amount)) lines.push({ no: String(c.orderNumber), amt: Math.abs(Number(c.amount)) });
        if (p2 + 1 >= (it.totalPages || 0)) break;
      }
    } catch (e) { stat.detail.err = String(e.message || e).slice(0, 90); return false; }
    if (!lines.length) return false;
    stat.detail.ok++; stat.detail.lines += lines.length;
    if (/platform hizmet|hizmet bedeli/i.test(t)) { for (const l of lines) svcDet.set(l.no, (svcDet.get(l.no) || 0) + l.amt); }
    else {
      const by = new Map(); for (const l of lines) by.set(l.no, (by.get(l.no) || 0) + l.amt);
      for (const [no, amt] of by) misc.push({ id: (id + '|' + no).slice(0, 120), no, date: x.transactionDate ? iso(Number(x.transactionDate)) : iso(), type: String(x.transactionType || 'Kesinti').slice(0, 80), amt: Math.round(amt * 100) / 100, descr: String(x.description || '').slice(0, 160) });
      detDel.push(id); // aynı faturanın toplu kaydı silinir (çift sayılmasın)
    }
    return true;
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
          const invS = { id: String(x.id).slice(0, 40), date: x.transactionDate ? iso(Number(x.transactionDate)).slice(0, 10) : null, debt: Math.round((Number(x.debt) || 0) * 100) / 100, items: 0, sum: 0, nos: [] };
          (stat.invs = stat.invs || []).push(invS);
          for (let p2 = 0; p2 < 20; p2++) {
            const it = await ty(env, `finance/che/sellers/${sid}/cargo-invoice/${encodeURIComponent(x.id)}/items`, { page: p2, size: 500 });
            for (const c of (it.content || [])) {
              const isRet = String(c.shipmentPackageType || '').toLocaleLowerCase('tr-TR').includes('iade');
              stat.cargoItems++; if (isRet) stat.retItems++;
              invS.items++; invS.sum += Number(c.amount) || 0; if (c.orderNumber) invS.nos.push(String(c.orderNumber));
              if (c.orderNumber) { const a = get(String(c.orderNumber)); if (isRet) { a.retCargo = (a.retCargo || 0) + (Number(c.amount) || 0); if (Number(c.desi) > 0) a.retDesi = Math.max(a.retDesi || 0, Number(c.desi)); } else a.cargo = (a.cargo || 0) + (Number(c.amount) || 0); }
              const d = Math.ceil(Number(c.desi) || 0), amt = Number(c.amount) || 0;
              if (d > 0 && amt > 0 && !isRet) { (learned[d] = learned[d] || []).push(amt); }
            }
            if (p2 + 1 >= (it.totalPages || 0)) break;
          }
          await flushCargo(String(x.id)); cargoInv++;
        } else if ((/platform hizmet|hizmet bedeli/i.test(t) || /kusurlu|yanl[ıi]ş|eksik|tedarik|ceza/i.test(t)) && x.id && !detTried.has(String(x.id)) && !(deadline && Date.now() > deadline - 5000) && await tryInvoiceDetail(x, t)) {
          /* fatura satırları siparişlere dağıtıldı */
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
  for (const [no, v] of svcDet) { const a = get(no); a.service = Math.round(((a.service || 0) + v) * 100) / 100; }
  if (detDel.length) await env.DB.batch(detDel.map(id => env.DB.prepare('DELETE FROM fin_misc WHERE id=?1').bind(id)));
  await setSetting(env, 'inv_detail_tried', JSON.stringify([...detTried].slice(-400)));
  // Teşhis: her kargo faturası için satır sayısı, toplam, sipariş numarası aralığı ve bizim siparişlerle eşleşme
  if (stat.invs && stat.invs.length) {
    const all = [...new Set(stat.invs.flatMap(v => v.nos))];
    const m = new Map((await selectIn(env, 'SELECT order_no, date FROM orders', 'order_no', all)).map(x => [x.order_no, x.date]));
    const invs = stat.invs.map(v => { const ns = [...new Set(v.nos)].sort(); const md = ns.filter(n => m.has(n)).map(n => m.get(n)).sort();
      return { id: v.id, date: v.date, debt: v.debt, items: v.items, sum: Math.round(v.sum * 100) / 100, nos: ns.length, matched: md.length, lo: ns[0] || null, hi: ns[ns.length - 1] || null, from: md[0] || null, to: md[md.length - 1] || null }; });
    stat.cargoCheck = { at: iso(), inv: cargoInv, items: stat.cargoItems, ret: stat.retItems, nos: all.length, matched: invs.reduce((a, v) => a + v.matched, 0), invs };
    await setSetting(env, 'fin_cargo_check', JSON.stringify(stat.cargoCheck));
  }
  delete stat.invs;
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
let SELF_ORIGIN = null;
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
    const due = await getSettings(env, ['run_prod_at', 'run_fin_at', 'run_bf_at', 'run_qna_at', 'run_sr_at', 'run_tys_at']); const now = Date.now();
    const lvl = (GUARD_CACHE && GUARD_CACHE.v && GUARD_CACHE.v.level) || 0, mult = lvl >= 2 ? 6 : lvl === 1 ? 3 : 1;
    const isDue = (k, ms) => now - (Number(due[k]) || 0) >= ms * mult;
    const ok = (need) => qLeft(env) > need;
    // Sıra önemli: seyrek ama kritik işler (kesintiler = gerçek kâr, ürün listesi) önce; sık ve küçük işler kalan sürede
    if (left() > 28000 && ok(350) && isDue('run_fin_at', 5 * 60000)) { await setSetting(env, 'run_fin_at', String(now)); await step('finance', () => syncTrendyolFinance(env, false, Math.min(budget ? budget - 15000 : Infinity, Date.now() + 20000)), 'fin_err'); if (result.finance && !result.steps.financeErr) await setSetting(env, 'fin_err', ''); }
    if (left() > 20000 && ok(350) && isDue('run_prod_at', 5 * 60000)) { await setSetting(env, 'run_prod_at', String(now)); await step('products', () => syncTrendyolProducts(env, 1)); }
    if (left() > 15000 && ok(300) && isDue('run_bf_at', 3 * 60000)) { await setSetting(env, 'run_bf_at', String(now)); await step('backfill', () => backfillTrendyolOrders(env), 'fin_err'); }
    if (left() > 8000 && ok(40)) await step('hook', () => ensureTyWebhook(env, false));
    if (left() > 8000 && ok(40)) await step('shPush', async () => { try { return await pushShopifyStock(env); } catch (e) { await setSetting(env, 'sh_push_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); throw e; } });
    // Shopify: bildirim kaçarsa diye 2 dakikada bir kontrol
    if (left() > 10000 && ok(120)) { const sd = await getSettings(env, ['run_sh_at', 'sh_cid']); if ((sd.sh_cid || env.SHOPIFY_CLIENT_ID) && now - (Number(sd.run_sh_at) || 0) >= 2 * 60000 * mult) { await setSetting(env, 'run_sh_at', String(now)); await step('shopify', async () => { try { const r = await syncShopifyOrders(env); if (left() > 15000) { try { await shPayBackfill(env, 3); } catch (e) { await setSetting(env, 'sh_pay_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); } } try { const pa2 = Number(await getSetting(env, 'run_pt_at')) || 0; if (now - pa2 > 3 * 3600000 && left() > 15000) { await setSetting(env, 'run_pt_at', String(now)); await ptSync(env, 4); } } catch (e) { await setSetting(env, 'pt_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); } const pa = await getSetting(env, 'run_shp_at'); if (now - (Number(pa) || 0) > 6 * 3600000 && left() > 20000) { await setSetting(env, 'run_shp_at', String(now)); try { await syncShopifyProducts(env); } catch (e) {} } try { await ensureShopifyHooks(env, false); } catch (e) { await setSetting(env, 'sh_hook_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); } return r; } catch (e) { await setSetting(env, 'sh_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); throw e; } }); } }
    // Sürat: şube okuttuysa takip numarası alınıp Shopify'a işlenir (müşteriye bildirim) — 30 dakikada bir
    if (left() > 12000 && ok(80) && isDue('run_sr_at', 30 * 60000)) { await setSetting(env, 'run_sr_at', String(now)); await step('surat', () => srTrackPending(env), 'sr_track_err'); }
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
    if ((env.__poll || 0) % 3 === 0) { await step('qna', async () => { const r = await syncTrendyolQna(env); try { const h = await getSetting(env, 'qna_hist_at'); if (!h || Date.now() - Date.parse(h) > ((await getSetting(env, 'qna_hist_done')) === '1' ? 3 * 3600000 : 60000)) r.hist = await syncQnaHistory(env); } catch (e) {} return r; }, 'qna_err'); if (result.qna && !result.steps.qnaErr && !env.__poll) await setSetting(env, 'qna_err', ''); }
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
  const s = await getSettings(env, ['fee_cargo_t1', 'fee_cargo_t2', 'fee_cargo_t3', 'cargo_desi_mode', 'desi_table', 'desi_tables', 'desi_learned', 'fee_service_ty', 'fee_cargo_sh', 'fee_sh_comm', 'sr_sms_fee', 'sr_sms_until', 'fee_pack_order_sh', 'fee_pack_unit_sh', 'fee_pack_order', 'fee_pack_unit', 'stopaj', 'fee_service_fast', 'service_cutoff', 'barem_max_desi']);
  const manual = parseDesiTable(s.desi_table), learned = learnedTable(s.desi_learned);
  // elle girilen satırlar öncelikli; eksik desiler faturalardan öğrenilenle tamamlanır
  const merged = [...manual]; for (const x of learned) if (!merged.some(m => m.desi === x.desi)) merged.push(x);
  merged.sort((a, b) => a.desi - b.desi);
  if (merged.length && manual.length && manual[manual.length - 1].extra && merged[merged.length - 1] !== manual[manual.length - 1]) merged[merged.length - 1] = { ...merged[merged.length - 1], extra: manual[manual.length - 1].extra };
  return { srSms: Number(s.sr_sms_fee ?? 3.07), srSmsUntil: s.sr_sms_until || '', shComm: Number(s.fee_sh_comm ?? 3), packOrderSh: Number(s.fee_pack_order_sh ?? 4), packUnitSh: Number(s.fee_pack_unit_sh ?? 1), packOrder: Number(s.fee_pack_order ?? 2), packUnit: Number(s.fee_pack_unit ?? 1), serviceFast: Number(s.fee_service_fast ?? 5.99), serviceCutoff: Number(s.service_cutoff ?? 15), baremMaxDesi: Number(s.barem_max_desi ?? 10), cargoT1: Number(s.fee_cargo_t1 ?? 46.49), cargoT2: Number(s.fee_cargo_t2 ?? 84.49), cargoT3: Number(s.fee_cargo_t3 ?? 98.35), desiMode: s.cargo_desi_mode === '1', desiTables: parseDesiTables(s.desi_tables), desiTable: merged, desiManual: manual, desiLearned: learned, packOrder: Number(s.fee_pack_order ?? 2), packUnit: Number(s.fee_pack_unit ?? 1), serviceTy: Number(s.fee_service_ty ?? 13.19), serviceFast: Number(s.fee_service_fast ?? 5.99), serviceCutoff: Number(s.service_cutoff ?? 15), baremMaxDesi: Number(s.barem_max_desi ?? 10), cargoSh: Number(s.fee_cargo_sh ?? 0), stopaj: Number(s.stopaj ?? 1) };
}
// Raporların başlangıç tarihi (Türkiye günü, YYYY-AA-GG): öncesindeki siparişler kâr/rapor hesabına girmez, silinmez
let RS_CACHE = { v: null, at: 0 };
async function reportStart(env) { if (Date.now() - RS_CACHE.at > 60000) { RS_CACHE = { v: (await getSetting(env, 'report_start')) || '', at: Date.now() }; } return RS_CACHE.v; }
async function computeProfit(env, from, to, ch0) {
  { const rs = await reportStart(env); if (/^\d{4}-\d{2}-\d{2}$/.test(rs || '')) { const a = iso(dayStartTR(rs)); if (from < a) from = a; if (to < from) to = from; } }
  const T0 = Date.now(), TM = {}; const mark = (k) => { TM[k] = Date.now() - T0; };
  // Tüm okumalar tek gidiş-dönüşte (veritabanına her sorgu ayrı yolculuk demek)
  const dayFrom = trDay(Date.parse(from)), dayTo = trDay(Date.parse(to) - 1);
  const SUBQ = `SELECT order_no FROM orders WHERE channel='trendyol' AND date >= ?1 AND date < ?2`;
  const [fee, [o, p, r, finR, custR, miscR, miscAllR, adR, adAnyR, expR, bkR, spR, scR, ptR, srtR]] = await Promise.all([loadFees(env), env.DB.batch([
    env.DB.prepare('SELECT * FROM orders WHERE date >= ?1 AND date < ?2 ORDER BY date DESC').bind(from, to),
    env.DB.prepare(`SELECT key, sku, name, image, CASE WHEN EXISTS(SELECT 1 FROM bundles b WHERE b.pkey=products.key) THEN (SELECT CASE WHEN SUM(cp.cost IS NULL) > 0 THEN NULL ELSE SUM(cp.cost * b.n) END FROM bundles b JOIN products cp ON cp.key=b.comp WHERE b.pkey=products.key) ELSE cost END cost, barcode, same_day, desi FROM products`),
    env.DB.prepare(`SELECT order_id, pkey, status, ext_status, qty, note, kept, inspect, insp_ok FROM returns WHERE order_id<>'' AND status<>'rejected'`),
    env.DB.prepare(`SELECT * FROM order_fin WHERE order_no IN (${SUBQ})`).bind(from, to),
    env.DB.prepare(`SELECT order_no, json_extract(data,'$.name') n FROM order_cust WHERE order_no IN (${SUBQ})`).bind(from, to),
    env.DB.prepare(`SELECT order_no, type, amount FROM fin_misc WHERE order_no IN (${SUBQ})`).bind(from, to),
    env.DB.prepare('SELECT type, SUM(amount) amount, COUNT(*) n FROM fin_misc WHERE (order_no IS NULL OR type LIKE ?3) AND date >= ?1 AND date < ?2 GROUP BY type ORDER BY 2 DESC').bind(from, to, '%azmin%'),
    env.DB.prepare('SELECT day, channel, amount, source FROM ad_spend WHERE day >= ?1 AND day <= ?2 ORDER BY day DESC').bind(dayFrom, dayTo),
    env.DB.prepare('SELECT COUNT(*) n FROM ad_spend'),
    env.DB.prepare('SELECT id, day, name, amount, created_at, kind FROM expenses WHERE day >= ?1 AND day <= ?2 ORDER BY day DESC, id DESC').bind(dayFrom, dayTo),
    env.DB.prepare('SELECT no, fee, cod_fee, handler, cod, cod_type FROM bk_ship WHERE created >= ?1').bind(addDay(dayFrom, -10)),
    env.DB.prepare(`SELECT p.* FROM sh_pay p WHERE p.no IN (SELECT replace(order_no,'#','') FROM orders WHERE channel='shopify' AND date >= ?1 AND date < ?2)`).bind(from, to),
    env.DB.prepare(`SELECT * FROM sr_cost WHERE no IN (SELECT replace(order_no,'#','') FROM orders WHERE channel='shopify' AND date >= ?1 AND date < ?2)`).bind(from, to),
    env.DB.prepare(`SELECT * FROM paytr_tx WHERE tip='S' AND tarih >= ?1 AND tarih <= ?2`).bind(addDay(dayFrom, -1), addDay(dayTo, 1)),
    env.DB.prepare(`SELECT no, SUM(cost) cost, COUNT(*) n FROM sh_ret WHERE deleted=0 AND no IN (SELECT replace(order_no,'#','') FROM orders WHERE channel='shopify' AND date >= ?1 AND date < ?2) GROUP BY no`).bind(from, to)])]);
  const ptTx = ptR.results, ptUsed = new Set(), ptRate = ptTx.filter(x => x.oran > 0).reduce((a, x, i, arr) => a + x.oran / arr.length, 0);
  const ptFind = (no, total, day, txIds) => { let m = ptTx.find(x => !ptUsed.has(x.k) && String(x.siparis_no || '').replace(/\D/g, '') === no);
    if (!m && txIds && txIds.length) m = ptTx.find(x => !ptUsed.has(x.k) && x.siparis_no && txIds.some(t => t && (t === x.siparis_no || t.includes(x.siparis_no))));
    if (!m) { const c = ptTx.filter(x => !ptUsed.has(x.k) && Math.abs((x.tutar || 0) - total) < 0.06 && x.tarih === day); if (c.length) m = c[0]; } // aynı gün aynı tutar: komisyon da aynı olduğundan herhangi biri
    if (m) ptUsed.add(m.k); return m; };
  const shPay = new Map(spR.results.map(x => [x.no, x])), srCost = new Map(scR.results.map(x => [x.no, x])), shRet = new Map(srtR.results.map(x => [x.no, x]));
  const bkMap = new Map(bkR.results.map(x => [x.no, x]));
  // Kanal seçiliyse sadece o kanalın siparişleri; Trendyol fatura kesintileri yalnız Trendyol'da, genel giderler kanal seçilince düşülmez
  if (ch0) { o.results = o.results.filter(x => x.channel === ch0); if (ch0 !== 'trendyol') { miscR.results = []; miscAllR.results = []; } adR.results = adR.results.filter(x => (x.channel || 'trendyol') === ch0); expR.results = []; }
  mark('batch'); const prods = new Map(p.results.map(x => [x.key, x]));
  // İade, Trendyol'un onayladığı (para iadesi yapılan) ya da senin depoda kabul ettiğin anda kâra yansır
  const rets = new Map(), pend = new Map(), defQ = new Map(), keptQ = new Map(), brokeQ = new Map(), missQ = new Map(), undOrders = new Set();
  for (const x of r.results) {
    const k = x.order_id + '|' + x.pkey, counted = x.status === 'accepted' || x.ext_status === 'Accepted';
    const note = String(x.note || '').toLocaleLowerCase('tr-TR');
    if (counted) {
      rets.set(k, (rets.get(k) || 0) + (x.qty || 0));
      if (MISSING_RE.test(note)) missQ.set(k, (missQ.get(k) || 0) + (x.qty || 0)); // eksik gönderim: geri kargo yok
      if (x.kept) keptQ.set(k, (keptQ.get(k) || 0) + (x.qty || 0)); // ücret iade edildi, ürün geri gelmedi
      else if (x.inspect === 'done') { const b = Math.max(0, (x.qty || 0) - (Number(x.insp_ok) || 0)); if (b) brokeQ.set(k, (brokeQ.get(k) || 0) + b); } // kırık çıktı: ürün maliyeti zarar
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
  const blank = () => ({ revenue: 0, commission: 0, cargo: 0, retCargo: 0, penalty: 0, service: 0, stopaj: 0, cost: 0, pack: 0, profit: 0, units: 0, retUnits: 0 });
  const add = (a, b) => { for (const k in b) if (typeof b[k] === 'number' && k in a) a[k] += b[k]; };
  const sum = { ...blank(), retOrders: 0, retCargoEst: 0, undOrders: 0, unsOrders: 0, defOrders: 0, penaltyEst: 0, penaltyActual: 0, otherFees: 0, orders: 0, actualOrders: 0, missingCost: 0, missingPrice: 0, desiOrders: 0, desiMissing: 0, noDesiTable: false };
  const rep = { grossU: 0, grossTL: 0, cancelU: 0, cancelTL: 0, retU: 0, retTL: 0, pendU: 0, pendTL: 0, discTL: 0, netU: 0, netTL: 0, noGross: 0 };
  for (const ord of o.results) for (const l of JSON.parse(ord.lines || '[]')) {
    if (!l.qty) continue; const f = l.fin || {}; const unitG = (f.gross ?? f.revenue ?? 0) / l.qty, unitR = (f.revenue ?? 0) / l.qty;
    if ((f.gross === null || f.gross === undefined) && ord.channel !== 'shopify') rep.noGross++; // Shopify'da brüt tutar ayrıca okunmaz
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
      const dq = Math.min(retQ, defQ.get(ord.id + '|' + l.pkey) || 0), kq = Math.min(retQ, keptQ.get(ord.id + '|' + l.pkey) || 0), bq = Math.min(retQ - kq, brokeQ.get(ord.id + '|' + l.pkey) || 0), mq = Math.min(retQ - kq, missQ.get(ord.id + '|' + l.pkey) || 0);
      if (unitCost === null && !qty && kq) { sum.missingCost++; missingCostSkus.add(l.sku); }
      rows.push({ l, qty, retQ, dq, kq, mq, full: (unitRev || 0) * l.qty, revenue, commission, stopaj, cost: (unitCost || 0) * (qty + kq + bq), pr });
    }
    const pkgs = new Map();
    for (const x of rows) { const pk = String(x.l.key).split('|')[0] || 'x'; const g = pkgs.get(pk) || { amount: 0, desi: null, carrier: null, ret: 0, und: false, defVal: 0, fast: true }; const f = x.l.fin || {}; g.amount += (f.paid !== null && f.paid !== undefined ? f.paid : (f.revenue || 0)); g.ret += x.retQ - (x.kq || 0) - (x.mq || 0); if (x.dq && x.l.qty) g.defVal += x.full * x.dq / x.l.qty; if (f.und || undOrders.has(ord.id)) g.und = true; if (f.desi) g.desi = f.desi; if (f.carrier) g.carrier = f.carrier; pkgs.set(pk, g); }
    let cargo = 0, retCargo = 0, penalty = 0, shReal = false, shInc = 0, undel = false, ptFee = 0, ptTxt = '';
    const cargoInfo = [];
    if (ch === 'trendyol') for (const g of pkgs.values()) { const c = tyCargo(fee, g.amount, g.desi, g.carrier); cargo += c.cost;
      // İade paketleri barem desteğinden yararlanmaz: dönüş kargosu desi fiyatından; teslim edilemeyende yalnızca taşıyıcının başarısız teslimat ek bedeli (desi fiyatının yüzdesi, barem değil)
      if (g.ret) retCargo += g.und ? Math.round(tyDesiPrice(fee, g.desi, g.carrier) * failPct(g.carrier) * 100) / 100 : tyDesiPrice(fee, g.desi, g.carrier);
      if (g.defVal > 0) penalty += penaltyFor(g.defVal); cargoInfo.push(c.tier === 1 ? '0–199,99 TL baremi' : c.tier === 2 ? '200–349,99 TL baremi' : c.flat ? '350 TL üzeri sabit' : `${CARRIER_NAMES[c.carrier]} · ${c.desi} desi${g.desi ? '' : ' (desi yok, 1 sayıldı)'}`); if (c.tier === 3 && !c.flat) { sum.desiOrders++; if (!g.desi) sum.desiMissing++; if (c.noTable) sum.noDesiTable = true; } }
    else if (ch === 'shopify' && rows.some(x => x.qty > 0 || x.retQ > 0)) {
      // Shopify kuralları: 700 TL altı müşteri 100 TL kargo öder; kapıda nakit +50 TL, kapıda kart +100 TL (müşteriden). Gider: kargo firmasının ücreti
      const no = String(ord.order_no || '').replace(/\D/g, ''), bk = bkMap.get(no), pay = shPay.get(no), post = String(ord.date || '') >= SURAT_DIRECT_FROM;
      const gross = rows.reduce((a, x) => a + x.full, 0);
      let cod = null, card = false; if (bk && !post) { cod = !!bk.cod; card = bk.cod_type === 'CREDIT_CARD'; } else if (pay) { cod = !!pay.cod; card = !!pay.card; }
      const shipInc = gross > 0 && gross < SH_FREE_SHIP ? SH_SHIP_FEE : 0, codInc = cod ? (card ? SH_COD_CARD : SH_COD_CASH) : 0; shInc = shipInc + codInc;
      const pm = cod === null ? 'ödeme yöntemi bilinmiyor (online sayıldı)' : cod ? (card ? 'kapıda kart' : 'kapıda nakit') : 'online';
      if (cod === false || (cod === null && pay)) { const m = ptFind(no, r2(gross + shInc), trDay(Date.parse(ord.date)), pay && pay.tx ? String(pay.tx).split(' ') : null); if (m && m.kesinti !== null) { ptFee = r2(m.kesinti); ptTxt = ` · PayTR komisyonu ${ptFee} TL`; } else if (ptRate > 0) { ptFee = r2((gross + shInc) * ptRate / 100); ptTxt = ` · PayTR komisyonu tahmini %${r2(ptRate)} (${ptFee} TL)`; } }
      const incTxt = shInc ? ` · müşteriden ${[shipInc ? 'kargo ' + shipInc + ' TL' : '', codInc ? 'kapıda ödeme ' + codInc + ' TL' : ''].filter(Boolean).join(' + ')} satışa eklendi` : '';
      if (post) { // 17.10.2026 10:00 sonrası: anlaşmalı Sürat. Sürat raporu yüklendiyse gerçek ücret (KDV + posta vergisi dahil), yoksa tarife (+%2,35 posta vergisi sadece kargoya) + kapıda ödeme bedeli
        let d = 0, miss = 0; for (const x of rows) { const q = x.qty + x.retQ, dz = x.pr && Number(x.pr.desi) > 0 ? Number(x.pr.desi) : null; if (dz === null) { miss++; d += q; } else d += dz * q; }
        const sc = srCost.get(no), real = sc && sc.cost !== null && sc.cost > 0;
        const desi = sc && sc.desi !== null ? Math.ceil(sc.desi) : Math.max(0, Math.ceil(d - 1e-9)), base = real ? r2(sc.cost) : r2(suratDirectPrice(desi) * (1 + SURAT_POST_TAX) + srSmsFor(fee, ord.date));
        if (sc && sc.undelivered) { // teslim edilemedi: gidiş tam + dönüş yarı fiyat; kapıda ödeme bedeli ve müşteriden gelir yok
          undel = true; cargo = r2(base * 1.5); shInc = 0; shReal = real;
          cargoInfo.push(`TESLİM EDİLEMEDİ · Sürat ${real ? 'gerçek ücret' : 'tarife'} ${base} TL + dönüş yarı fiyat ${r2(base / 2)} TL · ${sc.durum || ''}`); }
        else { const cf = cod ? suratDirectCod(gross + shInc) : 0; cargo = r2(base + cf); shReal = real ? cod !== null : (!miss && cod !== null);
          cargoInfo.push(`Sürat (anlaşmalı) · ${desi} desi${!real && miss ? ` (${miss} ürünün desisi yok, 1 sayıldı)` : ''}${desi > 20 ? ' · 20 desi üstü!' : ''} · ${real ? `gerçek ücret ${base} TL (Sürat raporu)` : `${suratDirectPrice(desi)} TL + %2,35 posta vergisi`}${cf ? ` + kapıda ödeme bedeli ${cf} TL` : ''} · ${pm}${incTxt}`); } }
      else if (bk && bk.fee !== null) { const cc = card && /s[üu]rat/i.test(bk.handler || '') ? r2((gross + shInc) * 0.045) : 0;
        cargo = r2(bk.fee + (bk.cod_fee || 0) + cc); shReal = true;
        cargoInfo.push(`Basit Kargo${bk.handler ? ' · ' + bk.handler : ''} · gerçek ücret${bk.cod_fee ? ' (kapıda ödeme bedeli ' + bk.cod_fee + ' TL dahil)' : ''}${cc ? ` + kart komisyonu %4,5 (${cc} TL)` : ''} · ${pm}${incTxt}`); }
      else { cargo = fee.cargoSh; cargoInfo.push(`Basit Kargo kaydı yok · sabit kargo ${fee.cargoSh} TL · ${pm}${incTxt}`); } }
    // Platform hizmet bedeli: sipariş saat <kesim> (15:00) öncesi geldiyse indirimli (Bugün Kargoda), sonrası normal. Fatura detayı gelince gerçeği yazılır.
    const ordHour = ord.date ? new Date(Date.parse(ord.date) + TY_TZ).getUTCHours() : 23;
    let service = 0, fastPk = 0;
    if (ch === 'trendyol') for (const g of pkgs.values()) { const f = g.fast && ordHour < fee.serviceCutoff; service += f ? fee.serviceFast : fee.serviceTy; if (f) fastPk++; }
    if (fastPk) sum.fastPkgs = (sum.fastPkgs || 0) + fastPk;
    const est = rows.reduce((a, x) => a + x.revenue, 0);
    let revenue = est + shInc, commission = rows.reduce((a, x) => a + x.commission, 0) + (ch === 'shopify' ? r2((est + shInc) * (fee.shComm || 0) / 100) + ptFee : 0); /* Shopify: Meta yardımcısının komisyonu (ciro × %) */ let actual = shReal, svcActual = false; // Shopify: satış tutarı Shopify'dan, kargo Basit Kargo'dan gerçekse sipariş gerçek sayılır
    const retUnits = rows.reduce((a, x) => a + x.retQ, 0);
    const fa = ch === 'trendyol' ? fin.get(ord.order_no) : null;
    const undelivered = retUnits > 0 && [...pkgs.values()].some(g => g.ret && g.und);
    const physRet = retUnits - rows.reduce((a, x) => a + (x.kq || 0), 0); // ürün müşteride kaldıysa dönüş kargosu yok
    let retCargoEst = physRet > 0 && !undelivered;
    if (fa) {
      // İade onaylanan siparişte ciro/komisyon satır verisinden (iade düşülmüş) hesaplanır; Trendyol ekstresi iadeyi geç yansıtabilir.
      if (fa.revenue !== null && !retUnits) { revenue = fa.revenue; commission = fa.commission || 0; actual = true; }
      if (fa.cargo !== null) { cargo = fa.cargo; actual = true; }
      if (fa.ret_cargo !== null && fa.ret_cargo !== undefined && physRet) { retCargo = fa.ret_cargo; retCargoEst = false; }
      if (fa.service !== null) { service = fa.service; svcActual = true; }
    }
    if (!physRet) retCargo = 0;
    if (ch === 'shopify') { const rr = shRet.get(String(ord.order_no || '').replace(/\D/g, '')); if (rr && rr.cost) { retCargo = r2(retCargo + rr.cost); retCargoEst = false; } }
    if (undel) { revenue = 0; commission = 0; } // teslim edilemeyen: satış yok, komisyon yok
    penalty += unsPenalty;
    // Gerçek kesinti faturası (ceza, kupon vb.) varsa tahmin yerine o kullanılır
    const mo = ch === 'trendyol' ? miscByOrder.get(ord.order_no) : null;
    const penaltyEst = !mo && penalty > 0;
    if (mo) penalty = mo.amount;
    const stopaj = actual && est ? rows.reduce((a, x) => a + x.stopaj, 0) * (revenue / est) : rows.reduce((a, x) => a + x.stopaj, 0);
    const cost = undel ? 0 : rows.reduce((a, x) => a + x.cost, 0), units = rows.reduce((a, x) => a + x.qty, 0);
    // Paketleme: gönderilen her sipariş için sabit + gönderilen her ürün adedi için (iade dönse de düşmez)
    const shipped = units + retUnits; const pack = shipped > 0 ? (ch === 'shopify' ? (fee.packOrderSh || 0) + (fee.packUnitSh || 0) * shipped : (fee.packOrder || 0) + (fee.packUnit || 0) * shipped) : 0; // Shopify ayrı paketleme ücreti
    const profit = revenue - commission - cargo - retCargo - penalty - service - stopaj - cost - pack;
    const oRes = { revenue, commission, cargo, retCargo, penalty, service, stopaj, cost, pack, profit, units, retUnits };
    add(sum, oRes); sum.orders++; if (actual) sum.actualOrders++; if (retUnits) { sum.retOrders++; if (retCargoEst && retCargo) sum.retCargoEst++; if (undelivered) sum.undOrders++; }
    if (penalty) { if (penaltyEst) sum.penaltyEst++; else sum.penaltyActual++; }
    if (rows.some(x => x.dq)) sum.defOrders++;
    byOrder.push({ pkeys: [...new Set(lines.map(l => l.pkey))].slice(0, 5), cname: cnames.get(ord.order_no) || '', q: lines.map(l => { const pr = prods.get(l.pkey); return l.sku + ' ' + (l.name || '') + ' ' + ((pr && pr.barcode) || ''); }).join(' ').slice(0, 400), id: ord.id, orderNo: ord.order_no, channel: ch, date: ord.date, actual, svcActual, retCargoEst, undelivered, penaltyEst, kept: rows.some(x => x.kq), penaltyTypes: mo ? mo.types.slice(0, 4) : null, commInfo: ch === 'shopify' ? `Meta yardımcısı %${fee.shComm || 0}${ptTxt}` : '', cargoInfo: fa && fa.cargo !== null ? 'Trendyol kargo faturası' : cargoInfo.join(', '), ...Object.fromEntries(Object.entries(oRes).map(([k, v]) => [k, R2(v)])) });
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
      const res = { revenue: lr, commission: lc, cargo: cargo * fshare, retCargo: retCargo * (retTot ? rv(x) / retTot : x.retQ / retQTot), penalty: (penalty - unsAlloc) * (dTot ? dv(x) / dTot : fshare), service: service * fshare, stopaj: ls, cost: x.cost, pack: pack * (x.l.qty / qtyTot), units: x.qty, retUnits: x.retQ };
      res.profit = lr - lc - res.cargo - res.retCargo - res.penalty - res.service - ls - x.cost - res.pack;
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
  // Günlük sabit gider / gelir: dönemdeki her güne (başlangıç–bitiş arası) yazılır
  let recurring = [];
  try {
    if (ch0) throw 0; // kanal seçiliyken günlük sabit giderler yazılmaz
    const { results: rr } = await env.DB.prepare('SELECT * FROM recurring WHERE start_day <= ?2 AND (end_day IS NULL OR end_day >= ?1) ORDER BY id').bind(dayFrom, dayTo).all();
    for (const x of rr) { const a = x.start_day > dayFrom ? x.start_day : dayFrom, b = x.end_day && x.end_day < dayTo ? x.end_day : dayTo;
      const days = Math.max(0, Math.round((dayStartTR(b) - dayStartTR(a)) / 86400000) + 1); if (!days) continue;
      const kind = x.kind === 'gelir' ? 'gelir' : 'gider';
      recurring.push({ id: x.id, name: x.name, daily: R2(x.amount || 0), kind, start: x.start_day, end: x.end_day || null, days });
      expenses.push({ id: 'r' + x.id, day: b, name: `${x.name} (günlük × ${days} gün)`, amount: R2((x.amount || 0) * days), kind, recurring: true }); }
  } catch (e) {}
  sum.expenses = expenses.filter(x => x.kind === 'gider').reduce((a, x) => a + x.amount, 0);
  sum.extraIncome = R2(expenses.filter(x => x.kind === 'gelir').reduce((a, x) => a + x.amount, 0));
  sum.compensation = R2(Math.abs(compensation)); sum.profit -= sum.otherFees + sum.ads + sum.expenses; sum.profit += sum.compensation + sum.extraIncome;
  const round = (o) => { for (const k in o) if (typeof o[k] === 'number' && !Number.isInteger(o[k])) o[k] = R2(o[k]); return o; };
  for (const bp of byProduct.values()) if (!prods.has(bp.key)) bp.orphan = true; // ürün silinmiş: satış hiçbir ürüne bağlı değil
  const products = [...byProduct.values()].map(round).map(x => ({ ...x, margin: x.revenue ? R2(x.profit / x.revenue * 100) : null }));
  round(sum); sum.margin = sum.revenue ? R2(sum.profit / sum.revenue * 100) : null;
  mark('cpu'); PERF_LAST = { ...TM, orders: o.results.length };
  return { channel: ch0 || '', from, to, fees: fee, summary: sum, report: rep, otherFees, expenses, ads: adRows.map(x => ({ day: x.day, channel: x.channel, amount: R2(x.amount || 0), source: x.source })), products, orders: byOrder, recurring, missingCostSkus: [...missingCostSkus].slice(0, 30) };
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
function mapReturn(r) { return { inspect: r.inspect || null, inspOk: r.insp_ok ?? null, kept: !!r.kept, outDesi: Number(r.o_desi) > 0 ? Number(r.o_desi) : null, autoAt: r.auto_at || null, retDesi: r.desi || r.f_ret_desi || null, retCargo: r.f_ret_cargo ?? null, claimId: r.claim_id && r.claim_id !== '-' ? r.claim_id : null, canTy: !!(r.item_id && r.claim_id && r.claim_id !== '-'), customer: r.customer || '', amount: r.amount === null || r.amount === undefined ? null : r.amount, reason: r.reason || '', cnote: r.cnote || '', cargo: r.cargo || '', cargoLink: r.cargo_link || '', extAt: r.ext_at || null, id: r.id, channel: r.channel, orderNo: r.order_no, orderId: r.order_id, lineKey: r.line_key, pkey: r.pkey, sku: r.sku, name: r.name, qty: r.qty, status: r.status, source: r.source, note: r.note, extStatus: r.ext_status, createdAt: r.created_at, decidedAt: r.decided_at }; }
function mapProduct(r) { return { mto: r.mto === 1, set: BUNDLES.get(r.key) || null, code: r.code || '', merged: r.merged_into || null, passive: r.all_passive !== undefined && r.all_passive !== null ? !!r.all_passive : r.ty_passive === 1 && !JSON.parse(r.channels || '[]').some(c => c !== 'trendyol'), sameDay: r.same_day === 1, id: r.key, sku: r.sku, name: r.name, barcode: r.barcode, image: r.image, channels: JSON.parse(r.channels || '[]'), qty: r.qty, cost: r.cost, min: r.min, tyQty: r.ty_qty === undefined ? null : r.ty_qty, createdAt: r.created_at, updatedAt: r.updated_at }; }
function mapMove(r) { return { id: r.id, t: r.t, key: r.pkey, sku: r.sku, name: r.name, delta: r.delta, after: r.after, type: r.type, channel: r.channel, ref: r.ref, note: r.note }; }
async function syncInfo(env) {
  const s = await getSettings(env, ['report_start', 'rev', 'started_at', 'auto_accept', 'ty_ok', 'ty_err', 'ty_prod_done', 'last_import', 'ty_prod_initial', 'ty_push', 'ty_push_at', 'ty_push_count', 'ty_push_err', 'ty_push_fail', 'fee_cargo_t1', 'fee_cargo_t2', 'fee_cargo_t3', 'cargo_desi_mode', 'desi_table', 'desi_tables', 'desi_learned', 'fee_service_ty', 'fee_cargo_sh', 'fee_sh_comm', 'sr_sms_fee', 'sr_sms_until', 'fee_pack_order_sh', 'fee_pack_unit_sh', 'fee_pack_order', 'fee_pack_unit', 'stopaj', 'fin_at', 'fin_err', 'fin_backfill_day', 'fin_stat', 'fin_cargo_check', 'ty_diag', 'cron_gaps', 'fee_service_fast', 'service_cutoff', 'barem_max_desi', 'perf_profit', 'qna_waiting', 'qna_err', 'usage_avg', 'hook_id', 'hook_at', 'hook_err']);
  let usage = null; try { usage = await usageGuard(env, false); } catch (e) {}
  // Trendyol'da yeni (Created) ve işleme alınan (Picking) paketler
  let newOrders = { n: 0, u: 0 };
  try { const r = await env.DB.prepare(`SELECT COUNT(DISTINCT order_no) n, COALESCE(SUM(units),0) u FROM audit_pkg WHERE status IN ('Created','Picking') AND day >= ?1`).bind(trDay(Date.now() - 30 * 86400000)).first(); if (r) newOrders = { n: r.n || 0, u: r.u || 0 }; } catch (e) {}
  try { const r = await env.DB.prepare(`SELECT COUNT(*) n FROM sh_unf WHERE data IS NOT NULL AND data <> '{}'`).first(); newOrders.sh = r ? r.n || 0 : 0; } catch (e) {} // Shopify: gönderilmemiş siparişler
  return { usage, rev: s.rev, settings: { reportStart: s.report_start || '', startedAt: s.started_at, autoAccept: s.auto_accept !== '0', prodInitial: s.ty_prod_initial !== '0', pushStock: s.ty_push !== '0', fees: { cargoT1: Number(s.fee_cargo_t1 ?? 46.49), cargoT2: Number(s.fee_cargo_t2 ?? 84.49), cargoT3: Number(s.fee_cargo_t3 ?? 98.35), desiMode: s.cargo_desi_mode === '1', desiTables: parseDesiTables(s.desi_tables), desiTable: parseDesiTable(s.desi_table), desiLearned: learnedTable(s.desi_learned), srSms: Number(s.sr_sms_fee ?? 3.07), srSmsUntil: s.sr_sms_until || '', shComm: Number(s.fee_sh_comm ?? 3), packOrderSh: Number(s.fee_pack_order_sh ?? 4), packUnitSh: Number(s.fee_pack_unit_sh ?? 1), packOrder: Number(s.fee_pack_order ?? 2), packUnit: Number(s.fee_pack_unit ?? 1), serviceTy: Number(s.fee_service_ty ?? 13.19), serviceFast: Number(s.fee_service_fast ?? 5.99), serviceCutoff: Number(s.service_cutoff ?? 15), baremMaxDesi: Number(s.barem_max_desi ?? 10), cargoSh: Number(s.fee_cargo_sh ?? 0), stopaj: Number(s.stopaj ?? 1) }, lastImport: s.last_import ? JSON.parse(s.last_import) : null }, sync: { trendyol: { configured: tyConfigured(env), ok: s.ty_ok || null, err: s.ty_err || '', productsAt: s.ty_prod_done || null, pushAt: s.ty_push_at || null, pushCount: Number(s.ty_push_count) || 0, pushErr: s.ty_push_err || '', pushFail: s.ty_push_fail || '', finAt: s.fin_at || null, finErr: s.fin_err || '', finStat: (() => { try { return JSON.parse(s.fin_stat || 'null'); } catch (e) { return null; } })(), cargoCheck: (() => { try { return JSON.parse(s.fin_cargo_check || 'null'); } catch (e) { return null; } })(), diag: (() => { try { return JSON.parse(s.ty_diag || 'null'); } catch (e) { return null; } })(), gaps: (() => { try { return JSON.parse(s.cron_gaps || '[]'); } catch (e) { return []; } })(), backfill: s.fin_backfill_day || null, newOrders, qnaWaiting: Number(s.qna_waiting) || 0, usage: (() => { try { return JSON.parse(s.usage_avg || 'null'); } catch (e) { return null; } })(), qnaErr: s.qna_err || '', hook: { on: !!s.hook_id, at: s.hook_at || '', err: s.hook_err || '' }, perf: (() => { try { return JSON.parse(s.perf_profit || 'null'); } catch (e) { return null; } })() } }, now: iso(), version: APP_VERSION, build: APP_BUILD };
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
const STAT_KEYS = ['revenue', 'commission', 'cargo', 'retCargo', 'penalty', 'service', 'stopaj', 'cost', 'pack', 'ads', 'expenses', 'extraIncome', 'otherFees', 'compensation', 'profit', 'orders', 'units', 'retUnits', 'retOrders'];
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
  const f30 = addDay(today, -29), fromD = [m0d, w0d, f30].sort()[0], yday = addDay(today, -1);
  const ySame = Math.max(t0 - 86400000 + 1, t00 - 86400000);
  // Ay toplamı Kâr ekranıyla birebir aynı olsun diye kayıtlı günlerden toplanmaz, aynı hesapla canlı alınır
  // Karşılaştırma için: geçen ayın aynı gününe kadarı ve önceki 30 gün
  const pm0 = (() => { const d = new Date(m0d + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })(), pmEnd = Math.min(dayStartTR(m0d), dayStartTR(pm0) + (t00 - dayStartTR(m0d)));
  const [T, YS, statsR, pdR, M, YD, M30, PM, P30] = await Promise.all([
    computeProfit(env, iso(t0), iso(t0 + 86400000)),
    computeProfit(env, iso(t0 - 86400000), iso(ySame)),
    env.DB.prepare('SELECT day, data FROM daily_stats WHERE day >= ?1 AND day < ?2').bind(fromD, today).all(),
    env.DB.prepare('SELECT pkey, SUM(profit) p FROM product_daily WHERE day >= ?1 AND day < ?2 GROUP BY pkey').bind(m0d, today).all(),
    computeProfit(env, iso(dayStartTR(m0d)), iso(t0 + 86400000)),
    computeProfit(env, iso(t0 - 86400000), iso(t0)),
    computeProfit(env, iso(dayStartTR(f30)), iso(t0 + 86400000)),
    computeProfit(env, iso(dayStartTR(pm0)), iso(pmEnd)).catch(() => null),
    computeProfit(env, iso(dayStartTR(addDay(f30, -30))), iso(dayStartTR(f30))).catch(() => null)]);
  const byDay = new Map(statsR.results.map(x => [x.day, JSON.parse(x.data || '{}')]));
  // Kaydı olmayan geçmiş gün varsa canlı hesaplanıp kaydedilir
  let snaps = 0;
  for (let d = fromD; d < today; d = addDay(d, 1)) if (!byDay.has(d) && snaps++ < 6) { try { await snapshotDay(env, d); const r = await env.DB.prepare('SELECT data FROM daily_stats WHERE day=?1').bind(d).first(); if (r) byDay.set(d, JSON.parse(r.data)); } catch (e) {} }
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = addDay(today, -i); const x = i === 0 ? T.summary : (byDay.get(d) || {}); days.push({ d, rev: Number(x.revenue) || 0, prof: Number(x.profit) || 0, n: Number(x.orders) || 0, u: Number(x.units) || 0 }); }
  const mRev = M.summary.revenue, mProf = M.summary.profit;
  const pp = new Map(pdR.results.map(x => [x.pkey, x.p || 0])); for (const x of T.products) pp.set(x.key, (pp.get(x.key) || 0) + (x.profit || 0));
  const R2 = (n) => Math.round(n * 100) / 100;
  // Kanal bazında (Kâr ekranında kanal seçilince çıkan hesapla aynı): sipariş kârları; Trendyol'a siparişe bağlanamayan Trendyol kesintileri / tazminat, her kanala kendi reklamı. Elle girilen genel giderler kanallara yazılmaz.
  const chOf = (P) => { const o = {}; for (const c of ['trendyol', 'shopify']) { const L = (P.orders || []).filter(x => x.channel === c), rev = L.reduce((a, x) => a + (x.revenue || 0), 0), ads = (P.ads || []).filter(x => (x.channel || 'trendyol') === c).reduce((a, x) => a + (x.amount || 0), 0);
      const prof = L.reduce((a, x) => a + (x.profit || 0), 0) - ads - (c === 'trendyol' ? (P.summary.otherFees || 0) - (P.summary.compensation || 0) : 0);
      o[c] = { revenue: R2(rev), profit: R2(prof), margin: rev ? R2(prof / rev * 100) : null, n: L.filter(x => (x.units || 0) + (x.retUnits || 0) > 0).length }; } return o; };
  const out = { day: today, at: Date.now(), ch: { today: chOf(T), ys: chOf(YS), yday: chOf(YD), month: chOf(M), d30: chOf(M30), pm: PM ? chOf(PM) : null, p30: P30 ? chOf(P30) : null }, todayN: T.summary.orders, ysN: YS.summary.orders,
    pm: PM ? { revenue: R2(PM.summary.revenue), profit: R2(PM.summary.profit) } : null, p30: P30 ? { revenue: R2(P30.summary.revenue), profit: R2(P30.summary.profit) } : null, ms: Date.now() - t00, ySame: { at: ySame, rev: YS.summary.revenue, prof: YS.summary.profit, n: YS.summary.orders, u: YS.summary.units }, days,
    month: { revenue: R2(mRev), profit: R2(mProf), margin: mRev ? R2(mProf / mRev * 100) : null },
    // Kâr ekranındaki "Dün" ve "Son 30 gün" ile birebir aynı hesap
    yday: { revenue: R2(YD.summary.revenue), profit: R2(YD.summary.profit), margin: YD.summary.revenue ? R2(YD.summary.profit / YD.summary.revenue * 100) : null },
    last30: { revenue: R2(M30.summary.revenue), profit: R2(M30.summary.profit), margin: M30.summary.revenue ? R2(M30.summary.profit / M30.summary.revenue * 100) : null }, losers: [...pp.values()].filter(v => v < 0).length };
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
  if (path === '/api/img') {
    // Ürün resmi aynı adresten verilir (etiket PDF'inde resim piksellerini okuyabilmek için); yalnızca ürün resmi sunucuları
    const u = new URL(req.url).searchParams.get('u') || ''; let h = ''; try { const x = new URL(u); h = x.protocol === 'https:' ? x.hostname : ''; } catch (e) {}
    if (!/(^|\.)(dsmcdn\.com|trendyol\.com|shopify\.com|shopifycdn\.com|myshopify\.com)$/.test(h)) return bad('Bu resim adresine izin yok.', 400);
    const r = await fetch(u, { cf: { cacheTtl: 86400, cacheEverything: true } }); if (!r.ok) return bad('Resim alınamadı.', 502);
    return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
  }
  if (path === '/api/state') {
    const info = await syncInfo(env);
    if (new URL(req.url).searchParams.get('rev') === info.rev) return json({ ...info, same: true });
    const [p, o, r, m] = await env.DB.batch([
      env.DB.prepare(`SELECT p.*, CASE WHEN EXISTS(SELECT 1 FROM listings l WHERE l.pkey=p.key) THEN NOT EXISTS(SELECT 1 FROM listings l WHERE l.pkey=p.key AND COALESCE(l.passive,0)=0) ELSE (p.ty_passive=1 AND p.channels='["trendyol"]') END AS all_passive FROM products p ORDER BY p.name`),
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
  if (path === '/api/recurring/add') {
    const name = String(body.name || '').trim().slice(0, 80), amount = Number(body.amount), kind = body.kind === 'gelir' ? 'gelir' : 'gider', start = String(body.start || trDay(Date.now()));
    if (!name) return bad('Adını yaz.'); if (!isFinite(amount) || amount <= 0 || amount > 1e7) return bad('Geçerli bir günlük tutar yaz.'); if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return bad('Tarih geçersiz.');
    await env.DB.batch([env.DB.prepare('INSERT INTO recurring(name, amount, kind, start_day, end_day, created_at) VALUES(?1,?2,?3,?4,NULL,?5)').bind(name, Math.round(amount * 100) / 100, kind, start, iso()),
      env.DB.prepare('DELETE FROM daily_stats WHERE day >= ?1').bind(start), setStmt(env, 'home_cache', ''), REV(env)]);
    return json({ ok: true });
  }
  if (path === '/api/recurring/stop' || path === '/api/recurring/delete') {
    const r = await env.DB.prepare('SELECT * FROM recurring WHERE id=?1').bind(Number(body.id) || 0).first(); if (!r) return bad('Kayıt bulunamadı.', 404);
    const today = trDay(Date.now());
    const st = path === '/api/recurring/delete' ? env.DB.prepare('DELETE FROM recurring WHERE id=?1').bind(r.id) : env.DB.prepare('UPDATE recurring SET end_day=?2 WHERE id=?1').bind(r.id, today < r.start_day ? r.start_day : today); // bugün dahil, yarından itibaren yazılmaz
    await env.DB.batch([st, env.DB.prepare('DELETE FROM daily_stats WHERE day >= ?1').bind(path === '/api/recurring/delete' ? r.start_day : addDay(today, 1)), setStmt(env, 'home_cache', ''), REV(env)]);
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
    // Taslağı olmayan bekleyen sorular ekran açılınca arka planda yazılır (zamanlanmış iş gecikirse "taslak hazırlanıyor" takılı kalmasın)
    if (body.status !== 'answered' && env.ANTHROPIC_API_KEY && results.some(q => !q.draft && !q.draft_err) && ctx && ctx.waitUntil) ctx.waitUntil(draftPendingQna(env, 4).catch(() => {}));
    return json({ ai: !!env.ANTHROPIC_API_KEY, general: (await getSetting(env, 'qa_general')) || '', items: results });
  }
  if (path === '/api/qna/draft') { try { return json(await draftQna(env, body.id, body.hint)); } catch (e) { return bad(e.message || String(e)); } }
  if (path === '/api/qna/answer') {
    const text = String(body.text || '').trim(), id = String(body.id || '');
    if (text.length < 10) return bad('Cevap en az 10 karakter olmalı.'); if (text.length > 2000) return bad('Cevap en fazla 2000 karakter olabilir.');
    if (/(https?:\/\/|www\.|@[a-z0-9-]+\.|\b0?5\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b)/i.test(text)) return bad('Cevapta web adresi, e-posta ya da telefon numarası olmamalı (Trendyol kuralı).');
    const r = await fetch(`${TY_BASE}qna/sellers/${env.TRENDYOL_SELLER_ID}/questions/${encodeURIComponent(id)}/answers`, { method: 'POST', headers: { ...tyHeaders(env), 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) { const t = (await r.text()).slice(0, 300); return bad(`Trendyol cevabı kabul etmedi (${r.status}): ${t}`); }
    await env.DB.prepare(`UPDATE qna SET status='answered', answer=?2, answered_at=?3, updated_at=?3, sent_draft=draft WHERE id=?1`).bind(id, text, iso()).run(); // taslak saklanır: düzeltmeden öğrenmek için
    await qnaCount(env);
    return json({ ok: true });
  }
  if (path === '/api/qna/note') {
    const mid = String(body.mainId || ''); if (!mid) return bad('Ürün bulunamadı.');
    await env.DB.prepare(`INSERT INTO product_info(main_id, title, note, updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(main_id) DO UPDATE SET note=excluded.note`).bind(mid, String(body.title || ''), String(body.note || '').slice(0, 3000), iso()).run();
    return json({ ok: true });
  }
  if (path === '/api/qna/general') { await setSetting(env, 'qa_general', String(body.text || '').slice(0, 4000)); return json({ ok: true }); }
  if (path === '/api/qna/sync') { try { const r = await syncTrendyolQna(env); try { r.hist = await syncQnaHistory(env, 2); } catch (e) {} return json(r); } catch (e) { return bad(e.message || String(e)); } }
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
    if (body.name !== undefined) { const n = String(body.name).trim(); if (!n) return bad('Ürün adı boş olamaz.'); sets.push('name'); vals.push(n);
      const cur = await env.DB.prepare('SELECT name FROM products WHERE key=?1').bind(key).first(); if (cur && cur.name !== n) { sets.push('name_manual'); vals.push(1); } } // elle verilen ad kanaldan ezilmez
    if (body.barcode !== undefined) { sets.push('barcode'); vals.push(String(body.barcode).trim()); }
    if (body.cost !== undefined) { const c = numOrNull(body.cost); if (c !== null && c < 0) return bad('Alış fiyatı eksi olamaz.'); sets.push('cost'); vals.push(c); sets.push('cost_date'); vals.push(null); }
    if (body.min !== undefined) { const m = intOr(body.min, NaN); if (!(m >= 0)) return bad('Düşük stok sınırı geçersiz.'); sets.push('min'); vals.push(m); }
    if (Array.isArray(body.channels)) { sets.push('channels'); vals.push(JSON.stringify(body.channels.map(String))); }
    if (body.sameDay !== undefined) { sets.push('same_day'); vals.push(body.sameDay ? 1 : 0); }
    if (body.code !== undefined) { // ürün kodunu kullanıcı belirleyebilir: büyük harf, benzersiz
      const cd = String(body.code).trim().toLocaleUpperCase('tr-TR').replace(/\s+/g, '-');
      if (!/^[A-ZÇĞİÖŞÜ0-9][A-ZÇĞİÖŞÜ0-9._\-\/]{0,29}$/.test(cd)) return bad('Ürün kodu 1-30 karakter olmalı; harf, rakam, tire, nokta kullanılabilir.');
      const dup = await env.DB.prepare('SELECT name FROM products WHERE code=?1 AND key<>?2').bind(cd, key).first();
      if (dup) return bad(`${cd} kodu zaten kullanılıyor: ${dup.name}`);
      sets.push('code'); vals.push(cd);
    }
    if (!sets.length) return json({ ok: true });
    const sql = `UPDATE products SET ${sets.map((c, i) => `${c}=?${i + 1}`).join(', ')}, updated_at=?${sets.length + 1} WHERE key=?${sets.length + 2}`;
    const r = await env.DB.batch([env.DB.prepare(sql).bind(...vals, iso(), key), REV(env)]);
    if (!r[0].meta.changes) return bad('Ürün bulunamadı.', 404);
    return json({ ok: true });
  }
  // Silinmiş bir ürüne ait geçmiş satışlar: mevcut bir ürüne bağla ya da ürünü aynı anahtarla geri getir (kâr hesabı maliyeti bulsun)
  if (path === '/api/products/relink') {
    const key = String(body.key || ''), into = String(body.into || '');
    if (!key || !into || key === into) return bad('Ürün seçilmedi.');
    if (await env.DB.prepare('SELECT 1 FROM products WHERE key=?1').bind(key).first()) return bad('Bu ürün zaten listede; ürün sayfasından birleştir.');
    let t = await env.DB.prepare('SELECT key, merged_into FROM products WHERE key=?1').bind(into).first();
    for (let i = 0; t && t.merged_into && i < 5; i++) t = await env.DB.prepare('SELECT key, merged_into FROM products WHERE key=?1').bind(t.merged_into).first();
    if (!t) return bad('Seçilen ürün bulunamadı.', 404);
    const pat = '"pkey":' + JSON.stringify(key), rep = '"pkey":' + JSON.stringify(t.key);
    await env.DB.batch([
      env.DB.prepare('UPDATE orders SET lines=replace(lines, ?1, ?2), updated_at=?3 WHERE instr(lines, ?1) > 0').bind(pat, rep, iso()),
      env.DB.prepare('UPDATE returns SET pkey=?2 WHERE pkey=?1').bind(key, t.key),
      env.DB.prepare('UPDATE listings SET pkey=?2 WHERE pkey=?1').bind(key, t.key),
      env.DB.prepare('DELETE FROM daily_stats'), env.DB.prepare('DELETE FROM product_daily'), setStmt(env, 'stats_first', ''), setStmt(env, 'stats_cursor', ''), setStmt(env, 'stats_busy', '0'),
      REV(env)]);
    const job = refreshStats(env, Date.now() + 25000).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(job);
    return json({ ok: true, key: t.key });
  }
  if (path === '/api/products/restore') {
    const key = String(body.key || ''), name = String(body.name || '').trim(), sku = String(body.sku || '').trim();
    if (!key || !name) return bad('Ürün adı gerekli.');
    const cost = numOrNull(body.cost); if (cost !== null && cost < 0) return bad('Alış fiyatı eksi olamaz.');
    if (await env.DB.prepare('SELECT 1 FROM products WHERE key=?1').bind(key).first()) return bad('Bu ürün zaten listede.');
    await env.DB.batch([...ensureProduct(env, key, { sku, name, cost }, null), REV(env)]);
    return json({ ok: true, key });
  }
  if (path === '/api/products/delete') { await env.DB.batch([env.DB.prepare('DELETE FROM products WHERE key=?1').bind(String(body.key || '')), REV(env)]); return json({ ok: true }); }
  if (path === '/api/stock') {
    const key = String(body.key || ''), mode = body.mode, n = intOr(body.n, NaN), note = String(body.note || '').slice(0, 300);
    const p = await env.DB.prepare('SELECT qty FROM products WHERE key=?1').bind(key).first(); if (!p) return bad('Ürün bulunamadı.', 404);
    if (BUNDLES.has(key)) return bad('Bu bir set ürün: stoğu içindeki ürünlerden hesaplanır. Giriş, çıkış ve sayımı içindeki ürünlerin sayfasından yap.');
    if (!Number.isFinite(n) || (n < 0 && !(mode === 'count' && body.allowNeg)) || (mode !== 'count' && n === 0)) return bad('Adet geçersiz.');
    const st = mode === 'count' ? setQty(env, key, n, { type: 'count', channel: 'manuel', note }) : changeQty(env, key, mode === 'in' ? n : -n, { type: mode === 'in' ? 'in' : 'out', channel: 'manuel', note });
    await env.DB.batch([...st, REV(env)]);
    const after = await env.DB.prepare('SELECT qty FROM products WHERE key=?1').bind(key).first();
    return json({ ok: true, qty: after.qty });
  }
  if (path === '/api/products/scan-index') {
    // Barkodla çıkış için hızlı yerel arama: bütün ilan barkod / stok kodu / kanal numaraları → ürün (paket çarpanıyla)
    const { results } = await env.DB.prepare('SELECT barcode, sku, ext, pkey, factor FROM listings').all();
    return json({ ok: true, l: results.map(r => [r.barcode || '', r.sku || '', r.ext || '', r.pkey, Math.max(1, Number(r.factor) || 1)]) });
  }
  if (path === '/api/products/lookup') {
    // Barkod okutma: Lilya kodu, ürün barkodu/stok kodu ya da bir kanal ilanının barkodu/stok kodu → ürün (paket ilanında adet çarpanıyla)
    const c = String(body.code || '').trim().slice(0, 80); if (!c) return bad('Kod boş.');
    const cols = 'key, code, name, image, qty, cost, merged_into';
    let p = await env.DB.prepare(`SELECT ${cols} FROM products WHERE UPPER(code)=UPPER(?1) OR barcode=?1 OR sku=?1 ORDER BY (merged_into IS NULL) DESC LIMIT 1`).bind(c).first(), factor = 1;
    if (!p) { const l = await env.DB.prepare(`SELECT pkey, factor FROM listings WHERE barcode=?1 OR sku=?1 OR ext=?1 LIMIT 1`).bind(c).first();
      if (l) { p = await env.DB.prepare(`SELECT ${cols} FROM products WHERE key=?1`).bind(l.pkey).first(); factor = Math.max(1, Number(l.factor) || 1); } }
    for (let i = 0; p && p.merged_into && i < 5; i++) p = await env.DB.prepare(`SELECT ${cols} FROM products WHERE key=?1`).bind(p.merged_into).first();
    if (!p) return json({ ok: true, found: false });
    return json({ ok: true, found: true, product: { key: p.key, code: p.code || '', name: p.name, image: p.image, qty: p.qty, cost: p.cost }, factor });
  }
  if (path === '/api/stock/out-bulk') {
    // Barkodla çıkış: stok düşülür ve liste kaydedilir (geçmiş çıkışlarda görülür, PDF'i yeniden alınır, geri alınabilir)
    const items = (Array.isArray(body.items) ? body.items : []).map(x => ({ key: String(x.key || ''), n: intOr(x.n, 0), code: String(x.code || '').slice(0, 40), name: String(x.name || '').slice(0, 200), image: String(x.image || '').slice(0, 500), cost: numOrNull(x.cost) })).filter(x => x.key && x.n > 0 && x.n <= 100000).slice(0, 500);
    if (!items.length) return bad('Çıkış yapılacak ürün yok.');
    const note = String(body.note || 'Barkodla çıkış').slice(0, 300), units = items.reduce((a, x) => a + x.n, 0);
    const lst = await env.DB.prepare(`INSERT INTO out_lists(t, reason, note, markup, disc, items, units, total) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) RETURNING id`).bind(iso(), String(body.reason || '').slice(0, 60), String(body.extra || '').slice(0, 200), numOrNull(body.markup), numOrNull(body.disc) || 0, JSON.stringify(items), units, numOrNull(body.total)).first();
    const st = []; for (const x of items) st.push(...changeQty(env, x.key, -x.n, { type: 'out', channel: 'manuel', ref: 'out:' + lst.id, note: note + ' · liste #' + lst.id }));
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    await env.DB.batch([REV(env)]);
    return json({ ok: true, id: lst.id, n: items.length, units });
  }
  if (path === '/api/outlists/list') {
    const { results } = await env.DB.prepare('SELECT * FROM out_lists ORDER BY id DESC LIMIT 200').all();
    return json({ ok: true, lists: results.map(r => ({ ...r, items: JSON.parse(r.items || '[]') })) });
  }
  if (path === '/api/purchase/read') {
    // Alış faturası / listesi (fotoğraf, PDF ya da Excel) yapay zekâyla okunur; satırlar ürün kataloğuyla eşleştirilir (önce daha önce onaylanan eşleşmeler)
    if (!env.ANTHROPIC_API_KEY) return bad('Yapay zekâ anahtarı (ANTHROPIC_API_KEY) Cloudflare\'e eklenmemiş.');
    const files = (Array.isArray(body.files) ? body.files : []).slice(0, 10).filter(f => f && typeof f.data === 'string' && /^(image\/(jpeg|png|webp)|application\/pdf|text\/plain)$/.test(f.type || ''));
    if (!files.length) return bad('Fotoğraf, PDF ya da Excel seç.');
    const prods = (await env.DB.prepare(`SELECT key, code, name FROM products WHERE merged_into IS NULL AND code IS NOT NULL AND code<>'' ORDER BY code`).all()).results;
    const catalog = prods.map(p => `${p.code}\t${p.name}`).join('\n');
    const content = files.map(f => f.type === 'text/plain' ? { type: 'text', text: `EXCEL ALIŞ LİSTESİ (${String(f.name || 'dosya').slice(0, 80)}) — hücreler TAB ile ayrılmış:\n${f.data.slice(0, 400000)}` } : f.type === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } } : { type: 'image', source: { type: 'base64', media_type: f.type, data: f.data } });
    content.push({ type: 'text', text: `Bu bir tedarikçi alış faturası / irsaliyesi / alış listesi (birden fazla sayfa olabilir). Her ürün satırını oku ve aşağıdaki ürün kataloğumuzla eşleştir.

KURALLAR:
- qty: alınan toplam PARÇA adedi. Satırda koli/paket ve koli içi adet yazıyorsa çarp (ör. 2 koli × 24 = 48) ve "note" alanına yaz.
- unit: bir parçanın birim fiyatı, satırda yazdığı gibi (KDV EKLEME). Sadece satır tutarı varsa unit = tutar / qty.
- amount: satır tutarı (yazıyorsa), yoksa qty × unit.
- match: katalogdaki en uygun ürünün KODU (ör. LH-0012). Emin değilsen en olası olanı yaz ve conf'u "low" yap; hiç benzeyen yoksa boş bırak.
- conf: "high" (açıkça aynı ürün), "mid" (büyük ihtimalle), "low" (tahmin).
- Toplam, KDV, iskonto, kargo gibi satırları ürün olarak yazma.
- Sayılarda Türkçe biçimi çöz (1.250,50 = 1250.5).

ÇIKTI: SADECE şu JSON, başka metin yok:
{"supplier":"tedarikçi firma adı","doc_no":"belge/fatura no","date":"YYYY-AA-GG","items":[{"name":"faturadaki ürün adı","code":"tedarikçi ürün kodu varsa","qty":0,"unit":0,"amount":0,"match":"","conf":"","note":""}],"total":0}

ÜRÜN KATALOĞUMUZ (kod<TAB>ad):
${catalog}` });
    const model = (await getSetting(env, 'pur_model')) || 'claude-sonnet-5-5';
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 12000, messages: [{ role: 'user', content }] }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const m = (data.error && data.error.message) || ''; return bad(/credit balance/i.test(m) ? 'Yapay zekâ kredisi bitti. platform.claude.com → Billing (Faturalandırma) bölümünden kredi yükle, sonra tekrar dene.' : (m || ('Yapay zekâ hatası ' + r.status)), 502); }
    const txt = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    let out; try { out = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); } catch (e) { return bad('Belge okunamadı; daha net bir fotoğrafla tekrar dene.', 422); }
    const byCode = new Map(prods.map(p => [String(p.code).toUpperCase(), p.key]));
    const supK = String(out.supplier || '').trim().toLocaleLowerCase('tr-TR');
    const nk = (t) => String(t || '').toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim().slice(0, 200);
    const mem = new Map((await env.DB.prepare('SELECT k, pkey FROM sup_map WHERE supplier=?1').bind(supK).all()).results.map(x => [x.k, x.pkey]));
    const live = new Set(prods.map(p => p.key));
    const items = (Array.isArray(out.items) ? out.items : []).slice(0, 300).map(x => {
      const qty = Math.max(0, Math.round(Number(x.qty) || 0)), unit = Math.max(0, Number(x.unit) || 0);
      let pkey = null, how = '';
      const m1 = mem.get(nk(x.name)) || (x.code ? mem.get('#' + nk(x.code)) : null); if (m1 && live.has(m1)) { pkey = m1; how = 'mem'; }
      if (!pkey && x.match) { const k = byCode.get(String(x.match).trim().toUpperCase()); if (k) { pkey = k; how = String(x.conf || 'mid'); } }
      return { name: String(x.name || '').slice(0, 200), code: String(x.code || '').slice(0, 60), qty, unit: Math.round(unit * 10000) / 10000, amount: Number(x.amount) || Math.round(qty * unit * 100) / 100, note: String(x.note || '').slice(0, 120), pkey, how };
    }).filter(x => x.name || x.qty);
    const sups = (await env.DB.prepare('SELECT name FROM suppliers ORDER BY name').all()).results.map(x => x.name);
    return json({ ok: true, supplier: String(out.supplier || '').trim().slice(0, 120), doc_no: String(out.doc_no || '').slice(0, 60), date: /^\d{4}-\d{2}-\d{2}$/.test(out.date || '') ? out.date : '', total: Number(out.total) || null, items, suppliers: sups });
  }
  // Sipariş ver: ürün başına son tedarikçi ve son alış fiyatı (alış listelerinden)
  if (path === '/api/buy/suppliers') {
    const { results } = await env.DB.prepare(`SELECT supplier, doc_date, t, items FROM purchases WHERE status IN ('stocked','draft','costed') ORDER BY COALESCE(doc_date, t) DESC LIMIT 400`).all();
    const map = {};
    for (const r of results) { let items = []; try { items = JSON.parse(r.items || '[]'); } catch (e) {}
      for (const x of items) if (x.pkey && !map[x.pkey]) map[x.pkey] = { supplier: r.supplier || '', unit: Number(x.unit) || 0, date: r.doc_date || String(r.t || '').slice(0, 10), code: x.code || '' }; }
    return json({ ok: true, map });
  }
  if (path === '/api/purchase/save') {
    // Alış listesini KAYDET (taslak): stok ve maliyet DEĞİŞMEZ, cariye işlenmez. Stoğa ekleme ve cari ayrı, onaylı adımlar.
    const supplier = String(body.supplier || '').trim().slice(0, 120); if (!supplier) return bad('Tedarikçi adını yaz.');
    const items = (Array.isArray(body.items) ? body.items : []).map(x => ({ pkey: x.ok && x.pkey ? String(x.pkey) : '', sug: !x.ok && x.pkey ? String(x.pkey).slice(0, 80) : '', name: String(x.name || '').slice(0, 200), code: String(x.code || '').slice(0, 60), qty: Math.max(0, intOr(x.qty, 0)), unit: Math.max(0, Number(x.unit) || 0), note: String(x.note || '').slice(0, 120) })).filter(x => x.name || x.qty).slice(0, 300);
    if (!items.length) return bad('Kaydedilecek satır yok.');
    const keys = [...new Set(items.filter(x => x.pkey).map(x => x.pkey))], pm = new Map();
    for (const r of await selectIn(env, 'SELECT key, code, name, image FROM products', 'key', keys)) pm.set(r.key, r);
    for (const x of items) { const p = pm.get(x.pkey); if (p) { x.pcode = p.code || ''; x.pname = p.name; x.image = p.image || ''; } else x.pkey = ''; }
    await env.DB.prepare('INSERT OR IGNORE INTO suppliers(name, created_at) VALUES(?1,?2)').bind(supplier, iso()).run();
    const sup = await env.DB.prepare('SELECT id, name FROM suppliers WHERE name=?1').bind(supplier).first();
    const units = items.reduce((a, x) => a + x.qty, 0), total = Math.round(items.reduce((a, x) => a + x.qty * x.unit, 0) * 100) / 100;
    const docNo = String(body.doc_no || '').slice(0, 60), date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : null;
    let id = intOr(body.id, 0);
    if (id) { const ex = await env.DB.prepare('SELECT status FROM purchases WHERE id=?1').bind(id).first(); if (!ex) return bad('Alış bulunamadı.', 404); if (ex.status !== 'draft') return bad('Stoğa eklenmiş alış düzenlenemez; önce stoktan geri al.');
      await env.DB.prepare('UPDATE purchases SET supplier_id=?2, supplier=?3, doc_no=?4, doc_date=?5, items=?6, units=?7, total=?8 WHERE id=?1').bind(id, sup.id, sup.name, docNo, date, JSON.stringify(items), units, total).run(); }
    else id = (await env.DB.prepare(`INSERT INTO purchases(t, supplier_id, supplier, doc_no, doc_date, items, units, total, status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'draft') RETURNING id`).bind(iso(), sup.id, sup.name, docNo, date, JSON.stringify(items), units, total).first()).id;
    // onaylanan eşleşmeler bir sonraki belgede ÖNERİ olarak gelsin (yine onay ister)
    const supK = sup.name.toLocaleLowerCase('tr-TR'), nk = (t) => String(t || '').toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim().slice(0, 200), st = [];
    for (const x of items) if (x.pkey) { if (x.name) st.push(env.DB.prepare('INSERT OR REPLACE INTO sup_map(supplier, k, pkey) VALUES(?1,?2,?3)').bind(supK, nk(x.name), x.pkey)); if (x.code) st.push(env.DB.prepare('INSERT OR REPLACE INTO sup_map(supplier, k, pkey) VALUES(?1,?2,?3)').bind(supK, '#' + nk(x.code), x.pkey)); }
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    return json({ ok: true, id });
  }
  if (path === '/api/purchase/list') {
    const { results } = await env.DB.prepare(`SELECT * FROM purchases WHERE status<>'deleted' ORDER BY id DESC LIMIT 200`).all();
    return json({ ok: true, list: results.map(r => ({ ...r, status: r.status === 'active' ? 'stocked' : r.status, items: JSON.parse(r.items || '[]') })) });
  }
  if (path === '/api/purchase/get') {
    const r = await env.DB.prepare('SELECT * FROM purchases WHERE id=?1').bind(intOr(body.id, 0)).first(); if (!r) return bad('Alış bulunamadı.', 404);
    const sups = (await env.DB.prepare('SELECT name FROM suppliers ORDER BY name').all()).results.map(x => x.name);
    return json({ ok: true, purchase: { ...r, items: JSON.parse(r.items || '[]') }, suppliers: sups });
  }
  if (path === '/api/purchase/stock') {
    // STOĞA EKLE (kullanıcı onayıyla): eşleşmiş satırlar stoğa girer, maliyet fişteki birim fiyat olur
    const id = intOr(body.id, 0), r = await env.DB.prepare('SELECT * FROM purchases WHERE id=?1').bind(id).first();
    if (!r) return bad('Alış bulunamadı.', 404);
    if (r.status !== 'draft' && r.status !== 'costed') return bad('Bu alış zaten stoğa eklenmiş.');
    const items = JSON.parse(r.items || '[]'), use = items.filter(x => x.pkey && x.qty > 0);
    if (!use.length) return bad('Stoğa eklenecek eşleşmiş satır yok; önce listeyi düzenleyip ürünleri eşleştir.');
    const upd = await env.DB.prepare(`UPDATE purchases SET status='stocked', stocked_at=?2 WHERE id=?1 AND status IN ('draft','costed')`).bind(id, iso()).run();
    if (!upd.meta || !upd.meta.changes) return bad('Bu alış zaten stoğa eklenmiş.');
    const cur = new Map(); for (const p of await selectIn(env, 'SELECT key, qty, cost, cost_date FROM products', 'key', [...new Set(use.map(x => x.pkey))])) cur.set(p.key, { ...p });
    const st = [], docD = r.doc_date || String(r.t || '').slice(0, 10);
    for (const x of use) { const p = cur.get(x.pkey); if (!p) { x.skipped = true; continue; }
      // fişteki birim fiyat aynen maliyet olur (ortalama yok, KDV eklenmez); eski tarihli fiş yenisini ezmez, aynı yüklemede yüksek fiyat kazanır
      const c1 = costPick(p, x.unit, docD);
      if (c1 !== null) { x.prevCost = p.cost === undefined ? null : p.cost; x.prevDate = p.cost_date || null; x.newCost = c1; p.cost = c1; p.cost_date = docD; p.touched = true; }
      x.stocked = true; p.qty = (Number(p.qty) || 0) + x.qty;
      st.push(...changeQty(env, x.pkey, x.qty, { type: 'in', channel: 'manuel', ref: 'pur:' + id, note: `Alış · ${r.supplier}${r.doc_no ? ' · ' + r.doc_no : ''} · alış #${id}` })); }
    for (const [k, p] of cur) if (p.touched) st.push(env.DB.prepare('UPDATE products SET cost=?2, cost_date=?4, updated_at=?3 WHERE key=?1').bind(k, p.cost, iso(), p.cost_date));
    st.push(env.DB.prepare('UPDATE purchases SET items=?2 WHERE id=?1').bind(id, JSON.stringify(items)));
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    await env.DB.batch([REV(env)]);
    return json({ ok: true, lines: use.filter(x => x.stocked).length, units: use.filter(x => x.stocked).reduce((a, x) => a + x.qty, 0) });
  }
  if (path === '/api/purchase/cost') {
    // SADECE MALİYETİ GÜNCELLE: eşleşmiş satırlarda ürün maliyeti fişteki birim fiyat olur; stok adedi DEĞİŞMEZ
    const id = intOr(body.id, 0), r = await env.DB.prepare('SELECT * FROM purchases WHERE id=?1').bind(id).first();
    if (!r) return bad('Alış bulunamadı.', 404);
    if (r.status !== 'draft') return bad('Bu alış zaten işlenmiş (stoğa eklenmiş ya da maliyeti güncellenmiş).');
    const items = JSON.parse(r.items || '[]'), use = items.filter(x => x.pkey && Number(x.unit) > 0);
    if (!use.length) return bad('Maliyeti güncellenecek eşleşmiş ve fiyatlı satır yok; önce listeyi düzenleyip ürünleri eşleştir.');
    const upd = await env.DB.prepare(`UPDATE purchases SET status='costed', stocked_at=?2 WHERE id=?1 AND status='draft'`).bind(id, iso()).run();
    if (!upd.meta || !upd.meta.changes) return bad('Bu alış zaten işlenmiş.');
    const cur = new Map(); for (const p of await selectIn(env, 'SELECT key, cost, cost_date FROM products', 'key', [...new Set(use.map(x => x.pkey))])) cur.set(p.key, { ...p });
    const docD = r.doc_date || String(r.t || '').slice(0, 10), seen = new Set(); let n = 0, kept = 0;
    for (const x of use) { const p = cur.get(x.pkey); if (!p) { x.skipped = true; continue; } x.costOnly = true;
      const c1 = costPick(p, x.unit, docD);
      if (c1 === null) { x.costKept = true; continue; }
      x.prevCost = p.cost === null || p.cost === undefined ? null : Number(p.cost); x.prevDate = p.cost_date || null; x.newCost = c1; p.cost = c1; p.cost_date = docD; p.touched = true; seen.add(x.pkey); }
    n = seen.size; kept = [...new Set(use.filter(x => x.costKept && !seen.has(x.pkey)).map(x => x.pkey))].length;
    const st = [];
    for (const [k, p] of cur) if (p.touched) st.push(env.DB.prepare('UPDATE products SET cost=?2, cost_date=?4, updated_at=?3 WHERE key=?1').bind(k, p.cost, iso(), p.cost_date));
    st.push(env.DB.prepare('UPDATE purchases SET items=?2 WHERE id=?1').bind(id, JSON.stringify(items)));
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    await env.DB.batch([REV(env)]);
    return json({ ok: true, lines: n, kept });
  }
  if (path === '/api/purchase/revert') {
    // STOKTAN GERİ AL: eklenen adetler düşülür, maliyet (sonradan değişmediyse) eski haline döner; liste taslak olarak kalır
    const id = intOr(body.id, 0), r = await env.DB.prepare('SELECT * FROM purchases WHERE id=?1').bind(id).first();
    if (!r) return bad('Alış bulunamadı.', 404);
    if (!(r.status === 'stocked' || r.status === 'active' || r.status === 'costed')) return bad('Bu alış stoğa eklenmemiş.');
    const costOnly = r.status === 'costed';
    const upd = await env.DB.prepare(`UPDATE purchases SET status='draft', stocked_at=NULL WHERE id=?1 AND status IN ('stocked','active','costed')`).bind(id).run();
    if (!upd.meta || !upd.meta.changes) return bad('Bu alış stoğa eklenmemiş.');
    const items = JSON.parse(r.items || '[]'), done = items.filter(x => x.pkey && (costOnly ? x.costOnly : x.qty > 0 && (x.stocked || r.status === 'active'))), st = [];
    const chg = done.filter(x => x.newCost !== undefined), last = new Map(); for (const x of chg) last.set(x.pkey, x); const first = new Map(); for (const x of chg.slice().reverse()) first.set(x.pkey, x);
    if (!costOnly) for (const x of done) st.push(...changeQty(env, x.pkey, -x.qty, { type: 'out', channel: 'manuel', ref: 'pur:' + id, note: 'Alış stoktan geri alındı · alış #' + id }));
    for (const [k, x] of last) st.push(env.DB.prepare('UPDATE products SET cost=?2, cost_date=?4 WHERE key=?1 AND ABS(COALESCE(cost,-1) - ?3) < 0.006').bind(k, first.get(k).prevCost ?? null, x.newCost, first.get(k).prevDate ?? null));
    for (const x of items) { delete x.stocked; delete x.prevCost; delete x.newCost; delete x.prevDate; delete x.costOnly; delete x.costKept; }
    st.push(env.DB.prepare('UPDATE purchases SET items=?2 WHERE id=?1').bind(id, JSON.stringify(items)));
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    await env.DB.batch([REV(env)]);
    return json({ ok: true });
  }
  if (path === '/api/purchase/cari') {
    // CARİYE İŞLE / ÇIKAR (kullanıcı onayıyla); cari hesap sekmesi bu işaretli alışları kullanacak
    const id = intOr(body.id, 0); const r = await env.DB.prepare('SELECT status FROM purchases WHERE id=?1').bind(id).first(); if (!r || r.status === 'deleted') return bad('Alış bulunamadı.', 404);
    await env.DB.prepare('UPDATE purchases SET cari_at=?2 WHERE id=?1').bind(id, body.on ? iso() : null).run();
    return json({ ok: true });
  }
  if (path === '/api/costs/reset') {
    // TÜM MALİYETLERİ SIFIRLA: önce yedek alınır (settings: cost_backup_<zaman>), sonra bütün ürünlerin maliyeti boşaltılır
    const { results } = await env.DB.prepare('SELECT key, cost FROM products WHERE cost IS NOT NULL').all();
    const at = iso(), k = 'cost_backup_' + at.replace(/[^0-9]/g, '').slice(0, 14);
    await env.DB.batch([setStmt(env, k, JSON.stringify({ at, rows: results.map(r => [r.key, r.cost]) })), setStmt(env, 'cost_backup_last', k)]);
    await env.DB.batch([env.DB.prepare('UPDATE products SET cost=NULL, cost_date=NULL, updated_at=?1 WHERE cost IS NOT NULL').bind(at), REV(env)]);
    return json({ ok: true, n: results.length, at });
  }
  if (path === '/api/cari/list') {
    // CARİLER: tedarikçi başına cariye işlenmiş alışlar (borç) − ödemeler = kalan borç; ödeme şekline göre vadesi gelenler uyarı olarak döner
    const all = await cariLoad(env), today = trToday(), list = [], alerts = [], dues = [], fx = all.some(c => c.cur !== 'TL') ? await fxRates(env) : { TL: 1 };
    for (const c of all) { const sc = cariSchedule(c, today), rate = fx[c.cur] || null, T = (v) => rate ? r2(v * rate) : null;
      for (const x of sc.items) { x.cur = c.cur; x.leftTL = T(x.left); }
      list.push({ cur: c.cur, rate, balTL: T(c.bal), overdueTL: T(sc.overdue), dueTodayTL: T(sc.today), dueWeekTL: T(sc.week), supplier: c.supplier, terms: c.terms, buys: c.buys.length, buy: c.buy, pays: c.pays.length, paid: c.paid, bal: c.bal, last: c.last, next: sc.next, overdue: sc.overdue, dueToday: sc.today, dueWeek: sc.week });
      for (const x of sc.items) { if (x.left > 0.004 && x.due <= addDayStr(today, 7)) alerts.push({ supplier: c.supplier, ...x }); if (x.left > 0.004 && x.due <= addDayStr(today, 100)) dues.push({ supplier: c.supplier, due: x.due, left: x.left, cur: c.cur, leftTL: x.leftTL, label: x.label }); } }
    list.sort((a, b) => (b.overdue + b.dueToday > 0.004) - (a.overdue + a.dueToday > 0.004) || b.bal - a.bal || a.supplier.localeCompare(b.supplier, 'tr'));
    alerts.sort((a, b) => a.due.localeCompare(b.due) || b.left - a.left);
    const sups = (await env.DB.prepare('SELECT name FROM suppliers ORDER BY name').all()).results.map(x => x.name);
    return json({ ok: true, today, list, alerts, dues, suppliers: sups, fx });
  }
  if (path === '/api/cari/get') {
    const sup = String(body.supplier || '').trim(); if (!sup) return bad('Tedarikçi seç.');
    const c = (await cariLoad(env, sup))[0] || { supplier: sup, terms: cariTerms(null), buys: [], pays: [], buy: 0, paid: 0, bal: 0 };
    const tr = await env.DB.prepare('SELECT name, terms, currency FROM suppliers WHERE name=?1').bind(sup).first(); if (tr) { c.supplier = tr.name; c.terms = cariTerms(tr.terms); c.cur = cariCur(tr.currency); }
    const cur = c.cur || 'TL', rate = cur === 'TL' ? 1 : (await fxRates(env))[cur] || null;
    const rows = [...c.buys.map(r => ({ kind: 'buy', id: r.id, mov: !!r.mov, date: r.date, t: r.t, amount: r.amount, text: r.mov ? r.label : `Alış #${r.id}${r.doc_no ? ' · ' + r.doc_no : ''} · ${r.units || 0} adet` })),
      ...c.pays.map(r => ({ kind: 'pay', id: r.id, mov: !!r.mov, date: r.date, t: r.t, amount: r.amount, text: r.mov ? r.label : [r.method || 'Ödeme', r.note].filter(Boolean).join(' · ') }))]
      .sort((a, b) => a.date.localeCompare(b.date) || a.t.localeCompare(b.t));
    let bal = 0; for (const r of rows) { bal = r2(bal + (r.kind === 'buy' ? r.amount : -r.amount)); r.bal = bal; }
    const today = trToday(), sc = cariSchedule(c, today);
    return json({ ok: true, supplier: c.supplier, cur, rate, balTL: rate ? r2(bal * rate) : null, terms: c.terms, rows: rows.reverse(), bal, today, plan: sc.items, next: sc.next });
  }
  if (path === '/api/cari/terms') {
    const sup = String(body.supplier || '').trim().slice(0, 120); if (!sup) return bad('Tedarikçi seç.');
    const t = cariTerms(body.terms || {});
    await env.DB.prepare('INSERT OR IGNORE INTO suppliers(name, created_at) VALUES(?1,?2)').bind(sup, iso()).run();
    await env.DB.prepare('UPDATE suppliers SET terms=?2 WHERE name=?1').bind(sup, JSON.stringify(t)).run();
    return json({ ok: true, terms: t });
  }
  if (path === '/api/cari/pay') {
    const sup = String(body.supplier || '').trim().slice(0, 120); if (!sup) return bad('Tedarikçi seç.');
    const a0 = String(body.amount ?? '').trim(), amount = Math.round((Number(a0.includes(',') ? a0.replace(/\./g, '').replace(',', '.') : a0) || 0) * 100) / 100;
    if (!(amount > 0)) return bad('Ödeme tutarını yaz.');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : iso().slice(0, 10);
    await env.DB.prepare('INSERT OR IGNORE INTO suppliers(name, created_at) VALUES(?1,?2)').bind(sup, iso()).run();
    const r = await env.DB.prepare('SELECT name FROM suppliers WHERE name=?1').bind(sup).first();
    await env.DB.prepare('INSERT INTO sup_pay(t, supplier, date, amount, method, note) VALUES(?1,?2,?3,?4,?5,?6)').bind(iso(), r ? r.name : sup, date, amount, String(body.method || '').slice(0, 40), String(body.note || '').slice(0, 160)).run();
    return json({ ok: true });
  }
  if (path === '/api/cari/new') {
    // ELLE CARİ AÇ: firma adı + (isteğe bağlı) devir bakiye; + borç (biz borçluyuz), − alacak
    const sup = String(body.supplier || '').trim().slice(0, 120); if (!sup) return bad('Firma adını yaz.');
    await env.DB.prepare('INSERT OR IGNORE INTO suppliers(name, created_at) VALUES(?1,?2)').bind(sup, iso()).run();
    await env.DB.prepare('UPDATE suppliers SET manual=1, currency=COALESCE(?2, currency) WHERE name=?1').bind(sup, body.currency ? (cariCur(body.currency) === 'TL' ? null : cariCur(body.currency)) : null).run();
    const r = await env.DB.prepare('SELECT name FROM suppliers WHERE name=?1').bind(sup).first(), name = r ? r.name : sup;
    const amt = cariAmt(body.open), date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : trToday();
    if (amt) await env.DB.prepare('INSERT INTO sup_mov(t, supplier, date, kind, amount, note) VALUES(?1,?2,?3,?4,?5,?6)').bind(iso(), name, date, 'open', amt, String(body.note || '').slice(0, 160)).run();
    return json({ ok: true, supplier: name });
  }
  if (path === '/api/cari/mov') {
    const sup = String(body.supplier || '').trim().slice(0, 120); if (!sup) return bad('Firma seç.');
    const kind = ['open', 'debt', 'credit'].includes(body.kind) ? body.kind : 'debt', amt = cariAmt(body.amount); if (!amt) return bad('Tutarı yaz.');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : trToday();
    await env.DB.prepare('INSERT OR IGNORE INTO suppliers(name, created_at) VALUES(?1,?2)').bind(sup, iso()).run();
    const r = await env.DB.prepare('SELECT name FROM suppliers WHERE name=?1').bind(sup).first();
    await env.DB.prepare('INSERT INTO sup_mov(t, supplier, date, kind, amount, note) VALUES(?1,?2,?3,?4,?5,?6)').bind(iso(), r ? r.name : sup, date, kind, kind === 'credit' ? Math.abs(amt) : amt, String(body.note || '').slice(0, 160)).run();
    return json({ ok: true });
  }
  if (path === '/api/cari/currency') { const sup = String(body.supplier || '').trim(); if (!sup) return bad('Firma seç.'); const c = cariCur(body.currency);
    await env.DB.prepare('UPDATE suppliers SET currency=?2 WHERE name=?1').bind(sup, c === 'TL' ? null : c).run(); return json({ ok: true, currency: c }); }
  if (path === '/api/cari/movdel') { await env.DB.prepare('UPDATE sup_mov SET deleted=1 WHERE id=?1').bind(intOr(String(body.id || '').replace(/^m/, ''), 0)).run(); return json({ ok: true }); }
  if (path === '/api/cari/import') {
    // EXCEL'DEN CARİ YÜKLE: her satır bir hareket: firma, para birimi, tarih, tür, tutar (+ borç / − alacak, ödeme), açıklama
    const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 5000); if (!rows.length) return bad('Yüklenecek satır yok.');
    const st = [], names = new Map(); let n = 0, pays = 0, skipped = 0; const t0 = Date.now(), batch = 'b' + t0;
    // Aynı dosya ikinci kez yüklenirse aynı hareketler (firma + tarih + tutar + açıklama) tekrar yazılmaz
    const K = (sup, date, amt, note) => [String(sup).toLocaleLowerCase('tr-TR'), date, r2(Math.abs(amt)), String(note || '').toLocaleLowerCase('tr-TR')].join('|');
    const [em, ep] = await env.DB.batch([env.DB.prepare(`SELECT supplier, date, amount, note FROM sup_mov WHERE deleted=0 AND src='xls'`), env.DB.prepare(`SELECT supplier, date, amount, note, method FROM sup_pay WHERE deleted=0 AND src='xls'`)]);
    const have = new Set([...em.results.map(x => K(x.supplier, x.date, x.amount, x.note)), ...ep.results.map(x => 'p|' + K(x.supplier, x.date, x.amount, x.note))]);
    rows.forEach((x, i) => { const sup = String(x.supplier || '').trim().slice(0, 120), amt = cariAmt(x.amount); if (!sup) return; const cu = cariCur(x.currency);
      if (!names.has(sup.toLocaleLowerCase('tr-TR'))) { names.set(sup.toLocaleLowerCase('tr-TR'), sup); st.push(env.DB.prepare('INSERT OR IGNORE INTO suppliers(name, created_at) VALUES(?1,?2)').bind(sup, iso()), env.DB.prepare('UPDATE suppliers SET manual=1, currency=COALESCE(?2, currency) WHERE name=?1').bind(sup, cu === 'TL' ? null : cu)); }
      if (!amt) return; const date = /^\d{4}-\d{2}-\d{2}$/.test(x.date || '') ? x.date : trToday(), tur = String(x.tur || '').trim().slice(0, 40), note = [tur, String(x.note || '').trim()].filter(Boolean).join(' · ').slice(0, 160), t = iso(t0 + i);
      if (/ödeme|odeme|tahsilat/i.test(tur) && amt < 0) { const pn = String(x.note || '').slice(0, 160), k = 'p|' + K(sup, date, amt, pn); if (have.has(k)) { skipped++; return; } have.add(k); pays++;
        st.push(env.DB.prepare('INSERT INTO sup_pay(t, supplier, date, amount, method, note, src, batch) VALUES(?1,(SELECT name FROM suppliers WHERE name=?2),?3,?4,?5,?6,?7,?8)').bind(t, sup, date, Math.abs(amt), tur || 'Ödeme', pn, 'xls', batch)); return; }
      const kind = /devir/i.test(tur) || x.kind === 'open' ? 'open' : amt < 0 ? 'credit' : 'debt', nt = note || 'Excel', k = K(sup, date, amt, nt); if (have.has(k)) { skipped++; return; } have.add(k);
      st.push(env.DB.prepare('INSERT INTO sup_mov(t, supplier, date, kind, amount, note, src, batch) VALUES(?1,(SELECT name FROM suppliers WHERE name=?2),?3,?4,?5,?6,?7,?8)').bind(t, sup, date, kind, kind === 'credit' ? Math.abs(amt) : amt, nt, 'xls', batch)); n++; });
    st.push(env.DB.prepare('INSERT INTO cari_imp(batch, at, file, n, skipped) VALUES(?1,?2,?3,?4,?5)').bind(batch, iso(), String(body.file || 'Excel').slice(0, 120), n + pays, skipped));
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    return json({ ok: true, suppliers: names.size, moves: n + pays, pays, skipped, batch });
  }
  const LEG_DEVIR = `note LIKE 'Hesap ekstresi devri%' OR note IN ('Excel devir','Excel')`;
  if (path === '/api/cari/imports') {
    // Excel yüklemeleri: her biri geri alınabilir; numarasız eski yüklemeler "Önceki yüklemeler" olarak tek satır
    const L = (await env.DB.prepare('SELECT * FROM cari_imp ORDER BY at DESC LIMIT 30').all()).results;
    const cnt = async (b) => { const [a, c] = await env.DB.batch([env.DB.prepare('SELECT COUNT(*) n FROM sup_mov WHERE deleted=0 AND batch=?1').bind(b), env.DB.prepare('SELECT COUNT(*) n FROM sup_pay WHERE deleted=0 AND batch=?1').bind(b)]); return (a.results[0].n || 0) + (c.results[0].n || 0); };
    const out = []; for (const x of L) out.push({ batch: x.batch, at: x.at, file: x.file, n: x.n, skipped: x.skipped || 0, live: await cnt(x.batch), undone: !!x.undone_at });
    const [l1, lm, lp] = await env.DB.batch([env.DB.prepare(`SELECT COUNT(*) n, MIN(t) a FROM sup_mov WHERE deleted=0 AND batch IS NULL AND (${LEG_DEVIR})`), env.DB.prepare(`SELECT COUNT(*) n, MIN(t) a FROM sup_mov WHERE deleted=0 AND batch IS NULL AND src='xls' AND NOT (${LEG_DEVIR})`), env.DB.prepare(`SELECT COUNT(*) n FROM sup_pay WHERE deleted=0 AND batch IS NULL AND src='xls'`)]);
    if (l1.results[0].n) out.push({ batch: 'legacy1', at: l1.results[0].a, file: 'Devir bakiye yüklemesi (cari_devir_yukle.xlsx)', n: l1.results[0].n, live: l1.results[0].n, undone: false });
    const l2 = (lm.results[0].n || 0) + (lp.results[0].n || 0); if (l2) out.push({ batch: 'legacy2', at: lm.results[0].a, file: 'Hareket yüklemesi (cari_hareketler_yukle.xlsx)', n: l2, live: l2, undone: false });
    return json({ ok: true, list: out });
  }
  if (path === '/api/cari/undo') {
    const b = String(body.batch || ''); if (!b) return bad('Yükleme seç.'); let a, c;
    if (b === 'legacy1') { a = await env.DB.prepare(`UPDATE sup_mov SET deleted=1 WHERE deleted=0 AND batch IS NULL AND (${LEG_DEVIR})`).run(); c = { meta: { changes: 0 } }; }
    else if (b === 'legacy2') { a = await env.DB.prepare(`UPDATE sup_mov SET deleted=1 WHERE deleted=0 AND batch IS NULL AND src='xls' AND NOT (${LEG_DEVIR})`).run(); c = await env.DB.prepare(`UPDATE sup_pay SET deleted=1 WHERE deleted=0 AND batch IS NULL AND src='xls'`).run(); }
    else { a = await env.DB.prepare('UPDATE sup_mov SET deleted=1 WHERE deleted=0 AND batch=?1').bind(b).run(); c = await env.DB.prepare('UPDATE sup_pay SET deleted=1 WHERE deleted=0 AND batch=?1').bind(b).run(); await env.DB.prepare('UPDATE cari_imp SET undone_at=?2 WHERE batch=?1').bind(b, iso()).run(); }
    // Geri alınca hiç hareketi kalmayan, elle açılmış ama başka kaydı olmayan cariler listeden kalkar
    await env.DB.prepare(`UPDATE suppliers SET manual=NULL WHERE manual=1 AND NOT EXISTS(SELECT 1 FROM sup_mov m WHERE m.deleted=0 AND m.supplier=suppliers.name) AND NOT EXISTS(SELECT 1 FROM sup_pay p WHERE p.deleted=0 AND p.supplier=suppliers.name) AND NOT EXISTS(SELECT 1 FROM purchases u WHERE u.cari_at IS NOT NULL AND u.status<>'deleted' AND u.supplier=suppliers.name COLLATE NOCASE)`).run();
    return json({ ok: true, n: ((a.meta && a.meta.changes) || 0) + ((c.meta && c.meta.changes) || 0) });
  }
  if (path === '/api/cari/delete') {
    // CARİYİ SİL: firmanın elle girilen / Excel'den gelen hareketleri ve ödemeleri silinir, cariye işlenmiş fişler cariden çıkarılır (fişler ve stok yerinde kalır)
    const sup = String(body.supplier || '').trim(); if (!sup) return bad('Firma seç.');
    const r = await env.DB.batch([env.DB.prepare('UPDATE sup_mov SET deleted=1 WHERE deleted=0 AND supplier=?1').bind(sup), env.DB.prepare('UPDATE sup_pay SET deleted=1 WHERE deleted=0 AND supplier=?1').bind(sup),
      env.DB.prepare('UPDATE purchases SET cari_at=NULL WHERE cari_at IS NOT NULL AND supplier=?1 COLLATE NOCASE').bind(sup), env.DB.prepare('UPDATE suppliers SET manual=NULL, terms=NULL, currency=NULL WHERE name=?1').bind(sup)]);
    return json({ ok: true });
  }
  if (path === '/api/cari/impclear') {
    // Excel'den yüklenen bütün hareketleri sil (önceki devir yüklemeleri dahil); elle girilenler ve fişler kalır
    const a = await env.DB.prepare(`UPDATE sup_mov SET deleted=1 WHERE deleted=0 AND (src='xls' OR note LIKE 'Hesap ekstresi devri%' OR note='Excel devir' OR note='Excel')`).run();
    const b = await env.DB.prepare(`UPDATE sup_pay SET deleted=1 WHERE deleted=0 AND src='xls'`).run();
    return json({ ok: true, n: ((a.meta && a.meta.changes) || 0) + ((b.meta && b.meta.changes) || 0) });
  }
  if (path === '/api/cari/paydel') {
    await env.DB.prepare('UPDATE sup_pay SET deleted=1 WHERE id=?1').bind(intOr(body.id, 0)).run();
    return json({ ok: true });
  }
  if (path === '/api/purchase/delete') {
    const id = intOr(body.id, 0); const r = await env.DB.prepare('SELECT status, cari_at FROM purchases WHERE id=?1').bind(id).first(); if (!r) return bad('Alış bulunamadı.', 404);
    if (r.status !== 'draft') return bad('Stoğa eklenmiş alış silinemez; önce stoktan geri al.');
    if (r.cari_at) return bad('Cariye işlenmiş alış silinemez; önce cariden çıkar.');
    await env.DB.prepare(`UPDATE purchases SET status='deleted' WHERE id=?1`).bind(id).run();
    return json({ ok: true });
  }
  if (path === '/api/outlists/revert') {
    // Çıkışı geri al: listedeki adetler stoğa geri eklenir (bir kez)
    const id = intOr(body.id, 0), r = await env.DB.prepare('SELECT * FROM out_lists WHERE id=?1').bind(id).first();
    if (!r) return bad('Liste bulunamadı.', 404);
    if (r.status === 'reverted') return bad('Bu liste zaten geri alınmış.');
    const upd = await env.DB.prepare(`UPDATE out_lists SET status='reverted', reverted_at=?2 WHERE id=?1 AND status<>'reverted'`).bind(id, iso()).run();
    if (!upd.meta || !upd.meta.changes) return bad('Bu liste zaten geri alınmış.');
    const st = []; for (const x of JSON.parse(r.items || '[]')) { let k = x.key; const p = await env.DB.prepare('SELECT key, merged_into FROM products WHERE key=?1').bind(k).first(); if (p && p.merged_into) k = p.merged_into; st.push(...changeQty(env, k, x.n, { type: 'in', channel: 'manuel', ref: 'out:' + id, note: 'Barkodla çıkış geri alındı · liste #' + id })); }
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    await env.DB.batch([REV(env)]);
    return json({ ok: true });
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
    const st = []; let inspectN = 0;
    for (const r of rows) {
      st.push(guardStmt(env, `(SELECT status FROM returns WHERE id=?1)='requested'`, r.id),
        env.DB.prepare(`UPDATE returns SET status=?1, decided_at=?2${tyApproved && r.ext_status === 'WaitingInAction' ? ", ext_status='WaitingFraudCheck', ext_at=?2" : ''} WHERE id=?3`).bind(body.accept ? 'accepted' : 'rejected', now, r.id));
      if (body.accept && !r.kept) st.push(...ensureProduct(env, r.pkey, { sku: r.sku, name: r.name }, null), ...retStock(env, r.id, r.pkey, r.qty, body.defect === undefined ? needsInspect(r.reason, r.cnote, r.note) : !!body.defect, { type: 'ret', channel: r.channel, ref: r.order_no, note: tyApproved ? 'Depoya ulaştı, Trendyol\'da onaylandı' : 'Depoya ulaştı, kabul edildi' }));
      st.push(unguard(env));
    }
    st.push(REV(env));
    try { await env.DB.batch(st); } catch (e) { return bad(tyApproved ? 'Trendyol\'da onaylandı ama stok güncellenemedi; sayfayı yenileyip "Depoya ulaştı" ile stoğu ekle.' : 'Bu iade az önce başka bir yerden işlendi.', 409); }
    return json({ ok: true, tyApproved, inspect: inspectN });
  }
  if (path === '/api/shopify/connect') {
    const shop = String(body.shop || '').trim(), cid = String(body.cid || '').trim(), secret = String(body.secret || '').trim();
    if (!shop || !cid || !secret) return bad('Mağaza adresi, Client ID ve Client secret gerekli.');
    const c = { shop: shop.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '').replace(/\/.*$/, ''), cid, secret, token: '', exp: 0 };
    try { await shToken(env, c, true); const d = await shGql(env, c, '{shop{name currencyCode}}'); c.name = d.shop.name; }
    catch (e) { return bad(String(e.message || e)); }
    const start = body.start && Date.parse(body.start) ? new Date(Date.parse(body.start)).toISOString() : iso();
    await env.DB.batch([setStmt(env, 'sh_shop', c.shop), setStmt(env, 'sh_cid', cid), setStmt(env, 'sh_secret', secret), setStmt(env, 'sh_name', c.name || ''), setStmt(env, 'sh_start', start), setStmt(env, 'sh_hwm', start), setStmt(env, 'sh_err', ''), setStmt(env, 'sh_hook_ok', ''), setStmt(env, 'sh_hook_try', '0'), setStmt(env, 'run_sh_at', '0')]);
    try { await syncShopifyProducts(env); } catch (e) { await setSetting(env, 'sh_err', iso() + ' · Ürünler: ' + String(e.message || e).slice(0, 200)); }
    let first = null; try { first = await syncShopifyOrders(env); } catch (e) { await setSetting(env, 'sh_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); }
    try { await ensureShopifyHooks(env, true); } catch (e) { await setSetting(env, 'sh_hook_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); }
    return json({ ok: true, name: c.name, first });
  }
  if (path === '/api/shopify/push') { await env.DB.batch([setStmt(env, 'sh_push', body.on ? '1' : '0'), setStmt(env, 'sh_push_err', '')]); return json({ ok: true }); }
  if (path === '/api/shopify/pause') {
    // Duraklat / devam: bilgiler silinmez; devam edince duraklatılan süredeki siparişler de sırayla işlenir
    const on = !!body.paused; await setSetting(env, 'sh_paused', on ? '1' : '');
    let r = null; if (!on) { try { r = await syncShopifyOrders(env, { pages: 5 }); } catch (e) { await setSetting(env, 'sh_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); } }
    return json({ ok: true, r });
  }
  if (path === '/api/shopify/disconnect') {
    await env.DB.batch(['sh_cid', 'sh_secret', 'sh_token', 'sh_token_exp', 'sh_hook_ok'].map(k => setStmt(env, k, '')));
    return json({ ok: true });
  }
  if (path === '/api/shopify/sync') {
    try { const r = await syncShopifyOrders(env, { pages: 5 }); await env.DB.batch([setStmt(env, 'sh_err', '')]); return json({ ok: true, r }); }
    catch (e) { await setSetting(env, 'sh_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); return bad(String(e.message || e)); }
  }
  if (path === '/api/shopify/products') {
    try { return json({ ok: true, r: await syncShopifyProducts(env, true) }); } catch (e) { return bad(String(e.message || e)); }
  }
  // ---------- Shopify adres düzeltme ----------
  if (path === '/api/shaddr/list') {
    const c = await shCreds(env); if (!shConfigured(c)) return bad('Shopify bağlı değil. Önce Bağlantılar bölümünden Shopify\'ı bağla.');
    // Sadece kargolanmamış (iptal edilmemiş) siparişler, tarih sınırı yok; sayfa sayfa (istek başına en çok 200, devamı "Daha fazla yükle" ile)
    const term = String(body.q || '').trim().replace(/['"\\]/g, '').slice(0, 60);
    let q = 'status:open -fulfillment_status:shipped';
    if (term) q += ' ' + (/^#?\d+$/.test(term) ? `name:#${term.replace('#', '')}` : term);
    try {
      let after = body.after || null, nodes = [], more = false;
      for (let page = 0; page < 8; page++) {
        const d = await shGql(env, c, SH_ADDR_Q, { q, after }); nodes.push(...d.orders.nodes);
        more = d.orders.pageInfo.hasNextPage; after = d.orders.pageInfo.endCursor; if (!more) break;
      }
      const left = o => { const L = o.lineItems || {}; return (L.pageInfo && L.pageInfo.hasNextPage) || (L.nodes || []).some(l => Number(l.unfulfilledQuantity) > 0); };
      const orders = nodes.filter(o => !o.test && !o.cancelledAt && !o.closed && left(o) && !['FULFILLED', 'RESTOCKED'].includes(o.displayFulfillmentStatus)).map(o => ({
        gid: o.id, name: o.name, createdAt: o.createdAt, cancelled: !!o.cancelledAt, fulfill: o.displayFulfillmentStatus, note: o.note || '', email: o.email || '', phone: o.phone || '',
        total: Number(((o.totalPriceSet || {}).shopMoney || {}).amount) || 0, items: ((o.lineItems || {}).nodes || []).filter(l => Number(l.unfulfilledQuantity) > 0).map(l => `${l.unfulfilledQuantity}× ${l.name}`),
        addr: o.shippingAddress || null }));
      const log = body.after ? null : (await env.DB.prepare('SELECT id, gid, order_no, before, after, at FROM sh_addr_log ORDER BY id DESC LIMIT 30').all()).results;
      const ships = orders.length ? (await selectIn(env, 'SELECT ref, gid, order_no, adet, desi, addr, lines, msg, at, tracking, track_at, track_msg, fulfilled_at, fulfill_err, exported_at, mode FROM sr_ship', 'gid', orders.map(o => o.gid))).map(r => ({ ...r, addr: JSON.parse(r.addr || '{}'), lines: JSON.parse(r.lines || '[]') })) : [];
      return json({ ok: true, orders, log, ships, after: more ? after : null });
    } catch (e) { return bad(shAddrErr(e)); }
  }
  // ---------- Sürat Kargo ----------
  if (path === '/api/tycari/sync') { try { return json({ ok: true, r: await tySettleSync(env, 3) }); } catch (e) { await setSetting(env, 'ty_set_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); return bad(String(e.message || e), 502); } }
  if (path === '/api/tycari/diag') { const sid = env.TRENDYOL_SELLER_ID, end = Date.now(), st = end - 14 * 86400000;
    const a = await ty(env, `finance/che/sellers/${sid}/settlements`, { transactionType: 'Sale', startDate: st, endDate: end, page: 0, size: 500, supplierId: sid }).catch(e => ({ err: String(e.message) }));
    const b = await ty(env, `finance/che/sellers/${sid}/otherfinancials`, { transactionType: 'PaymentOrder', startDate: st, endDate: end, page: 0, size: 500, supplierId: sid }).catch(e => ({ err: String(e.message) }));
    const { results: dd } = await env.DB.prepare(`SELECT tx_ms, due_ms, po FROM ty_set WHERE type='Sale' AND tx_ms IS NOT NULL AND due_ms IS NOT NULL`).all(); const gap = {}, wd = {}, WD = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
    for (const x of dd) { const g0 = Math.round((Date.parse(trDay(x.due_ms)) - Date.parse(trDay(x.tx_ms))) / 86400000); gap[g0] = (gap[g0] || 0) + 1; const w = WD[new Date(trDay(x.due_ms) + 'T12:00:00Z').getUTCDay()]; wd[w] = (wd[w] || 0) + 1; }
    const poDays = (await env.DB.prepare('SELECT day, amount FROM ty_po ORDER BY day DESC LIMIT 10').all()).results.map(x => x.day + ' ' + WD[new Date(x.day + 'T12:00:00Z').getUTCDay()] + ' ' + x.amount);
    const c = await env.DB.prepare('SELECT COUNT(*) n, COUNT(due_ms) due, MIN(tx_ms) a, MAX(tx_ms) b FROM ty_set').first(), d = await env.DB.prepare('SELECT COUNT(*) n, SUM(amount) t FROM ty_po').first(), e = await env.DB.prepare(`SELECT COUNT(*) n, COUNT(delivered) d FROM audit_pkg WHERE status='Delivered'`).first();
    const s0 = await getSettings(env, ['ty_settle_at', 'ty_settle_cur', 'ty_set_err', 'ty_po_err']);
    return json({ vadeFarki_gun: gap, vadeGunleri: wd, odemeGunleri: poDays, ozet: { satirlar: c.n, vadeli: c.due, ilk: c.a ? trDay(c.a) : null, son: c.b ? trDay(c.b) : null, odemeEmri: d.n, odemeToplam: r2(d.t || 0), teslimPaket: e.n, teslimTarihli: e.d, sonOkuma: s0.ty_settle_at || '', hata: s0.ty_set_err || '', odemeHata: s0.ty_po_err || '' }, satis: a.err || (a.content || []).slice(0, 2).map(x => ({ transactionDate: x.transactionDate && trDay(x.transactionDate), paymentDate: x.paymentDate && trDay(x.paymentDate), paymentPeriod: x.paymentPeriod, paymentOrderId: x.paymentOrderId, orderDate: x.orderDate && trDay(x.orderDate), sellerRevenue: x.sellerRevenue })), odeme: b.err || (b.content || []).slice(0, 3).map(x => ({ id: x.id, transactionDate: x.transactionDate && trDay(x.transactionDate), paymentDate: x.paymentDate && trDay(x.paymentDate), debt: x.debt, credit: x.credit, paymentOrderId: x.paymentOrderId, description: x.description })) }); }
  if (path === '/api/tycari/recon') {
    // Trendyol mutabakatı: her siparişin neti (satıcı hakedişi), teslim günü, kurala göre vade (teslim + 28 gün sonraki ilk salı/perşembe), Trendyol'un yazdığı vade ve hakediş ödemeleri
    const rs = (await reportStart(env)) || '2026-10-01', from = iso(dayStartTR(rs)), today = trToday();
    const EI = (await env.DB.prepare('SELECT * FROM ty_early_inv').all()).results;
    const [oR, sR, aR, pR] = await env.DB.batch([env.DB.prepare(`SELECT id, order_no, date, lines FROM orders WHERE channel='trendyol' AND date >= ?1 ORDER BY date DESC`).bind(from),
      env.DB.prepare(`SELECT order_no, type, tx_ms, due_ms, net, po, period FROM ty_set WHERE order_no IN (SELECT order_no FROM orders WHERE channel='trendyol' AND date >= ?1)`).bind(from),
      env.DB.prepare(`SELECT order_no, MIN(delivered) d, GROUP_CONCAT(DISTINCT status) st FROM audit_pkg WHERE order_no IN (SELECT order_no FROM orders WHERE channel='trendyol' AND date >= ?1) GROUP BY order_no`).bind(from),
      env.DB.prepare('SELECT day, SUM(amount) amount, COUNT(*) n FROM ty_po WHERE day >= ?1 GROUP BY day ORDER BY day').bind(rs)]);
    const S = new Map(); for (const x of sR.results) { const g = S.get(x.order_no) || { net: 0, sale: null, due: null, ret: 0, po: null }; g.net += x.net || 0; if (x.po) g.po = x.po; if (x.type === 'Sale') { if (x.tx_ms && (!g.sale || x.tx_ms < g.sale)) g.sale = x.tx_ms; if (x.due_ms && (!g.due || x.due_ms > g.due)) g.due = x.due_ms; if (x.period) g.period = x.period; } if (x.type === 'Return') g.ret += x.net || 0; S.set(x.order_no, g); }
    const A = new Map(aR.results.map(x => [x.order_no, x])), PO = new Map(pR.results.map(x => [x.day, x])), out = [];
    for (const r of oR.results) { let lines = []; try { lines = JSON.parse(r.lines || '[]'); } catch (e) {} if (!lines.some(l => l.status !== 'cancelled')) continue;
      const g = S.get(r.order_no), a = A.get(r.order_no), deliv = (a && a.d) || (g && g.sale ? trDay(g.sale) : null), rule = tyPayDay(deliv), tyDue = g && g.due ? trDay(g.due) : null, paidPo = !!(g && g.po && tyDue && tyDue <= today), day = paidPo ? tyDue : tyDue ? tyPayout(tyDue) : rule; // Trendyol'un ekstredeki vade tarihi → o haftanın ödeme günü (pazartesi/perşembe); ödendiyse ödendiği gün // ödendiyse Trendyol'un ödediği gün; değilse kural (teslim + 28 gün → ilk salı/perşembe) esas; Trendyol vadesi yalnızca bilgi
      const net = g ? r2(g.net) : null, st = !g ? (deliv ? 'nosale' : 'transit') : net <= 0.01 ? 'zero' : paidPo ? (tyDue && rule && tyDue < rule ? 'early' : 'paid') : day && day < today ? (PO.has(day) ? 'paid' : 'late') : 'pending'; // ekstre satırında ödeme emri no varsa ödenmiştir
      out.push({ id: r.id, orderNo: r.order_no, date: r.date, deliv, rule, tyDue, day, period: g ? g.period || null : null, po: g ? g.po : null, net, ret: g ? r2(g.ret) : 0, diffDay: rule && tyDue && rule !== tyDue, pkgSt: a ? a.st : '', st }); }
    const sch = new Map(); for (const x of out) if (x.day && x.net > 0 && x.st !== 'transit') { const g = sch.get(x.day) || { day: x.day, net: 0, n: 0 }; g.net = r2(g.net + x.net); g.n++; sch.set(x.day, g); }
    const schedule = [...sch.values()].sort((a, b) => a.day < b.day ? -1 : 1).map(g => { const p = PO.get(g.day); return { ...g, efee: r2(EI.filter(e => e.matched && e.day === g.day).reduce((a, e) => a + (e.amount || 0), 0)), paid: p ? r2(p.amount) : null, diff: p ? r2(p.amount - g.net) : null, future: g.day >= today }; });
    for (const [d, p] of PO) if (!sch.has(d)) schedule.push({ day: d, net: 0, n: 0, efee: r2(EI.filter(e => e.matched && e.day === d).reduce((a, e) => a + (e.amount || 0), 0)), paid: r2(p.amount), diff: r2(p.amount), future: false, extra: true }); schedule.sort((a, b) => a.day < b.day ? -1 : 1);
    const sum = (f) => r2(out.filter(f).reduce((a, x) => a + (x.net || 0), 0)), cnt = (k) => out.filter(x => x.st === k || (k === 'paid' && x.st === 'early')).length;
    return json({ ok: true, items: out, n: out.length, schedule, next: schedule.find(x => x.future && x.net > 0) || null,
      tot: { pending: sum(x => x.st === 'pending'), late: sum(x => x.st === 'late'), paidNet: sum(x => x.st === 'paid' || x.st === 'early'), earlyNet: sum(x => x.st === 'early'), poTotal: r2(pR.results.reduce((a, x) => a + (x.amount || 0), 0)), transit: cnt('transit') + cnt('nosale') },
      counts: { early: out.filter(x => x.st === 'early').length, pending: cnt('pending'), late: cnt('late'), paid: cnt('paid'), transit: cnt('transit'), nosale: cnt('nosale'), diffDay: out.filter(x => x.diffDay).length }, at: (await getSetting(env, 'ty_settle_at')) || '', early: { total: r2(EI.reduce((a, e) => a + (e.amount || 0), 0)), matched: r2(EI.filter(e => e.matched).reduce((a, e) => a + (e.amount || 0), 0)), n: EI.length, un: EI.filter(e => !e.matched).length } });
  }
  if (path === '/api/paytr/recon') {
    // PayTR mutabakatı: Shopify online siparişlerde beklenen tutar (ürün + 700 TL altı 100 TL kargo) ile PayTR'nin işlediği tutar, komisyonu, neti ve hesaba yattığı gün
    const rs = (await reportStart(env)) || '2026-10-01', from = iso(dayStartTR(rs));
    const [oR, tR, pR] = await env.DB.batch([env.DB.prepare(`SELECT o.id, o.order_no, o.date, o.lines, p.cod, p.subtotal, p.total, p.tx, p.gateway, p.delivered shd, s.teslim srd, b.delivered bkd FROM orders o JOIN sh_pay p ON p.no = replace(o.order_no,'#','') LEFT JOIN sr_cost s ON s.no = p.no LEFT JOIN bk_ship b ON b.no = p.no WHERE o.channel='shopify' AND o.date >= ?1 AND COALESCE(p.cod,0)=0 ORDER BY o.date`).bind(from),
      env.DB.prepare(`SELECT * FROM paytr_tx WHERE tarih >= ?1 ORDER BY tarih`).bind(addDayStr(rs, -1)), env.DB.prepare('SELECT * FROM pt_payout WHERE day >= ?1 ORDER BY day DESC').bind(rs)]);
    const sales = tR.results.filter(x => x.tip === 'S'), refunds = tR.results.filter(x => x.tip === 'I'), used = new Set(), out = [];
    for (const r of oR.results) { let lines = []; try { lines = JSON.parse(r.lines || '[]'); } catch (e) {} const act = lines.filter(l => l.status !== 'cancelled'); if (!act.length) continue;
      const sub = r2(r.subtotal !== null ? r.subtotal : act.reduce((a, l) => a + ((l.fin && l.fin.revenue) || 0), 0)), exp = r2(sub + (sub > 0 && sub < SH_FREE_SHIP ? SH_SHIP_FEE : 0)), day = trDay(Date.parse(r.date)), ids = String(r.tx || '').split(' ').filter(Boolean);
      let m = ids.length ? sales.find(x => !used.has(x.k) && x.siparis_no && ids.some(t => t === x.siparis_no || t.includes(x.siparis_no))) : null;
      if (!m) m = sales.find(x => !used.has(x.k) && Math.abs((x.tutar || 0) - exp) < 0.06 && x.tarih === day) || sales.find(x => !used.has(x.k) && Math.abs((x.tutar || 0) - exp) < 0.06 && Math.abs(Date.parse(x.tarih) - Date.parse(day)) <= 86400000);
      if (!m) { const c = sales.filter(x => !used.has(x.k) && x.tarih === day && Math.abs((x.tutar || 0) - exp) <= exp * 0.15).sort((a, b) => Math.abs(a.tutar - exp) - Math.abs(b.tutar - exp)); if (c.length) m = c[0]; } // aynı gün en yakın tutar: fark olarak gösterilir
      if (m) used.add(m.k);
      const lag = m && m.paid_day ? Math.round((Date.parse(m.paid_day) - Date.parse(m.tarih)) / 86400000) : null;
      const deliv = dlvDay(r.srd) || r.bkd || r.shd || null, dlag = m && m.paid_day && deliv ? Math.round((Date.parse(m.paid_day) - Date.parse(deliv)) / 86400000) : null; // PayTR ödemeyi teslimata göre yapar
      out.push({ id: r.id, orderNo: r.order_no, date: r.date, exp, pt: m ? r2(m.tutar) : null, kes: m ? r2(m.kesinti || 0) : null, oran: m ? m.oran : null, net: m ? r2(m.net || 0) : null, paid: m ? m.paid_day || null : null, lag, deliv, dlag, due: deliv ? ptPayDay(deliv) : null, diff: m ? r2(m.tutar - exp) : null, st: !m ? 'nodata' : Math.abs(m.tutar - exp) < 1 ? 'ok' : 'diff' }); }
    const orphan = sales.filter(x => !used.has(x.k)).map(x => ({ siparis_no: x.siparis_no, tutar: x.tutar, tarih: x.tarih, paid: x.paid_day, odeme: x.odeme_tipi || '' }));
    // Eşleşmeyen her PayTR işlemi için aday Shopify siparişleri (±1 gün, tutar ±%15): neden eşleşmediği yazılır
    if (orphan.length) { const { results: cand } = await env.DB.prepare(`SELECT o.id, o.order_no, o.date, o.lines, p.cod, p.card, p.subtotal, p.total, p.gateway FROM orders o LEFT JOIN sh_pay p ON p.no = replace(o.order_no,'#','') WHERE o.channel='shopify' AND o.date >= ?1`).bind(iso(dayStartTR(addDayStr(rs, -2)))).all();
      for (const x of orphan.slice(0, 50)) { const t0 = Date.parse(x.tarih + 'T12:00:00+03:00');
        x.cands = cand.filter(c => Math.abs(Date.parse(c.date) - t0) <= 36 * 3600000).map(c => { let lines = []; try { lines = JSON.parse(c.lines || '[]'); } catch (e) {} const act = lines.filter(l => l.status !== 'cancelled'), tot = c.total !== null && c.total !== undefined ? r2(c.total) : null;
          const sub = r2(c.subtotal !== null && c.subtotal !== undefined ? c.subtotal : lines.reduce((a, l) => a + ((l.fin && l.fin.revenue) || 0), 0)), exp = r2(sub + (sub > 0 && sub < SH_FREE_SHIP ? SH_SHIP_FEE : 0));
          const amt = tot !== null ? tot : exp; if (Math.abs(amt - x.tutar) > x.tutar * 0.15 + 1) return null;
          const why = !act.length ? 'Shopify\'da iptal / tamamen iade edilmiş' : c.cod ? `Shopify'da kapıda ödeme görünüyor (${c.gateway || ''})` : c.total === null || c.total === undefined ? 'Shopify ödeme bilgisi henüz okunmamış' : Date.parse(c.date) < Date.parse(from) ? 'rapor başlangıcından (1 Ekim) önce verilmiş' : Math.abs(amt - x.tutar) >= 1 ? `tutar farklı (Shopify ${amt} TL)` : 'başka bir PayTR işlemiyle eşleşmiş olabilir';
          return { id: c.id, orderNo: c.order_no, date: c.date, amt, why }; }).filter(Boolean).slice(0, 4); } }
    const st3 = (k) => { const a = out.filter(x => x[k] !== null && x[k] !== undefined).map(x => x[k]).sort((p, q) => p - q); return a.length ? { min: a[0], max: a[a.length - 1], med: a[Math.floor(a.length / 2)], avg: r2(a.reduce((p, q) => p + q, 0) / a.length), n: a.length } : null; };
    const lags = out.filter(x => x.lag !== null).map(x => x.lag).sort((a, b) => a - b), mm = (k, f = () => true) => r2(out.filter(x => x.st !== 'nodata' && f(x)).reduce((a, x) => a + (x[k] || 0), 0));
    const today = trToday(), dueM = new Map(); for (const x of out) if (x.st !== 'nodata' && !x.paid && x.due) { const g = dueM.get(x.due) || { day: x.due, net: 0, n: 0 }; g.net = r2(g.net + (x.net || 0)); g.n++; dueM.set(x.due, g); }
    const dueList = [...dueM.values()].sort((a, b) => a.day < b.day ? -1 : 1).map(g => ({ ...g, late: g.day < today }));
    const pend = mm('net', x => !x.paid), paidTot = r2(pR.results.reduce((a, x) => a + (x.net || 0), 0));
    return json({ ok: true, items: out.reverse(), n: out.length, matched: out.filter(x => x.st !== 'nodata').length, ok_n: out.filter(x => x.st === 'ok').length, diff_n: out.filter(x => x.st === 'diff').length,
      tot: { exp: mm('exp'), pt: mm('pt'), kes: mm('kes'), net: mm('net'), pend, paid: paidTot, refunds: r2(refunds.reduce((a, x) => a + (x.tutar || 0), 0)) },
      lag: lags.length ? { min: lags[0], max: lags[lags.length - 1], med: lags[Math.floor(lags.length / 2)], n: lags.length } : null, lagD: st3('dlag'), dueList, noDue: out.filter(x => x.st !== 'nodata' && !x.paid && !x.due).length, delivN: out.filter(x => x.deliv).length, payouts: pR.results.slice(0, 60), orphan: orphan.slice(0, 50), orphanN: orphan.length });
  }
  if (path === '/api/paytr/rawdiag') { const cr = await ptCreds(env); const d = trToday(); const a = await ptPost(cr, 'https://www.paytr.com/rapor/odeme-dokumu/', { start_date: addDayStr(d, -14), end_date: d }, cr.id + addDayStr(d, -14) + d + cr.salt).catch(e => ({ err: String(e.message) }));
    const p1 = a.list && a.list[0]; const day = p1 ? ptDay(String(p1.date_paid || '')) : addDayStr(d, -1); const b = await ptPost(cr, 'https://www.paytr.com/rapor/odeme-detayi/', { date: day }, cr.id + day + cr.salt).catch(e => ({ err: String(e.message) }));
    const mask = (o) => JSON.parse(JSON.stringify(o || null, (k, v) => /iban|name|kart|pan/i.test(k) ? '•' : v)); const oids = (b.list || []).flat(4).map(ptOid).filter(Boolean), hit = oids.length ? (await env.DB.prepare(`SELECT COUNT(*) n FROM paytr_tx WHERE siparis_no IN (${oids.slice(0, 90).map(() => '?').join(',')})`).bind(...oids.slice(0, 90)).first()).n : 0;
    const pd = await env.DB.prepare(`SELECT COUNT(*) n, SUM(detailed) d FROM pt_payout`).first(), lk = await env.DB.prepare(`SELECT COUNT(*) n FROM paytr_tx WHERE paid_day IS NOT NULL`).first();
    return json({ ozet: { detayGunu: day, detaySatir: (b.list || []).flat(4).length, siparisNoBulunan: oids.length, bizdeEslesen: hit, odemeGunu: pd.n, detayiOkunanGun: pd.d || 0, yattiIsaretli: lk.n }, detay: b.err || mask(b.list && b.list.slice(0, 2)), detayKeys: b.raw ? Object.keys(b.raw) : [], dokum: a.err || mask(a.raw && a.raw.paid_list ? a.raw.paid_list.slice(0, 2) : a.raw) }); }
  if (path === '/api/paytr/status') {
    const cr = await ptCreds(env), s0 = await getSettings(env, ['pt_sync_at', 'pt_err']);
    const c = await env.DB.prepare(`SELECT COUNT(*) n, SUM(tip='S') sales, SUM(tip='I') refunds, SUM(CASE WHEN tip='S' THEN kesinti END) kes, AVG(CASE WHEN tip='S' AND oran>0 THEN oran END) oran, MIN(tarih) a, MAX(tarih) b FROM paytr_tx`).first();
    const smp = (await env.DB.prepare(`SELECT siparis_no, tutar, tarih FROM paytr_tx WHERE tip='S' ORDER BY tarih DESC LIMIT 3`).all()).results;
    return json({ connected: !!(cr.id && cr.key && cr.salt), id: cr.id ? cr.id.slice(0, 2) + '•••' + cr.id.slice(-2) : '', syncAt: s0.pt_sync_at || '', err: s0.pt_err || '', ...c, sample: smp });
  }
  if (path === '/api/paytr/connect') {
    const cr = { id: String(body.id || '').trim(), key: String(body.key || '').trim(), salt: String(body.salt || '').trim() };
    if (!cr.id || !cr.key || !cr.salt) return bad('Mağaza no, Mağaza Parola (merchant_key) ve Mağaza Gizli Anahtar (merchant_salt) üçü de gerekli.');
    try { await ptList(env, cr, Date.now() - 2 * 86400000, Date.now()); } catch (e) { return bad('PayTR bağlantısı kurulamadı: ' + e.message); }
    await env.DB.batch([setStmt(env, 'pt_id', cr.id), setStmt(env, 'pt_key', cr.key), setStmt(env, 'pt_salt', cr.salt), setStmt(env, 'pt_cursor', '')]);
    try { const r = await ptSync(env, 8); return json({ ok: true, r }); } catch (e) { return json({ ok: true, err: String(e.message || e) }); }
  }
  if (path === '/api/paytr/sync') { try { return json({ ok: true, r: await ptSync(env, 10) }); } catch (e) { await setSetting(env, 'pt_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); return bad(String(e.message || e), 502); } }
  if (path === '/api/paytr/disconnect') { await env.DB.batch([setStmt(env, 'pt_id', ''), setStmt(env, 'pt_key', ''), setStmt(env, 'pt_salt', '')]); return json({ ok: true }); }
  if (path === '/api/bk/status') {
    const s0 = await getSettings(env, ['bk_token', 'bk_sync_at', 'bk_sync_msg']), c = await env.DB.prepare('SELECT COUNT(*) n, SUM(fee IS NOT NULL) f, SUM(cod) c, SUM(cod=1 AND cod_fee IS NULL) cp, MIN(created) a, MAX(created) b FROM bk_ship').first();
    const mt = await env.DB.prepare(`SELECT COUNT(*) n FROM bk_ship b WHERE EXISTS(SELECT 1 FROM orders o WHERE o.channel='shopify' AND replace(o.order_no,'#','')=b.no)`).first();
    const smp = (await env.DB.prepare('SELECT no FROM bk_ship ORDER BY created DESC LIMIT 4').all()).results.map(x => x.no), so = (await env.DB.prepare(`SELECT order_no FROM orders WHERE channel='shopify' AND date < ?1 ORDER BY date DESC LIMIT 4`).bind('2026-10-17T07:00:00Z').all()).results.map(x => x.order_no);
    return json({ matched: mt ? mt.n : 0, sampleBk: smp, sampleSh: so, connected: !!(env.BASIT_KARGO_TOKEN || s0.bk_token), syncAt: s0.bk_sync_at || '', msg: s0.bk_sync_msg || '', n: c.n || 0, withFee: c.f || 0, cod: c.c || 0, codPending: c.cp || 0, from: c.a || '', to: c.b || '', cutoff: BK_CUTOFF });
  }
  if (path === '/api/bk/connect') {
    const t = String(body.token || '').trim(); if (t.length < 10) return bad('API anahtarını (token) yapıştır.');
    try { await bkCall({ ...env, BASIT_KARGO_TOKEN: t }, 'POST', '/v2/order/filter', { page: 0, size: 1 }); } catch (e) { return bad('Basit Kargo bağlantısı kurulamadı: ' + e.message); }
    await setSetting(env, 'bk_token', t); return json({ ok: true });
  }
  if (path === '/api/bk/disconnect') { await setSetting(env, 'bk_token', ''); return json({ ok: true }); }
  if (path === '/api/bk/sync') {
    try { const r = await bkSync(env); return json({ ok: true, ...r }); } catch (e) { await setSetting(env, 'bk_sync_msg', iso() + ' · ' + String(e.message || e).slice(0, 200)); return bad('Basit Kargo: ' + e.message, 502); }
  }
  if (path === '/api/bk/order') {
    // Teşhis: bir Shopify siparişinin Basit Kargo'daki bütün gönderileri ve ücret dökümü (kişisel bilgi yok)
    const no = String(body.no || '').replace(/\D/g, ''); if (!no) return bad('Sipariş no yaz.');
    const L = await bkCall(env, 'POST', '/v2/order/filter', { keyword: no, page: 0, size: 20 });
    const arr = (Array.isArray(L.list) ? L.list : []).filter(o => String(o.orderNumber || '').replace(/\D/g, '') === no);
    const row = await env.DB.prepare('SELECT * FROM bk_ship WHERE no=?1').bind(no).first();
    return json({ ok: true, saved: row, shipments: arr.map(o => ({ id: o.id, type: o.type, status: o.status, created: o.createdTime, handler: o.shipmentInfo && o.shipmentInfo.handler && o.shipmentInfo.handler.name, priceInfo: o.priceInfo, codInfo: o.codInfo ? { ...o.codInfo, amount: o.codInfo.amount } : null, orderTotal: o.orderTotal, desi: o.content && o.content.totalDesiKg })) });
  }
  if (path === '/api/bk/sample') {
    // Teşhis: alan adlarını görmek için ilk 2 gönderinin kişisel bilgileri çıkarılmış yapısı
    const L = await bkCall(env, 'POST', '/v2/order/filter', { page: 0, size: 2, endDate: bkTime(BK_CUTOFF_MS) });
    const strip = (o, d = 0) => { if (Array.isArray(o)) return o.slice(0, 2).map(x => strip(x, d + 1)); if (!o || typeof o !== 'object') return o; const out = {}; for (const [k, v] of Object.entries(o)) out[k] = /name|phone|address|mail|city|town|district|street|surname|note|tckn|identity/i.test(k) && typeof v !== 'object' ? '•' : d > 4 ? '…' : strip(v, d + 1); return out; };
    return json({ ok: true, sample: strip(L.list) });
  }
  if (path === '/api/surat/status') {
    const c = await srCreds(env), s = await getSettings(env, ['sr_err', 'sr_ok']);
    const tk = await getSettings(env, ['sr_track_err', 'sr_mode']);
    const mask = (x) => x ? x.slice(0, 2) + '•••' + x.slice(-2) : '';
    return json({ connected: !!((c.user || c.cari) && c.pass), cari: mask(c.cari), user: mask(c.user), web: !!c.web, mode: tk.sr_mode === 'api' ? 'api' : 'excel', desi: c.desi, err: s.sr_err || '', trackErr: tk.sr_track_err || '', ok: s.sr_ok || '' });
  }
  if (path === '/api/surat/connect') {
    const user = String(body.user || '').trim(), cari = String(body.cari || '').trim() || user, pass = String(body.pass || '').trim(), desi = Math.max(0.5, Math.min(300, Number(String(body.desi || '2').replace(',', '.')) || 2));
    if (!user || !pass) return bad('Kullanıcı adı ve şifre gerekli.');
    try { await srSchema(env, true); } catch (e) { return bad(String(e.message || e)); }
    await env.DB.batch([setStmt(env, 'sr_cari', cari), setStmt(env, 'sr_user', user), setStmt(env, 'sr_pass', pass), setStmt(env, 'sr_web', String(body.web || '').trim()), setStmt(env, 'sr_desi', String(desi)), setStmt(env, 'sr_err', '')]);
    return json({ ok: true });
  }
  if (path === '/api/surat/settings') { const desi = Math.max(0.5, Math.min(300, Number(String(body.desi || '2').replace(',', '.')) || 2)); await env.DB.batch([setStmt(env, 'sr_desi', String(desi)), ...(body.web !== undefined ? [setStmt(env, 'sr_web', String(body.web || '').trim())] : [])]); return json({ ok: true }); }
  if (path === '/api/srcari/summary') {
    // Sürat cari: alacak = kapıda tahsil edilen; borç = kargo ücretleri; hareketler = Sürat'ın aktardığı (in) / bizim ödediğimiz (out) / düzeltme
    const t = await env.DB.prepare(`SELECT COUNT(*) n, SUM(fee) fee, SUM(CASE WHEN cod>0 THEN cod END) codAll, SUM(CASE WHEN cod>0 THEN 1 END) codN, SUM(CASE WHEN cod>0 AND collected=1 THEN COALESCE(NULLIF(coll_amt,0), cod) END) coll, SUM(CASE WHEN cod>0 AND collected=1 THEN 1 END) collN, SUM(CASE WHEN cod>0 AND collected=0 THEN cod END) pend, MIN(day) a, MAX(day) b FROM sr_rows`).first();
    const mv = (await env.DB.prepare('SELECT * FROM sr_mov WHERE deleted=0 ORDER BY day DESC, id DESC LIMIT 200').all()).results;
    // Ödeme takvimi: teslim edilen kapıda ödemeli gönderiler, teslim haftasının ertesi haftası perşembe
    const { results: cr } = await env.DB.prepare(`SELECT s.takip, s.cod, s.coll_amt, s.collected, c.teslim FROM sr_rows s LEFT JOIN sr_cost c ON c.tracking = s.takip WHERE s.cod > 0`).all();
    const today = trToday(), sch = new Map(); let noDl = 0, noDlAmt = 0;
    for (const x of cr) { const dl = dlvDay(x.teslim), amt = r2(x.collected && x.coll_amt ? x.coll_amt : x.cod || 0); if (!dl) { if (x.collected) { noDl++; noDlAmt = r2(noDlAmt + amt); } continue; }
      const pd = srPayDay(dl), g = sch.get(pd) || { day: pd, amount: 0, n: 0 }; g.amount = r2(g.amount + amt); g.n++; sch.set(pd, g); }
    const inMv = mv.filter(x => x.kind === 'in'), schedule = [...sch.values()].sort((a, b) => a.day < b.day ? -1 : 1).map(g => { const got = r2(inMv.filter(x => Math.abs(Date.parse(x.day) - Date.parse(g.day)) <= 2 * 86400000).reduce((a, x) => a + (x.amount || 0), 0)); return { ...g, got, st: g.day > today ? 'future' : got >= g.amount - 1 ? 'paid' : 'late' }; });
    const sumK = (k) => r2(mv.filter(x => x.kind === k).reduce((a, x) => a + (x.amount || 0), 0));
    const fee = r2(t.fee || 0), coll = r2(t.coll || 0), inn = sumK('in'), out = sumK('out'), adj = sumK('adj');
    const bal = r2(coll - fee - inn + out + adj); // + : Sürat bize borçlu, − : biz Sürat'a borçluyuz
    return json({ ok: true, schedule, noDl, noDlAmt, next: schedule.find(x => x.day >= today) || null, n: t.n || 0, fee, codAll: r2(t.codAll || 0), codN: t.codN || 0, coll, collN: t.collN || 0, pend: r2(t.pend || 0), from: t.a || '', to: t.b || '', inn, out, adj, bal, moves: mv });
  }
  if (path === '/api/srcari/recon') {
    // Sipariş bazında Sürat mutabakatı (17.10.2026 10:00 sonrası Shopify): bizim beklediğimiz (tahsilat − ücret) ile Sürat raporundaki (tahsilat − ücret)
    const rs = await reportStart(env), from = iso(Math.max(Date.parse(SURAT_DIRECT_FROM), /^\d{4}-\d{2}-\d{2}$/.test(rs || '') ? dayStartTR(rs) : 0));
    const [oR, pR] = await env.DB.batch([env.DB.prepare(`SELECT o.id, o.order_no, o.date, o.lines, p.cod, p.card, p.subtotal, p.total, c.tracking, c.undelivered, c.teslim, c.planned, s.fee sfee, s.cod scod, s.collected scoll, s.coll_amt samt, s.durum sdurum, s.iade siade, s.day sday
      FROM orders o LEFT JOIN sh_pay p ON p.no = replace(o.order_no,'#','') LEFT JOIN sr_cost c ON c.no = replace(o.order_no,'#','') LEFT JOIN sr_rows s ON s.takip = c.tracking
      WHERE o.channel='shopify' AND o.date >= ?1 ORDER BY o.date DESC LIMIT 2000`).bind(from), env.DB.prepare('SELECT key, desi FROM products')]);
    const fee = await loadFees(env), dz = new Map(pR.results.map(x => [x.key, Number(x.desi) || null])), out = [];
    for (const r of oR.results) { let lines = []; try { lines = JSON.parse(r.lines || '[]'); } catch (e) {} const act = lines.filter(l => l.status !== 'cancelled'); if (!act.length) continue;
      const cod = !!r.cod, card = !!r.card, sub = r2(r.subtotal !== null ? r.subtotal : act.reduce((a, l) => a + ((l.fin && l.fin.revenue) || 0), 0));
      const total = r2(sub + (sub > 0 && sub < SH_FREE_SHIP ? SH_SHIP_FEE : 0) + (cod ? (card ? SH_COD_CARD : SH_COD_CASH) : 0));
      let d = 0, miss = 0; for (const l of act) { const x = dz.get(l.pkey); if (x) d += x * l.qty; else { miss++; d += l.qty; } } const desi = Math.ceil(d - 1e-9);
      const und = !!r.undelivered, base = r2(suratDirectPrice(desi) * (1 + SURAT_POST_TAX) + srSmsFor(fee, r.date)), codFee = cod && !und ? suratDirectCod(total) : 0;
      const eColl = cod && !und ? total : 0, eFee = r2(und ? base * 1.5 : base + codFee), eNet = r2(eColl - eFee);
      const has = r.sfee !== null && r.sfee !== undefined, sColl = has ? r2(r.scod || 0) : null, sFee = has ? r2(r.sfee || 0) : null, sNet = has ? r2(sColl - sFee) : null;
      const diff = has ? r2(sNet - eNet) : null, deliv = dlvDay(r.teslim), payDay = cod && !und && deliv ? srPayDay(deliv) : null, planned = dlvDay(r.planned), estPay = cod && !und && !deliv && planned ? srPayDay(planned) : null;
      out.push({ id: r.id, orderNo: r.order_no, date: r.date, method: cod ? (card ? 'Kapıda kart' : 'Kapıda nakit') : 'Online', desi, miss, und, tracking: r.tracking || '', eColl, eFee, eNet, sColl, sFee, sNet, diff, collected: !!r.scoll, deliv, payDay, planned, estPay, durum: r.sdurum || '', st: !has ? 'nodata' : Math.abs(diff) < 1 ? 'ok' : 'diff' });
    }
    const sum = (f, k) => r2(out.filter(f).reduce((a, x) => a + (x[k] || 0), 0)), m = (x) => x.st !== 'nodata';
    return json({ ok: true, items: out, n: out.length, matched: out.filter(m).length, ok_n: out.filter(x => x.st === 'ok').length, diff_n: out.filter(x => x.st === 'diff').length,
      tot: { eColl: sum(m, 'eColl'), eFee: sum(m, 'eFee'), eNet: sum(m, 'eNet'), sColl: sum(m, 'sColl'), sFee: sum(m, 'sFee'), sNet: sum(m, 'sNet'), eNetAll: sum(() => true, 'eNet') } });
  }
  if (path === '/api/srcari/add') {
    const kind = ['in', 'out', 'adj'].includes(body.kind) ? body.kind : 'in', a0 = String(body.amount ?? '').trim(), amount = r2(Number(a0.includes(',') ? a0.replace(/\./g, '').replace(',', '.') : a0) || 0);
    if (!amount) return bad('Tutar yaz.'); const day = /^\d{4}-\d{2}-\d{2}$/.test(body.day || '') ? body.day : trToday();
    await env.DB.prepare('INSERT INTO sr_mov(day, kind, amount, note, at) VALUES(?1,?2,?3,?4,?5)').bind(day, kind, amount, String(body.note || '').slice(0, 160), iso()).run();
    return json({ ok: true });
  }
  if (path === '/api/srcari/del') { await env.DB.prepare('UPDATE sr_mov SET deleted=1 WHERE id=?1').bind(intOr(body.id, 0)).run(); return json({ ok: true }); }
  if (path === '/api/shcheck') {
    // Shopify hesap kontrolü: beklenen tutar (ürün + 700 TL altı 100 TL kargo + kapıda nakit 50 / kart 100) ile Shopify'ın tahsil ettiği ve kargonun topladığı tutar karşılaştırılır
    let from = String(body.from || ''), to = String(body.to || ''); if (!from || !to) return bad('Tarih aralığı yok.');
    const rs = await reportStart(env); if (/^\d{4}-\d{2}-\d{2}$/.test(rs || '')) { const a = iso(dayStartTR(rs)); if (from < a) from = a; }
    const { results } = await env.DB.prepare(`SELECT o.id, o.order_no, o.date, o.lines, p.gateway, p.cod, p.card, p.subtotal, p.ship, p.total, c.cod_amount sr_cod, c.undelivered, b.cod bk_cod, b.cod_type bk_type, b.cod_amount bk_amt
      FROM orders o LEFT JOIN sh_pay p ON p.no = replace(o.order_no,'#','') LEFT JOIN sr_cost c ON c.no = replace(o.order_no,'#','') LEFT JOIN bk_ship b ON b.no = replace(o.order_no,'#','')
      WHERE o.channel='shopify' AND o.date >= ?1 AND o.date < ?2 ORDER BY o.date DESC`).bind(from, to).all();
    const out = []; let checked = 0, noData = 0;
    for (const r of results) { let lines = []; try { lines = JSON.parse(r.lines || '[]'); } catch (e) {}
      if (!lines.some(l => l.status !== 'cancelled')) continue; // iptal
      if (r.total === null || r.total === undefined) { noData++; continue; }
      const post = String(r.date || '') >= SURAT_DIRECT_FROM;
      const cod = !post && r.bk_cod !== null && r.bk_cod !== undefined ? !!r.bk_cod : !!r.cod, card = !post && r.bk_type ? r.bk_type === 'CREDIT_CARD' : !!r.card;
      const sub = r2(r.subtotal !== null ? r.subtotal : lines.filter(l => l.status !== 'cancelled').reduce((a, l) => a + ((l.fin && l.fin.revenue) || 0), 0));
      const shipE = sub > 0 && sub < SH_FREE_SHIP ? SH_SHIP_FEE : 0, codE = cod ? (card ? SH_COD_CARD : SH_COD_CASH) : 0, exp = r2(sub + shipE + codE);
      const got = r2(r.total), collected = cod ? (post ? (r.sr_cod > 0 ? r2(r.sr_cod) : null) : (r.bk_amt > 0 ? r2(r.bk_amt) : null)) : null;
      checked++;
      const issues = [];
      if (Math.abs(got - exp) > 0.5) issues.push(`Shopify ${got} TL tahsil etmiş, olması gereken ${exp} TL (fark ${r2(got - exp)} TL)`);
      if (collected !== null && Math.abs(collected - exp) > 0.5) issues.push(`Kargo kapıda ${collected} TL tahsil etmiş/edecek, olması gereken ${exp} TL (fark ${r2(collected - exp)} TL)`);
      if (!issues.length) continue;
      const shipGot = r.ship !== null ? r2(r.ship) : null;
      out.push({ id: r.id, orderNo: r.order_no, date: r.date, method: cod ? (card ? 'Kapıda kart' : 'Kapıda nakit') : 'Online', gateway: r.gateway || '', sub, shipE, codE, exp, got, shipGot, collected, diff: r2((collected !== null ? collected : got) - exp), issues, undelivered: !!r.undelivered });
    }
    return json({ ok: true, checked, noData, items: out, sum: r2(out.reduce((a, x) => a + x.diff, 0)) });
  }
  if (path === '/api/shret/list') {
    const no = String(body.no || '').replace(/\D/g, ''); const { results } = await env.DB.prepare('SELECT * FROM sh_ret WHERE no=?1 AND deleted=0 ORDER BY id').bind(no).all();
    const sc = await env.DB.prepare('SELECT * FROM sr_cost WHERE no=?1').bind(no).first();
    return json({ ok: true, items: results, cost: sc });
  }
  if (path === '/api/shret/add') {
    // Elle iade kargosu: müşteri bizim cari kodumuzla gönderdi; ücret = Sürat tarifesi (desi) + %2,35 posta vergisi, tam fiyat (ya da girilen tutar)
    const no = String(body.no || '').replace(/\D/g, ''); if (!no) return bad('Sipariş no yok.');
    const desi = Math.max(0, Number(String(body.desi ?? '').replace(',', '.')) || 0); const amt = Number(String(body.cost ?? '').replace(',', '.'));
    const cost = Number.isFinite(amt) && amt > 0 ? r2(amt) : r2(suratDirectPrice(Math.ceil(desi || 1)) * (1 + SURAT_POST_TAX));
    await env.DB.prepare('INSERT INTO sh_ret(no, tracking, desi, cost, note, at) VALUES(?1,?2,?3,?4,?5,?6)').bind(no, String(body.tracking || '').trim().slice(0, 40), desi || null, cost, String(body.note || '').slice(0, 120), iso()).run();
    await env.DB.batch([env.DB.prepare('DELETE FROM daily_stats WHERE day >= ?1').bind('2026-10-01'), setStmt(env, 'home_cache', ''), REV(env)]);
    return json({ ok: true, cost });
  }
  if (path === '/api/shret/del') {
    await env.DB.batch([env.DB.prepare('UPDATE sh_ret SET deleted=1 WHERE id=?1').bind(intOr(body.id, 0)), env.DB.prepare('DELETE FROM daily_stats WHERE day >= ?1').bind('2026-10-01'), setStmt(env, 'home_cache', ''), REV(env)]);
    return json({ ok: true });
  }
  if (path === '/api/surat/trackdiag') {
    // Teşhis: bir siparişin Sürat'taki takip sorgusu ve listede eşleşen satır (kişisel bilgiler gizli)
    const no = String(body.no || '').replace(/\D/g, ''); if (!no) return bad('Sipariş no yaz.');
    const cr = await srCreds(env); if (!cr.cari || !cr.pass) return bad('Sürat bağlı değil.');
    const row = await env.DB.prepare(`SELECT * FROM sr_ship WHERE replace(order_no,'#','')=?1 ORDER BY at DESC LIMIT 1`).bind(no).first();
    if (!row) return bad('Bu sipariş için Sürat gönderisi kaydı yok (barkod oluşturulmamış).');
    const PII = /ad|isim|unvan|alici|gonderen|kisi|tel|gsm|adres|il$|ilce|mahalle|sokak|mail|tc|vergi/i;
    const mask = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, PII.test(k) && !/takip|barkod|kod$|no$/i.test(k) ? (v ? '•' : '') : v]));
    const out = { ref: row.ref, order_no: row.order_no, at: row.at, saved: { tracking: row.tracking, track_msg: row.track_msg, track_at: row.track_at, fulfilled_at: row.fulfilled_at, fulfill_err: row.fulfill_err } };
    try { const q = await srQuery(env, cr, row.ref); out.byRef = { no: q.no, durum: q.durum, raw: q.raw }; } catch (e) { out.byRef = { err: String(e.message || e) }; }
    try { const q = await srQuery(env, cr, no); out.byOrderNo = { no: q.no, durum: q.durum, raw: q.raw }; } catch (e) { out.byOrderNo = { err: String(e.message || e) }; }
    try { const L = await srList(env, cr, 6); out.list = { count: L ? L.rows.length : 0, mesaj: L && L.mesaj, text: L && L.text, keys: L && L.rows[0] ? Object.keys(L.rows[0]) : [] }; const m = L && srMatch(L.rows, row); out.match = m ? mask(m) : null; out.matchTrack = m ? srRowTrack(m) : ''; if (!m && L && L.rows[0]) out.sampleRow = mask(L.rows[0]); } catch (e) { out.list = { err: String(e.message || e) }; }
    try { const sc = await srSchema(env, false); out.queryMethod = sc.query ? sc.query.method + '(' + sc.query.params.map(p => p.name).join(', ') + ')' : null; } catch (e) {}
    return json(out);
  }
  if (path === '/api/surat/diag') {
    const cr = await srCreds(env), out = { creds: {}, tests: [] };
    const info = (x) => ({ len: x.length, space: /^\s|\s$/.test(x), nonAscii: /[^\x20-\x7e]/.test(x) });
    out.creds = { user: { ...info(cr.user), mask: cr.user.slice(0, 2) + '•••' + cr.user.slice(-2) }, cari: { ...info(cr.cari), mask: cr.cari.slice(0, 2) + '•••' + cr.cari.slice(-2) }, pass: info(cr.pass), web: cr.web ? info(cr.web) : null };
    let sc; try { sc = await srSchema(env, true); out.schema = { ns: sc.ns, create: (sc.alts || []).map(a => a.method + '(' + a.params.map(p => p.name).join(', ') + ')'), query: sc.query ? sc.query.method + '(' + sc.query.params.map(p => p.name).join(', ') + ')' : null, ops: sc.ops }; } catch (e) { out.schema = { err: String(e.message || e) }; return json(out); }
    const tries = [['Cari kodu + şifre', { ...cr, cari: cr.cari, web: '' }]];
    if (cr.user && cr.user !== cr.cari) tries.push(['Kullanıcı adı + şifre', { ...cr, cari: cr.user, web: '' }]);
    if (cr.web) tries.push(['Cari kodu + web servis şifresi', { ...cr, web: cr.web }]);
    // Liste: her iki şifreyle; gönderi girişi: boş gönderiyle (şifre doğruysa Sürat alan hatası verir, kayıt oluşmaz)
    out.lists = []; for (const [label, c2] of [['Cari kodu + gönderim şifresi', { ...cr, web: '' }], ['Cari kodu + web servis şifresi', cr]]) { if (label.includes('web') && !cr.web) continue; try { const L = await srList(env, c2, 2); out.lists.push({ label, msg: L ? (L.rows.length && !L.mesaj ? `${L.rows.length} gönderi` : (L.mesaj || L.text || `${L.rows.length} satır`)) : 'işlem yok' }); } catch (e) { out.lists.push({ label, msg: String(e.message || e) }); } }
    out.listParams = ((sc.lists || {}).CariKoduveSifre || []).map(p => p.name + ':' + p.type);
    out.create = []; for (const a of (sc.alts || [])) { for (const [label, u] of [['kullanıcı adı', cr.user], ['cari kodu', cr.cari]].filter((x, i, arr) => i === 0 || x[1] !== arr[0][1])) { try { const t = await srCall(env, a.method, a.params, p => p.tns ? null : /kullanici|cari/i.test(p.name) ? u : /sifre|password/i.test(p.name) ? cr.pass : null); out.create.push({ label: `${a.method} (${label} + gönderim şifresi)`, msg: srText(t).slice(0, 200) || '(boş)' }); } catch (e) { out.create.push({ label: a.method, msg: String(e.message || e) }); } } }
    try { const L = await srList(env, cr, 2); out.list = L ? { count: L.rows.length, mesaj: L.mesaj, text: L.text, sample: L.rows[0] || null, keys: L.rows[0] ? Object.keys(L.rows[0]) : [] } : { err: 'Listeleme işlemi yok' }; } catch (e) { out.list = { err: String(e.message || e) }; }
    for (const [label, c] of tries) { try { const q = await srQuery(env, c, 'LH0'); out.tests.push({ label, msg: q.durum || q.raw || '(boş cevap)' }); } catch (e) { out.tests.push({ label, msg: String(e.message || e) }); } }
    return json(out);
  }
  // Sürat eKargo "Gönderi Raporu → Excel'e aktar" dosyasındaki satırlarla eşleştir; takip no Shopify'a işlenir
  if (path === '/api/surat/report') {
    const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 3000).filter(r => r && typeof r === 'object');
    if (!rows.length) return bad('Dosyada satır bulunamadı.');
    // Sürat cari hesabı: rapordaki her gönderi (ücret, kapıda tahsilat, tahsil edildi mi) saklanır
    { const st = []; for (const m of rows) { const tn = srRowTrack(m); if (!tn) continue; const E = Object.entries(m).map(([k, v]) => [srNorm(k), String(v ?? '').trim()]), get = (re) => { const x = E.find(([k]) => re.test(k)); return x ? x[1] : ''; }, num = (t) => { const n = Number(String(t).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
        const fd = get(/^FATURATARIHI$/), day = /^\d{4}-\d{2}-\d{2}/.test(fd) ? fd.slice(0, 10) : (/^(\d{2})\.(\d{2})\.(\d{4})/.exec(fd) || []).slice(1).reverse().join('-') || null, coll = /^(EVET|E|1|TRUE)$/.test(srNorm(get(/^TAHSILEDILDIMI$/)));
        st.push(env.DB.prepare('INSERT INTO sr_rows(takip, day, alici, fee, cod, collected, coll_amt, iade, durum, at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(takip) DO UPDATE SET day=COALESCE(excluded.day, sr_rows.day), fee=excluded.fee, cod=excluded.cod, collected=excluded.collected, coll_amt=excluded.coll_amt, iade=excluded.iade, durum=excluded.durum, at=excluded.at')
          .bind(tn, day, get(/^ALICI$/).slice(0, 80), num(get(/^TUTAR$/)), num(get(/^KAPIDANTAHSILATTUTARI$/)), coll ? 1 : 0, num(get(/^TAHSILATTUTARI$/)), get(/^IADEDURUM$/).slice(0, 20), (get(/^TESLIMATDURUM$/) || get(/^BULUNDUGUYER$/)).slice(0, 60), iso())); }
      for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90)); }
    const cr = await srCreds(env), c = await shCreds(env);
    const { results } = await env.DB.prepare(`SELECT * FROM sr_ship s WHERE at > ?1 AND at = (SELECT MAX(at) FROM sr_ship t WHERE t.gid = s.gid)`).bind(iso(Date.now() - 30 * 86400000)).all();
    const out = [], miss = [], fixed = []; let already = 0;
    const costSt = [];
    for (const r of results) { const m = srMatch(rows, r), tn = m && srRowTrack(m);
      if (m) { const g = srPick(m); if (g.cost !== null || g.undelivered) costSt.push(env.DB.prepare('INSERT INTO sr_cost(no, tracking, cost, desi, cod_amount, undelivered, durum, teslim, at, planned) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(no) DO UPDATE SET planned=excluded.planned, tracking=excluded.tracking, cost=COALESCE(excluded.cost, sr_cost.cost), desi=COALESCE(excluded.desi, sr_cost.desi), cod_amount=excluded.cod_amount, undelivered=excluded.undelivered, durum=excluded.durum, teslim=excluded.teslim, at=excluded.at').bind(String(r.order_no || '').replace(/\D/g, ''), tn || null, g.cost, g.desi, g.cod, g.undelivered ? 1 : 0, g.durum, g.teslim, iso(), g.planned || null)); }
      if (!tn) { if (!r.fulfilled_at) miss.push(r.order_no); continue; }
      if (r.fulfilled_at) { // zaten kargolandı: numara farklıysa (eski hatalı okuma) düzelt
        if (r.tracking === tn) { already++; continue; }
        try { if (shConfigured(c)) await shFixTracking(env, c, r.gid, tn); await env.DB.prepare('UPDATE sr_ship SET tracking=?2, track_msg=?3, track_at=?4 WHERE ref=?1').bind(r.ref, tn, 'Sürat raporundan düzeltildi (önceki: ' + (r.tracking || '-') + ')', iso()).run(); fixed.push(r.order_no); out.push({ ref: r.ref, tracking: tn, fulfilled: true, fixed: true }); }
        catch (e) { out.push({ ref: r.ref, tracking: tn, err: String(e.message || e) }); } continue; }
      r.tracking = tn; r.track_msg = srRowState(m) || 'Sürat raporundan';
      try { out.push(await srTrackOne(env, r, cr, c)); } catch (e) { out.push({ ref: r.ref, tracking: tn, err: String(e.message || e) }); } }
    for (let i = 0; i < costSt.length; i += 90) await env.DB.batch(costSt.slice(i, i + 90));
    if (costSt.length) await env.DB.batch([env.DB.prepare('DELETE FROM daily_stats WHERE day >= ?1').bind('2026-10-17'), setStmt(env, 'home_cache', ''), REV(env)]);
    return json({ ok: true, costs: costSt.length, undelivered: 0, rows: rows.length, pending: results.filter(r => !r.fulfilled_at).length, tracked: out.filter(x => !x.fixed).length, fulfilled: out.filter(x => x.fulfilled && !x.fixed).length, fixed: fixed.length, fixedList: fixed.slice(0, 30), already, errs: out.filter(x => x.err).map(x => x.ref + ': ' + x.err).slice(0, 3), miss: miss.slice(0, 30), items: out });
  }
  if (path === '/api/surat/mode') { await env.DB.batch([setStmt(env, 'sr_mode', body.api ? 'api' : 'excel'), setStmt(env, 'sr_block_until', '0'), setStmt(env, 'sr_track_err', '')]); return json({ ok: true }); }
  if (path === '/api/surat/trackall') { try { const r = await srTrackPending(env, 60); if (!r) return bad('Sürat bağlantısı yok: Bağlantılar → Sürat Kargo\'da cari kodu ve şifreyi gir.'); return json({ ok: true, r }); } catch (e) { return bad(String(e.message || e)); } }
  if (path === '/api/surat/track') {
    if (body.number === undefined) { const cr1 = await srCreds(env), row1 = await env.DB.prepare('SELECT * FROM sr_ship WHERE gid=?1 ORDER BY at DESC LIMIT 1').bind(String(body.gid || '')).first();
      if (row1 && !row1.tracking && row1.mode === 'api' && cr1.user) { try { const fb = await srFetchBarcode(env, cr1, row1.ref); if (fb.barcode) { row1.tracking = fb.barcode; row1.track_msg = 'Sürat barkodu'; return json({ ok: true, r: await srTrackOne(env, row1, cr1, await shCreds(env)) }); } await env.DB.prepare("UPDATE sr_ship SET msg=substr(COALESCE(msg,''),1,300) || ' ‖ Barkod sorgusu: ' || ?2 WHERE ref=?1").bind(row1.ref, fb.log.join(' / ').slice(0, 700)).run(); return json({ ok: true, r: { ref: row1.ref, tracking: '', msg: 'Barkod sorgusu: ' + fb.log.join(' / '), fulfilled: false, err: '' }, barcodeLog: fb.log }); } catch (e) { return json({ ok: true, r: { ref: row1.ref, tracking: '', msg: 'Barkod sorgusu hatası: ' + String(e.message || e), fulfilled: false, err: '' } }); } } }
    if (body.number === undefined) { const cr0 = await srCreds(env), row0 = await env.DB.prepare('SELECT * FROM sr_ship WHERE gid=?1 ORDER BY at DESC LIMIT 1').bind(String(body.gid || '')).first();
      if (row0 && !row0.tracking && cr0.cari) { try { const L = await srList(env, cr0, 6), m = L && srMatch(L.rows, row0), tn = m && srRowTrack(m); if (tn) { row0.tracking = tn; row0.track_msg = srRowState(m) || 'Sürat listesinden'; return json({ ok: true, r: await srTrackOne(env, row0, cr0, await shCreds(env)) }); } } catch (e) {} } }
    const cr = await srCreds(env); if (!cr.cari || !cr.pass) return bad('Sürat Kargo bağlı değil.');
    const row = await env.DB.prepare('SELECT * FROM sr_ship WHERE gid=?1 ORDER BY at DESC LIMIT 1').bind(String(body.gid || '')).first(); if (!row) return bad('Bu siparişin Sürat barkodu yok.');
    if (body.number !== undefined) { const n = String(body.number || '').toLocaleUpperCase('tr').replace(/[^A-Z0-9]/g, ''); if (n.length < 8 || (n.match(/\d/g) || []).length < 6) return bad('Takip numarası en az 8 karakter olmalı (Sürat eKargo\'daki "Kargo Takip No").');
      if (row.fulfilled_at) { const c0 = await shCreds(env); try { if (shConfigured(c0)) await shFixTracking(env, c0, row.gid, n); await env.DB.prepare('UPDATE sr_ship SET tracking=?2, track_msg=?3, track_at=?4 WHERE ref=?1').bind(row.ref, n, 'Elle düzeltildi (önceki: ' + (row.tracking || '-') + ')', iso()).run(); return json({ ok: true, r: { ref: row.ref, tracking: n, fulfilled: true, fixed: true } }); } catch (e) { return bad(String(e.message || e)); } }
      row.tracking = n; row.track_msg = 'Elle girildi'; }
    try { return json({ ok: true, r: await srTrackOne(env, row, cr, await shCreds(env)) }); } catch (e) { return bad(String(e.message || e)); }
  }
  if (path === '/api/surat/disconnect') { await env.DB.batch([setStmt(env, 'sr_cari', ''), setStmt(env, 'sr_user', ''), setStmt(env, 'sr_pass', ''), setStmt(env, 'sr_web', '')]); return json({ ok: true }); }
  if (path === '/api/surat/schema') { try { const sc = await srSchema(env, true); return json({ ok: true, method: sc.method, fields: sc.gonderi.fields.map(f => f.name + (f.min ? '*' : '')) }); } catch (e) { return bad(String(e.message || e)); } }
  // Sürat Excel: yüklenmeyi bekleyen (ya da son 7 günün) gönderileri; indirildikten sonra işaretlenir
  if (path === '/api/surat/export') {
    const all = !!body.all;
    const { results } = await env.DB.prepare(`SELECT ref, gid, order_no, adet, desi, addr, lines, at, exported_at FROM sr_ship s WHERE COALESCE(mode,'excel')='excel' AND at = (SELECT MAX(at) FROM sr_ship t WHERE t.gid = s.gid) AND ${all ? 'at > ?1' : 'exported_at IS NULL AND at > ?1'} ORDER BY at`).bind(iso(Date.now() - (all ? 7 : 30) * 86400000)).all();
    return json({ ok: true, ships: results.map(r => ({ ...r, addr: JSON.parse(r.addr || '{}'), lines: JSON.parse(r.lines || '[]') })) });
  }
  if (path === '/api/surat/exported') {
    const refs = (Array.isArray(body.refs) ? body.refs : []).map(String).slice(0, 500); if (!refs.length) return json({ ok: true });
    const now = iso(); const st = refs.map(r => env.DB.prepare('UPDATE sr_ship SET exported_at=COALESCE(exported_at, ?2) WHERE ref=?1').bind(r, now));
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    return json({ ok: true, at: now });
  }
  // Kayıtlı → bekleyen: siparişin Sürat barkodu kaydı silinir (etiket kullanılmayacaksa)
  if (path === '/api/surat/unship') {
    const gid = String(body.gid || ''); if (!gid) return bad('Sipariş bulunamadı.');
    const f = await env.DB.prepare('SELECT 1 FROM sr_ship WHERE gid=?1 AND fulfilled_at IS NOT NULL').bind(gid).first();
    if (f) return bad("Bu sipariş Shopify'da kargolandı olarak işlendi; geri alınamaz.");
    await env.DB.prepare('DELETE FROM sr_ship WHERE gid=?1').bind(gid).run();
    return json({ ok: true });
  }
  // ---------- Yeni Shopify siparişi (elle) ----------
  if (path === '/api/shorder/products') {
    const q = String(body.q || '').trim().slice(0, 60); if (q.length < 2) return json({ items: [] });
    const like = '%' + q.replace(/[%_]/g, '') + '%', low = '%' + q.toLocaleLowerCase('tr').replace(/[%_]/g, '') + '%', up = '%' + q.toLocaleUpperCase('tr').replace(/[%_]/g, '') + '%';
    const { results } = await env.DB.prepare(`SELECT l.ext, l.name, l.sku, l.image, l.factor, p.code, p.qty FROM listings l LEFT JOIN products p ON p.key=l.pkey WHERE l.channel='shopify' AND (l.name LIKE ?1 OR l.name LIKE ?2 OR l.name LIKE ?3 OR l.sku LIKE ?1 OR p.code LIKE ?1 OR p.code LIKE ?3) ORDER BY l.name LIMIT 25`).bind(like, low, up).all();
    return json({ items: results });
  }
  if (path === '/api/shorder/create') {
    const c = await shCreds(env); if (!shConfigured(c)) return bad('Shopify bağlı değil.');
    const a = body.addr || {}, t = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 255);
    const items = (Array.isArray(body.items) ? body.items : []).filter(x => /^\d+$/.test(String(x.ext || '')) && Number(x.qty) > 0).slice(0, 50);
    if (!items.length) return bad('En az bir ürün ekle.');
    const first = t(a.firstName), last = t(a.lastName), phone = t(a.phone, 20);
    if (!first || !last) return bad('Ad ve soyad gerekli.'); if (!t(a.address1)) return bad('Adres gerekli.'); if (!t(a.city) || !t(a.province)) return bad('İl ve ilçe gerekli.');
    if (!/^\+905\d{9}$/.test(phone)) return bad('Telefon 05xx xxx xx xx biçiminde olmalı.');
    // Fiyat girilmeyen ürünlerde Shopify'daki satış fiyatı kullanılır
    let prices = {}; try { const d = await shGql(env, c, `query($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{id price}}}`, { ids: items.map(x => 'gid://shopify/ProductVariant/' + x.ext) }); for (const n of d.nodes || []) if (n && n.id) prices[shId(n.id)] = Number(n.price) || 0; } catch (e) { return bad(shAddrErr(e)); }
    const money = (v) => ({ shopMoney: { amount: String(Math.round(Number(v) * 100) / 100), currencyCode: 'TRY' } });
    const lineItems = items.map(x => { const pr = String(x.price ?? '').trim() !== '' ? Number(String(x.price).replace(',', '.')) : prices[String(x.ext)]; return { variantId: 'gid://shopify/ProductVariant/' + x.ext, quantity: Math.min(999, Math.max(1, parseInt(x.qty, 10) || 1)), ...(Number.isFinite(pr) && pr >= 0 ? { priceSet: money(pr) } : {}) }; });
    const ma = { firstName: first, lastName: last, address1: t(a.address1), address2: t(a.address2), city: t(a.city), provinceCode: t(a.provinceCode, 10) || undefined, countryCode: 'TR', zip: t(a.zip, 10) || undefined, phone };
    const ship = Number(String(body.shipping ?? '').replace(',', '.'));
    const total = lineItems.reduce((s2, l) => s2 + (l.priceSet ? Number(l.priceSet.shopMoney.amount) * l.quantity : 0), 0) + (ship > 0 ? ship : 0);
    const paid = body.paid !== false;
    const order = { lineItems, shippingAddress: ma, billingAddress: ma, phone, currency: 'TRY', financialStatus: paid ? 'PAID' : 'PENDING', sourceName: 'Lilya Backstage', tags: ['Backstage'], note: t(body.note, 1000) || undefined,
      ...(t(a.email) ? { email: t(a.email), customer: { toUpsert: { firstName: first, lastName: last, email: t(a.email) } } } : {}),
      ...(ship > 0 ? { shippingLines: [{ title: 'Kargo', priceSet: money(ship) }] } : {}),
      ...(paid && total > 0 ? { transactions: [{ kind: 'SALE', status: 'SUCCESS', gateway: body.gateway === 'havale' ? 'Havale/EFT' : 'manual', amountSet: money(total) }] } : {}) };
    try {
      const r = await shGql(env, c, `mutation($order:OrderCreateOrderInput!,$options:OrderCreateOptionsInput){orderCreate(order:$order,options:$options){order{id name}userErrors{field message}}}`,
        { order, options: { inventoryBehaviour: 'DECREMENT_IGNORING_POLICY', sendReceipt: !!body.sendReceipt } });
      const ue = r.orderCreate.userErrors || []; if (ue.length) return bad('Shopify kabul etmedi: ' + ue.map(e => e.message).join(' · '));
      const o = r.orderCreate.order;
      try { await syncShopifyOrders(env, { pages: 1 }); } catch (e) {} // stok hemen düşsün
      return json({ ok: true, order: o });
    } catch (e) { return bad(shAddrErr(e)); }
  }
  if (path === '/api/surat/ship') {
    // Varsayılan: Excel ile (Sürat eKargo → Gönderi Girişi Excel). Web servis yalnız sr_mode=api ise kullanılır.
    const cr = await srCreds(env), apiMode = (await getSetting(env, 'sr_mode')) === 'api' && cr.user && cr.pass;
    const c = await shCreds(env); if (!shConfigured(c)) return bad('Shopify bağlı değil.');
    const gid = String(body.gid || ''); if (!/^gid:\/\/shopify\/Order\/\d+$/.test(gid)) return bad('Sipariş bulunamadı.');
    const adet = Math.max(1, Math.min(50, parseInt(body.adet, 10) || 1)), desi = Math.max(0.5, Math.min(300, Number(String(body.desi || cr.desi).replace(',', '.')) || cr.desi));
    let o; try { o = (await shGql(env, c, SR_ORDER_Q, { id: gid })).order; } catch (e) { return bad(shAddrErr(e)); }
    if (!o) return bad('Sipariş Shopify\'da bulunamadı.'); if (o.cancelledAt) return bad('Sipariş iptal edilmiş.');
    const a = o.shippingAddress || {};
    const name = `${a.firstName || ''} ${a.lastName || ''}`.replace(/\s+/g, ' ').trim() || (a.company || '');
    const tel = (() => { let d = String(a.phone || o.phone || '').replace(/\D/g, ''); if (d.startsWith('90') && d.length === 12) d = d.slice(2); if (d.startsWith('0') && d.length === 11) d = d.slice(1); return d; })();
    const adres = [a.address1, a.address2].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const miss = [!name && 'ad soyad', !adres && 'adres', !a.city && 'ilçe', !a.province && 'il', !/^5\d{9}$/.test(tel) && 'cep telefonu'].filter(Boolean);
    if (miss.length) return bad('Adreste eksik var: ' + miss.join(', ') + '. Önce adresi düzeltip Shopify\'a kaydet.');
    // Kendi barkodumuz: LH + sipariş no (aynı sipariş için yeniden oluşturulursa sonuna B, C… eklenir)
    const base = 'LH' + String(o.name || '').replace(/\D/g, '');
    const prev = (await env.DB.prepare('SELECT ref FROM sr_ship WHERE gid=?1').bind(gid).all()).results.map(r => r.ref);
    if (prev.length && !body.again) return bad('Bu siparişin Sürat barkodu zaten var: ' + prev[prev.length - 1]);
    let ref = base; for (let k = 0; prev.includes(ref) && k < 25; k++) ref = base + String.fromCharCode(66 + k);
    const lines = ((o.lineItems || {}).nodes || []).filter(l => Number(l.unfulfilledQuantity) > 0);
    const lm = await listingMap(env, 'shopify', lines.map(l => shId(l.variant && l.variant.id)).filter(Boolean));
    const codes = new Map((await selectIn(env, 'SELECT key, code FROM products', 'key', [...new Set([...lm.values()].map(v => v.pkey).filter(Boolean))])).map(r => [r.key, r.code]));
    const L = lines.map(l => { const m = lm.get(shId(l.variant && l.variant.id)); return { name: l.name, sku: l.sku || '', qty: Number(l.unfulfilledQuantity) || Number(l.quantity) || 1, code: m ? codes.get(m.pkey) || '' : '', factor: m ? m.factor : 1, unit: Number(((l.discountedUnitPriceAfterAllDiscountsSet || {}).shopMoney || {}).amount) || 0, image: (l.image || {}).url || '' }; });
    const icerik = L.map(l => `${l.qty}x ${l.code || l.sku || l.name}`).join(', ').slice(0, 100);
    const g = { kisikurum: name, aliciadresi: adres, il: a.province, ilce: a.city, telefoncep: tel, telefonev: '', telefonis: '', email: o.email || '', alicikodu: '', kargoturu: 3, odemetipi: 1, adet, birimdesi: desi, desi, birimkg: 1, kg: 1, kargoicerigi: icerik, ozelkargotakipno: ref, referansno: ref, kapidanodemetahsilattipi: 0, kapidanodemetutari: 0, ekhizmetler: '', sevkadresi: '', teslimsekli: 1, irsaliyeserino: '', irsaliyesirano: '' };
    let res; if (!apiMode) res = { msg: 'Sürat Excel dosyasına eklendi' }; else try { const sc = await srSchema(env, false), errs = []; for (const a of (sc.alts || [])) { try { res = await srSend(env, cr, g, a.method); if (!res.barcode && /daha [öo]nce/i.test(res.msg)) { const fb = await srFetchBarcode(env, cr, ref); if (fb.barcode) res.barcode = fb.barcode; errs.push('barkod sorgusu: ' + fb.log.join(' / ')); } if (errs.length) res.msg = res.msg + ' ‖ ' + errs.join(' | '); break; } catch (e1) { errs.push(a.method.replace('GonderiyiKargoyaGonder', '…') + ': ' + String(e1.message || e1).slice(0, 220)); } } if (!res) throw new Error(errs.join(' | ')); } catch (e) { await setSetting(env, 'sr_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); return bad(String(e.message || e)); }
    const addr = { name, adres, il: a.province, ilce: a.city, zip: a.zip || '', tel, email: o.email || '', icerik };
    await env.DB.batch([env.DB.prepare('INSERT INTO sr_ship(ref,gid,order_no,adet,desi,addr,lines,msg,at,mode) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)').bind(ref, gid, o.name, adet, desi, JSON.stringify(addr), JSON.stringify(L), res.msg, iso(), apiMode ? 'api' : 'excel'), setStmt(env, 'sr_ok', iso()), ...(apiMode ? [setStmt(env, 'sr_err', '')] : [])]);
    // Sürat barkodu geldiyse takip no hemen Shopify'a işlenir (Trendyol'daki gibi)
    let trk = null; if (res.barcode) { try { trk = await srTrackOne(env, { ref, gid, order_no: o.name, tracking: res.barcode, track_msg: 'Sürat barkodu', fulfilled_at: null }, cr, c); } catch (e) { trk = { err: String(e.message || e) }; } }
    return json({ ok: true, ship: { ref, gid, order_no: o.name, adet, desi, addr, lines: L, msg: res.msg, at: iso(), mode: apiMode ? 'api' : 'excel', tracking: res.barcode || null, fulfilled_at: trk && trk.fulfilled ? iso() : null, fulfill_err: trk && trk.err || null, total: Number(((o.totalPriceSet || {}).shopMoney || {}).amount) || 0 } });
  }
  if (path === '/api/shaddr/save') {
    const c = await shCreds(env); if (!shConfigured(c)) return bad('Shopify bağlı değil.');
    const gid = String(body.gid || ''); if (!/^gid:\/\/shopify\/Order\/\d+$/.test(gid)) return bad('Sipariş bulunamadı.');
    const a = body.addr || {}, F = ['firstName', 'lastName', 'company', 'address1', 'address2', 'city', 'provinceCode', 'zip', 'countryCode', 'phone'], input = {};
    for (const f of F) { const v = String(a[f] == null ? '' : a[f]).replace(/\s+/g, ' ').trim().slice(0, 255); if (v || f === 'address2' || f === 'company') input[f] = v; }
    if (!input.firstName && !input.lastName) return bad('Ad soyad boş olamaz.');
    if (!input.address1) return bad('Adres boş olamaz.');
    if (!input.city) return bad('İlçe boş olamaz.');
    if (!input.countryCode) input.countryCode = 'TR';
    if (input.phone && !/^\+\d{8,15}$/.test(input.phone)) return bad('Telefon +905xxxxxxxxx biçiminde olmalı.');
    try {
      const run = (inp) => shGql(env, c, `mutation($input:OrderInput!){orderUpdate(input:$input){order{id name shippingAddress{${SH_ADDR_F}}}userErrors{field message}}}`, { input: { id: gid, shippingAddress: inp } });
      let r = await run(input), ue = r.orderUpdate.userErrors || [];
      const errTxt = () => ue.map(e => (e.field || []).join('.') + ' ' + e.message).join(' ');
      // Posta kodu yeni ille uyuşmuyorsa (ör. il Kayseri→Mersin, posta kodu 38000 kalmış) posta kodu boşaltılıp bir kez daha denenir
      if (ue.length && input.zip && /zip|postal|posta/i.test(errTxt())) { input.zip = ''; r = await run(input); ue = r.orderUpdate.userErrors || []; if (!ue.length) r._noZip = true; }
      // İl kodu Shopify'ın beklediği biçimde değilse il kodu olmadan bir kez daha denenir (il, mevcut haliyle kalır)
      if (ue.length && input.provinceCode && /province|zone|il\b/i.test(ue.map(e => (e.field || []).join('.') + ' ' + e.message).join(' '))) { const { provinceCode, ...rest } = input; r = await run(rest); ue = r.orderUpdate.userErrors || []; if (!ue.length) r._noProv = true; }
      if (ue.length) return bad('Shopify kabul etmedi: ' + ue.map(e => e.message).join(' · '));
      // İl gerçekten değişti mi? Shopify kodu tanımazsa sessizce eski ili bırakabiliyor: başka kod biçimleri denenir
      const plate = intOr(body.plate, 0), want = String(body.provinceName || ''), fold = (t) => String(t || '').toLocaleLowerCase('tr').replace(/ç/g,'c').replace(/ğ/g,'g').replace(/ı/g,'i').replace(/i̇/g,'i').replace(/ö/g,'o').replace(/ş/g,'s').replace(/ü/g,'u').replace(/[^a-z0-9]/g,'');
      const okProv = (sa) => sa && ((plate && Number((/(\d+)\s*$/.exec(sa.provinceCode || '') || [])[1]) === plate) || (want && fold(sa.province) === fold(want)));
      if (plate && !okProv(r.orderUpdate.order && r.orderUpdate.order.shippingAddress)) {
        const pp = String(plate).padStart(2, '0'), tried = [input.provinceCode];
        for (const code of ['TR-' + pp, pp, 'TR' + pp, String(plate)]) { if (tried.includes(code)) continue; tried.push(code);
          const r2 = await run({ ...input, provinceCode: code }); if ((r2.orderUpdate.userErrors || []).length) continue; r = r2; if (okProv(r2.orderUpdate.order.shippingAddress)) break; }
        const sa = r.orderUpdate.order && r.orderUpdate.order.shippingAddress;
        if (!okProv(sa)) return bad(`Shopify ili değiştirmedi: ${want} istendi, Shopify'da hâlâ ${(sa && sa.province) || '?'} (${(sa && sa.provinceCode) || '?'}). Denenen kodlar: ${tried.filter(Boolean).join(', ')}. Bu siparişin ilini Shopify panelinden değiştir; kodu bana söylersen uygulamayı ona göre ayarlarım.`);
      }
      const o = r.orderUpdate.order;
      await env.DB.prepare('INSERT INTO sh_addr_log(gid, order_no, before, after, at) VALUES(?1,?2,?3,?4,?5)').bind(gid, o.name, JSON.stringify(body.before || null), JSON.stringify(o.shippingAddress || null), iso()).run();
      await env.DB.prepare('DELETE FROM sh_addr_log WHERE id NOT IN (SELECT id FROM sh_addr_log ORDER BY id DESC LIMIT 300)').run();
      return json({ ok: true, addr: o.shippingAddress, noProv: !!r._noProv, noZip: !!r._noZip });
    } catch (e) { return bad(shAddrErr(e)); }
  }
  if (path === '/api/shopify/status') {
    const s = await getSettings(env, ['sh_shop', 'sh_name', 'sh_cid', 'sh_start', 'sh_ok', 'sh_err', 'sh_hook_ok', 'sh_hook_at', 'sh_hook_err', 'sh_prod', 'sh_paused', 'sh_push', 'sh_push_at', 'sh_push_count', 'sh_push_err']);
    // Shopify'dan gelip başka kanalda (Trendyol) karşılığı olmayan stok kodları: büyük ihtimalle farklı yazılmış
    const { results } = await env.DB.prepare(`SELECT key, sku, name, qty FROM products WHERE EXISTS(SELECT 1 FROM json_each(products.channels) WHERE value='shopify') AND NOT EXISTS(SELECT 1 FROM json_each(products.channels) WHERE value='trendyol') ORDER BY sku LIMIT 100`).all();
    const n = await env.DB.prepare(`SELECT COUNT(*) n FROM orders WHERE channel='shopify'`).first();
    // Shopify ilanları kaç ürüne bağlı: birden çok ilan aynı ürüne bağlanınca (birleştirme / aynı stok kodu) ürün sayısı ilan sayısından az olur
    const lc = await env.DB.prepare(`SELECT COUNT(*) listings, COUNT(DISTINCT l.pkey) products, SUM(CASE WHEN EXISTS(SELECT 1 FROM listings t WHERE t.pkey=l.pkey AND t.channel='trendyol') THEN 1 ELSE 0 END) withTy FROM listings l WHERE l.channel='shopify'`).first();
    const shared = await env.DB.prepare(`SELECT COUNT(*) n FROM (SELECT pkey FROM listings WHERE channel='shopify' GROUP BY pkey HAVING COUNT(*) > 1)`).first();
    // Aynı ürüne bağlanmış birden çok Shopify ilanı (çoğunlukla aynı stok kodu): kullanıcı "ayrı ürün yap" diyebilsin
    const grp = (await env.DB.prepare(`SELECT l.pkey, p.code, p.name pname, l.ext, l.name, l.sku, l.image FROM listings l JOIN products p ON p.key=l.pkey WHERE l.channel='shopify' AND l.pkey IN (SELECT pkey FROM listings WHERE channel='shopify' GROUP BY pkey HAVING COUNT(*) > 1) ORDER BY p.code, l.name LIMIT 400`).all()).results;
    const groups = []; for (const r of grp) { let g = groups[groups.length - 1]; if (!g || g.pkey !== r.pkey) { g = { pkey: r.pkey, code: r.code, name: r.pname, listings: [] }; groups.push(g); } g.listings.push({ ext: r.ext, name: r.name, sku: r.sku, image: r.image }); }
    return json({ connected: !!(s.sh_cid || env.SHOPIFY_CLIENT_ID), shop: s.sh_shop || env.SHOPIFY_SHOP || '', name: s.sh_name || '', start: s.sh_start || null, ok: s.sh_ok || null, err: s.sh_err || '', hook: !!s.sh_hook_ok, hookAt: s.sh_hook_at || '', hookErr: s.sh_hook_err || '', counts: { listings: (lc && lc.listings) || 0, products: (lc && lc.products) || 0, withTy: (lc && lc.withTy) || 0, shared: (shared && shared.n) || 0 }, groups, paused: s.sh_paused === '1', push: { on: s.sh_push !== '0', at: s.sh_push_at || '', count: Number(s.sh_push_count) || 0, err: s.sh_push_err || '' }, prod: (() => { try { return JSON.parse(s.sh_prod || 'null'); } catch (e) { return null; } })(), orders: (n && n.n) || 0, unmatched: results });
  }
  /* ---------- Lilya ürünleri: ilanlar, birleştirme, eşleştirme önerileri ---------- */
  if (path === '/api/trendyol/products-now') {
    // Ürün listesini hemen tara (sayfa sayfa; ekran tamamlanana kadar tekrar çağırır)
    if (!tyConfigured(env)) return bad('Trendyol bağlı değil.');
    if (body.first) await env.DB.batch([setStmt(env, 'ty_prod_page', 0), setStmt(env, 'ty_prod_done', '1970-01-01T00:00:00.000Z')]);
    try { const r = await syncTrendyolProducts(env, 2); return json({ ok: true, finished: !r || !!r.finished, created: (r && r.created) || 0, page: Number(await getSetting(env, 'ty_prod_page')) || 0 }); }
    catch (e) { return bad('Trendyol ürün listesi okunamadı: ' + String(e.message || e).slice(0, 200)); }
  }
  if (path === '/api/products/pending') {
    // Satılmış ama henüz kargolanmamış adet: Trendyol'da Yeni / İşleme alındı / Faturalandı paketler, Shopify'da gönderilmemiş satırlar
    const key = String(body.key || ''); const out = { ty: 0, sh: 0, orders: [] };
    const pk = (await env.DB.prepare(`SELECT pkg_id, order_no FROM audit_pkg WHERE status IN ('Created','Picking','Invoiced') AND day >= ?1`).bind(trDay(Date.now() - 30 * 86400000)).all()).results;
    const pkgs = new Set(pk.map(r => String(r.pkg_id))), nos = [...new Set(pk.map(r => String(r.order_no)))];
    // Birleştirilmiş eski ürün anahtarları ve bu ürüne bağlı Trendyol barkodları da sayılır (eski siparişler eski anahtarla kayıtlı olabilir)
    const keys = new Set([key, ...(await env.DB.prepare('SELECT key FROM products WHERE merged_into=?1').bind(key).all()).results.map(r => r.key)]);
    const inSet = new Map((await env.DB.prepare('SELECT pkey, n FROM bundles WHERE comp=?1').bind(key).all()).results.map(r => [r.pkey, Number(r.n) || 1])); // bu ürünü içeren setlerin satışları
    const tyF = new Map((await env.DB.prepare(`SELECT ext, factor FROM listings WHERE channel='trendyol' AND pkey=?1`).bind(key).all()).results.map(l => [String(l.ext), Math.max(1, Number(l.factor) || 1)]));
    if (nos.length) for (const o of await selectIn(env, `SELECT order_no, lines FROM orders`, `channel='trendyol' AND order_no`, nos)) {
      let n = 0; for (const l of JSON.parse(o.lines || '[]')) { if (l.status === 'cancelled' || !pkgs.has(String(l.key || '').split('|')[0])) continue;
        if (keys.has(l.pkey) || tyF.has(String(l.barcode || l.ext || ''))) n += Number(l.applied ?? l.qty) || 0;
        else if (inSet.has(l.pkey)) n += (Number(l.applied ?? l.qty) || 0) * inSet.get(l.pkey); }
      if (n) { out.ty += n; out.orders.push('#' + o.order_no); }
    }
    const ls = (await env.DB.prepare(`SELECT ext, factor FROM listings WHERE channel='shopify' AND pkey=?1`).bind(key).all()).results;
    if (ls.length) { const f = new Map(ls.map(l => [String(l.ext), Math.max(1, Number(l.factor) || 1)]));
      for (const r of (await env.DB.prepare('SELECT order_no, data FROM sh_unf').all()).results) { let n = 0; const m = JSON.parse(r.data || '{}'); for (const [v, q] of Object.entries(m)) if (f.has(v)) n += q * f.get(v); if (n) { out.sh += n; out.orders.push(r.order_no); } } }
    out.total = out.ty + out.sh;
    return json({ ok: true, ...out });
  }
  if (path === '/api/products/mto') {
    // Stoksuz satış işareti (toplu): işaretli ürünlerde stok yokken de kanallara en az 10 adet gönderilir, satılınca stok eksiye iner (= alınacak)
    const keys = (Array.isArray(body.keys) ? body.keys : []).map(String).filter(Boolean).slice(0, 1000); if (!keys.length) return bad('Ürün seç.');
    const st = []; for (let i = 0; i < keys.length; i += 80) { const part = keys.slice(i, i + 80); st.push(env.DB.prepare(`UPDATE products SET mto=?1 WHERE key IN (${part.map((_, j) => '?' + (j + 2)).join(',')})`).bind(body.on ? 1 : null, ...part)); }
    await env.DB.batch([...st, REV(env)]);
    return json({ ok: true, n: keys.length });
  }
  if (path === '/api/products/bundle') {
    // Set içeriğini kaydet: items boşsa ürün artık set değildir
    const key = String(body.key || ''); const p = await env.DB.prepare('SELECT key, merged_into FROM products WHERE key=?1').bind(key).first();
    if (!p || p.merged_into) return bad('Ürün bulunamadı.', 404);
    const items = new Map(); for (const x of (Array.isArray(body.items) ? body.items : []).slice(0, 30)) { const k = String(x.key || ''), n = Math.max(1, Math.min(1000, intOr(x.n, 1))); if (k && k !== key) items.set(k, (items.get(k) || 0) + n); }
    if (items.size) {
      const rows = await selectIn(env, 'SELECT key, merged_into FROM products', 'key', [...items.keys()]);
      if (rows.length !== items.size || rows.some(r => r.merged_into)) return bad('Set içindeki ürünlerden biri bulunamadı.');
      for (const k of items.keys()) if (BUNDLES.has(k) || (await env.DB.prepare('SELECT 1 FROM bundles WHERE pkey=?1 LIMIT 1').bind(k).first())) return bad('Bir setin içine başka bir set konamaz.');
      if (await env.DB.prepare('SELECT 1 FROM bundles WHERE comp=?1 LIMIT 1').bind(key).first()) return bad('Bu ürün başka bir setin içinde; set yapılamaz.');
    }
    await env.DB.batch([env.DB.prepare('DELETE FROM bundles WHERE pkey=?1').bind(key), ...[...items].map(([k, n]) => env.DB.prepare('INSERT INTO bundles(pkey, comp, n) VALUES(?1,?2,?3)').bind(key, k, n)), ...(items.size ? setQty(env, key, 0, { type: 'count', channel: 'manuel', note: 'Set ürün: setin kendi stoğu sıfırlandı (stok içindeki ürünlerden hesaplanır)' }) : []), REV(env)]);
    await loadBundles(env);
    return json({ ok: true });
  }
  if (path === '/api/products/listings') {
    const key = String(body.key || '');
    const { results } = await env.DB.prepare('SELECT channel, ext, pkey, orig_pkey, factor, sku, barcode, name, image, ext_qty, passive FROM listings WHERE pkey=?1 ORDER BY channel, name').bind(key).all();
    return json({ ok: true, listings: results });
  }
  if (path === '/api/products/merge') {
    // "from" ürününün bütün ilanları "into" ürününe bağlanır (paket ilanı için adet çarpanıyla); from gizlenir, geçmiş kayıtları kalır
    const from = String(body.from || ''), into = String(body.into || ''), factor = Math.max(1, Math.min(100, intOr(body.factor, 1)));
    if (!from || !into || from === into) return bad('Birleştirilecek ürünleri seç.');
    const [a, b] = await Promise.all([env.DB.prepare('SELECT * FROM products WHERE key=?1').bind(from).first(), env.DB.prepare('SELECT * FROM products WHERE key=?1').bind(into).first()]);
    if (!a || !b) return bad('Ürün bulunamadı.', 404);
    if (b.merged_into) return bad('Hedef ürün başka bir ürüne birleştirilmiş.');
    const chs = [...new Set([...JSON.parse(b.channels || '[]'), ...JSON.parse(a.channels || '[]')])];
    await env.DB.batch([
      env.DB.prepare('UPDATE listings SET pkey=?2, factor=CASE WHEN pkey=?1 THEN ?3 * COALESCE(factor,1) ELSE factor END WHERE pkey=?1').bind(from, into, factor),
      env.DB.prepare('UPDATE products SET merged_into=?2 WHERE key=?1').bind(from, into),
      env.DB.prepare('UPDATE products SET merged_into=?2 WHERE merged_into=?1').bind(from, into),
      env.DB.prepare(`UPDATE products SET channels=?2, cost=COALESCE(cost, ?3), image=CASE WHEN image='' THEN ?4 ELSE image END, ty_passive=CASE WHEN EXISTS(SELECT 1 FROM listings l WHERE l.pkey=?1 AND l.channel='trendyol' AND COALESCE(l.passive,0)=0) OR NOT EXISTS(SELECT 1 FROM listings l WHERE l.pkey=?1 AND l.channel='trendyol') THEN 0 ELSE 1 END WHERE key=?1`).bind(into, JSON.stringify(chs), a.cost, a.image || ''),
      env.DB.prepare('INSERT OR IGNORE INTO match_skip(a,b) VALUES(?1,?2)').bind(from, into), REV(env)]);
    return json({ ok: true });
  }
  if (path === '/api/products/factor') {
    const ch = String(body.channel || ''), ext = String(body.ext || ''), f = Math.max(1, Math.min(100, intOr(body.factor, 1)));
    await env.DB.batch([env.DB.prepare('UPDATE listings SET factor=?3 WHERE channel=?1 AND ext=?2').bind(ch, ext, f), REV(env)]);
    return json({ ok: true });
  }
  if (path === '/api/products/unlink') {
    // İlanı ayır: ilk bağlı olduğu ürüne geri döner (o ürün tekrar görünür); ilk ürünü buysa yapılacak bir şey yok
    const ch = String(body.channel || ''), ext = String(body.ext || '');
    const l = await env.DB.prepare('SELECT * FROM listings WHERE channel=?1 AND ext=?2').bind(ch, ext).first(); if (!l) return bad('İlan bulunamadı.', 404);
    if (!l.orig_pkey || l.orig_pkey === l.pkey) return bad('Bu ilan zaten kendi ürününe bağlı.');
    await env.DB.batch([env.DB.prepare('UPDATE listings SET pkey=orig_pkey, factor=1 WHERE channel=?1 AND ext=?2').bind(ch, ext), env.DB.prepare('UPDATE products SET merged_into=NULL WHERE key=?1').bind(l.orig_pkey), env.DB.prepare('DELETE FROM match_skip WHERE a=?1').bind(l.orig_pkey), REV(env)]);
    return json({ ok: true });
  }
  if (path === '/api/products/split') {
    // İlanı kendi başına yeni bir ürün yap (aynı stok kodu yüzünden başka ürünle birleşmiş ilan için); stok 0'dan başlar
    const ch = String(body.channel || ''), ext = String(body.ext || '');
    const l = await env.DB.prepare('SELECT * FROM listings WHERE channel=?1 AND ext=?2').bind(ch, ext).first(); if (!l) return bad('İlan bulunamadı.', 404);
    const key = (ch === 'shopify' ? 'shv-' : 'tyb-') + safeSeg(ext);
    if (key === l.pkey) return bad('Bu ilan zaten kendi ürünü.');
    await env.DB.batch([...ensureProduct(env, key, { sku: l.sku || '', name: l.name || l.sku || ext, barcode: l.barcode || '', image: l.image || '' }, ch),
      env.DB.prepare('UPDATE products SET merged_into=NULL WHERE key=?1').bind(key),
      env.DB.prepare('UPDATE listings SET pkey=?3, orig_pkey=?3, factor=1 WHERE channel=?1 AND ext=?2').bind(ch, ext, key), REV(env)]);
    return json({ ok: true, key });
  }
  if (path === '/api/products/skip') {
    const a = String(body.a || ''), b = String(body.b || ''); if (!a || !b) return bad('Eksik.');
    await env.DB.prepare('INSERT OR IGNORE INTO match_skip(a,b) VALUES(?1,?2)').bind(a, b).run();
    return json({ ok: true });
  }
  if (path === '/api/products/suggest') {
    // Aynı ürün olabilecek çiftler: adlar kelime kelime karşılaştırılır (adet/ölçü/renk dışı kelimeler); farklı kanallardan ya da paket (1'li/2'li) ilanları
    const { results } = await env.DB.prepare(`SELECT key, code, sku, name, image, channels, qty, ty_passive FROM products p WHERE merged_into IS NULL AND (NOT EXISTS(SELECT 1 FROM listings l WHERE l.pkey=p.key) OR EXISTS(SELECT 1 FROM listings l WHERE l.pkey=p.key AND COALESCE(l.passive,0)=0)) AND NOT (p.ty_passive=1 AND p.channels='["trendyol"]')`).all();
    const skip = new Set((await env.DB.prepare('SELECT a, b FROM match_skip').all()).results.flatMap(r => [r.a + '|' + r.b, r.b + '|' + r.a]));
    const STOP = new Set(['adet', 'li', 'lı', 'lu', 'lü', 've', 'ile', 'için', 'set', 'seti', 'takım', 'takımı', 'cm', 'mm', 'ml', 'lt', 'gr', 'kg', 'adetli', 'adet', 'lilya', 'home', 'one', 'size', 'tek', 'ebat', 'beyaz', 'siyah', 'gri']);
    const norm = (t) => String(t || '').toLocaleLowerCase('tr-TR').replace(/[^a-zçğıöşü0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w) && !/^\d+(x|\*)\d+/.test(w));
    const packN = (t) => { const m = /(\d+)\s*(?:'?\s*(?:adet|li|lı|lu|lü)(?![a-zçğıöşü])|\s*(?:pcs|parça))/i.exec(String(t || '')); const n = m ? Number(m[1]) : 1; return n >= 1 && n <= 50 ? n : 1; };
    const P = results.map(r => ({ key: r.key, code: r.code, sku: r.sku, name: r.name, image: r.image, ch: JSON.parse(r.channels || '[]'), qty: r.qty, passive: r.ty_passive === 1, w: new Set(norm(r.name)), n: packN(r.name) }));
    const out = [];
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const a = P[i], b = P[j]; if (skip.has(a.key + '|' + b.key) || !a.w.size || !b.w.size) continue;
      let inter = 0; for (const w of a.w) if (b.w.has(w)) inter++;
      const score = inter / (a.w.size + b.w.size - inter); if (score < 0.5) continue;
      const crossCh = a.ch.some(c => !b.ch.includes(c)) || b.ch.some(c => !a.ch.includes(c));
      if (!crossCh && a.n === b.n) continue; // aynı kanalda aynı paket = büyük ihtimalle farklı ürün (renk/ölçü)
      // Hedef: daha küçük paket (1'li) ve tercihen Trendyol'daki; kaynak paket adedi / hedef paket adedi = çarpan
      const [src, dst] = (a.n !== b.n ? a.n > b.n : (a.ch.includes('trendyol') ? false : b.ch.includes('trendyol'))) ? [a, b] : [b, a];
      const f = src.n % dst.n === 0 ? src.n / dst.n : 1;
      out.push({ score: Math.round(score * 100), factor: f, from: { key: src.key, code: src.code, sku: src.sku, name: src.name, image: src.image, ch: src.ch, qty: src.qty, passive: src.passive }, into: { key: dst.key, code: dst.code, sku: dst.sku, name: dst.name, image: dst.image, ch: dst.ch, qty: dst.qty, passive: dst.passive } });
    }
    out.sort((x, y) => y.score - x.score);
    // Bir ürün yalnızca en iyi önerisinde görünür
    const used = new Set(), list = []; for (const x of out) { if (used.has(x.from.key) || used.has(x.into.key)) continue; used.add(x.from.key); used.add(x.into.key); list.push(x); if (list.length >= 150) break; }
    return json({ ok: true, list, total: P.length });
  }
  // ---------- Kusurlu iadeler: sağlam / kırık kontrolü ----------
  if (path === '/api/inspect/list') {
    const done = body.done ? `inspect='done'` : `inspect='pending'`;
    const { results } = await env.DB.prepare(`SELECT r.id, r.channel, r.order_no, r.pkey, r.sku, r.name, r.qty, r.reason, r.cnote, r.note, r.customer, r.decided_at, r.created_at, r.insp_ok, r.insp_at, p.code, p.image, p.qty pqty, p.cost FROM returns r LEFT JOIN products p ON p.key=r.pkey WHERE r.${done} AND r.status='accepted' AND COALESCE(r.kept,0)=0 ORDER BY ${body.done ? 'r.insp_at DESC LIMIT 60' : 'COALESCE(r.decided_at, r.created_at) ASC LIMIT 200'}`).all();
    return json({ ok: true, items: results });
  }
  if (path === '/api/inspect/decide') {
    const r = await env.DB.prepare('SELECT * FROM returns WHERE id=?1').bind(String(body.id || '')).first(); if (!r) return bad('İade bulunamadı.', 404);
    const qty = Math.max(1, Number(r.qty) || 1), ok = Math.max(0, Math.min(qty, parseInt(body.ok, 10) || 0)), broken = qty - ok;
    const st = [];
    if (r.inspect === 'done') { // düzeltme: önceki sağlam adet geri alınır
      const prev = Number(r.insp_ok) || 0; if (prev) st.push(...changeQty(env, r.pkey, -prev, { type: 'adjust', channel: r.channel, ref: r.order_no, note: 'Kusurlu iade kontrolü düzeltildi' })); }
    else if (r.inspect !== 'pending') return bad('Bu iade kontrol beklemiyor.');
    if (ok) st.push(...changeQty(env, r.pkey, ok, { type: 'ret', channel: r.channel, ref: r.order_no, note: `Kusurlu iade kontrol edildi: ${ok} sağlam, stoğa eklendi` }));
    if (broken) st.push(env.DB.prepare(`INSERT INTO moves(t, pkey, sku, name, delta, after, type, channel, ref, note) SELECT ?1, key, sku, name, 0, qty, 'adjust', ?2, ?3, ?4 FROM products WHERE key=?5`).bind(iso(), r.channel, r.order_no, `Kusurlu iade: ${broken} adet kırık/kullanılamaz (ziyan, stoğa eklenmedi)`, r.pkey));
    st.push(env.DB.prepare(`UPDATE returns SET inspect='done', insp_ok=?2, insp_at=?3 WHERE id=?1`).bind(r.id, ok, iso()));
    const o = await env.DB.prepare('SELECT date FROM orders WHERE id=?1').bind(r.order_id).first();
    if (o && o.date) st.push(env.DB.prepare('DELETE FROM daily_stats WHERE day=?1').bind(trDay(Date.parse(o.date))));
    st.push(setStmt(env, 'home_cache', ''), REV(env));
    await env.DB.batch(st);
    return json({ ok: true, okQty: ok, broken });
  }
  // Kabul edilmiş bir iadeyi elle kontrole al (ör. sebebi kusurlu yazmayan ama kırık gelen ürün): eklenen iade stoğu geri alınır
  if (path === '/api/inspect/add') {
    const r = await env.DB.prepare('SELECT * FROM returns WHERE id=?1').bind(String(body.id || '')).first(); if (!r) return bad('İade bulunamadı.', 404);
    if (r.status !== 'accepted' || r.kept) return bad('Yalnız depoya ulaşıp kabul edilmiş iadeler kontrole alınabilir.');
    if (r.inspect) return bad('Bu iade zaten kusurlu iadeler panelinde.');
    const mv = await env.DB.prepare(`SELECT COALESCE(SUM(delta),0) n FROM moves WHERE ref=?1 AND pkey=?2 AND type='ret'`).bind(r.order_no, r.pkey).first();
    const added = Math.min(Number(r.qty) || 0, Math.max(0, Number(mv && mv.n) || 0));
    await env.DB.batch([...(added ? changeQty(env, r.pkey, -added, { type: 'adjust', channel: r.channel, ref: r.order_no, note: 'Kusurlu iade kontrolüne alındı; iade stoğu geri alındı' }) : []), env.DB.prepare(`UPDATE returns SET inspect='pending', insp_ok=NULL, insp_at=NULL WHERE id=?1`).bind(r.id), REV(env)]);
    return json({ ok: true });
  }
  if (path === '/api/returns/kept') {
    // Ürün müşteride kaldı (ücret iadesi yapıldı, ürün geri gelmeyecek): stoğa eklenmez/eklendiyse geri alınır; kârda ürün maliyeti zarar sayılır, dönüş kargosu yok
    const r = await env.DB.prepare('SELECT * FROM returns WHERE id=?1').bind(String(body.id || '')).first(); if (!r) return bad('İade bulunamadı.', 404);
    const kept = !!body.kept; if (!!r.kept === kept) return json({ ok: true });
    const st = [env.DB.prepare('UPDATE returns SET kept=?2 WHERE id=?1').bind(r.id, kept ? 1 : 0)];
    if (r.status === 'accepted') {
      const mv = await env.DB.prepare(`SELECT COALESCE(SUM(delta),0) n FROM moves WHERE ref=?1 AND pkey=?2 AND (type='ret' OR note LIKE 'Ürün müşteride kaldı%')`).bind(r.order_no, r.pkey).first();
      const added = Number(mv && mv.n) || 0;
      if (kept && added > 0) st.push(...changeQty(env, r.pkey, -Math.min(added, r.qty), { type: 'adjust', channel: r.channel, ref: r.order_no, note: 'Ürün müşteride kaldı; iade stoğu geri alındı' }));
      if (!kept && added < r.qty) st.push(...changeQty(env, r.pkey, r.qty - Math.max(0, added), { type: 'ret', channel: r.channel, ref: r.order_no, note: 'Ürün iade geldi; stoğa eklendi' }));
    }
    const o = await env.DB.prepare('SELECT date FROM orders WHERE id=?1').bind(r.order_id).first();
    if (o && o.date) st.push(env.DB.prepare('DELETE FROM daily_stats WHERE day=?1').bind(trDay(Date.parse(o.date))));
    st.push(setStmt(env, 'home_cache', ''), REV(env));
    await env.DB.batch(st);
    return json({ ok: true });
  }
  if (path === '/api/orders/ty-diag') {
    // Teşhis: bir siparişin Trendyol'daki iade/talep kayıtları ve cari hesap hareketleri (para nasıl kesildi/iade edildi). Müşteri bilgisi çıkarılır.
    if (!tyConfigured(env)) return bad('Trendyol bağlı değil.');
    const no = String(body.orderNo || '').trim(); if (!/^\d{5,20}$/.test(no)) return bad('Sipariş no geçersiz.');
    const sid = env.TRENDYOL_SELLER_ID, now = Date.now(), out = { orderNo: no, claims: [], fin: [], other: [], app: {}, errors: [] };
    const PII = /customer|address|firstName|lastName|phone|email|fullName|otp|identity|taxNumber|name$/i;
    const flat = (o, pre = '', acc = {}, d = 0) => { if (d > 4 || !o || typeof o !== 'object') return acc; for (const [k, v] of Object.entries(o)) { const key = pre ? pre + '.' + k : k; if (PII.test(k) && !/reason|status|product/i.test(key)) continue; if (v && typeof v === 'object') { if (Array.isArray(v)) v.slice(0, 6).forEach((x, i) => flat(x, key + '[' + i + ']', acc, d + 1)); else flat(v, key, acc, d + 1); } else if (v !== null && v !== '' && !/image|url$/i.test(k)) acc[key] = typeof v === 'number' && v > 1e12 ? iso(v + TY_TZ).slice(0, 16).replace('T', ' ') : String(v).slice(0, 120); } return acc; };
    try { const r = await ty(env, `order/sellers/${sid}/claims`, { orderNumber: no, startDate: now - 60 * 86400000, endDate: now, size: 20, page: 0 }); out.claims = (r.content || []).map(c => flat(c)); } catch (e) { out.errors.push('Talepler: ' + String(e.message || e).slice(0, 120)); }
    for (const type of FIN_TYPES.split(',')) {
      try { for (let page = 0; page < 5; page++) { const r = await ty(env, `finance/che/sellers/${sid}/settlements`, { transactionType: type, startDate: now - 15 * 86400000 + 60000, endDate: now, page, size: 1000, supplierId: sid });
        for (const x of (r.content || [])) if (String(x.orderNumber) === no) out.fin.push({ type, at: x.transactionDate ? iso(Number(x.transactionDate) + TY_TZ).slice(0, 16).replace('T', ' ') : '', desc: x.description || x.transactionType || '', credit: Number(x.credit) || 0, debt: Number(x.debt) || 0, commission: Number(x.commissionAmount) || 0, sellerRevenue: Number(x.sellerRevenue) || 0, rate: x.commissionRate ?? null });
        if (page + 1 >= (r.totalPages || 0)) break; } }
      catch (e) { out.errors.push(type + ': ' + String(e.message || e).slice(0, 100)); }
    }
    try { for (let page = 0; page < 5; page++) { const r = await ty(env, `finance/che/sellers/${sid}/otherfinancials`, { transactionType: 'DeductionInvoices', startDate: now - 15 * 86400000 + 60000, endDate: now, page, size: 500, supplierId: sid });
      for (const x of (r.content || [])) if (String(x.orderNumber || '') === no || JSON.stringify(x).includes(no)) out.other.push({ at: x.transactionDate ? iso(Number(x.transactionDate) + TY_TZ).slice(0, 16).replace('T', ' ') : '', type: x.transactionType || '', desc: x.description || '', credit: Number(x.credit) || 0, debt: Number(x.debt) || 0 });
      if (page + 1 >= (r.totalPages || 0)) break; } }
    catch (e) { out.errors.push('Kesinti faturaları: ' + String(e.message || e).slice(0, 100)); }
    const oid = orderId('trendyol', no);
    const [rr, ff, mm] = await env.DB.batch([env.DB.prepare('SELECT id, sku, qty, status, ext_status, note, kept, created_at, decided_at FROM returns WHERE order_id=?1').bind(oid), env.DB.prepare('SELECT * FROM order_fin WHERE order_no=?1').bind(no), env.DB.prepare('SELECT type, amount, date FROM fin_misc WHERE order_no=?1').bind(no)]);
    out.app = { returns: rr.results, fin: ff.results[0] || null, misc: mm.results };
    return json(out);
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
  if (path === '/api/labels/pending') {
    // Kargo etiketi için bekleyen paketler (Trendyol'da Yeni + İşleme alınan), güncel takip numarası ve adresle
    if (!tyConfigured(env)) return bad('Trendyol bağlı değil.');
    const sid = env.TRENDYOL_SELLER_ID, now = Date.now(), out = [];
    for (const status of ['Created', 'Picking', 'Invoiced']) {
      for (let page = 0; page < 5; page++) {
        let r;
        try { r = await ty(env, `order/sellers/${sid}/orders`, { status, startDate: now - 13 * 86400000, endDate: now + TY_TZ, size: 200, page, orderByField: 'PackageLastModifiedDate', orderByDirection: 'DESC' }); }
        catch (e) { return bad('Trendyol siparişleri alınamadı: ' + e.message, 502); }
        for (const p of (r.content || [])) {
          const sa = p.shipmentAddress || {}, t = (v) => String(v || '').trim();
          out.push({ pkgId: String(p.shipmentPackageId || p.id), orderNo: String(p.orderNumber || ''), status: p.shipmentPackageStatus || p.status || status,
            date: p.orderDate ? iso(Number(p.orderDate) - TY_ORDER_DATE_SHIFT) : null, provider: t(p.cargoProviderName), tracking: t(p.cargoTrackingNumber), sender: t(p.cargoSenderNumber),
            desi: Number(p.cargoDeci ?? p.deci) || null, fast: /sameday|bugun|bugün/i.test(String(p.fastDeliveryType || '')),
            to: { name: t(sa.fullName) || t([p.customerFirstName, p.customerLastName].filter(Boolean).join(' ')), address: t(sa.fullAddress || [sa.address1, sa.address2].filter(Boolean).join(' ')), district: t(sa.district), city: t(sa.city), phone: t(sa.phone) },
            total: Number(p.totalPrice ?? p.packageTotalPrice) || null,
            lines: (p.lines || []).filter(l => !/cancel|iptal/i.test(String(l.orderLineItemStatusName || ''))).map(l => { const q = Number(l.quantity) || 1, unit = Number(l.price) || 0;
              return { sku: t(l.merchantSku || l.stockCode || l.barcode), barcode: t(l.barcode), name: t(l.productName), size: t(l.productSize), color: t(l.productColor), qty: q, unit, amount: Number(l.amount) > 0 ? Number(l.amount) : Math.round(unit * q * 100) / 100 }; }) });
        }
        if (page + 1 >= (r.totalPages || 0)) break;
      }
    }
    out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    // PDF'e dönüştürülmüş (kayıtlı) paketler
    const pr = new Map((await selectIn(env, 'SELECT pkg_id, printed_at FROM label_printed', 'pkg_id', out.map(x => x.pkgId))).map(r => [String(r.pkg_id), r.printed_at]));
    for (const x of out) x.printedAt = pr.get(x.pkgId) || null;
    // Ürün resimleri (100×150 etikette ürünün yanında); stok kodundan, Türkçe İ/I farkı gözetmeden
    try { const fm = await skuFoldMap(env); const imgs = new Map((await env.DB.prepare(`SELECT key, image FROM products WHERE image<>''`).all()).results.map(r => [r.key, r.image]));
      for (const x of out) for (const l of x.lines) { const e = fm.get(skuFold(l.sku)); l.image = (e && imgs.get(e.key)) || imgs.get(skuKey(l.sku)) || ''; } } catch (e) {}
    // Lilya ürün kodu (ilanın bağlı olduğu ürün) ve paket adedi: kağıtlarda stok kodu yerine ürün kodu yazılır
    try { const lm = await listingMap(env, 'trendyol', out.flatMap(x => x.lines.map(l => l.barcode)));
      const keys = [...new Set([...lm.values()].map(v => v.pkey))];
      const pr = new Map((await selectIn(env, 'SELECT key, code, image FROM products', 'key', keys)).map(r => [r.key, r]));
      for (const x of out) for (const l of x.lines) { const e = lm.get(l.barcode); const p = e && pr.get(e.pkey); if (p) { l.code = p.code || ''; l.factor = e.factor; if (p.image) l.image = p.image; } } } catch (e) {}
    return json({ ok: true, sellerId: String(env.TRENDYOL_SELLER_ID || ''), packages: out });
  }
  if (path === '/api/labels/mark') {
    const ids = (Array.isArray(body.items) ? body.items : []).slice(0, 500).filter(x => x && x.pkgId);
    if (!ids.length) return bad('Paket seçilmedi.');
    const now = iso(), st = ids.map(x => body.printed === false ? env.DB.prepare('DELETE FROM label_printed WHERE pkg_id=?1').bind(String(x.pkgId))
      : env.DB.prepare('INSERT INTO label_printed(pkg_id, order_no, printed_at) VALUES(?1,?2,?3) ON CONFLICT(pkg_id) DO UPDATE SET printed_at=excluded.printed_at').bind(String(x.pkgId), String(x.orderNo || ''), now));
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    await env.DB.batch([REV(env)]);
    return json({ ok: true });
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
    for (const [k, f] of [['feeCargoT1', 'fee_cargo_t1'], ['feeCargoT2', 'fee_cargo_t2'], ['feeCargoT3', 'fee_cargo_t3'], ['feeServiceTy', 'fee_service_ty'], ['feeServiceFast', 'fee_service_fast'], ['serviceCutoff', 'service_cutoff'], ['baremMaxDesi', 'barem_max_desi'], ['feeCargoSh', 'fee_cargo_sh'], ['feePackOrder', 'fee_pack_order'], ['feePackUnit', 'fee_pack_unit'], ['feePackOrderSh', 'fee_pack_order_sh'], ['feePackUnitSh', 'fee_pack_unit_sh'], ['shComm', 'fee_sh_comm'], ['srSms', 'sr_sms_fee'], ['stopaj', 'stopaj']]) {
      if (body[k] !== undefined) { const n = numOrNull(body[k]); if (n === null || n < 0 || n > 100000) return bad('Gider değeri geçersiz.'); st.push(setStmt(env, f, n)); }
    }
    if (body.pushStock !== undefined) st.push(setStmt(env, 'ty_push', body.pushStock ? '1' : '0'));
    if (body.srSmsUntil !== undefined) { const v = String(body.srSmsUntil || ''); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return bad('Tarih geçersiz.'); st.push(setStmt(env, 'sr_sms_until', v), env.DB.prepare('DELETE FROM daily_stats WHERE day >= ?1').bind('2026-10-17'), setStmt(env, 'home_cache', '')); }
    if (body.reportStart !== undefined) { const v = String(body.reportStart || ''); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return bad('Tarih geçersiz.'); st.push(setStmt(env, 'report_start', v), env.DB.prepare('DELETE FROM daily_stats'), env.DB.prepare('DELETE FROM product_daily'), setStmt(env, 'stats_first', ''), setStmt(env, 'stats_cursor', ''), setStmt(env, 'home_cache', '')); RS_CACHE = { v, at: Date.now() }; }
    if (body.resyncProducts) st.push(setStmt(env, 'ty_prod_page', 0), setStmt(env, 'ty_prod_done', '1970-01-01T00:00:00.000Z'));
    // Kesinti/paketleme değerleri değişince raporlardaki kayıtlı günler yeniden hesaplanır
    if (['feeCargoT1','feeCargoT2','feeCargoT3','feeServiceTy','feeServiceFast','serviceCutoff','baremMaxDesi','feeCargoSh','feePackOrder','feePackUnit','feePackOrderSh','feePackUnitSh','shComm','srSms','stopaj','desiTables','desiMode'].some(k => body[k] !== undefined)) st.push(env.DB.prepare('DELETE FROM daily_stats'), env.DB.prepare('DELETE FROM product_daily'), setStmt(env, 'home_cache', ''));
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
    const ch = ['trendyol', 'shopify'].includes(body.channel) ? body.channel : '';
    const out = await computeProfit(env, iso(from), iso(to), ch); const ms = Date.now() - t0;
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
    const size = Math.max(1, Math.min(100, intOr(body.size, 100))), page = Math.max(1, intOr(body.page, 1));
    const where = [], args = [];
    const f = String(body.filter || 'all');
    if (f === 'delivered') where.push(`o.channel='trendyol' AND o.order_no IN (SELECT order_no FROM audit_pkg WHERE status='Delivered')`); else if (f === 'new' || f === 'printed') where.push(`o.channel='trendyol' AND o.order_no IN (SELECT a.order_no FROM audit_pkg a WHERE a.status IN ('Created','Picking','Invoiced') AND a.day >= '${trDay(Date.now() - 30 * 86400000)}' AND ${f === 'printed' ? '' : 'NOT '}EXISTS(SELECT 1 FROM label_printed lp WHERE lp.pkg_id=a.pkg_id))`); else if (f === 'active') where.push(`o.status='active'`); else if (f === 'cancelled') where.push(`o.status IN ('cancelled','partial')`); else if (f === 'returned') where.push(`o.status='returned'`);
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
    const [totR, listR] = await env.DB.batch([env.DB.prepare(`SELECT COUNT(*) n ${J}`).bind(...args), env.DB.prepare(`SELECT o.*, json_extract(c.data,'$.name') cname ${J} ORDER BY o.date DESC LIMIT ${size} OFFSET ${(page - 1) * size}`).bind(...args)]);
    const tot = totR.results[0], results = listR.results;
    // Kâr ayrı istekle gelir (liste beklemeden açılsın)
    if (body.prof === false) return json({ ok: true, page, size, total: tot ? tot.n : 0, orders: results.map(r => ({ ...mapOrder(r), prof: null })) });
    // Her siparişin kârı: Kâr ekranıyla aynı hesap, bu sayfadaki siparişlerin tarih aralığı için
    const prof = {};
    try {
      const ds = results.map(r => Date.parse(r.date)).filter(Number.isFinite);
      if (ds.length) {
        const pr = await computeProfit(env, iso(Math.min(...ds) - 1000), iso(Math.max(...ds) + 1000)) /* Shopify tarihleri milisaniyesiz ('…12Z'); metin karşılaştırmasında dışarıda kalmasın */;
        const ids = new Set(results.map(r => r.id));
        for (const x of pr.orders) if (ids.has(x.id)) prof[x.id] = { p: x.profit, r: x.revenue, a: !!x.actual };
      }
    } catch (e) {}
    return json({ ok: true, page, size, total: tot ? tot.n : 0, orders: results.map(r => ({ ...mapOrder(r), prof: prof[r.id] || null })) });
  }
  if (path === '/api/orders/profdet') {
    // Tek siparişin kâr dökümü (sipariş detayında gelir / gider kalemleri; Kâr ekranıyla aynı hesap)
    const id = String(body.id || ''); const r = await env.DB.prepare('SELECT date FROM orders WHERE id=?1').bind(id).first(); if (!r) return bad('Sipariş bulunamadı.', 404);
    const d = Date.parse(r.date); const pr = await computeProfit(env, iso(d - 1000), iso(d + 1000)); const x = (pr.orders || []).find(y => y.id === id);
    return json({ ok: true, x: x || null, outOfRange: !x });
  }
  if (path === '/api/orders/prof') {
    // Listede görünen siparişlerin kârı (Kâr ekranıyla aynı hesap)
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 100); const prof = {};
    if (ids.length) {
      const rows = await selectIn(env, 'SELECT id, date FROM orders', 'id', ids);
      const ds = rows.map(r => Date.parse(r.date)).filter(Number.isFinite);
      if (ds.length) { const pr = await computeProfit(env, iso(Math.min(...ds) - 1000), iso(Math.max(...ds) + 1000)) /* Shopify tarihleri milisaniyesiz ('…12Z'); metin karşılaştırmasında dışarıda kalmasın */; const want = new Set(ids); for (const x of pr.orders) if (want.has(x.id)) prof[x.id] = { p: x.profit, r: x.revenue, a: !!x.actual }; }
    }
    return json({ ok: true, prof });
  }
  if (path === '/api/orders/get') {
    // Tek sipariş: birincil anahtarla hızlı okuma (Kâr ekranından açılan eski siparişler için)
    const r = await env.DB.prepare(`SELECT o.*, json_extract(c.data,'$.name') cname FROM orders o LEFT JOIN order_cust c ON c.order_no=o.order_no AND o.channel='trendyol' WHERE o.id=?1`).bind(String(body.id || '')).first();
    return json({ ok: true, orders: r ? [mapOrder(r)] : [] });
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
      const all = [...changes.map(c => env.DB.prepare('UPDATE products SET cost=?1, cost_date=NULL, updated_at=?2 WHERE key=?3').bind(c.cost, now, c.key)),
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
      if (path === '/hook/shopify') {
        if (req.method !== 'POST') return new Response('ok');
        await init(env); USE.req++;
        const raw = await req.arrayBuffer(); const c = await shCreds(env);
        if (!shConfigured(c)) return new Response('yok', { status: 404 });
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(c.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, raw))));
        if (sig !== (req.headers.get('x-shopify-hmac-sha256') || '')) return new Response('yetkisiz', { status: 401 });
        ctx.waitUntil((async () => { await sleep(1500); try { const r = await syncShopifyOrders(env, { pages: 1 }); await setSetting(env, 'sh_hook_at', iso() + ' · ' + (r ? r.orders + ' sipariş' : '')); } catch (e) { await setSetting(env, 'sh_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); } })());
        return new Response('ok');
      }
      if (path === '/hook/ty') {
        // Trendyol sipariş bildirimi: anahtar doğrulanır, yeni sipariş hemen işlenir
        if (req.method !== 'POST') return new Response('ok');
        await init(env); USE.req++;
        const key = await getSetting(env, 'hook_key');
        if (!key || req.headers.get('x-api-key') !== key) return new Response('yetkisiz', { status: 401 });
        const b = await req.json().catch(() => null);
        const pkgs = !b ? [] : Array.isArray(b) ? b : Array.isArray(b.content) ? b.content : [b];
        try { const r = await handleTyHook(env, pkgs); await setSetting(env, 'hook_at', iso() + ' · ' + (r.n ? r.n + ' yeni paket' : 'kayıtlı')); }
        catch (e) { await setSetting(env, 'hook_err', iso() + ' · ' + String(e.message || e).slice(0, 200)); }
        return json({ ok: true });
      }
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
        if (SELF_ORIGIN !== url.origin) { SELF_ORIGIN = url.origin; ctx.waitUntil(getSetting(env, 'self_origin').then(v => v !== url.origin ? setSetting(env, 'self_origin', url.origin) : null).catch(() => {})); }
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

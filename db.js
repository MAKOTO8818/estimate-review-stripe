/**
 * データベース接続・初期化
 *
 * Render純正のPostgreSQL(環境変数 DATABASE_URL)に接続する。
 * マイグレーションフレームワークは使わず(ローカル開発環境が無いため)、
 * 起動時に CREATE TABLE IF NOT EXISTS / ALTER TABLE で必要なテーブル・カラムを
 * 自動的に用意する方式(冪等: 何度実行しても安全)。
 *
 * マルチテナント化(建設会社へのSaaS販売)について:
 *   「tenants」テーブルが会社(テナント)ごとの設定(LINEチャネル情報・担当者LINE ID等)を持つ。
 *   既存の他のテーブルにはすべて tenant_id を追加し、会社ごとにデータを分離する。
 *   これまで単一事業(建設顧問セカンドオピニオン)として動いていたデータは、
 *   起動時に自動で「デフォルトテナント」(slug: 'default')に割り当てられる。
 *   これにより、既存のLINE公式アカウント・Webhook URLの設定は一切変更不要。
 */

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('⚠️ DATABASE_URL が未設定です。環境変数を確認してください。');
}

// Renderの「Internal Database URL」はRenderの同一プライベートネットワーク内の接続のためSSL不要。
// 「External Database URL」(ホスト名が ...render.com で終わる)を使う場合はSSLが必要になるため、
// ホスト名で自動判定する。
const needsSsl = (process.env.DATABASE_URL || '').includes('render.com');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('❌ DBプールで予期しないエラー:', err);
});

/**
 * 指定テーブルに指定カラムが既に存在するかを調べる(マイグレーションの冪等性確保のため)。
 */
async function columnExists(table, column) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows.length > 0;
}

/**
 * 「line_user_id を単独の主キーにしている既存テーブル」を、
 * (tenant_id, line_user_id) の複合主キーに移行する。
 * 既にtenant_idカラムがある場合は何もしない(初回起動時のみ実行される)。
 */
async function migrateToTenantScoped(table, defaultTenantId) {
  if (await columnExists(table, 'tenant_id')) return;

  console.log(`↻ ${table} をテナント対応に移行しています...`);
  await pool.query(`ALTER TABLE ${table} ADD COLUMN tenant_id UUID REFERENCES tenants(id)`);
  await pool.query(`UPDATE ${table} SET tenant_id = $1 WHERE tenant_id IS NULL`, [defaultTenantId]);
  await pool.query(`ALTER TABLE ${table} ALTER COLUMN tenant_id SET NOT NULL`);
  await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey`);
  await pool.query(`ALTER TABLE ${table} ADD PRIMARY KEY (tenant_id, line_user_id)`);
}

/**
 * tenant_idを持たない「tenant_id無しで作られた」テーブル(pending_reviews等)に、
 * 後からtenant_idカラムだけを追加する(主キーは変更しない)。
 */
async function addTenantIdColumn(table, defaultTenantId) {
  if (await columnExists(table, 'tenant_id')) return;

  console.log(`↻ ${table} にtenant_idを追加しています...`);
  await pool.query(`ALTER TABLE ${table} ADD COLUMN tenant_id UUID REFERENCES tenants(id)`);
  await pool.query(`UPDATE ${table} SET tenant_id = $1 WHERE tenant_id IS NULL`, [defaultTenantId]);
  await pool.query(`ALTER TABLE ${table} ALTER COLUMN tenant_id SET NOT NULL`);
}

/**
 * 起動時に呼び出す。必要なテーブル・カラムが無ければ作成する。
 */
async function initDb() {
  // --- テナント(会社)テーブル ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id UUID PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      company_name TEXT NOT NULL,
      admin_email TEXT,
      line_channel_secret TEXT,
      line_channel_access_token TEXT,
      expert_line_user_id TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // --- デフォルトテナント(これまでの単一事業)を用意する ---
  // 既存のLINE_CHANNEL_SECRET等の環境変数の値を、そのままデフォルトテナントの設定として使う。
  // slug='default' で既に存在する場合は何もしない。
  const crypto = require('crypto');
  const existing = await pool.query(`SELECT id FROM tenants WHERE slug = 'default'`);
  let defaultTenantId;
  if (existing.rows.length > 0) {
    defaultTenantId = existing.rows[0].id;
  } else {
    defaultTenantId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO tenants (id, slug, company_name, line_channel_secret, line_channel_access_token, expert_line_user_id)
       VALUES ($1, 'default', '建設顧問セカンドオピニオン', $2, $3, $4)`,
      [
        defaultTenantId,
        process.env.LINE_CHANNEL_SECRET || null,
        process.env.LINE_CHANNEL_ACCESS_TOKEN || null,
        process.env.EXPERT_LINE_USER_ID || null,
      ]
    );
    console.log('✅ デフォルトテナント(建設顧問セカンドオピニオン)を作成しました');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS seen_users (
      line_user_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await migrateToTenantScoped('seen_users', defaultTenantId);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stripe_customers (
      line_user_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await migrateToTenantScoped('stripe_customers', defaultTenantId);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_estimate_pdfs (
      line_user_id TEXT PRIMARY KEY,
      pdf_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await migrateToTenantScoped('pending_estimate_pdfs', defaultTenantId);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_reviews (
      id UUID PRIMARY KEY,
      line_user_id TEXT NOT NULL,
      page_count INT,
      summary TEXT,
      findings JSONB NOT NULL DEFAULT '[]',
      matched_count INT DEFAULT 0,
      unmatched_count INT DEFAULT 0,
      pdf_data BYTEA,
      approved BOOLEAN NOT NULL DEFAULT false,
      replaced_by_expert BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await addTenantIdColumn('pending_reviews', defaultTenantId);

  // 学習機能の元データ: 処理した見積りの行データを全件蓄積していく。
  // 将来、ここから単価の統計(カテゴリ別の平均・分布など)を集計し、
  // AIのチェック精度向上に使う(item③以降で活用)。テナントごとに分離する。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS estimate_line_items (
      id SERIAL PRIMARY KEY,
      review_id UUID,
      page INT,
      item_text TEXT,
      qty TEXT,
      unit TEXT,
      unit_price TEXT,
      amount TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await addTenantIdColumn('estimate_line_items', defaultTenantId);

  console.log('✅ DB初期化完了(テーブル確認・作成済み、マルチテナント対応済み)');
}

module.exports = { pool, initDb };

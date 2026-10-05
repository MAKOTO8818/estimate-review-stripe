/**
 * データベース接続・初期化
 *
 * Render純正のPostgreSQL(環境変数 DATABASE_URL)に接続する。
 * マイグレーションフレームワークは使わず(ローカル開発環境が無いため)、
 * 起動時に CREATE TABLE IF NOT EXISTS で必要なテーブルを自動的に用意する方式。
 *
 * これまでメモリ上のMap/Set・ローカルディスクに置いていた以下のデータを、
 * すべてこのDBに永続化する(Renderの再起動・再デプロイで消えなくなる):
 *   - 初回利用者かどうかの判定 (seen_users)
 *   - LINEユーザー ↔ Stripe顧客ID の対応 (stripe_customers)
 *   - 受付中の見積書PDF本体 (pending_estimate_pdfs)
 *   - 専門家の承認待ちレビュー (pending_reviews)
 *   - 添削済みPDF本体 (pending_reviews.pdf_data)
 *   - 見積りの行データ(学習機能の元データ) (estimate_line_items)
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
 * 起動時に呼び出す。必要なテーブルが無ければ作成する。
 */
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seen_users (
      line_user_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stripe_customers (
      line_user_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_estimate_pdfs (
      line_user_id TEXT PRIMARY KEY,
      pdf_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

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

  // 学習機能の元データ: 処理した見積りの行データを全件蓄積していく。
  // 将来、ここから単価の統計(カテゴリ別の平均・分布など)を集計し、
  // AIのチェック精度向上に使う(item③以降で活用)。
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

  console.log('✅ DB初期化完了(テーブル確認・作成済み)');
}

module.exports = { pool, initDb };

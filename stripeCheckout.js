/**
 * Stripe Checkout Session の作成
 *
 * 「都度金額が変わる決済リンク」は、Payment Links ではなく
 * Checkout Sessions + line_items[].price_data で作るのが Stripe 推奨の方法。
 * (Payment Links は事前に作った Price に紐づくため、金額を毎回変えるのに不向き)
 *
 * カード情報の保存・再利用について:
 *   LINEのユーザーIDごとにStripeの「顧客(Customer)」を作成し、
 *   決済時に setup_future_usage を指定することで、カード情報をStripe側に安全に保存する。
 *   2回目以降は同じCustomerでCheckout Sessionを作るだけで、
 *   Stripeが自動的に「保存済みのカードを選ぶ/新しいカードを追加する」画面を出してくれる。
 *   (カード番号そのものはこちらのサーバーには一切保存しない)
 *
 *   顧客IDの対応(lineUserId -> Stripe Customer ID)は、以下の順で解決する:
 *     1. メモリ上のキャッシュ(customerIdCache。同一プロセス内の高速化のみ)
 *     2. DB(stripe_customersテーブル。再起動しても消えない正の情報源)
 *     3. (DBにも無い場合のみ)Stripe側をmetadataで検索し、無ければ新規作成してDBに保存
 *
 *   検索には stripe.customers.search ではなく stripe.customers.list を使っている。
 *   search は反映まで数秒〜数十秒のタイムラグがあり(作成直後は見つからないことがある)、
 *   その間に重複して顧客が作られてしまう不具合があったため、即時反映される list に変更した。
 *
 * マルチテナント化について:
 *   複数の会社(テナント)が同じ仕組みを使うようになったため、
 *   lineUserId だけでなく tenantId もあわせてキー(組み合わせ)として顧客を管理する。
 *   (今のところ、決済そのものはすべて同じStripeアカウントで受け付ける。
 *    会社ごとに別々のStripeアカウントで受け付ける仕組み(Stripe Connect)は、
 *    従量課金の自動化(item③)に合わせて別途検討する)
 */

const Stripe = require('stripe');
const { pool } = require('./db');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-08-27.basil',
});

// "tenantId:lineUserId" -> Stripe Customer ID のキャッシュ(同一プロセス内のみ有効。再起動したらDBから復元する)
const customerIdCache = new Map();

/**
 * テナントのLINEユーザーIDに対応するStripe顧客を取得する。いなければ新規作成する。
 * @param {string} tenantId
 * @param {string} lineUserId
 * @returns {Promise<string>} Stripe Customer ID
 */
async function findOrCreateCustomerForLineUser(tenantId, lineUserId) {
  const cacheKey = `${tenantId}:${lineUserId}`;
  if (customerIdCache.has(cacheKey)) {
    return customerIdCache.get(cacheKey);
  }

  // 1. DBを確認(これが正の情報源。再起動しても消えない)
  const { rows } = await pool.query(
    'SELECT stripe_customer_id FROM stripe_customers WHERE tenant_id = $1 AND line_user_id = $2',
    [tenantId, lineUserId]
  );
  if (rows.length > 0) {
    const customerId = rows[0].stripe_customer_id;
    customerIdCache.set(cacheKey, customerId);
    return customerId;
  }

  // 2. DBに無い場合のみ、Stripe側をmetadataで検索する
  //    (DB導入前に作られた顧客や、何らかの理由でDB書き込みが失敗したケースの救済)
  let customerId = null;
  for await (const customer of stripe.customers.list({ limit: 100 })) {
    if (
      customer.metadata &&
      customer.metadata.line_user_id === lineUserId &&
      customer.metadata.tenant_id === tenantId
    ) {
      customerId = customer.id;
      break;
    }
  }

  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { line_user_id: lineUserId, tenant_id: tenantId },
    });
    customerId = customer.id;
  }

  // 3. DBに保存して、次回以降はDBだけで解決できるようにする
  await pool.query(
    `INSERT INTO stripe_customers (tenant_id, line_user_id, stripe_customer_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, line_user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
    [tenantId, lineUserId, customerId]
  );

  customerIdCache.set(cacheKey, customerId);
  return customerId;
}

/**
 * @param {object} params
 * @param {string} params.tenantId テナント(会社)のID
 * @param {string} params.tenantName 商品名表示に使う会社名
 * @param {number} params.amount 請求金額(円、整数)
 * @param {string} params.lineUserId LINEのユーザーID(注文とお客様を紐づけるため)
 * @param {number} params.pageCount 見積書のページ数
 * @param {boolean} params.isFirstTimeUser 初回利用者かどうか
 * @param {string} params.successUrl 決済完了後にリダイレクトするURL
 * @param {string} params.cancelUrl 決済キャンセル時にリダイレクトするURL
 * @returns {Promise<{ id: string, url: string }>} Checkout Session の id とお客様に送る決済URL
 */
async function createEstimateReviewCheckoutSession({
  tenantId,
  tenantName,
  amount,
  lineUserId,
  pageCount,
  isFirstTimeUser,
  successUrl,
  cancelUrl,
}) {
  if (amount <= 0) {
    // 初回利用で1ページのみ(=無料)の場合は決済不要。呼び出し側でこのケースを分岐すること。
    throw new Error('amount が0円以下です。無料枠のみの場合は決済セッションを作成しないでください。');
  }

  const customerId = await findOrCreateCustomerForLineUser(tenantId, lineUserId);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    managed_payments: { enabled: false },
    customer: customerId,
    payment_intent_data: {
      // このお客様の今後の決済のためにカードを保存する(Stripeが安全に保管。こちらのサーバーには残らない)
      setup_future_usage: 'off_session',
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'jpy',
          unit_amount: amount, // JPYはゼロ・ディシマル通貨。100倍不要。
          product_data: {
            name: `AI見積り添削(${tenantName || '建設顧問セカンドオピニオン'})`,
            description: `${pageCount}ページ分の添削`,
          },
        },
      },
    ],
    metadata: {
      tenant_id: tenantId,
      line_user_id: lineUserId,
      page_count: String(pageCount),
      is_first_time_user: String(isFirstTimeUser),
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  return { id: session.id, url: session.url };
}

module.exports = { createEstimateReviewCheckoutSession, findOrCreateCustomerForLineUser, stripe };

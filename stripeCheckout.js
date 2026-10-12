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
 *
 * テナント(会社)向けのサブスクリプション課金について(2026-10-12 決定事項):
 *   セルフサインアップで登録した会社には、以下を毎月課金する:
 *     - 月額基本料金: 5,000円/月
 *     - 従量課金: 見積り添削1ページあたり100円(Stripeの Billing Meters を使用)
 *   月額基本料金・従量課金ともに、全テナント共通の Price を1つだけ作成し、
 *   (初回だけStripe側に作成、以降はDBのbilling_configテーブルに保存したIDを再利用する)
 *   テナントごとに別々のStripe Customer・Subscriptionを作ってそのPriceに紐づける。
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

// --- テナント(会社)向けサブスクリプション課金 ---

const TENANT_BASE_MONTHLY_FEE_YEN = 5000; // 月額基本料金
const TENANT_USAGE_YEN_PER_PAGE = 100; // 従量課金(見積り添削1ページあたり)
const TENANT_METER_EVENT_NAME = 'tenant_estimate_review_page';

async function getBillingConfigValue(key) {
  const { rows } = await pool.query('SELECT value FROM billing_config WHERE key = $1', [key]);
  return rows.length > 0 ? rows[0].value : null;
}

async function setBillingConfigValue(key, value) {
  await pool.query(
    `INSERT INTO billing_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

// 同一プロセス内では毎回Stripe/DBに問い合わせなくて済むようにキャッシュする
let billingConfigCache = null;

/**
 * テナント課金用の Meter / Price が無ければ作成し、あれば再利用する。
 * (初回起動時にだけStripe側への作成が走り、以降はDBに保存されたIDを使う)
 * @returns {Promise<{ meterId: string, basePriceId: string, usagePriceId: string }>}
 */
async function ensureTenantBillingConfig() {
  if (billingConfigCache) return billingConfigCache;

  let meterId = await getBillingConfigValue('meter_id');
  if (!meterId) {
    const meter = await stripe.billing.meters.create({
      display_name: 'AI見積り添削 テナント従量課金(1ページあたり)',
      event_name: TENANT_METER_EVENT_NAME,
      default_aggregation: { formula: 'sum' },
      customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
      value_settings: { event_payload_key: 'value' },
    });
    meterId = meter.id;
    await setBillingConfigValue('meter_id', meterId);
    console.log('✅ Stripe Meterを作成しました:', meterId);
  }

  let basePriceId = await getBillingConfigValue('base_price_id');
  if (!basePriceId) {
    const price = await stripe.prices.create({
      currency: 'jpy',
      unit_amount: TENANT_BASE_MONTHLY_FEE_YEN,
      recurring: { interval: 'month' },
      product_data: { name: 'AI見積り添削 月額基本料金' },
    });
    basePriceId = price.id;
    await setBillingConfigValue('base_price_id', basePriceId);
    console.log('✅ 月額基本料金のPriceを作成しました:', basePriceId);
  }

  let usagePriceId = await getBillingConfigValue('usage_price_id');
  if (!usagePriceId) {
    const price = await stripe.prices.create({
      currency: 'jpy',
      unit_amount: TENANT_USAGE_YEN_PER_PAGE,
      billing_scheme: 'per_unit',
      recurring: { interval: 'month', usage_type: 'metered', meter: meterId },
      product_data: { name: 'AI見積り添削 従量課金(1ページあたり)' },
    });
    usagePriceId = price.id;
    await setBillingConfigValue('usage_price_id', usagePriceId);
    console.log('✅ 従量課金のPriceを作成しました:', usagePriceId);
  }

  billingConfigCache = { meterId, basePriceId, usagePriceId };
  return billingConfigCache;
}

/**
 * セルフサインアップしたテナント(会社)用に、サブスクリプション契約のための
 * Checkout Session(mode: 'subscription')を作成する。
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.companyName
 * @param {string} [params.adminEmail]
 * @param {string} params.successUrl
 * @param {string} params.cancelUrl
 * @returns {Promise<{ id: string, url: string }>}
 */
async function createTenantSubscriptionCheckoutSession({ tenantId, companyName, adminEmail, successUrl, cancelUrl }) {
  const { basePriceId, usagePriceId } = await ensureTenantBillingConfig();

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: adminEmail || undefined,
    line_items: [
      { price: basePriceId, quantity: 1 },
      { price: usagePriceId },
    ],
    metadata: { tenant_id: tenantId, purpose: 'tenant_subscription' },
    subscription_data: {
      metadata: { tenant_id: tenantId, purpose: 'tenant_subscription' },
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  return { id: session.id, url: session.url };
}

/**
 * テナントの契約状況をStripe Checkout SessionのIDから確定させ、DBに反映する。
 * Webhook到達前でも/signup/completeの表示時点で即時反映できるようにするための関数。
 * (Webhookと両方から呼ばれても安全なよう、何度呼んでも同じ結果になるようにしている)
 * @param {string} sessionId
 * @returns {Promise<{ tenantId: string, subscriptionStatus: string } | null>}
 */
async function finalizeTenantSubscriptionFromSession(sessionId) {
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
  if (session.mode !== 'subscription' || session.metadata?.purpose !== 'tenant_subscription') {
    return null;
  }
  const tenantId = session.metadata.tenant_id;
  if (!tenantId || session.status !== 'complete') {
    return null;
  }

  const subscription = session.subscription;
  const subscriptionId = typeof subscription === 'string' ? subscription : subscription?.id;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;

  await pool.query(
    `UPDATE tenants
     SET is_active = true, subscription_status = 'active', stripe_customer_id = $1, stripe_subscription_id = $2
     WHERE id = $3`,
    [customerId, subscriptionId, tenantId]
  );

  return { tenantId, subscriptionStatus: 'active' };
}

/**
 * テナントの今月の使用量(見積り添削のページ数)をStripeに報告する(従量課金の計上)。
 * サブスクリプションが有効なテナントのみ報告する。失敗しても添削フロー自体は止めない。
 * @param {object} tenant tenants テーブルの1行(stripe_customer_id, subscription_status を含む)
 * @param {number} quantity 今回添削したページ数
 */
async function reportTenantUsage(tenant, quantity) {
  if (!tenant.stripe_customer_id || tenant.subscription_status !== 'active') return;
  try {
    await ensureTenantBillingConfig();
    await stripe.billing.meterEvents.create({
      event_name: TENANT_METER_EVENT_NAME,
      payload: {
        stripe_customer_id: tenant.stripe_customer_id,
        value: String(quantity),
      },
    });
  } catch (err) {
    console.error(`⚠️ [${tenant.slug}] 従量課金の使用量送信に失敗しました:`, err.message);
  }
}

module.exports = {
  createEstimateReviewCheckoutSession,
  findOrCreateCustomerForLineUser,
  createTenantSubscriptionCheckoutSession,
  finalizeTenantSubscriptionFromSession,
  reportTenantUsage,
  stripe,
};

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
 * テナント(会社)向けの課金について(2026-10-13 更新):
 *   セルフサインアップで登録した会社には、以下を課金する:
 *     - 月額基本料金: 5,000円/月(Stripeのサブスクリプションとして毎月自動請求)
 *     - 従量課金: 見積り添削1件ごとに、ページ数 × 100円を、その場で即時決済する
 *       (月末まで溜めて請求するのではなく、サインアップ時に登録したカードに対して
 *        都度 PaymentIntent で即時課金することで、未回収リスクを避ける。
 *        2026-10-13 成瀬さんの指示により、Stripe Billing Meters での月末まとめ請求から変更した)
 *   月額基本料金は、全テナント共通の Price を1つだけ作成し、
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
const TENANT_USAGE_YEN_PER_PAGE = 100; // 従量課金(見積り添削1ページあたり。都度即時決済する)

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
 * テナント課金用の月額基本料金 Price が無ければ作成し、あれば再利用する。
 * (初回起動時にだけStripe側への作成が走り、以降はDBに保存されたIDを使う)
 * 従量課金(1ページ100円)は、サブスクリプションのPriceとしては作らず、
 * 見積り添削のたびに chargeTenantUsageImmediately() で都度PaymentIntentとして即時決済する。
 * @returns {Promise<{ basePriceId: string }>}
 */
async function ensureTenantBillingConfig() {
  if (billingConfigCache) return billingConfigCache;

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

  billingConfigCache = { basePriceId };
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
  const { basePriceId } = await ensureTenantBillingConfig();

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    managed_payments: { enabled: false },
    customer_email: adminEmail || undefined,
    line_items: [
      { price: basePriceId, quantity: 1 },
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
 * テナントの登録済みカード(支払い方法)のIDを、複数の手がかりから探して返す。
 * Stripe Checkout(サブスクリプション)で登録したカードは、必ずしも
 * 顧客の「デフォルト支払い方法(invoice_settings.default_payment_method)」に
 * 自動設定されるとは限らないため、以下の順で確実に探す:
 *   1. 顧客のデフォルト支払い方法(invoice_settings.default_payment_method)
 *   2. 顧客のデフォルトの古い形式の支払い元(default_source)
 *   3. サブスクリプション自体に設定されているデフォルト支払い方法
 *   4. 上記で見つからない場合、その顧客に登録されているカードを直接検索し、最新のものを使う
 * @param {object} tenant tenants テーブルの1行(stripe_customer_id, stripe_subscription_id を含む)
 * @returns {Promise<string|null>}
 */
async function findTenantPaymentMethodId(tenant) {
  const customer = await stripe.customers.retrieve(tenant.stripe_customer_id);

  if (customer.invoice_settings && customer.invoice_settings.default_payment_method) {
    const pm = customer.invoice_settings.default_payment_method;
    return typeof pm === 'string' ? pm : pm.id;
  }

  if (customer.default_source) {
    const src = customer.default_source;
    return typeof src === 'string' ? src : src.id;
  }

  if (tenant.stripe_subscription_id) {
    try {
      const subscription = await stripe.subscriptions.retrieve(tenant.stripe_subscription_id);
      if (subscription.default_payment_method) {
        const pm = subscription.default_payment_method;
        return typeof pm === 'string' ? pm : pm.id;
      }
    } catch (err) {
      // サブスクリプションの取得に失敗しても、次の手段(直接検索)にフォールバックする
      console.error(`⚠️ [${tenant.slug}] サブスクリプション情報の取得に失敗しました:`, err.message);
    }
  }

  const methods = await stripe.paymentMethods.list({
    customer: tenant.stripe_customer_id,
    type: 'card',
    limit: 1,
  });
  if (methods.data.length > 0) {
    return methods.data[0].id;
  }

  return null;
}

/**
 * テナントの登録済みカード(サブスクリプション契約時に保存されたもの)に対して、
 * 従量課金分(ページ数 × 100円)をその場で即時決済する(1件分)。
 * 成功したらDB側に決済済みの印をつける。
 * 失敗しても例外を投げない(呼び出し側の添削フローを止めないため)。
 * idempotencyKeyにreview_idを使うことで、同じレビューを誤って二重に呼び出しても
 * 二重決済にならないようにしている。
 */
async function chargeTenantUsageImmediately(tenant, usageEventId, reviewId, quantity) {
  if (!tenant.stripe_customer_id || tenant.subscription_status !== 'active') return;
  const amount = quantity * TENANT_USAGE_YEN_PER_PAGE;
  if (amount <= 0) return;

  try {
    const paymentMethodId = await findTenantPaymentMethodId(tenant);

    if (!paymentMethodId) {
      throw new Error('登録済みの支払い方法が見つかりません(カード登録が完了していない可能性があります)');
    }

    await stripe.paymentIntents.create(
      {
        amount,
        currency: 'jpy',
        customer: tenant.stripe_customer_id,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description: `AI見積り添削 従量課金(${quantity}ページ分)`,
        metadata: {
          tenant_id: tenant.id,
          review_id: reviewId,
          purpose: 'tenant_usage_charge',
        },
      },
      { idempotencyKey: `tenant-usage-charge-${reviewId}` }
    );

    await pool.query(
      `UPDATE tenant_usage_events SET reported_to_stripe = true, reported_at = now() WHERE id = $1`,
      [usageEventId]
    );
  } catch (err) {
    console.error(
      `⚠️ [${tenant.slug}] 従量課金の即時決済に失敗しました(DBには記録済みのため、後ほど自動的に再試行されます):`,
      err.message
    );
  }
}

/**
 * テナントの使用量(見積り添削1件分のページ数)を記録し、その場で即時決済する。
 * 1. まず自社DB(tenant_usage_events)に記録する(review_idにユニーク制約があるため、
 *    同じレビューに対して二重に呼び出されても二重計上されない)。
 * 2. 続けてStripeへの即時決済(PaymentIntent)を試みる。失敗しても、DBには記録が残っているので
 *    retryUnreportedTenantUsage() による自動再試行の対象になる(使用量そのものを失わない)。
 * @param {object} tenant tenants テーブルの1行
 * @param {string} reviewId pending_reviews.id
 * @param {number} quantity 今回添削したページ数
 */
async function recordAndReportTenantUsage(tenant, reviewId, quantity) {
  if (tenant.slug === 'default') return; // 成瀬さん自身の事業はSaaS課金の対象外

  let usageEventId;
  try {
    const { rows } = await pool.query(
      `INSERT INTO tenant_usage_events (tenant_id, review_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (review_id) DO NOTHING
       RETURNING id`,
      [tenant.id, reviewId, quantity]
    );
    if (rows.length === 0) return; // 既に記録済み(二重呼び出し)。何もしない。
    usageEventId = rows[0].id;
  } catch (err) {
    console.error(`⚠️ [${tenant.slug}] 使用量のDB記録に失敗しました:`, err.message);
    return;
  }

  await chargeTenantUsageImmediately(tenant, usageEventId, reviewId, quantity);
}

/**
 * 即時決済に失敗してDBに溜まっている使用量を再試行する。
 * サーバー起動時、および一定時間おきに自動実行される(server.js参照)。
 * 1回につき最大50件まで(溜まりすぎている場合は次回に持ち越す)。
 */
/**
 * テナント自身によるセルフサービス解約。
 * Stripeのサブスクリプションを即時キャンセルし、テナントを非アクティブ化する。
 * (キャンセル後は Stripe 側の customer.subscription.deleted Webhook も届くが、
 *  このテーブル更新と内容が同じなので二重実行しても問題ない)
 * @param {object} tenant tenants テーブルの1行(stripe_subscription_id を含む)
 */
async function cancelTenantSubscription(tenant) {
  if (tenant.stripe_subscription_id) {
    try {
      await stripe.subscriptions.cancel(tenant.stripe_subscription_id);
    } catch (err) {
      // 既にStripe側で解約済み(resource_missing)の場合は無視して、DB側だけ揃える
      if (err.code !== 'resource_missing') {
        throw err;
      }
    }
  }
  await pool.query(
    `UPDATE tenants SET subscription_status = 'canceled', is_active = false WHERE id = $1`,
    [tenant.id]
  );
}

async function retryUnreportedTenantUsage() {
  const { rows } = await pool.query(
    `SELECT u.id AS usage_id, u.review_id, u.quantity,
            t.id AS tenant_id, t.slug, t.stripe_customer_id, t.stripe_subscription_id, t.subscription_status
     FROM tenant_usage_events u
     JOIN tenants t ON t.id = u.tenant_id
     WHERE u.reported_to_stripe = false
     ORDER BY u.created_at ASC
     LIMIT 50`
  );
  for (const row of rows) {
    const tenant = {
      id: row.tenant_id,
      slug: row.slug,
      stripe_customer_id: row.stripe_customer_id,
      stripe_subscription_id: row.stripe_subscription_id,
      subscription_status: row.subscription_status,
    };
    await chargeTenantUsageImmediately(tenant, row.usage_id, row.review_id, row.quantity);
  }
}

module.exports = {
  createEstimateReviewCheckoutSession,
  findOrCreateCustomerForLineUser,
  createTenantSubscriptionCheckoutSession,
  finalizeTenantSubscriptionFromSession,
  recordAndReportTenantUsage,
  retryUnreportedTenantUsage,
  cancelTenantSubscription,
  TENANT_BASE_MONTHLY_FEE_YEN,
  TENANT_USAGE_YEN_PER_PAGE,
  stripe,
};

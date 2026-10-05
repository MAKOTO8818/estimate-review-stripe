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
 *   顧客IDは、まずメモリ上のキャッシュ(customerIdCache)を見て、
 *   無ければStripe側をmetadataで検索し、それでも無ければ新規作成する。
 *   こうすることで、サーバーが再起動してキャッシュが消えても、
 *   Stripe側に残っている顧客情報から正しく復元できる(本番でDBを導入すれば、
 *   customerIdCacheの代わりにDBを使うよう差し替えればよい)。
 *
 *   検索には stripe.customers.search ではなく stripe.customers.list を使っている。
 *   search は反映まで数秒〜数十秒のタイムラグがあり(作成直後は見つからないことがある)、
 *   その間に重複して顧客が作られてしまう不具合があったため、即時反映される list に変更した。
 *   (顧客数が非常に多くなった場合は、ここもDB管理に置き換える)
 */

const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-08-27.basil',
});

// lineUserId -> Stripe Customer ID のキャッシュ(再起動で消えてもStripe側の検索でフォールバックする)
const customerIdCache = new Map();

/**
 * LINEのユーザーIDに対応するStripe顧客を取得する。いなければ新規作成する。
 * @param {string} lineUserId
 * @returns {Promise<string>} Stripe Customer ID
 */
async function findOrCreateCustomerForLineUser(lineUserId) {
  if (customerIdCache.has(lineUserId)) {
    return customerIdCache.get(lineUserId);
  }

  // metadataに line_user_id を仕込んだ顧客が既に存在しないか、Stripe側を確認する
  // (customers.list は作成直後でも即座に反映されるため、customers.search のような
  //  タイムラグによる重複作成が起きない)
  let customerId = null;
  for await (const customer of stripe.customers.list({ limit: 100 })) {
    if (customer.metadata && customer.metadata.line_user_id === lineUserId) {
      customerId = customer.id;
      break;
    }
  }

  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { line_user_id: lineUserId },
    });
    customerId = customer.id;
  }

  customerIdCache.set(lineUserId, customerId);
  return customerId;
}

/**
 * @param {object} params
 * @param {number} params.amount 請求金額(円、整数)
 * @param {string} params.lineUserId LINEのユーザーID(注文とお客様を紐づけるため)
 * @param {number} params.pageCount 見積書のページ数
 * @param {boolean} params.isFirstTimeUser 初回利用者かどうか
 * @param {string} params.successUrl 決済完了後にリダイレクトするURL
 * @param {string} params.cancelUrl 決済キャンセル時にリダイレクトするURL
 * @returns {Promise<{ id: string, url: string }>} Checkout Session の id とお客様に送る決済URL
 */
async function createEstimateReviewCheckoutSession({
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

  const customerId = await findOrCreateCustomerForLineUser(lineUserId);

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
            name: 'AI見積り添削(建設顧問セカンドオピニオン)',
            description: `${pageCount}ページ分の添削`,
          },
        },
      },
    ],
    metadata: {
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

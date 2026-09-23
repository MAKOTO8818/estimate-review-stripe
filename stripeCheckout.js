/**
 * Stripe Checkout Session の作成
 *
 * 「都度金額が変わる決済リンク」は、Payment Links ではなく
 * Checkout Sessions + line_items[].price_data で作るのが Stripe 推奨の方法。
 * (Payment Links は事前に作った Price に紐づくため、金額を毎回変えるのに不向き)
 */

const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-08-27.basil',
});

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

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'], // クレジットカードのみ
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

module.exports = { createEstimateReviewCheckoutSession, stripe };

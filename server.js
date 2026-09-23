/**
 * AI見積り添削 - 自動化サーバーのプロトタイプ
 *
 * 流れ:
 * 1. LINEで見積書(PDF/画像)を受付      -> POST /line/webhook
 * 2. ページ数から金額を自動計算         -> pricing.js
 * 3. 無料枠のみなら決済不要、即添削開始
 *    有料分があればCheckout Session発行 -> stripeCheckout.js
 * 4. 決済完了をWebhookで検知           -> POST /stripe/webhook
 * 5. 受注確定・添削開始のトリガー
 *
 * 注意: これは「配線」を示すプロトタイプです。
 * - LINE Messaging APIとの実際のやり取り(署名検証・PDF/画像の取得)
 * - PDFの実際のページ数カウント(例: pdf-lib, pdf-parse などのライブラリ)
 * - 「初回利用者かどうか」の永続的な判定(データベースが必要。ここではメモリ上のSetで代用)
 * は、実際の開発時に組み込んでください。
 */

require('dotenv').config();
const express = require('express');
const { calculatePrice } = require('./pricing');
const { createEstimateReviewCheckoutSession, stripe } = require('./stripeCheckout');
const { reviewEstimate } = require('./aiReview');
const { client: lineClient, middleware: lineMiddleware } = require('./lineClient');
const { extractPdfInfo } = require('./pdfUtils');

const app = express();
const PORT = process.env.PORT || 4242;

// 初回利用者かどうかの判定用(本番ではDBに置き換える)
const seenLineUserIds = new Set();
function isFirstTimeUser(lineUserId) {
  return !seenLineUserIds.has(lineUserId);
}
function markUserAsSeen(lineUserId) {
  seenLineUserIds.add(lineUserId);
}

// --- Stripe Webhook は署名検証のため「生のボディ」が必要 ---
// 必ず express.json() より前、かつこのルート専用で raw を使うこと。
app.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const signature = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('⚠️ Webhook署名検証エラー:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { line_user_id, page_count, is_first_time_user } = session.metadata || {};

      console.log('✅ 決済完了:', {
        lineUserId: line_user_id,
        pageCount: page_count,
        isFirstTimeUser: is_first_time_user,
        amountTotal: session.amount_total,
      });

      // 受注確定 → AI一次チェックエージェントを起動する。
      // extractedText は、LINEから受け取ったPDFをテキスト抽出したものを
      // どこかに一時保存しておき、ここで読み出す想定(本番ではDB/ストレージに置き換え)。
      startEstimateReview({ lineUserId: line_user_id, pageCount: Number(page_count) });
    }

    res.json({ received: true });
  }
);

// 通常のJSONボディパーサーは、Stripe Webhookルートより後ろに置く
app.use((req, res, next) => {
  if (req.path === '/line/webhook') return next();
  express.json()(req, res, next);
});

// --- LINEからの見積書受付 ---
// lineMiddleware が x-line-signature を検証し、req.body.events を渡してくれる。
// このルートは express.json() より前段に置いても lineMiddleware が自前でボディを読むため問題ない。
app.post('/line/webhook', lineMiddleware, async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleLineEvent));
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('❌ LINE Webhook処理エラー:', err);
    res.status(500).json({ error: err.message });
  }
});

async function handleLineEvent(event) {
  if (event.type !== 'message') return;

  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const message = event.message;

  // --- PDFファイルの受付 ---
  if (message.type === 'file' && message.fileName?.toLowerCase().endsWith('.pdf')) {
    const buffer = await downloadLineContent(message.id);
    const { pageCount, text } = await extractPdfInfo(buffer);

    pendingEstimateTexts.set(userId, text);

    const firstTime = isFirstTimeUser(userId);
    const { amount, breakdown } = calculatePrice(pageCount, firstTime);
    console.log(breakdown);

    if (amount === 0) {
      // 初回利用・1ページのみ = 無料。決済不要でそのまま添削開始。
      markUserAsSeen(userId);
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: `見積書を受け取りました（${pageCount}ページ）。${breakdown}\n無料でAI一次チェックを開始します。結果は最短7日以内にお送りします。`,
      });
      await startEstimateReview({ lineUserId: userId, pageCount });
      return;
    }

    const { url } = await createEstimateReviewCheckoutSession({
      amount,
      lineUserId: userId,
      pageCount,
      isFirstTimeUser: firstTime,
      successUrl: process.env.CHECKOUT_SUCCESS_URL || 'https://example.com/thanks',
      cancelUrl: process.env.CHECKOUT_CANCEL_URL || 'https://example.com/cancelled',
    });
    markUserAsSeen(userId);

    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: `見積書を受け取りました（${pageCount}ページ）。${breakdown}\nお支払いはこちらからお願いします:\n${url}`,
    });
    return;
  }

  // --- 画像で送られてきた場合 ---
  // 画像からのテキスト抽出(OCR)は未実装のため、PDFでの送付をお願いする。
  if (message.type === 'image') {
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: '画像でのお受け取りも可能ですが、より正確に添削するため、見積書はPDF形式で送付いただけますでしょうか。',
    });
    return;
  }

  // --- それ以外のテキストメッセージ等 ---
  if (message.type === 'text') {
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: 'ご利用ありがとうございます。見積書（PDF）を送信いただくと、自動でお見積り・添削を開始します。初回は1ページ目無料です。',
    });
  }
}

/**
 * LINEのContent APIからメッセージ本体(画像/ファイル)をBufferとして取得する
 * @param {string} messageId
 * @returns {Promise<Buffer>}
 */
async function downloadLineContent(messageId) {
  const stream = await lineClient.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// --- AI一次チェックエージェントの起動口 ---
// pendingEstimateTexts: lineUserId -> PDF抽出テキスト の一時置き場(本番ではDB/ストレージに置き換える)
const pendingEstimateTexts = new Map();

async function startEstimateReview({ lineUserId, pageCount }) {
  const extractedText = pendingEstimateTexts.get(lineUserId);
  if (!extractedText) {
    console.error(`⚠️ ${lineUserId} の見積書テキストが見つかりません。PDF受付時の保存処理を確認してください。`);
    return;
  }

  try {
    const result = await reviewEstimate(extractedText);
    console.log('🤖 AI一次チェック完了:', { lineUserId, pageCount, summary: result.summary });

    // ここで result を専門家(人間の最終確認者)向けの管理画面/通知に渡す。
    // 例: notifyExpertReviewer({ lineUserId, aiResult: result });
    // 専門家の承認後、LINEで施主に結果を返信する処理へ続く。
  } catch (err) {
    console.error('❌ AI一次チェックでエラー:', err.message);
    // 例: notifyExpertReviewer({ lineUserId, error: err.message }); で人間に丸投げする
  }
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

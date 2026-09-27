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
 * 6. AI一次チェック完了 -> 専門家(管理者)のLINEに承認依頼を通知
 * 7. 専門家が確認画面で承認 -> お客様のLINEに結果を送信
 *
 * 注意: これは「配線」を示すプロトタイプです。
 * - LINE Messaging APIとの実際のやり取り(署名検証・PDF/画像の取得)
 * - PDFの実際のページ数カウント(例: pdf-lib, pdf-parse などのライブラリ)
 * - 「初回利用者かどうか」の永続的な判定(データベースが必要。ここではメモリ上のSetで代用)
 * - 承認待ちレビューの永続化(データベースが必要。ここではメモリ上のMapで代用)
 * は、実際の開発時に組み込んでください。
 */

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { calculatePrice } = require('./pricing');
const { createEstimateReviewCheckoutSession, stripe } = require('./stripeCheckout');
const { reviewEstimate } = require('./aiReview');
const { client: lineClient, middleware: lineMiddleware } = require('./lineClient');
const { extractPdfInfo } = require('./pdfUtils');

const app = express();
const PORT = process.env.PORT || 4242;

// 専門家(最終確認者)自身のLINEユーザーID。ここに承認依頼の通知が届く。
const EXPERT_LINE_USER_ID = process.env.EXPERT_LINE_USER_ID;
// 承認リンクの組み立てに使うベースURL(Renderの公開URL)
const BASE_URL = process.env.BASE_URL || 'https://estimate-review-stripe.onrender.com';

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

// 承認待ちレビュー: reviewId -> { lineUserId, pageCount, summary, approved }
const pendingReviews = new Map();

async function startEstimateReview({ lineUserId, pageCount }) {
  const extractedText = pendingEstimateTexts.get(lineUserId);
  if (!extractedText) {
    console.error(`⚠️ ${lineUserId} の見積書テキストが見つかりません。PDF受付時の保存処理を確認してください。`);
    return;
  }

  try {
    const result = await reviewEstimate(extractedText);
    console.log('🤖 AI一次チェック完了:', { lineUserId, pageCount, summary: result.summary });

    // 専門家(人間の最終確認者)向けに承認依頼を作成する。
    const reviewId = crypto.randomUUID();
    pendingReviews.set(reviewId, {
      lineUserId,
      pageCount,
      summary: result.summary,
      approved: false,
    });

    if (EXPERT_LINE_USER_ID) {
      await lineClient.pushMessage(EXPERT_LINE_USER_ID, {
        type: 'text',
        text:
          `【添削結果 確認依頼】\n` +
          `ページ数: ${pageCount}\n\n` +
          `${result.summary}\n\n` +
          `内容を確認し、お客様に送信するにはこちら:\n` +
          `${BASE_URL}/admin/review/${reviewId}`,
      });
    } else {
      console.error('⚠️ EXPERT_LINE_USER_ID が未設定のため、専門家への通知をスキップしました。');
    }
  } catch (err) {
    console.error('❌ AI一次チェックでエラー:', err.message);
    if (EXPERT_LINE_USER_ID) {
      await lineClient.pushMessage(EXPERT_LINE_USER_ID, {
        type: 'text',
        text: `【エラー】AI一次チェックに失敗しました(lineUserId: ${lineUserId})。\n${err.message}`,
      }).catch(() => {});
    }
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// --- 専門家向け 確認・承認画面 ---
app.get('/admin/review/:id', (req, res) => {
  const review = pendingReviews.get(req.params.id);
  if (!review) {
    return res.status(404).send('<p>このレビューは見つかりません。URLが正しいかご確認ください。</p>');
  }
  if (review.approved) {
    return res.send('<p>このレビューは既にお客様へ送信済みです。</p>');
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>見積り添削 確認</title>
    </head>
    <body style="font-family: sans-serif; padding: 20px; max-width: 600px; margin: auto; line-height: 1.6;">
      <h2>見積り添削 内容確認</h2>
      <p><b>ページ数:</b> ${review.pageCount}</p>
      <div style="white-space: pre-wrap; background:#f5f5f5; padding:16px; border-radius:8px; margin: 16px 0;">${escapeHtml(review.summary)}</div>
      <form method="POST" action="/admin/review/${req.params.id}/approve">
        <button type="submit" style="font-size:18px; padding:14px 28px; background:#06c755; color:white; border:none; border-radius:8px; width:100%;">
          この内容でお客様に送信する
        </button>
      </form>
    </body>
    </html>
  `);
});

app.post('/admin/review/:id/approve', async (req, res) => {
  const review = pendingReviews.get(req.params.id);
  if (!review) {
    return res.status(404).send('<p>このレビューは見つかりません。</p>');
  }
  if (review.approved) {
    return res.send('<p>既に送信済みです。</p>');
  }

  try {
    await lineClient.pushMessage(review.lineUserId, {
      type: 'text',
      text:
        `【AI見積り添削 結果】\n\n${review.summary}\n\n` +
        `ご不明点があれば、こちらのトークにご返信ください。`,
    });
    review.approved = true;
    res.send('<p>お客様に送信しました。このページは閉じて問題ありません。</p>');
  } catch (err) {
    console.error('❌ お客様への送信エラー:', err.message);
    res.status(500).send('<p>送信に失敗しました。時間をおいて再度お試しください。</p>');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

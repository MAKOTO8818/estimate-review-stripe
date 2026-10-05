/**
 * AI見積り添削 - 自動化サーバー
 *
 * 流れ:
 * 1. LINEで見積書(PDF)を受付             -> POST /line/webhook
 * 2. ページ数から金額を自動計算            -> pricing.js
 * 3. 無料枠のみなら決済不要、即添削開始
 *    有料分があればCheckout Session発行    -> stripeCheckout.js
 * 4. 決済完了をWebhookで検知              -> POST /stripe/webhook
 * 5. 受注確定・添削開始のトリガー
 * 6. PDFを構造化抽出(項目/数量/単位/単価/金額) -> pdfRows.js
 * 7. AI一次チェック(構造化データを行単位で厳密チェック) -> aiReview.js
 * 8. 元のPDFに直接、色付け・番号マーカーを書き込み + 詳細一覧ページを追加 -> pdfAnnotate.js
 * 9. 専門家(管理者)のLINEに、添削済みPDFの確認依頼を通知
 * 10. 専門家が確認画面で承認 -> お客様のLINEに「添削済みPDFのリンク + 簡単な文章」を送信
 *
 * 注意:
 * - 「初回利用者かどうか」の永続的な判定、承認待ちレビューの永続化、
 *   生成済みPDFの永続保存は、いずれもデータベース/永続ストレージが必要。
 *   ここではメモリ上のMap/Set・ローカルファイルで代用している(サーバー再起動で消える)。
 *   本番運用でアクセスが増える場合は、DB(例: Postgres)やS3等のストレージに置き換えること。
 */

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { calculatePrice } = require('./pricing');
const { createEstimateReviewCheckoutSession, stripe } = require('./stripeCheckout');
const { reviewEstimate } = require('./aiReview');
const { client: lineClient, middleware: lineMiddleware } = require('./lineClient');
const { extractStructuredPdf } = require('./pdfRows');
const { annotatePdf } = require('./pdfAnnotate');

const app = express();
const PORT = process.env.PORT || 4242;

// 「一式」注意書き(お客様が利用前に必ず目にするよう、案内文・受付確認メッセージの両方に挿入する)
const LUMP_SUM_WARNING =
  '【ご利用前の注意】内訳が「一式」とだけ記載され、数量・単価の内訳がない項目は、AIが金額の妥当性を判断できません。' +
  'より正確な添削のためには、できる限り数量・単価の内訳が記載された見積書をご用意ください。';

// 専門家(最終確認者)自身のLINEユーザーID。ここに承認依頼の通知が届く。
const EXPERT_LINE_USER_ID = process.env.EXPERT_LINE_USER_ID;
// 承認リンク・PDFリンクの組み立てに使うベースURL(Renderの公開URL)
const BASE_URL = process.env.BASE_URL || 'https://estimate-review-stripe.onrender.com';
// 添削済みPDFの日本語文字埋め込みに使うフォント(IPAゴシック、再配布可)
const FONT_PATH = path.join(__dirname, 'ipag.ttf'); // フォントはリポジトリのルート直下に配置されている
// 生成した添削済みPDFの保存先
const GENERATED_DIR = path.join(__dirname, 'generated');
fs.mkdirSync(GENERATED_DIR, { recursive: true });

// 添削済みPDFを配信する静的ルート
app.use('/files', express.static(GENERATED_DIR));

// 専門家が「自分で書き込んだPDF」をアップロードするための設定
// (メモリ上で受け取り、そのままgenerated/に書き込む。20MBまで、PDFのみ許可)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('PDFファイルのみアップロードできます。'));
    }
    cb(null, true);
  },
});

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

    let pageCount;
    try {
      const structured = await extractStructuredPdf(buffer);
      pageCount = structured.pageCount;
    } catch (err) {
      console.error('❌ PDF構造化抽出エラー:', err.message);
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: '見積書PDFの読み込みに失敗しました。お手数ですが、別のファイルでお試しいただくか、サポートまでご連絡ください。',
      });
      return;
    }

    // 元のPDFバッファを一時保存(添削書き込み・再抽出に使う)
    pendingEstimatePdfs.set(userId, buffer);

    const firstTime = isFirstTimeUser(userId);
    const { amount, breakdown } = calculatePrice(pageCount, firstTime);
    console.log(breakdown);

    if (amount === 0) {
      markUserAsSeen(userId);
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text:
          `見積書を受け取りました（${pageCount}ページ）。${breakdown}\n無料でAI一次チェックを開始します。結果は最短7日以内にお送りします。\n\n` +
          LUMP_SUM_WARNING,
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
      text:
        `見積書を受け取りました（${pageCount}ページ）。${breakdown}\nお支払いはこちらからお願いします:\n${url}\n\n` +
        LUMP_SUM_WARNING,
    });
    return;
  }

  if (message.type === 'image') {
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: '画像でのお受け取りも可能ですが、より正確に添削するため、見積書はPDF形式で送付いただけますでしょうか。',
    });
    return;
  }

  if (message.type === 'text') {
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text:
        'ご利用ありがとうございます。見積書（PDF）を送信いただくと、自動でお見積り・添削を開始します。初回は1ページ目無料です。\n\n' +
        LUMP_SUM_WARNING,
    });
  }
}

async function downloadLineContent(messageId) {
  const stream = await lineClient.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// --- AI一次チェック〜添削PDF生成エージェントの起動口 ---
// pendingEstimatePdfs: lineUserId -> 元PDFのBuffer の一時置き場(本番ではDB/ストレージに置き換える)
const pendingEstimatePdfs = new Map();

// 承認待ちレビュー: reviewId -> { lineUserId, pageCount, summary, findings, pdfFileName, approved }
const pendingReviews = new Map();

async function startEstimateReview({ lineUserId, pageCount }) {
  const pdfBuffer = pendingEstimatePdfs.get(lineUserId);
  if (!pdfBuffer) {
    console.error(`⚠️ ${lineUserId} の見積書PDFが見つかりません。PDF受付時の保存処理を確認してください。`);
    return;
  }

  try {
    const { pages } = await extractStructuredPdf(pdfBuffer);
    const result = await reviewEstimate(pages);
    console.log('🤖 AI一次チェック完了:', {
      lineUserId,
      pageCount,
      summary: result.summary,
      findingsCount: result.findings.length,
    });

    const { buffer: annotatedBuffer, matchedCount, unmatchedFindings } = await annotatePdf(
      pdfBuffer,
      pages,
      result.findings,
      FONT_PATH
    );

    const reviewId = crypto.randomUUID();
    const pdfFileName = `${reviewId}.pdf`;
    fs.writeFileSync(path.join(GENERATED_DIR, pdfFileName), annotatedBuffer);

    pendingReviews.set(reviewId, {
      lineUserId,
      pageCount,
      summary: result.summary,
      findings: result.findings,
      matchedCount,
      unmatchedCount: unmatchedFindings.length,
      pdfFileName,
      approved: false,
      replacedByExpert: false,
    });

    if (EXPERT_LINE_USER_ID) {
      await lineClient.pushMessage(EXPERT_LINE_USER_ID, {
        type: 'text',
        text:
          `【添削結果 確認依頼】\n` +
          `ページ数: ${pageCount} / 指摘件数: ${result.findings.length}件(PDFに反映: ${matchedCount}件)\n\n` +
          `${result.summary}\n\n` +
          `添削済みPDFの確認・お客様への送信はこちら:\n` +
          `${BASE_URL}/admin/review/${reviewId}`,
      });
    } else {
      console.error('⚠️ EXPERT_LINE_USER_ID が未設定のため、専門家への通知をスキップしました。');
    }
  } catch (err) {
    console.error('❌ AI一次チェック/PDF添削でエラー:', err);
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

function severityLabel(sev) {
  return { high: '🔴重要', medium: '🟠確認推奨', low: '🔵参考' }[sev] || '🟠確認推奨';
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

  const pdfUrl = `${BASE_URL}/files/${review.pdfFileName}`;
  const findingsHtml = review.findings
    .map(
      (f, i) => `
        <li style="margin-bottom:10px;">
          <b>${severityLabel(f.severity)} (${f.page}ページ) ${escapeHtml(f.itemText || '')}</b><br>
          ${escapeHtml(f.concern || '')}<br>
          <span style="color:#666;font-size:0.9em;">根拠: ${escapeHtml(f.basis || '')}</span>
        </li>`
    )
    .join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>見積り添削 確認</title>
    </head>
    <body style="font-family: sans-serif; padding: 20px; max-width: 700px; margin: auto; line-height: 1.6;">
      <h2>見積り添削 内容確認</h2>
      <p><b>ページ数:</b> ${review.pageCount} / <b>指摘件数:</b> ${review.findings.length}件(PDFに反映: ${review.matchedCount}件)</p>

      <p style="margin: 20px 0;">
        <a href="${pdfUrl}" target="_blank" style="display:inline-block; font-size:16px; padding:12px 20px; background:#1a73e8; color:white; border-radius:8px; text-decoration:none;">
          添削済みPDFを開く
        </a>
      </p>

      <div style="white-space: pre-wrap; background:#f5f5f5; padding:16px; border-radius:8px; margin: 16px 0;">${escapeHtml(review.summary)}</div>

      <h3>指摘事項一覧</h3>
      <ul style="padding-left: 20px;">${findingsHtml || '<li>特筆すべき指摘はありませんでした。</li>'}</ul>

      ${
        review.replacedByExpert
          ? '<p style="color:#06c755; font-weight:bold;">✓ あなたが書き込んだPDFに差し替え済みです。上の「添削済みPDFを開く」のリンクは、その差し替え後のPDFを開きます。</p>'
          : ''
      }

      <div style="border:1px solid #ddd; border-radius:8px; padding:16px; margin: 20px 0;">
        <h3 style="margin-top:0;">ご自身でPDFに書き込みを追加する場合</h3>
        <p style="color:#666; font-size:0.9em;">
          上のリンクからPDFをダウンロードし、お使いの端末(iPadの手書きアプリ、PCのPDF編集ソフトなど)で
          直接コメントや修正を書き込んだあと、そのファイルをここからアップロードしてください。
          お客様に送信されるPDFが、アップロードした内容に差し替わります。
        </p>
        <form method="POST" action="/admin/review/${req.params.id}/upload" enctype="multipart/form-data" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <input type="file" name="pdf" accept="application/pdf" required>
          <button type="submit" style="font-size:14px; padding:10px 16px; background:#1a73e8; color:white; border:none; border-radius:8px;">
            アップロードして差し替える
          </button>
        </form>
      </div>

      <form method="POST" action="/admin/review/${req.params.id}/approve">
        <button type="submit" style="font-size:18px; padding:14px 28px; background:#06c755; color:white; border:none; border-radius:8px; width:100%;">
          この内容でお客様に送信する
        </button>
      </form>
    </body>
    </html>
  `);
});

app.post('/admin/review/:id/upload', (req, res) => {
  upload.single('pdf')(req, res, (err) => {
    const review = pendingReviews.get(req.params.id);
    if (!review) {
      return res.status(404).send('<p>このレビューは見つかりません。</p>');
    }
    if (review.approved) {
      return res.send('<p>既にお客様へ送信済みのため、差し替えできません。</p>');
    }
    if (err) {
      console.error('❌ PDFアップロードエラー:', err.message);
      return res.status(400).send(`<p>アップロードに失敗しました: ${escapeHtml(err.message)}</p><p><a href="/admin/review/${req.params.id}">戻る</a></p>`);
    }
    if (!req.file) {
      return res.status(400).send(`<p>ファイルが選択されていません。</p><p><a href="/admin/review/${req.params.id}">戻る</a></p>`);
    }

    fs.writeFileSync(path.join(GENERATED_DIR, review.pdfFileName), req.file.buffer);
    review.replacedByExpert = true;

    res.redirect(`/admin/review/${req.params.id}`);
  });
});

app.post('/admin/review/:id/approve', async (req, res) => {
  const review = pendingReviews.get(req.params.id);
  if (!review) {
    return res.status(404).send('<p>このレビューは見つかりません。</p>');
  }
  if (review.approved) {
    return res.send('<p>既に送信済みです。</p>');
  }

  const pdfUrl = `${BASE_URL}/files/${review.pdfFileName}`;

  try {
    await lineClient.pushMessage(review.lineUserId, {
      type: 'text',
      text:
        `【AI見積り添削 結果】\n\n` +
        `見積書を専門家が確認いたしました。気になる箇所には印をつけ、PDF内に直接コメントを記載しております。\n\n` +
        `添削済みPDFはこちら:\n${pdfUrl}\n\n` +
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

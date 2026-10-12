/**
 * AI見積り添削 - 自動化サーバー(マルチテナント対応版)
 *
 * 流れ:
 * 1. LINEで見積書(PDF)を受付             -> POST /line/webhook (デフォルトテナント) または /line/webhook/:slug (他テナント)
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
 * マルチテナント化について:
 * 「tenants」テーブルが会社(テナント)ごとの設定(LINEチャネル情報・担当者LINE ID等)を持つ。
 * これまでの単一事業(建設顧問セカンドオピニオン)は、起動時に自動で
 * slug='default' のテナントとして登録される(db.js参照)。
 * 既存のLINE Webhook URL(/line/webhook)はそのまま使えるようにしてあるので、
 * 既存のLINE公式アカウント側の設定変更は不要。
 * 新しい会社を追加する場合は、その会社専用のLINE公式アカウントを用意してもらい、
 * Webhook URLを /line/webhook/<その会社のslug> に設定してもらう。
 *
 * データの永続化について:
 * 「初回利用者かどうか」の判定、承認待ちレビュー、受付中/添削済みPDF本体、
 * 学習機能の元データ(行データ)は、すべてPostgreSQL(db.js)に保存している。
 * これにより、Renderの再起動・再デプロイでデータが消えなくなった。
 */

require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const line = require('@line/bot-sdk');
const { pool, initDb } = require('./db');
const { calculatePrice } = require('./pricing');
const {
  createEstimateReviewCheckoutSession,
  createTenantSubscriptionCheckoutSession,
  finalizeTenantSubscriptionFromSession,
  recordAndReportTenantUsage,
  retryUnreportedTenantUsage,
  TENANT_BASE_MONTHLY_FEE_YEN,
  TENANT_USAGE_YEN_PER_PAGE,
  stripe,
} = require('./stripeCheckout');
const { reviewEstimate } = require('./aiReview');
const { clientForTenant, middlewareForTenant } = require('./lineClient');
const { extractStructuredPdf } = require('./pdfRows');
const { annotatePdf } = require('./pdfAnnotate');

const app = express();
const PORT = process.env.PORT || 4242;

// 「一式」注意書き(お客様が利用前に必ず目にするよう、案内文・受付確認メッセージの両方に挿入する)
const LUMP_SUM_WARNING =
  '【ご利用前の注意】内訳が「一式」とだけ記載され、数量・単価の内訳がない項目は、AIが金額の妥当性を判断できません。' +
  'より正確な添削のためには、できる限り数量・単価の内訳が記載された見積書をご用意ください。';

// 承認リンク・PDFリンクの組み立てに使うベースURL(Renderの公開URL)
const BASE_URL = process.env.BASE_URL || 'https://estimate-review-stripe.onrender.com';
// 添削済みPDFの日本語文字埋め込みに使うフォント(IPAゴシック、再配布可)
const FONT_PATH = path.join(__dirname, 'ipag.ttf'); // フォントはリポジトリのルート直下に配置されている
// テナント管理用の簡易エンドポイント(/admin/tenants)を保護するための合言葉。
// 本格的なセルフサインアップ画面ができるまでの、暫定的なテナント追加手段。
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// 専門家が「自分で書き込んだPDF」をアップロードするための設定
// (メモリ上で受け取り、DBにそのまま書き込む。20MBまで、PDFのみ許可)
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

// --- テナント(会社)関連 ---
async function getTenantBySlug(slug) {
  const { rows } = await pool.query('SELECT * FROM tenants WHERE slug = $1 AND is_active = true', [slug]);
  return rows[0] || null;
}
async function getTenantById(tenantId) {
  const { rows } = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  return rows[0] || null;
}

// --- 初回利用者かどうかの判定(テナント・DB永続化) ---
async function isFirstTimeUser(tenantId, lineUserId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM seen_users WHERE tenant_id = $1 AND line_user_id = $2',
    [tenantId, lineUserId]
  );
  return rows.length === 0;
}
async function markUserAsSeen(tenantId, lineUserId) {
  await pool.query(
    'INSERT INTO seen_users (tenant_id, line_user_id) VALUES ($1, $2) ON CONFLICT (tenant_id, line_user_id) DO NOTHING',
    [tenantId, lineUserId]
  );
}

// --- 受付中の見積書PDF本体(テナント・DB永続化) ---
async function savePendingPdf(tenantId, lineUserId, buffer) {
  await pool.query(
    `INSERT INTO pending_estimate_pdfs (tenant_id, line_user_id, pdf_data)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, line_user_id) DO UPDATE SET pdf_data = EXCLUDED.pdf_data, created_at = now()`,
    [tenantId, lineUserId, buffer]
  );
}
async function getPendingPdf(tenantId, lineUserId) {
  const { rows } = await pool.query(
    'SELECT pdf_data FROM pending_estimate_pdfs WHERE tenant_id = $1 AND line_user_id = $2',
    [tenantId, lineUserId]
  );
  return rows.length > 0 ? rows[0].pdf_data : null;
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

      // --- テナント(会社)のセルフサインアップ・サブスクリプション契約完了 ---
      if (session.mode === 'subscription' && session.metadata?.purpose === 'tenant_subscription') {
        console.log('✅ テナントのサブスクリプション契約完了:', { tenantId: session.metadata.tenant_id });
        finalizeTenantSubscriptionFromSession(session.id).catch((err) => {
          console.error('❌ テナント契約確定処理でエラー:', err);
        });
        return res.json({ received: true });
      }

      // --- お客様(LINEの利用者)による、見積り添削1回分の決済完了 ---
      const { tenant_id, line_user_id, page_count, is_first_time_user } = session.metadata || {};

      console.log('✅ 決済完了:', {
        tenantId: tenant_id,
        lineUserId: line_user_id,
        pageCount: page_count,
        isFirstTimeUser: is_first_time_user,
        amountTotal: session.amount_total,
      });

      (async () => {
        const tenant = await getTenantById(tenant_id);
        if (!tenant) {
          console.error(`⚠️ 決済完了Webhookのtenant_id(${tenant_id})に対応するテナントが見つかりません。`);
          return;
        }
        await startEstimateReview({ tenant, lineUserId: line_user_id, pageCount: Number(page_count) });
      })().catch((err) => {
        console.error('❌ startEstimateReview(Webhook経由)でエラー:', err);
      });
    }

    // --- テナントがサブスクリプションを解約した場合 ---
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const tenantId = subscription.metadata?.tenant_id;
      if (tenantId) {
        console.log('🛑 テナントのサブスクリプションが解約されました:', { tenantId });
        pool
          .query(
            `UPDATE tenants SET subscription_status = 'canceled', is_active = false WHERE id = $1`,
            [tenantId]
          )
          .catch((err) => console.error('❌ サブスクリプション解約処理でエラー:', err));
      }
    }

    res.json({ received: true });
  }
);

// 通常のJSONボディパーサーは、Stripe Webhook・LINE Webhookルートより後ろに置く
// (LINE側は署名検証のため生のボディが必要なので、/line/webhook* はここで除外する)
app.use((req, res, next) => {
  if (req.path.startsWith('/line/webhook')) return next();
  express.json()(req, res, next);
});
// セルフサインアップのフォーム(application/x-www-form-urlencoded)を受け取るため
app.use(express.urlencoded({ extended: true }));

/**
 * LINE Webhookの共通処理。テナントが確定した後に呼ばれる。
 * (署名検証はこの前段で、テナントごとのchannelSecretを使って既に完了している)
 */
async function processLineWebhookBody(req, res, tenant) {
  const lineClient = clientForTenant(tenant);
  try {
    const events = req.body.events || [];
    await Promise.all(events.map((event) => handleLineEvent(event, tenant, lineClient)));
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('❌ LINE Webhook処理エラー:', err);
    res.status(500).json({ error: err.message });
  }
}

// --- LINEからの見積書受付(デフォルトテナント。既存のLINE公式アカウントのWebhook URLはこのまま) ---
app.post('/line/webhook', async (req, res) => {
  const tenant = await getTenantBySlug('default');
  if (!tenant) {
    console.error('⚠️ デフォルトテナントが見つかりません。DB初期化が完了しているか確認してください。');
    return res.status(500).end();
  }
  middlewareForTenant(tenant)(req, res, (err) => {
    if (err) {
      console.error('⚠️ LINE署名検証エラー(default):', err.message);
      return res.status(400).send('signature validation failed');
    }
    processLineWebhookBody(req, res, tenant).catch((err2) => {
      console.error('❌ LINE Webhook処理エラー:', err2);
    });
  });
});

// --- LINEからの見積書受付(追加テナント用。URLにそのテナントのslugを含める) ---
app.post('/line/webhook/:slug', async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) {
    return res.status(404).send('このテナントは見つかりません。');
  }
  middlewareForTenant(tenant)(req, res, (err) => {
    if (err) {
      console.error(`⚠️ LINE署名検証エラー(${req.params.slug}):`, err.message);
      return res.status(400).send('signature validation failed');
    }
    processLineWebhookBody(req, res, tenant).catch((err2) => {
      console.error('❌ LINE Webhook処理エラー:', err2);
    });
  });
});

async function handleLineEvent(event, tenant, lineClient) {
  if (event.type !== 'message') return;

  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const message = event.message;

  // --- PDFファイルの受付 ---
  if (message.type === 'file' && message.fileName?.toLowerCase().endsWith('.pdf')) {
    const buffer = await downloadLineContent(lineClient, message.id);

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
    await savePendingPdf(tenant.id, userId, buffer);

    // セルフサインアップした建設会社(テナント)のLINEアカウントでは、
    // 送ってきた人への都度課金(1ページ500円)は行わない。
    // その会社自身が成瀬さんに月額基本料金+従量課金(1ページ100円)を既に支払っているため、
    // ここでさらに都度課金してしまうと二重課金になってしまう。
    // (成瀬さんご自身の事業=デフォルトテナントのみ、従来通り都度課金する)
    if (tenant.slug !== 'default') {
      await markUserAsSeen(tenant.id, userId);
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text:
          `見積書を受け取りました（${pageCount}ページ）。AI一次チェックを開始します。結果は最短7日以内にお送りします。\n\n` +
          LUMP_SUM_WARNING,
      });
      await startEstimateReview({ tenant, lineUserId: userId, pageCount });
      return;
    }

    const firstTime = await isFirstTimeUser(tenant.id, userId);
    const { amount, breakdown } = calculatePrice(pageCount, firstTime);
    console.log(breakdown);

    if (amount === 0) {
      await markUserAsSeen(tenant.id, userId);
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text:
          `見積書を受け取りました（${pageCount}ページ）。${breakdown}\n無料でAI一次チェックを開始します。結果は最短7日以内にお送りします。\n\n` +
          LUMP_SUM_WARNING,
      });
      await startEstimateReview({ tenant, lineUserId: userId, pageCount });
      return;
    }

    const { url } = await createEstimateReviewCheckoutSession({
      tenantId: tenant.id,
      tenantName: tenant.company_name,
      amount,
      lineUserId: userId,
      pageCount,
      isFirstTimeUser: firstTime,
      successUrl: process.env.CHECKOUT_SUCCESS_URL || 'https://example.com/thanks',
      cancelUrl: process.env.CHECKOUT_CANCEL_URL || 'https://example.com/cancelled',
    });
    await markUserAsSeen(tenant.id, userId);

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

async function downloadLineContent(lineClient, messageId) {
  const stream = await lineClient.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 見積りの行データ(学習機能の元データ)をDBに保存する。
 * 今はまだ「貯めるだけ」の段階。将来ここから単価の統計を集計し、
 * AIのチェック精度向上に使う。テナントごとに分離して蓄積する。
 */
async function saveLineItemsForLearning(tenantId, reviewId, pages) {
  try {
    for (const page of pages) {
      for (const row of page.rows || []) {
        await pool.query(
          `INSERT INTO estimate_line_items (tenant_id, review_id, page, item_text, qty, unit, unit_price, amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [tenantId, reviewId, page.pageNumber, row.item, row.qty, row.unit, row.unitPrice, row.amount]
        );
      }
    }
  } catch (err) {
    // 学習データの保存に失敗しても、添削そのものは止めない
    console.error('⚠️ 学習用データの保存に失敗しました:', err.message);
  }
}

// --- AI一次チェック〜添削PDF生成エージェントの起動口 ---
async function startEstimateReview({ tenant, lineUserId, pageCount }) {
  const pdfBuffer = await getPendingPdf(tenant.id, lineUserId);
  if (!pdfBuffer) {
    console.error(`⚠️ [${tenant.slug}] ${lineUserId} の見積書PDFが見つかりません。PDF受付時の保存処理を確認してください。`);
    return;
  }

  const lineClient = clientForTenant(tenant);

  try {
    const { pages } = await extractStructuredPdf(pdfBuffer);
    const result = await reviewEstimate(pages);
    console.log('🤖 AI一次チェック完了:', {
      tenant: tenant.slug,
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

    await pool.query(
      `INSERT INTO pending_reviews
         (id, tenant_id, line_user_id, page_count, summary, findings, matched_count, unmatched_count, pdf_data, approved, replaced_by_expert)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, false)`,
      [
        reviewId,
        tenant.id,
        lineUserId,
        pageCount,
        result.summary,
        JSON.stringify(result.findings),
        matchedCount,
        unmatchedFindings.length,
        annotatedBuffer,
      ]
    );

    // 学習機能の元データを蓄積(失敗しても添削フローは止めない)
    await saveLineItemsForLearning(tenant.id, reviewId, pages);

    // セルフサインアップしたテナント(会社)であれば、従量課金(1ページあたり100円)を
    // その場で登録済みカードに即時決済する(未回収リスクを避けるため、月末まとめ請求にはしない)。
    // (成瀬さん自身のデフォルトテナントはSaaS契約の対象外なので課金しない)
    // まず自社DBに記録してから決済を試みるので、決済が一時的に失敗しても
    // 使用量そのものは失われず、後から自動的に再試行される(stripeCheckout.js参照)。
    await recordAndReportTenantUsage(tenant, reviewId, pageCount);

    if (tenant.expert_line_user_id) {
      await lineClient.pushMessage(tenant.expert_line_user_id, {
        type: 'text',
        text:
          `【添削結果 確認依頼】\n` +
          `ページ数: ${pageCount} / 指摘件数: ${result.findings.length}件(PDFに反映: ${matchedCount}件)\n\n` +
          `${result.summary}\n\n` +
          `添削済みPDFの確認・お客様への送信はこちら:\n` +
          `${BASE_URL}/admin/review/${reviewId}`,
      });
    } else {
      console.error(`⚠️ [${tenant.slug}] expert_line_user_id が未設定のため、専門家への通知をスキップしました。`);
    }
  } catch (err) {
    console.error('❌ AI一次チェック/PDF添削でエラー:', err);
    if (tenant.expert_line_user_id) {
      await lineClient.pushMessage(tenant.expert_line_user_id, {
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

async function getReview(reviewId) {
  const { rows } = await pool.query('SELECT * FROM pending_reviews WHERE id = $1', [reviewId]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    tenantId: r.tenant_id,
    lineUserId: r.line_user_id,
    pageCount: r.page_count,
    summary: r.summary,
    findings: r.findings || [],
    matchedCount: r.matched_count,
    unmatchedCount: r.unmatched_count,
    pdfData: r.pdf_data,
    approved: r.approved,
    replacedByExpert: r.replaced_by_expert,
  };
}

// --- 添削済みPDFの配信(DBから直接ストリーミング。ローカルディスクを使わないため再起動で消えない) ---
app.get('/files/:filename', async (req, res) => {
  const reviewId = req.params.filename.replace(/\.pdf$/i, '');
  const review = await getReview(reviewId);
  if (!review || !review.pdfData) {
    return res.status(404).send('ファイルが見つかりません。');
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.send(review.pdfData);
});

// --- 専門家向け 確認・承認画面 ---
app.get('/admin/review/:id', async (req, res) => {
  const review = await getReview(req.params.id);
  if (!review) {
    return res.status(404).send('<p>このレビューは見つかりません。URLが正しいかご確認ください。</p>');
  }
  const pdfUrl = `${BASE_URL}/files/${review.id}.pdf`;
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

      ${
        review.approved
          ? `<p style="color:#06c755; font-weight:bold; background:#eafaf0; padding:12px; border-radius:8px;">✓ このレビューは既にお客様へ送信済みです。上の「添削済みPDFを開く」のリンクは、いつでもこのまま開けます。</p>`
          : `
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
      `
      }
    </body>
    </html>
  `);
});

app.post('/admin/review/:id/upload', (req, res) => {
  upload.single('pdf')(req, res, async (err) => {
    const review = await getReview(req.params.id);
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

    await pool.query(
      'UPDATE pending_reviews SET pdf_data = $1, replaced_by_expert = true WHERE id = $2',
      [req.file.buffer, req.params.id]
    );

    res.redirect(`/admin/review/${req.params.id}`);
  });
});

app.post('/admin/review/:id/approve', async (req, res) => {
  const review = await getReview(req.params.id);
  if (!review) {
    return res.status(404).send('<p>このレビューは見つかりません。</p>');
  }
  if (review.approved) {
    return res.send('<p>既に送信済みです。</p>');
  }

  const tenant = await getTenantById(review.tenantId);
  if (!tenant) {
    return res.status(500).send('<p>このレビューに紐づく会社情報が見つかりません。</p>');
  }
  const lineClient = clientForTenant(tenant);

  const pdfUrl = `${BASE_URL}/files/${review.id}.pdf`;

  try {
    await lineClient.pushMessage(review.lineUserId, {
      type: 'text',
      text:
        `【AI見積り添削 結果】\n\n` +
        `見積書を専門家が確認いたしました。気になる箇所には印をつけ、PDF内に直接コメントを記載しております。\n\n` +
        `添削済みPDFはこちら:\n${pdfUrl}\n\n` +
        `ご不明点があれば、こちらのトークにご返信ください。`,
    });
    await pool.query('UPDATE pending_reviews SET approved = true WHERE id = $1', [review.id]);
    res.send('<p>お客様に送信しました。このページは閉じて問題ありません。</p>');
  } catch (err) {
    console.error('❌ お客様への送信エラー:', err.message);
    res.status(500).send('<p>送信に失敗しました。時間をおいて再度お試しください。</p>');
  }
});

// --- セルフサインアップ(新しい建設会社が自分で登録する画面) ---

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/; // 半角英小文字・数字・ハイフン、3〜40文字

function signupFormPage({ error, values } = {}) {
  const v = values || {};
  const esc = (s) => escapeHtml(s || '');
  return `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AI見積り添削 - 新規お申し込み</title>
    </head>
    <body style="font-family: sans-serif; padding: 20px; max-width: 600px; margin: auto; line-height: 1.6;">
      <h2>AI見積り添削 新規お申し込み</h2>
      <p style="color:#444;">
        月額基本料金 5,000円のサブスクリプションです。<br>
        これとは別に、見積り添削を1件ご利用いただくたびに、ページ数 × 100円を登録済みのカードへ都度ご請求します。<br>
        お申し込み後、決済情報の登録画面に進みます。
      </p>
      ${error ? `<p style="color:#c00; background:#fde8e8; padding:12px; border-radius:8px;">${esc(error)}</p>` : ''}
      <form method="POST" action="/signup" style="display:flex; flex-direction:column; gap:14px; margin-top:20px;">
        <label>
          会社名 <span style="color:#c00;">*</span><br>
          <input type="text" name="companyName" required value="${esc(v.companyName)}" style="width:100%; padding:8px; box-sizing:border-box;">
        </label>
        <label>
          ご担当者メールアドレス <span style="color:#c00;">*</span><br>
          <input type="email" name="adminEmail" required value="${esc(v.adminEmail)}" style="width:100%; padding:8px; box-sizing:border-box;">
        </label>
        <label>
          お申し込みID(半角英数字・ハイフン、3〜40文字。LINEのWebhook URLに使われます) <span style="color:#c00;">*</span><br>
          <input type="text" name="slug" required pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" value="${esc(v.slug)}" placeholder="例: yamada-kensetsu" style="width:100%; padding:8px; box-sizing:border-box;">
        </label>
        <hr style="width:100%; border:none; border-top:1px solid #ddd;">
        <p style="margin:0; color:#666; font-size:0.9em;">
          以下は、お客様自身のLINE公式アカウント(Messaging API)のチャネル情報です。
          LINE Developersコンソールの「Messaging API設定」からご確認ください。
        </p>
        <label>
          LINEチャネルシークレット <span style="color:#c00;">*</span><br>
          <input type="text" name="lineChannelSecret" required value="${esc(v.lineChannelSecret)}" style="width:100%; padding:8px; box-sizing:border-box;">
        </label>
        <label>
          LINEチャネルアクセストークン(長期) <span style="color:#c00;">*</span><br>
          <input type="text" name="lineChannelAccessToken" required value="${esc(v.lineChannelAccessToken)}" style="width:100%; padding:8px; box-sizing:border-box;">
        </label>
        <label>
          添削内容を確認する担当者様のLINEユーザーID<br>
          <input type="text" name="expertLineUserId" value="${esc(v.expertLineUserId)}" style="width:100%; padding:8px; box-sizing:border-box;">
        </label>
        <button type="submit" style="font-size:16px; padding:14px 20px; background:#06c755; color:white; border:none; border-radius:8px;">
          内容を確認してお支払い登録へ進む
        </button>
      </form>
    </body>
    </html>
  `;
}

app.get('/signup', (req, res) => {
  res.send(signupFormPage());
});

app.post('/signup', async (req, res) => {
  const {
    companyName,
    adminEmail,
    slug,
    lineChannelSecret,
    lineChannelAccessToken,
    expertLineUserId,
  } = req.body || {};

  const values = { companyName, adminEmail, slug, lineChannelSecret, lineChannelAccessToken, expertLineUserId };

  if (!companyName || !adminEmail || !slug || !lineChannelSecret || !lineChannelAccessToken) {
    return res.status(400).send(signupFormPage({ error: '必須項目(*)が未入力です。', values }));
  }
  if (!SLUG_PATTERN.test(slug)) {
    return res
      .status(400)
      .send(signupFormPage({ error: 'お申し込みIDは、半角英小文字・数字・ハイフンのみ、3〜40文字で入力してください。', values }));
  }

  const tenantId = crypto.randomUUID();
  try {
    await pool.query(
      `INSERT INTO tenants
         (id, slug, company_name, admin_email, line_channel_secret, line_channel_access_token, expert_line_user_id, is_active, subscription_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, 'pending')`,
      [tenantId, slug, companyName, adminEmail, lineChannelSecret, lineChannelAccessToken, expertLineUserId || null]
    );
  } catch (err) {
    if (err.code === '23505') {
      return res
        .status(409)
        .send(signupFormPage({ error: `そのお申し込みID「${slug}」は既に使われています。別のIDをお試しください。`, values }));
    }
    console.error('❌ テナント作成エラー(セルフサインアップ):', err);
    return res.status(500).send(signupFormPage({ error: '登録に失敗しました。時間をおいて再度お試しください。', values }));
  }

  try {
    const { url } = await createTenantSubscriptionCheckoutSession({
      tenantId,
      companyName,
      adminEmail,
      successUrl: `${BASE_URL}/signup/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${BASE_URL}/signup`,
    });
    res.redirect(303, url);
  } catch (err) {
    console.error('❌ サブスクリプション決済セッション作成エラー:', err);
    res.status(500).send('<p>決済画面の作成に失敗しました。お手数ですが、サポートまでご連絡ください。</p>');
  }
});

app.get('/signup/complete', async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) {
    return res.status(400).send('<p>不正なアクセスです。</p>');
  }

  try {
    const result = await finalizeTenantSubscriptionFromSession(sessionId);
    if (!result) {
      return res.send('<p>決済が完了していないか、確認中です。しばらくしてから画面を再度開いてください。</p>');
    }
    const tenant = await getTenantById(result.tenantId);
    const webhookUrl = `${BASE_URL}/line/webhook/${tenant.slug}`;

    res.send(`
      <!DOCTYPE html>
      <html lang="ja">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>お申し込み完了</title></head>
      <body style="font-family: sans-serif; padding: 20px; max-width: 600px; margin: auto; line-height: 1.6;">
        <h2 style="color:#06c755;">✓ お申し込みが完了しました</h2>
        <p><b>${escapeHtml(tenant.company_name)}</b> 様、ご契約ありがとうございます。</p>
        <p>最後に、お客様のLINE Developersコンソールで、以下のWebhook URLを設定してください。</p>
        <div style="background:#f5f5f5; padding:16px; border-radius:8px; word-break:break-all; margin:16px 0;">
          ${escapeHtml(webhookUrl)}
        </div>
        <p style="color:#666; font-size:0.9em;">
          設定方法: LINE Developersコンソール → 対象のチャネル → 「Messaging API設定」タブ →
          「Webhook URL」欄に上記URLを貼り付けて保存 → 「Webhookの利用」をオンにする。
        </p>
        <p>設定が完了すれば、すぐにご利用いただけます。</p>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ サインアップ完了画面でエラー:', err);
    res.status(500).send('<p>確認中にエラーが発生しました。お手数ですが、サポートまでご連絡ください。</p>');
  }
});

// --- 管理画面トップ(成瀬さん用。全テナント一覧。編集・請求状況へのリンクを持つ) ---
function requireAdminSecret(req, res) {
  if (!ADMIN_SECRET) {
    res.status(503).send('ADMIN_SECRETが未設定のため、このページは無効化されています。');
    return false;
  }
  if (req.query.secret !== ADMIN_SECRET) {
    res
      .status(401)
      .send('<p>合言葉が違います。URLの末尾に <code>?secret=(ADMIN_SECRETの値)</code> を付けてアクセスしてください。</p>');
    return false;
  }
  return true;
}

app.get('/admin', async (req, res) => {
  if (!requireAdminSecret(req, res)) return;
  const secretQs = `secret=${encodeURIComponent(req.query.secret)}`;

  const { rows } = await pool.query(`SELECT * FROM tenants ORDER BY created_at ASC`);

  const statusLabel = (s) => ({ active: '契約中', pending: '決済待ち', canceled: '解約済み' }[s] || s);

  const rowsHtml = rows
    .map((t) => {
      const webhookUrl = t.slug === 'default' ? `${BASE_URL}/line/webhook` : `${BASE_URL}/line/webhook/${t.slug}`;
      return `
        <tr>
          <td>${escapeHtml(t.company_name)}<br><span style="color:#888; font-size:0.85em;">${escapeHtml(t.slug)}</span></td>
          <td>${t.slug === 'default' ? '(成瀬さんの本業・課金対象外)' : statusLabel(t.subscription_status)}${
            t.is_active ? '' : '<br><span style="color:#c00;">(非アクティブ)</span>'
          }</td>
          <td style="word-break:break-all; font-size:0.85em;">${escapeHtml(webhookUrl)}</td>
          <td>
            <a href="/admin/tenants/${t.id}/edit?${secretQs}">編集</a>
            ${t.slug === 'default' ? '' : ` / <a href="/admin/tenants?${secretQs}">請求状況</a>`}
          </td>
        </tr>`;
    })
    .join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>管理画面</title>
    </head>
    <body style="font-family: sans-serif; padding: 20px; max-width: 900px; margin: auto; line-height: 1.6;">
      <h2>AI見積り添削 管理画面</h2>
      <p><a href="/admin/tenants?${secretQs}">→ 全テナントの請求状況(今月分・概算)を見る</a></p>
      <table style="width:100%; border-collapse: collapse;" cellpadding="10">
        <thead>
          <tr style="border-bottom: 2px solid #333; text-align:left;">
            <th>会社名</th><th>状況</th><th>LINE Webhook URL</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || '<tr><td colspan="4">テナントがまだありません。</td></tr>'}
        </tbody>
      </table>
    </body>
    </html>
  `);
});

// --- テナント個別の編集画面(LINEチャネル情報・担当者情報・有効/無効の切り替え) ---
app.get('/admin/tenants/:id/edit', async (req, res) => {
  if (!requireAdminSecret(req, res)) return;
  const secretQs = `secret=${encodeURIComponent(req.query.secret)}`;

  const tenant = await getTenantById(req.params.id);
  if (!tenant) {
    return res.status(404).send('<p>このテナントは見つかりません。</p>');
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>テナント編集 - ${escapeHtml(tenant.company_name)}</title>
    </head>
    <body style="font-family: sans-serif; padding: 20px; max-width: 600px; margin: auto; line-height: 1.6;">
      <p><a href="/admin?${secretQs}">← 管理画面トップへ戻る</a></p>
      <h2>${escapeHtml(tenant.company_name)} の編集</h2>
      <form method="POST" action="/admin/tenants/${tenant.id}/edit?${secretQs}" style="display:flex; flex-direction:column; gap:14px;">
        <label>
          会社名<br>
          <input type="text" name="companyName" required value="${escapeHtml(tenant.company_name)}" style="width:100%; padding:8px; box-sizing:border-box;">
        </label>
        <label>
          ご担当者メールアドレス<br>
          <input type="email" name="adminEmail" value="${escapeHtml(tenant.admin_email || '')}" style="width:100%; padding:8px; box-sizing:border-box;">
        </label>
        <label>
          LINEチャネルシークレット<br>
          <input type="text" name="lineChannelSecret" value="${escapeHtml(tenant.line_channel_secret || '')}" style="width:100%; padding:8px; box-sizing:border-box;">
        </label>
        <label>
          LINEチャネルアクセストークン(長期)<br>
          <input type="text" name="lineChannelAccessToken" value="${escapeHtml(tenant.line_channel_access_token || '')}" style="width:100%; padding:8px; box-sizing:border-box;">
        </label>
        <label>
          添削内容を確認する担当者様のLINEユーザーID<br>
          <input type="text" name="expertLineUserId" value="${escapeHtml(tenant.expert_line_user_id || '')}" style="width:100%; padding:8px; box-sizing:border-box;">
        </label>
        ${
          tenant.slug === 'default'
            ? ''
            : `
        <label style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" name="isActive" value="true" ${tenant.is_active ? 'checked' : ''}>
          このテナントを有効にする(オフにすると、LINE Webhookを受け付けなくなります)
        </label>`
        }
        <button type="submit" style="font-size:16px; padding:12px 20px; background:#06c755; color:white; border:none; border-radius:8px;">
          保存する
        </button>
      </form>
      ${
        tenant.slug === 'default'
          ? ''
          : `
      <hr style="margin: 30px 0; border:none; border-top:1px solid #ddd;">
      <form method="POST" action="/admin/tenants/${tenant.id}/delete?${secretQs}"
            onsubmit="return confirm('本当に削除しますか？このテナントのデータは元に戻せません。');">
        <button type="submit" style="font-size:14px; padding:10px 16px; background:#c00; color:white; border:none; border-radius:8px;">
          このテナントを削除する
        </button>
      </form>`
      }
    </body>
    </html>
  `);
});

app.post('/admin/tenants/:id/delete', async (req, res) => {
  if (!requireAdminSecret(req, res)) return;
  const secretQs = `secret=${encodeURIComponent(req.query.secret)}`;

  const tenant = await getTenantById(req.params.id);
  if (!tenant) {
    return res.status(404).send('<p>このテナントは見つかりません。</p>');
  }
  if (tenant.slug === 'default') {
    return res.status(400).send('<p>デフォルトテナント(成瀬さんの本業)は削除できません。</p>');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tenant_usage_events WHERE tenant_id = $1', [tenant.id]);
    await client.query('DELETE FROM seen_users WHERE tenant_id = $1', [tenant.id]);
    await client.query('DELETE FROM stripe_customers WHERE tenant_id = $1', [tenant.id]);
    await client.query('DELETE FROM pending_estimate_pdfs WHERE tenant_id = $1', [tenant.id]);
    await client.query('DELETE FROM estimate_line_items WHERE tenant_id = $1', [tenant.id]);
    await client.query('DELETE FROM pending_reviews WHERE tenant_id = $1', [tenant.id]);
    await client.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ テナント削除エラー:', err);
    return res.status(500).send(`<p>削除に失敗しました: ${escapeHtml(err.message)}</p>`);
  } finally {
    client.release();
  }

  res.redirect(`/admin?${secretQs}`);
});

app.post('/admin/tenants/:id/edit', async (req, res) => {
  if (!requireAdminSecret(req, res)) return;
  const secretQs = `secret=${encodeURIComponent(req.query.secret)}`;

  const tenant = await getTenantById(req.params.id);
  if (!tenant) {
    return res.status(404).send('<p>このテナントは見つかりません。</p>');
  }

  const { companyName, adminEmail, lineChannelSecret, lineChannelAccessToken, expertLineUserId, isActive } =
    req.body || {};

  await pool.query(
    `UPDATE tenants
     SET company_name = $1, admin_email = $2, line_channel_secret = $3, line_channel_access_token = $4,
         expert_line_user_id = $5, is_active = $6
     WHERE id = $7`,
    [
      companyName || tenant.company_name,
      adminEmail || null,
      lineChannelSecret || null,
      lineChannelAccessToken || null,
      expertLineUserId || null,
      tenant.slug === 'default' ? tenant.is_active : isActive === 'true',
      tenant.id,
    ]
  );

  res.redirect(`/admin?${secretQs}`);
});

// --- 月末請求の確認画面(成瀬さん用。各テナントの今月の使用量・概算請求額を一覧表示する) ---
app.get('/admin/tenants', async (req, res) => {
  if (!requireAdminSecret(req, res)) return;
  const secretQs = `secret=${encodeURIComponent(req.query.secret)}`;

  const { rows } = await pool.query(`
    SELECT
      t.id, t.slug, t.company_name, t.admin_email, t.is_active, t.subscription_status, t.stripe_customer_id,
      COALESCE(SUM(u.quantity) FILTER (WHERE u.created_at >= date_trunc('month', now())), 0) AS month_usage,
      COUNT(u.id) FILTER (WHERE u.reported_to_stripe = false) AS unreported_count
    FROM tenants t
    LEFT JOIN tenant_usage_events u ON u.tenant_id = t.id
    WHERE t.slug != 'default'
    GROUP BY t.id
    ORDER BY t.created_at DESC
  `);

  const statusLabel = (s) => ({ active: '契約中', pending: '決済待ち', canceled: '解約済み' }[s] || s);

  const rowsHtml = rows
    .map((t) => {
      const usage = Number(t.month_usage);
      const usageTotal = usage * TENANT_USAGE_YEN_PER_PAGE;
      const unreported = Number(t.unreported_count);
      return `
        <tr>
          <td>${escapeHtml(t.company_name)}<br><span style="color:#888; font-size:0.85em;">${escapeHtml(t.slug)}</span></td>
          <td>${statusLabel(t.subscription_status)}${t.is_active ? '' : '<br><span style="color:#c00;">(非アクティブ)</span>'}</td>
          <td>${usage}ページ</td>
          <td>${usageTotal.toLocaleString()}円(都度決済済み分の合計)<br><span style="color:#888; font-size:0.85em;">+ 月額基本料金 ${TENANT_BASE_MONTHLY_FEE_YEN.toLocaleString()}円</span></td>
          <td>${unreported > 0 ? `<span style="color:#c00;">${unreported}件 決済失敗(自動再試行中)</span>` : '-'}</td>
        </tr>`;
    })
    .join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>テナント請求状況</title>
    </head>
    <body style="font-family: sans-serif; padding: 20px; max-width: 900px; margin: auto; line-height: 1.6;">
      <p><a href="/admin?${secretQs}">← 管理画面トップへ戻る</a></p>
      <h2>テナント請求状況(今月分)</h2>
      <p style="color:#666; font-size:0.9em;">
        従量課金(1ページ${TENANT_USAGE_YEN_PER_PAGE}円)は、見積り添削のたびに登録済みカードへ即時決済される方式です。
        「都度決済済み分の合計」は、今月すでに決済が成功した分の合計金額です。これとは別に、
        月額基本料金(${TENANT_BASE_MONTHLY_FEE_YEN.toLocaleString()}円)がStripe側のサブスクリプションとして毎月自動請求されます。
        「決済失敗」が表示されている場合は、カードの有効期限切れ等で即時決済に失敗した分です
        (自動的に再試行されますが、改善しない場合はテナント側にカード情報の更新を依頼してください)。
      </p>
      <table style="width:100%; border-collapse: collapse;" cellpadding="10">
        <thead>
          <tr style="border-bottom: 2px solid #333; text-align:left;">
            <th>会社名</th><th>契約状況</th><th>今月の使用量</th><th>今月の請求状況</th><th>決済状況</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || '<tr><td colspan="5">テナントがまだありません。</td></tr>'}
        </tbody>
      </table>
    </body>
    </html>
  `);
});

// --- テナント(会社)追加用の暫定エンドポイント ---
// 本格的なセルフサインアップ画面(item②の次のステップ)ができるまでの、
// 成瀬さん自身が新しい会社を手動登録するための簡易手段。
// ADMIN_SECRET環境変数が未設定の場合は、安全のためこのエンドポイント自体を無効化する。
app.post('/admin/tenants', async (req, res) => {
  if (!ADMIN_SECRET) {
    return res.status(503).send('ADMIN_SECRETが未設定のため、このエンドポイントは無効化されています。');
  }
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(401).send('合言葉が違います。');
  }

  const { slug, companyName, lineChannelSecret, lineChannelAccessToken, expertLineUserId, adminEmail } = req.body || {};
  if (!slug || !companyName || !lineChannelSecret || !lineChannelAccessToken) {
    return res.status(400).json({
      error: 'slug, companyName, lineChannelSecret, lineChannelAccessToken は必須です。',
    });
  }

  try {
    const tenantId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO tenants (id, slug, company_name, admin_email, line_channel_secret, line_channel_access_token, expert_line_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, slug, companyName, adminEmail || null, lineChannelSecret, lineChannelAccessToken, expertLineUserId || null]
    );
    res.json({
      id: tenantId,
      slug,
      webhookUrl: `${BASE_URL}/line/webhook/${slug}`,
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `slug "${slug}" は既に使われています。` });
    }
    console.error('❌ テナント作成エラー:', err);
    res.status(500).json({ error: err.message });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });

    // Stripeへの使用量送信に失敗して溜まっている分を、起動時と10分おきに自動で再送する
    retryUnreportedTenantUsage().catch((err) => console.error('❌ 使用量の再送処理でエラー:', err));
    setInterval(() => {
      retryUnreportedTenantUsage().catch((err) => console.error('❌ 使用量の再送処理でエラー:', err));
    }, 10 * 60 * 1000);
  })
  .catch((err) => {
    console.error('❌ DB初期化に失敗したため、サーバーを起動できません:', err);
    process.exit(1);
  });

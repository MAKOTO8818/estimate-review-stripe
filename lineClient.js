/**
 * LINE Messaging API クライアント設定
 *
 * マルチテナント化により、会社(テナント)ごとに別々のLINE公式アカウント
 * (別々の channelSecret / channelAccessToken)を使うようになったため、
 * 固定の1クライアントではなく、テナントの設定を渡してその場でクライアントと
 * 署名検証ミドルウェアを組み立てる関数を提供する。
 *
 * 前提: npm install @line/bot-sdk
 */

const line = require('@line/bot-sdk');

/**
 * テナント(tenants テーブルの1行)から、そのテナント用のLINEクライアントを作る。
 * @param {{ line_channel_access_token: string, line_channel_secret: string }} tenant
 * @returns {import('@line/bot-sdk').Client}
 */
function clientForTenant(tenant) {
  return new line.Client({
    channelAccessToken: tenant.line_channel_access_token,
    channelSecret: tenant.line_channel_secret,
  });
}

/**
 * テナント(tenants テーブルの1行)から、そのテナント用の署名検証ミドルウェアを作る。
 * (LINEからのWebhookが、本当にそのテナントのLINEチャネルから送られたものかを検証する)
 * @param {{ line_channel_secret: string }} tenant
 */
function middlewareForTenant(tenant) {
  return line.middleware({ channelSecret: tenant.line_channel_secret });
}

module.exports = { clientForTenant, middlewareForTenant };

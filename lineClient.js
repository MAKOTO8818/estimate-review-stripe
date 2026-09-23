/**
 * LINE Messaging API クライアント設定
 *
 * .env の LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET を使って
 * @line/bot-sdk のクライアントと署名検証ミドルウェアを組み立てる。
 *
 * 前提: npm install @line/bot-sdk
 */

const line = require('@line/bot-sdk');

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!lineConfig.channelAccessToken || !lineConfig.channelSecret) {
  console.warn(
    '⚠️ LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET が.envに設定されていません。LINE連携は動作しません。'
  );
}

const client = new line.Client(lineConfig);

// express.Router() にそのままマウントできる署名検証ミドルウェア
const middleware = line.middleware(lineConfig);

module.exports = { client, middleware, lineConfig };

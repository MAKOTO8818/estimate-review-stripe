# AI見積り添削 - 決済まわりプロトタイプ

## これは何か
- `pricing.js`: 料金計算ロジック(初回1ページ無料、以降1ページ500円)
- `stripeCheckout.js`: Stripe Checkout Session(都度金額が変わる決済リンク)の発行
- `server.js`: LINE受付→金額計算→決済リンク発行、Stripe決済完了のWebhook受信、の配線
- `pricing.test.js`: 料金計算の動作確認(`node pricing.test.js` で実行可能)

## 動作確認済み
- 料金計算ロジック(4パターン)
- 実際のStripeサンドボックスで、都度金額を指定したCheckout Sessionの発行

## まだ実装していない部分(次のステップ)
1. LINE Messaging APIとの実際の連携
   - 署名検証(x-line-signature)
   - 見積書(画像/PDF)の取得(LINEのContent API)
2. PDFの実ページ数カウント(`pdf-lib` や `pdf-parse` などのライブラリを使用)
3. 「初回利用者かどうか」の永続化(現状はメモリ上のSetのみ。サーバー再起動で消えるため、実運用にはデータベースが必要)
4. サーバーの実際のデプロイ先(RenderやVal Townなどの選定)
5. `.env.example` を `.env` にコピーし、実際のAPIキーを設定

## 起動方法
```
npm install
cp .env.example .env   # その後、.envに実際のキーを設定
node server.js
```

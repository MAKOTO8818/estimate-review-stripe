/**
 * LINE お客様対応の自動応答エージェント
 *
 * 役割:
 *   見積書(PDF)以外のテキストメッセージが届いたとき、使い方・料金・解約などの
 *   よくある質問にAIが自動で答える。テナント(default=個人のお客様向け / 会社ごとのSaaS契約)
 *   によって料金体系・解約方法が異なるため、テナントに応じたFAQ情報をシステムプロンプトに埋め込む。
 *
 * 安全のための方針:
 *   - 見積書の内容そのものへの判断(金額が妥当か等)は、このエージェントの役割ではない。
 *     PDFを送るよう案内するにとどめ、ここでは答えない。
 *   - FAQの範囲外の質問(わからないこと・個別の契約内容の確認など)は、
 *     無理に答えず「担当者に確認します」という案内に留める。
 */

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const BASE_URL = process.env.BASE_URL || 'https://estimate-review-stripe.onrender.com';

function systemPromptForTenant(tenant) {
  const common = `あなたは「AI見積り添削」のLINE公式アカウントで、お客様からのメッセージに自動で返信するカスタマーサポート担当です。
以下のルールを厳守してください。

- 返信は3〜5文程度、LINEで読みやすい短い日本語にする。箇条書きや記号の多用はしない。
- 下記の「わかっている情報」の範囲でのみ答える。わからないこと・個別の契約内容・返金や例外対応など、断定できない質問には
  「担当の者が確認のうえ、改めてご連絡いたします」とだけ答え、推測で答えない。
- 見積書の内容そのもの(金額が妥当かどうか等)について聞かれた場合は、添削結果ではなく、
  「見積書のPDFを送っていただければAIが自動でチェックを開始します」という案内にとどめる。
- 挨拶やお礼だけのメッセージには、短く丁寧に応じる。
- 敬語を使い、売り込みすぎない落ち着いたトーンで答える。`;

  if (tenant.slug === 'default') {
    return `${common}

# わかっている情報(建設顧問セカンドオピニオン / 個人・法人のお客様向け)
- サービス内容: 工事・リフォームの見積書(PDF)を送っていただくと、AIによる一次チェックと、
  設計士・現場管理者・施工管理技士などの専門家による二重チェックを行い、最短7日以内に結果をお届けする。
- 対応範囲: 個人・法人どちらの見積書も対応。3億円以下の見積書が対象。
- 料金: 初めての方は1ページ目の添削が無料。2ページ目以降は1ページ500円。2回目以降のご利用は無料枠なく、全ページ1ページ500円。
- 決済: クレジットカード(Stripe)。見積書を送っていただくたびに、金額が自動計算されその場で決済される都度課金方式。
  月額契約・サブスクリプションではないため、特別な解約手続きは不要(利用しなければ課金は発生しない)。
- 施工店紹介: ご希望の方には、提携する信頼できる施工店を紹介することがある(紹介料2〜10%は施工店側が負担、お客様の追加費用はなし)。
- 利用方法: このLINE公式アカウントに、見積書のPDFファイルをそのまま送っていただくだけで開始できる。`;
  }

  return `${common}

# わかっている情報(${tenant.company_name} 様が導入している「AI見積り添削」SaaS版)
- サービス内容: このLINE公式アカウントに見積書(PDF)を送ると、AIが一次チェックを行い、結果を貴社のご担当者にお届けする。
- 見積書を送ってくる方(貴社の社内の方や取引先など)への課金は一切ない。費用はすべて貴社の契約にまとめて請求される。
- 料金: 貴社は月額基本料金5,000円+従量課金(見積り添削1件につきページ数×100円)を契約している。
- 解約: 担当者への連絡は不要で、以下のページからいつでもご自身で解約できる。
  ${BASE_URL}/cancel/${encodeURIComponent(tenant.slug)}
- 利用方法: このLINE公式アカウントに見積書のPDFファイルをそのまま送るだけで、AIチェックが始まる。`;
}

/**
 * 見積書以外のテキストメッセージに対する返信を生成する。
 * 失敗した場合は null を返す(呼び出し側で固定文言にフォールバックする)。
 */
async function answerGeneralQuestion(tenant, userText) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 400,
      temperature: 0.3,
      system: systemPromptForTenant(tenant),
      messages: [{ role: 'user', content: userText.slice(0, 1000) }],
    });
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    return text || null;
  } catch (err) {
    console.error(`⚠️ [${tenant.slug}] LINE自動応答の生成に失敗しました:`, err.message);
    return null;
  }
}

module.exports = { answerGeneralQuestion };

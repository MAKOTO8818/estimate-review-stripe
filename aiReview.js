/**
 * AI一次チェックエージェント
 *
 * 役割:
 *   見積書(PDFから抽出したテキスト)を受け取り、Claude APIで一次チェックを行う。
 *   出力は「人間の最終確認者(専門家)」がそのまま読んで承認/修正できる形式にする。
 *   このサービスの核心である「AI一次チェック + 人間の最終ダブルチェック」の、AI側を担当する。
 *
 * 前提:
 *   - ANTHROPIC_API_KEY を環境変数に設定すること
 *   - npm install @anthropic-ai/sdk が必要
 *   - PDFからのテキスト抽出(pdf-parseなど)は呼び出し側で行い、
 *     extractedText として渡すこと(このファイルではPDF処理自体は行わない)
 */

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `あなたは「建設顧問セカンドオピニオン」のAI一次チェック担当です。
建築・リフォーム工事の見積書を精査し、専門家(人間)が最終確認しやすい形に整理することが役割です。

# 厳守事項
- あなた自身が最終判断者ではありません。「専門家が確認すべき論点」を洗い出すのが仕事です。
- 断定的な「これは不当請求です」等の表現は使わない。「相場と比べて高い可能性がある」等、根拠とセットで指摘する。
- 数値の指摘は必ず根拠(何と比べて、どのくらい)を示す。
- 見積書に記載のない情報を推測で補わない。不明な点は「不明」「要確認」と明記する。
- 個人や会社を誹謗中傷しない。あくまで見積書の記載内容に対する客観的な指摘に留める。

# チェック観点(このサービスのSEO記事群と一貫させる)
1. 数量・単価の妥当性(一般的な相場との乖離)
2. 「一式」表記など、内訳が不明瞭な項目の有無
3. 同一内容の重複計上がないか
4. 仮設・諸経費など付帯費用の割合が過大でないか
5. 工事範囲の記載漏れ・曖昧さ

# 出力形式(JSON)
{
  "summary": "全体総評(2〜3文)",
  "findings": [
    {
      "item": "見積書上の項目名",
      "concern": "指摘内容",
      "basis": "指摘の根拠(相場観・一般的な計算方法など)",
      "severity": "high" | "medium" | "low",
      "expertQuestion": "専門家が施主に確認すべき質問文"
    }
  ],
  "unclearItems": ["記載が不明瞭で判断できなかった項目"],
  "expertChecklist": ["最終確認者が特に見るべきポイントを箇条書きで"]
}`;

/**
 * 見積書テキストをAIで一次チェックする
 * @param {string} extractedText PDFやOCRから抽出した見積書のテキスト
 * @param {object} [context] 追加情報(工事種別など、わかれば精度が上がる)
 * @param {string} [context.workType] 例: "外壁塗装", "リフォーム", "注文住宅"
 * @returns {Promise<object>} 上記JSON構造のチェック結果
 */
async function reviewEstimate(extractedText, context = {}) {
  if (!extractedText || extractedText.trim().length === 0) {
    throw new Error('extractedText が空です。PDFからのテキスト抽出に失敗している可能性があります。');
  }

  const userMessage = [
    context.workType ? `工事種別: ${context.workType}` : null,
    '以下は見積書から抽出したテキストです。上記の観点でチェックしてください。',
    '---',
    extractedText,
  ]
    .filter(Boolean)
    .join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock) {
    throw new Error('AIからのテキスト応答が取得できませんでした。');
  }

  try {
    // モデルがコードブロックで返す場合に備えて抽出
    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : textBlock.text);
  } catch (err) {
    throw new Error(`AI応答のJSON解析に失敗しました: ${err.message}\n生の応答: ${textBlock.text}`);
  }
}

module.exports = { reviewEstimate, SYSTEM_PROMPT };

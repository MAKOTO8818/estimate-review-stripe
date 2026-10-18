/**
 * AI一次チェックエージェント (構造化データ版)
 *
 * 役割:
 *   pdfRows.js が抽出した「ページ・行ごとの構造化データ(項目/数量/単位/単価/金額)」を受け取り、
 *   Claude APIで一行ずつ厳密にチェックする。
 *   出力は「人間の最終確認者(専門家)」がそのまま読んで承認/修正できる形式にする。
 *
 *   以前は pdf-parse によるフラットな文字列をそのままAIに渡していたため、
 *   「だいたいの雰囲気」でしか判断できなかった。
 *   このバージョンでは、
 *     (1) 数量×単価と金額が一致しているかの機械的チェックをコード側で行い(100%正確)、
 *     (2) 単価の相場妥当性・項目の不明瞭さなどはAIが行の単位で判断する
 *   という2段構えにして精度を上げている。
 *
 * 前提:
 *   - ANTHROPIC_API_KEY を環境変数に設定すること
 *   - npm install @anthropic-ai/sdk が必要
 *   - PDFの構造化抽出(pdfRows.js)は呼び出し側で行い、
 *     structuredPages として渡すこと
 */

const Anthropic = require('@anthropic-ai/sdk');
const { fetchPriceStatsGroupedByItem, matchStatsToPages, buildPriceStatsPromptBlock } = require('./priceStats');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `あなたは「建設顧問セカンドオピニオン」のAI一次チェック担当です。
建築・リフォーム工事の見積書を、ページ・行単位で精査し、専門家(人間)が最終確認しやすい形に整理することが役割です。

# 入力データについて
入力は、PDFから機械的に抽出した「ページごとの行データ」です。各行は
「項目名 | 数量 | 単位 | 単価 | 金額」の形式で渡されます(値が取得できない項目は "-" になります)。
抽出処理の都合上、まれに項目名や数値が誤って分割・結合されていることがあります。
明らかにおかしい場合は "unclearItems" に記載してください。

# 厳守事項
- あなた自身が最終判断者ではありません。「専門家が確認すべき論点」を洗い出すのが仕事です。
- 断定的な「これは不当請求です」等の表現は使わない。「相場と比べて高い可能性がある」等、根拠とセットで指摘する。
- 単価の妥当性は、以下の優先順位で根拠づけること:
  1. 「本サービスの過去実績データに基づく単価統計」が提供されている項目は、最優先でそれを根拠にする。
     件数・平均・範囲を明示し、今回の単価がその範囲内か、どの程度乖離しているかを具体的に述べること。
     (例:「過去12件の実績平均は3,200円/m²ですが、本見積りは5,000円/m²で、実績平均より約56%高くなっています(本サービス実績データに基づく)」)
  2. 過去実績データが無い項目で、金額が大きい・疑わしいなど重点的に確認すべきものについては、
     web_search ツールを使って現在の一般的な相場・単価情報を調べてよい(無制限に使わず、必要な項目に絞ること)。
     検索結果を根拠にする場合は、調べた情報源(サイト名)を明記すること。
     (例:「〇〇(サイト名)によれば、現在の相場は◯◯円/m²程度とされており、本見積りはこれより高めです(web検索結果に基づく)」)
  3. 上記のいずれも無い項目については、あなたの学習知識に基づく一般的な相場観であることを明記し
     (例:「一般的な相場は◯◯円/ m程度と思われます(AI推定・参考値)」)、リアルタイムの最新相場ではない可能性がある旨がわかるようにする。
- web_searchツールを使う場合でも、最終的な出力は必ず下記の「出力形式」通りのJSONのみとすること。
  検索中の説明文(「検索します」等)を最終回答として出力してはいけない。検索が終わったら、
  その結果を踏まえて改めてJSON形式の回答を生成すること。
- 見積書に記載のない情報を推測で補わない。不明な点は「不明」「要確認」と明記する。
- 個人や会社を誹謗中傷しない。あくまで見積書の記載内容に対する客観的な指摘に留める。
- findings の "page" と "itemText" は、入力データに登場する値をそのまま(一字一句変えずに)使うこと。
  この値は自動的にPDF上の該当箇所への注釈(マーカー)配置に使われるため、要約したり言い換えたりしないこと。
- 出力全体が長くなりすぎて途中で切れることを避けるため、各 "concern" "basis" "expertQuestion" は
  それぞれ120文字程度までを目安に簡潔にまとめること。findings は特に重要な論点を優先し、
  最大20件程度を目安とすること(それ以上の軽微な指摘は expertChecklist に要約して含めてよい)。

# チェック観点(行単位で細かく確認すること)
1. 単価の妥当性(一般的な相場との乖離) — 特に単価が明記されている行は重点的に確認する
2. 「一式」など、内訳・単価が不明瞭な項目の有無(金額の大きい「一式」項目は特に指摘する)
3. 同一内容・類似項目の重複計上がないか(ページをまたいだ重複も含めて確認する)
4. 仮設・諸経費・工事管理費など付帯費用の、合計に対する割合が過大でないか
5. 工事範囲の記載漏れ・曖昧さ、数量の記載ミス(桁違いなど)がないか
6. 数量×単価が金額と一致しない行(コード側の機械チェックで既に検出されている場合があるが、
   コードが検出できなかったパターン(単位の考慮ミスなど)があれば追加で指摘する)

# 出力形式(JSON。他の文章は一切含めないこと)
{
  "summary": "全体総評(2〜4文)",
  "findings": [
    {
      "page": 4,
      "itemText": "入力データの項目名と完全一致する文字列",
      "concern": "指摘内容",
      "basis": "指摘の根拠(相場観・一般的な計算方法など)",
      "severity": "high" | "medium" | "low",
      "expertQuestion": "専門家が施主に確認すべき質問文"
    }
  ],
  "unclearItems": ["記載や抽出が不明瞭で判断できなかった項目"],
  "expertChecklist": ["最終確認者が特に見るべきポイントを箇条書きで"]
}`;

/**
 * 数値文字列(カンマ区切り含む)をパースする。パースできない場合は null。
 */
function parseNum(str) {
  if (str === null || str === undefined || str === '-') return null;
  const cleaned = String(str).replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

/**
 * 数量×単価 と 金額 が一致しているかを、コード側で機械的にチェックする。
 * AIの判断に頼らない、100%正確な補完チェック。
 * @param {Array<PageData>} pages pdfRows.jsの出力(pages配列)
 * @returns {Array} findings形式の配列(source: 'arithmetic' 付き)
 */
function arithmeticCheck(pages) {
  const findings = [];

  for (const page of pages) {
    for (const row of page.rows) {
      const qty = parseNum(row.qty);
      const unitPrice = parseNum(row.unitPrice);
      const amount = parseNum(row.amount);

      if (qty === null || unitPrice === null || amount === null) continue;

      const expected = qty * unitPrice;
      const diff = Math.abs(expected - amount);
      const tolerance = Math.max(1, amount * 0.01); // 1%または1円の誤差は丸め誤差として許容

      if (diff > tolerance) {
        findings.push({
          page: page.pageNumber,
          itemText: row.item,
          concern:
            `数量(${row.qty})×単価(${row.unitPrice})を計算すると${Math.round(expected).toLocaleString()}円になりますが、` +
            `見積書の記載金額は${row.amount}円で、計算が一致しません。`,
          basis: '数量×単価の計算(機械的チェック・根拠不要で確実な指摘)',
          severity: 'high',
          expertQuestion: `「${row.item}」の金額計算に誤りがある可能性があります。ご確認いただけますか。`,
          source: 'arithmetic',
        });
      }
    }
  }

  return findings;
}

/**
 * 構造化データをAIに渡すためのテキスト形式に変換する
 */
function buildStructuredText(pages) {
  const lines = [];
  for (const page of pages) {
    lines.push(`--- ページ ${page.pageNumber} ---`);
    if (!page.rows || page.rows.length === 0) {
      lines.push('(表形式の項目は検出されませんでした)');
      continue;
    }
    for (const row of page.rows) {
      lines.push(
        `項目: ${row.item} | 数量: ${row.qty ?? '-'} | 単位: ${row.unit ?? '-'} | 単価: ${row.unitPrice ?? '-'} | 金額: ${row.amount ?? '-'}`
      );
    }
  }
  return lines.join('\n');
}

/**
 * AIの応答が途中で(トークン上限などにより)切れてしまい、
 * 完全なJSONとして閉じていない場合に、
 * そこまでに完成している findings 配列の要素だけを救い出して、
 * 閉じ括弧を補って解析可能な形に修復する。
 * 修復できない場合は null を返す。
 */
function repairTruncatedJson(rawJson) {
  let inString = false;
  let escape = false;
  const stack = [];
  let lastSafeCut = -1;
  let lastSafeStack = null;

  for (let i = 0; i < rawJson.length; i++) {
    const ch = rawJson[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      const opener = stack.pop();
      const isMatch = (ch === '}' && opener === '{') || (ch === ']' && opener === '[');
      if (!isMatch) {
        // 括弧の対応が崩れている = ここより前が安全圏
        break;
      }
      // 「配列の直下でオブジェクトを1つ閉じ終えた直後」を安全な切断点として記録する
      // (findings配列の要素を1件閉じ終えたタイミングに相当)
      if (ch === '}' && stack[stack.length - 1] === '[') {
        lastSafeCut = i + 1;
        lastSafeStack = stack.slice();
      }
    }
  }

  if (lastSafeCut === -1 || !lastSafeStack) return null;

  const closing = lastSafeStack
    .slice()
    .reverse()
    .map((b) => (b === '{' ? '}' : ']'))
    .join('');

  const repairedStr = rawJson.slice(0, lastSafeCut) + closing;

  try {
    return JSON.parse(repairedStr);
  } catch (err) {
    return null;
  }
}

/**
 * 見積書の構造化データをAIで一次チェックする
 * @param {Array<PageData>} structuredPages pdfRows.extractStructuredPdf() が返す pages 配列
 * @param {object} [context] 追加情報(工事種別など、わかれば精度が上がる)
 * @param {string} [context.workType] 例: "外壁塗装", "リフォーム", "注文住宅"
 * @param {import('pg').Pool} [context.pool] DB接続プール。渡された場合、過去の見積り実績(estimate_line_items)
 *   から単価統計を集計し、「学習型」としてプロンプトに含める。渡されない/取得失敗時は従来通り(AIの一般知識のみ)で動作する。
 * @returns {Promise<object>} { summary, findings, unclearItems, expertChecklist }
 *   findings には、コード側の機械チェック(arithmeticCheck)の結果もマージして含まれる。
 */
async function reviewEstimate(structuredPages, context = {}) {
  if (!Array.isArray(structuredPages) || structuredPages.length === 0) {
    throw new Error('structuredPages が空です。PDFからの構造化抽出に失敗している可能性があります。');
  }

  const structuredText = buildStructuredText(structuredPages);

  // 学習型AI添削: 過去に処理した見積りの単価実績を集計し、該当する項目があれば
  // 「本サービス実績データ」としてプロンプトに含める。使えばAIの判断材料が増えていく。
  let priceStatsBlock = null;
  if (context.pool) {
    try {
      const allStats = await fetchPriceStatsGroupedByItem(context.pool);
      const matchedStats = matchStatsToPages(structuredPages, allStats);
      priceStatsBlock = buildPriceStatsPromptBlock(matchedStats);
    } catch (err) {
      console.error('⚠️ 学習型単価統計の組み込みに失敗しました(通常モードで続行します):', err.message);
    }
  }

  const userMessage = [
    context.workType ? `工事種別: ${context.workType}` : null,
    '以下は見積書PDFから、ページ・行単位で抽出した構造化データです。上記の観点でチェックしてください。',
    '---',
    structuredText,
    priceStatsBlock ? '---' : null,
    priceStatsBlock,
  ]
    .filter(Boolean)
    .join('\n');

  // 過去実績データが無い項目について、現在の一般的な相場をweb検索で調べられるようにする。
  // (1件のチェックあたり最大5回までに制限し、コストと処理時間が膨らみすぎないようにしている)
  const tools = [
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5,
    },
  ];
  // web検索ツールを使う場合、Claudeが「検索します」という説明文 -> 検索実行 -> 検索結果を踏まえた
  // 最終回答、という複数ターンのやり取りを1回のAPI呼び出し内で行う(stop_reasonが'pause_turn'の間は
  // 続きがあるので、応答をそのまま履歴に積んで呼び出しを継続する)。
  const MAX_SEARCH_ROUNDS = 5;

  // Anthropic APIが混雑時などに一時的に空応答を返すことがあるため、
  // テキストブロックが取得できなかった場合は1回だけ自動的に再試行する。
  const MAX_ATTEMPTS = 2;
  let response = null;
  let textBlock = null;
  let lastDiagnostics = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const messages = [{ role: 'user', content: userMessage }];

    for (let round = 1; round <= MAX_SEARCH_ROUNDS; round++) {
      response = await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages,
        tools,
      });

      if (response.stop_reason !== 'pause_turn') break;
      // 検索の続きがある場合、直前の応答をそのまま履歴に積んで継続する
      messages.push({ role: 'assistant', content: response.content });
    }

    // web検索を使った場合、「検索します」という説明文のあとに検索結果・最終回答の順で
    // テキストブロックが並ぶことがあるため、最後のテキストブロックを最終回答として扱う。
    const textBlocks = response.content.filter((block) => block.type === 'text');
    textBlock = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1] : null;
    if (textBlock) break;

    lastDiagnostics = {
      attempt,
      stopReason: response.stop_reason,
      contentTypes: response.content.map((b) => b.type),
    };
    console.warn(
      `⚠️ AIからテキスト応答が得られませんでした(試行${attempt}/${MAX_ATTEMPTS})。stop_reason=${response.stop_reason}, content types=${JSON.stringify(
        lastDiagnostics.contentTypes
      )}`
    );
  }

  if (!textBlock) {
    throw new Error(
      `AIからのテキスト応答が取得できませんでした(${MAX_ATTEMPTS}回試行)。診断情報: ${JSON.stringify(lastDiagnostics)}`
    );
  }

  let aiResult;
  let wasTruncated = false;
  {
    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    const rawJson = jsonMatch ? jsonMatch[0] : textBlock.text;
    try {
      aiResult = JSON.parse(rawJson);
    } catch (err) {
      // AIの応答がトークン上限などで途中で切れた場合、
      // そこまでに完成している指摘事項だけを救い出して処理を続行する。
      const repaired = repairTruncatedJson(rawJson);
      if (repaired) {
        console.warn(
          '⚠️ AI応答の一部が途中で切れていたため、自動修復して処理を続行しました(検出できた範囲の指摘のみ反映されます)。'
        );
        aiResult = repaired;
        wasTruncated = true;
      } else {
        throw new Error(`AI応答のJSON解析に失敗しました: ${err.message}\n生の応答: ${textBlock.text}`);
      }
    }
  }

  const arithmeticFindings = arithmeticCheck(structuredPages);
  const aiFindings = (aiResult.findings || []).map((f) => ({ ...f, source: f.source || 'ai' }));

  // 機械チェックとAIチェックが同じ項目を重複して指摘した場合、機械チェックの結果を優先して残す
  const dedupedAiFindings = aiFindings.filter(
    (af) =>
      !arithmeticFindings.some(
        (mf) => mf.page === af.page && mf.itemText && af.itemText && mf.itemText === af.itemText
      )
  );

  const findings = [...arithmeticFindings, ...dedupedAiFindings].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return 0;
  });

  return {
    summary: aiResult.summary,
    findings,
    unclearItems: aiResult.unclearItems || [],
    expertChecklist: aiResult.expertChecklist || [],
    truncated: wasTruncated,
  };
}

module.exports = { reviewEstimate, arithmeticCheck, SYSTEM_PROMPT };

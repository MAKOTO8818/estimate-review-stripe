/**
 * AI一次チェックエージェント (構造化データ版・ページ単位チェック)
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
 *   さらに本バージョンでは、見積書全体を1回のAI呼び出しにまとめず、
 *   「1ページ=1回のAI呼び出し」に分割してチェックする。
 *   ページ数・行数が多い見積書を1回のプロンプトにまとめると、AIが分量に圧倒されて
 *   一部の行の単価チェックを省略したり、似た項目をまとめて1件に要約してしまったりする
 *   ことがあったため、ページごとに分けることで「単価が書いてある行は全て見る」を徹底する。
 *   ページをまたいだ重複計上のチェックは、AIではなくコード側の機械チェックで別途行う。
 *
 *   また、スキャナーで読み込んだ/写真を貼り付けただけの「画像のみのPDF」(ページ内に
 *   テキスト情報が一切無いもの)は、pdfRows.jsの行抽出では何も取れない。この場合は
 *   そのページだけを1ページのPDFとして切り出し、Claudeの画像認識(ビジョン)機能に
 *   直接読ませてチェックする(reviewSingleScannedPage)。文字が綺麗に抽出できるページと
 *   画像しかないページが混在していても、ページごとに自動で適切な方式に振り分けられる。
 *
 * 前提:
 *   - ANTHROPIC_API_KEY を環境変数に設定すること
 *   - npm install @anthropic-ai/sdk pdf-lib が必要
 *   - PDFの構造化抽出(pdfRows.js)は呼び出し側で行い、
 *     structuredPages として渡すこと。画像のみのページのフォールバックに使うため、
 *     元のPDFバッファ(context.pdfBuffer)も渡すこと。
 */

const Anthropic = require('@anthropic-ai/sdk');
const { PDFDocument } = require('pdf-lib');
const { fetchPriceStatsGroupedByItem, matchStatsToPages, buildPriceStatsPromptBlock } = require('./priceStats');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `あなたは「建設顧問セカンドオピニオン」のAI一次チェック担当です。
建築・リフォーム工事の見積書を、ページ単位で精査し、専門家(人間)が最終確認しやすい形に整理することが役割です。

# 入力データについて
入力は、見積書PDFから機械的に抽出した「このページ1枚分の行データ」です(見積書全体ではなく、1ページ分だけが渡されます)。
各行は「項目名 | 数量 | 単位 | 単価 | 金額」の形式で渡されます(値が取得できない項目は "-" になります)。
抽出処理の都合上、まれに項目名や数値が誤って分割・結合されていることがあります。
明らかにおかしい場合は "unclearItems" に記載してください。
単価の欄に「(※見積書に単価の記載なし。金額÷数量から逆算した参考値)」と付いている場合は、
見積書に単価が直接印字されていなかったため、数量と金額から機械的に逆算した値です。
推測ではなく確実な計算なので、通常の単価と同様に妥当性チェックの対象にしてください。
※ページをまたいだ重複計上の確認は別の仕組み(機械的チェック)で行うため、ここでは行わなくて構いません。

# 厳守事項(最重要・必ず守ること)
- このページ内で単価が記載されている行は、金額の大小や「怪しく見えるかどうか」に関係なく、
  原則として全ての行について単価の妥当性を個別にチェックし、findings に1件ずつ出力すること。
  「問題なさそうだから省略する」「重要な論点に絞る」という理由で個々の行の判断を省くことは禁止する。
  妥当と判断した行も、下記の severity: "low" として findings に含めること(「相場内で妥当」という
  確認結果そのものが、専門家にとって価値のある情報だから)。行数が多くても、似たような項目だからと
  いって複数行をまとめて1件に要約しないこと。
- 【最重要】web_searchツールの使用について: 「怪しい項目だけ検索すればよい」という判断は禁止する。
  過去実績データが無い項目は、単価の大小や印象に関わらず、ツール使用回数の上限に達するまで
  積極的に web_search を使って現在の一般的な相場・単価情報を調べること。特に、メーカー名・
  型番・商品名が明記されている項目(例:「LIXIL/フェンスAB YL2-K型」「TOYO/シルフ」等)は、
  検索すれば実勢価格や定価が見つかりやすいため、最優先で検索すること。検索を怠って
  「AI推定(参考値)」で済ませるのは、実際に調べれば分かる情報を調べなかったことになるため、
  明確な指示違反とみなす。ツール使用回数の上限内で収まらない場合は、金額が大きい項目から
  優先的に検索すること。
- あなた自身が最終判断者ではありません。「専門家が確認すべき論点」を洗い出すのが仕事です。
- 断定的な「これは不当請求です」等の表現は使わない。「相場と比べて高い可能性がある」等、根拠とセットで指摘する。
- 単価の妥当性は、以下の優先順位で根拠づけること:
  1. 「本サービスの過去実績データに基づく単価統計」が提供されている項目は、最優先でそれを根拠にする。
     件数・平均・範囲を明示し、今回の単価がその範囲内か、どの程度乖離しているかを具体的に述べること。
     (例:「過去12件の実績平均は3,200円/m²ですが、本見積りは5,000円/m²で、実績平均より約56%高くなっています(本サービス実績データに基づく)」)
  2. 過去実績データが無い項目は、上記の通りweb_searchツールで確認すること。
     検索結果を根拠にする場合は、調べた情報源(サイト名)を明記すること。
     (例:「〇〇(サイト名)によれば、現在の相場は◯◯円/m²程度とされており、本見積りとほぼ一致しています(web検索結果に基づく)」)
  3. 検索しても有効な情報が得られなかった項目についてのみ、あなたの学習知識に基づく一般的な相場観である
     ことを明記し(例:「一般的な相場は◯◯円/m程度と思われます(AI推定・参考値)」)、リアルタイムの
     最新相場ではない可能性がある旨がわかるようにする。
- web_searchツールを使う場合でも、最終的な出力は必ず下記の「出力形式」通りのJSONのみとすること。
  検索中の説明文(「検索します」等)を最終回答として出力してはいけない。検索が終わったら、
  その結果を踏まえて改めてJSON形式の回答を生成すること。
- 見積書に記載のない情報を推測で補わない。不明な点は「不明」「要確認」と明記する。
- 個人や会社を誹謗中傷しない。あくまで見積書の記載内容に対する客観的な指摘に留める。
- findings の "page" と "itemText" は、入力データに登場する値をそのまま(一字一句変えずに)使うこと。
  この値は自動的にPDF上の該当箇所への注釈(マーカー)配置に使われるため、要約したり言い換えたりしないこと。
- 各 "concern" "basis" "expertQuestion" はそれぞれ120文字程度までを目安に簡潔にまとめること
  (このページ単位でのチェックのため、件数の上限は設けない。該当する行の数だけ出力してよい)。

# チェック観点(このページの行ごとに、1行ずつ確認すること)
1. 単価の妥当性(一般的な相場との乖離) — 単価が明記されている行は全て、上記のweb_search方針に従って確認する
2. 「一式」など、内訳・単価が不明瞭な項目の有無(金額の大きい「一式」項目は特に指摘する)
3. 同一ページ内での同一内容・類似項目の重複計上がないか
4. 仮設・諸経費・工事管理費など付帯費用の、合計に対する割合が過大でないか
5. 工事範囲の記載漏れ・曖昧さ、数量の記載ミス(桁違いなど)がないか
6. 数量×単価が金額と一致しない行(コード側の機械チェックで既に検出されている場合があるが、
   コードが検出できなかったパターン(単位の考慮ミスなど)があれば追加で指摘する)

# 出力形式(JSON。他の文章は一切含めないこと)
{
  "summary": "このページの総評(1〜2文)",
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

// 画像のみのPDFページ(スキャン・写真)用のシステムプロンプト。基本方針はSYSTEM_PROMPTと同じだが、
// 「構造化データ」ではなく「ページの画像そのもの」を読み取る前提で指示を書き換えている。
const SYSTEM_PROMPT_SCANNED = `あなたは「建設顧問セカンドオピニオン」のAI一次チェック担当です。
建築・リフォーム工事の見積書を、ページ単位で精査し、専門家(人間)が最終確認しやすい形に整理することが役割です。

# 入力データについて
入力は、見積書PDFの1ページ分を、そのままページ画像として渡したものです(スキャナー取り込みや写真のPDFのため、
機械的なテキスト抽出ができません)。あなたの画像認識機能を使って、表の各行(項目名・数量・単位・単価・金額)を
できる限り正確に読み取った上で、通常のチェックを行ってください。
文字が不鮮明・かすれている・影で読みにくい等で確信が持てない数字や項目名は、無理に読み取らず
"unclearItems" にその旨を記載してください(誤った数字で断定的な指摘をしない方が重要です)。

# 厳守事項(最重要・必ず守ること)
- このページ内で単価が記載されている行は、金額の大小や「怪しく見えるかどうか」に関係なく、
  原則として全ての行について単価の妥当性を個別にチェックし、findings に1件ずつ出力すること。
  「問題なさそうだから省略する」という理由で個々の行の判断を省くことは禁止する。妥当と判断した
  行も、下記の severity: "low" として findings に含めること(「相場内で妥当」という確認結果
  そのものが、専門家にとって価値のある情報だから)。行数が多くても、複数行をまとめて1件に
  要約しないこと。
- 【最重要】web_searchツールの使用について: 「怪しい項目だけ検索すればよい」という判断は禁止する。
  過去実績データが無い項目は、単価の大小や印象に関わらず、ツール使用回数の上限に達するまで
  積極的に web_search を使って現在の一般的な相場・単価情報を調べること。特に、メーカー名・
  型番・商品名が読み取れる項目は、検索すれば実勢価格や定価が見つかりやすいため、最優先で
  検索すること。検索を怠って「AI推定(参考値)」で済ませるのは、実際に調べれば分かる情報を
  調べなかったことになるため、明確な指示違反とみなす。
- あなた自身が最終判断者ではありません。「専門家が確認すべき論点」を洗い出すのが仕事です。
- 断定的な「これは不当請求です」等の表現は使わない。「相場と比べて高い可能性がある」等、根拠とセットで指摘する。
- 単価の妥当性は、以下の優先順位で根拠づけること:
  1. 「本サービスの過去実績データに基づく単価統計」が提供されている項目は、最優先でそれを根拠にする。
  2. 過去実績データが無い項目は、上記の通りweb_searchツールで確認すること。
     検索結果を根拠にする場合は、調べた情報源(サイト名)を明記すること。
  3. 検索しても有効な情報が得られなかった項目についてのみ、あなたの学習知識に基づく一般的な相場観である
     ことを明記する。
- web_searchツールを使う場合でも、最終的な出力は必ず下記の「出力形式」通りのJSONのみとすること。
- findings の "itemText" は、あなたがページ画像から読み取った項目名の文字列をそのまま使うこと
  (この入力は画像のため、PDF上への自動マーキングには使われず、一覧表示にのみ使われます)。
- 各 "concern" "basis" "expertQuestion" はそれぞれ120文字程度までを目安に簡潔にまとめること
  (件数の上限は設けない。該当する行の数だけ出力してよい)。

# チェック観点(このページの行ごとに、1行ずつ確認すること)
1. 単価の妥当性(一般的な相場との乖離) — 単価が明記されている行は全て、上記のweb_search方針に従って確認する
2. 「一式」など、内訳・単価が不明瞭な項目の有無(金額の大きい「一式」項目は特に指摘する)
3. 同一ページ内での同一内容・類似項目の重複計上がないか
4. 仮設・諸経費・工事管理費など付帯費用の、合計に対する割合が過大でないか
5. 工事範囲の記載漏れ・曖昧さ、数量の記載ミス(桁違いなど)がないか
6. 数量×単価が金額と一致しない行

# 出力形式(JSON。他の文章は一切含めないこと)
{
  "summary": "このページの総評(1〜2文)",
  "findings": [
    {
      "page": 4,
      "itemText": "画像から読み取った項目名",
      "concern": "指摘内容",
      "basis": "指摘の根拠(相場観・一般的な計算方法など)",
      "severity": "high" | "medium" | "low",
      "expertQuestion": "専門家が施主に確認すべき質問文"
    }
  ],
  "unclearItems": ["記載や読み取りが不明瞭で判断できなかった項目"],
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
 * 同じ項目名の行が、別々のページに重複して計上されていないかを、コード側で機械的にチェックする。
 * (以前はAIにページをまたいだ重複チェックも依頼していたが、1ページ単位でAIを呼ぶ構成に変えたため、
 *  ページをまたぐ重複はAIから見えなくなった。その代わりをこの機械チェックで担う)
 * 短すぎる項目名(「一式」など)は誤検知が多いため対象外とする。
 * @param {Array<PageData>} pages
 * @returns {Array} findings形式の配列(source: 'duplicate-check' 付き)
 */
function crossPageDuplicateCheck(pages) {
  const firstSeenPage = new Map(); // key: item_text(trim), value: ページ番号
  const findings = [];

  for (const page of pages) {
    for (const row of page.rows || []) {
      const key = String(row.item || '').trim();
      if (key.length < 4) continue;

      const amount = parseNum(row.amount);
      if (amount === null || amount <= 0) continue;

      if (firstSeenPage.has(key)) {
        const firstPage = firstSeenPage.get(key);
        if (firstPage !== page.pageNumber) {
          findings.push({
            page: page.pageNumber,
            itemText: row.item,
            concern: `同じ項目名「${row.item}」が${firstPage}ページと${page.pageNumber}ページの両方に計上されています。重複計上でないかご確認ください。`,
            basis: '同一項目名が複数ページに計上されている(機械的チェック)',
            severity: 'medium',
            expertQuestion: `「${row.item}」は${firstPage}ページと${page.pageNumber}ページで別々に必要な工事か、重複計上でないかご確認ください。`,
            source: 'duplicate-check',
          });
        }
      } else {
        firstSeenPage.set(key, page.pageNumber);
      }
    }
  }

  return findings;
}

/**
 * 1ページ分の構造化データをAIに渡すためのテキスト形式に変換する
 */
function buildStructuredTextForPage(page) {
  const lines = [`--- ページ ${page.pageNumber} ---`];
  if (!page.rows || page.rows.length === 0) {
    lines.push('(表形式の項目は検出されませんでした)');
    return lines.join('\n');
  }
  for (const row of page.rows) {
    const unitPriceLabel =
      row.unitPrice && row.unitPriceDerived ? `${row.unitPrice}(※見積書に単価の記載なし。金額÷数量から逆算した参考値)` : row.unitPrice ?? '-';
    lines.push(
      `項目: ${row.item} | 数量: ${row.qty ?? '-'} | 単位: ${row.unit ?? '-'} | 単価: ${unitPriceLabel} | 金額: ${row.amount ?? '-'}`
    );
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

// 1ページあたりのweb検索の上限(ページ単位でAIを呼ぶため、見積書全体で見れば
// ページ数に比例して検索回数が増える)。単価が記載されている行は基本的に全て検索対象とする
// 方針に変更したため、1ページに項目が多い場合でも足りるよう、やや余裕を持たせている。
const WEB_SEARCH_MAX_USES_PER_PAGE = 15;
const MAX_SEARCH_ROUNDS_PER_PAGE = 15;

// Anthropic APIが混雑時などに一時的に空応答を返すことがあるため、
// テキストブロックが取得できなかった場合は1回だけ自動的に再試行する。
const MAX_ATTEMPTS_PER_PAGE = 2;

// 同時に投げるページ数(多すぎるとAPIのレート制限に当たる可能性があるため抑える)
const PAGE_CONCURRENCY = 3;

/**
 * 1ページ分をAIでチェックする。
 * @param {PageData} page pdfRows.jsの1ページ分
 * @param {object} opts
 * @param {string} [opts.workType]
 * @param {Array} opts.allStats fetchPriceStatsGroupedByItemの結果(全項目分。ページ内の項目にマッチするものだけ絞り込んで使う)
 * @returns {Promise<{pageNumber: number, summary: string, findings: Array, unclearItems: Array, expertChecklist: Array, truncated: boolean}>}
 */
async function reviewSinglePage(page, opts) {
  const { workType, allStats } = opts;

  const structuredText = buildStructuredTextForPage(page);

  let priceStatsBlock = null;
  try {
    const matchedStats = matchStatsToPages([page], allStats || []);
    priceStatsBlock = buildPriceStatsPromptBlock(matchedStats);
  } catch (err) {
    console.error(`⚠️ [${page.pageNumber}ページ] 単価統計のマッチングに失敗しました(通常モードで続行します):`, err.message);
  }

  const userMessage = [
    workType ? `工事種別: ${workType}` : null,
    `以下は見積書PDFの${page.pageNumber}ページ目から抽出した構造化データです。上記の観点でチェックしてください。`,
    '---',
    structuredText,
    priceStatsBlock ? '---' : null,
    priceStatsBlock,
  ]
    .filter(Boolean)
    .join('\n');

  const tools = [
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: WEB_SEARCH_MAX_USES_PER_PAGE,
    },
  ];

  let response = null;
  let textBlock = null;
  let lastDiagnostics = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PAGE; attempt++) {
    const messages = [{ role: 'user', content: userMessage }];

    for (let round = 1; round <= MAX_SEARCH_ROUNDS_PER_PAGE; round++) {
      response = await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 16000,
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
      page: page.pageNumber,
      attempt,
      stopReason: response.stop_reason,
      contentTypes: response.content.map((b) => b.type),
    };
    console.warn(
      `⚠️ [${page.pageNumber}ページ] AIからテキスト応答が得られませんでした(試行${attempt}/${MAX_ATTEMPTS_PER_PAGE})。stop_reason=${response.stop_reason}, content types=${JSON.stringify(
        lastDiagnostics.contentTypes
      )}`
    );
  }

  if (!textBlock) {
    throw new Error(
      `${page.pageNumber}ページ目のAIチェックで、テキスト応答が取得できませんでした(${MAX_ATTEMPTS_PER_PAGE}回試行)。診断情報: ${JSON.stringify(lastDiagnostics)}`
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
      const repaired = repairTruncatedJson(rawJson);
      if (repaired) {
        console.warn(
          `⚠️ [${page.pageNumber}ページ] AI応答の一部が途中で切れていたため、自動修復して処理を続行しました(検出できた範囲の指摘のみ反映されます)。`
        );
        aiResult = repaired;
        wasTruncated = true;
      } else {
        throw new Error(`${page.pageNumber}ページ目のAI応答のJSON解析に失敗しました: ${err.message}\n生の応答: ${textBlock.text}`);
      }
    }
  }

  return {
    pageNumber: page.pageNumber,
    summary: aiResult.summary || '',
    findings: (aiResult.findings || []).map((f) => ({ ...f, source: f.source || 'ai' })),
    unclearItems: aiResult.unclearItems || [],
    expertChecklist: aiResult.expertChecklist || [],
    truncated: wasTruncated,
  };
}

/**
 * 元のPDFから指定ページだけを切り出して、1ページのPDFバッファを作る。
 * (画像のみのページをClaudeに「document」として渡す際、ページ全体ではなく
 *  該当ページだけに絞ることで、他ページの内容に引っ張られないようにする)
 */
async function extractSinglePagePdfBuffer(pdfBuffer, pageNumber) {
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const outDoc = await PDFDocument.create();
  const [copiedPage] = await outDoc.copyPages(srcDoc, [pageNumber - 1]);
  outDoc.addPage(copiedPage);
  const bytes = await outDoc.save();
  return Buffer.from(bytes);
}

/**
 * テキスト情報を持たない(スキャン・写真の)ページを、画像としてClaudeに直接読ませてチェックする。
 * @param {Buffer} pdfBuffer 見積書PDF全体のバッファ
 * @param {number} pageNumber チェック対象のページ番号(1始まり)
 * @param {object} opts
 * @param {string} [opts.workType]
 * @returns {Promise<{pageNumber: number, summary: string, findings: Array, unclearItems: Array, expertChecklist: Array, truncated: boolean}>}
 */
async function reviewSingleScannedPage(pdfBuffer, pageNumber, opts) {
  const { workType } = opts;

  const pageBuffer = await extractSinglePagePdfBuffer(pdfBuffer, pageNumber);
  const base64 = pageBuffer.toString('base64');

  const userContent = [
    {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: base64 },
    },
    {
      type: 'text',
      text: [
        workType ? `工事種別: ${workType}` : null,
        `これは見積書PDFの${pageNumber}ページ目です(画像のみでテキスト情報がないため、ページそのものを渡しています)。` +
          '上記の観点でチェックしてください。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];

  const tools = [
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: WEB_SEARCH_MAX_USES_PER_PAGE,
    },
  ];

  let response = null;
  let textBlock = null;
  let lastDiagnostics = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PAGE; attempt++) {
    const messages = [{ role: 'user', content: userContent }];

    for (let round = 1; round <= MAX_SEARCH_ROUNDS_PER_PAGE; round++) {
      response = await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 16000,
        system: SYSTEM_PROMPT_SCANNED,
        messages,
        tools,
      });

      if (response.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: response.content });
    }

    const textBlocks = response.content.filter((block) => block.type === 'text');
    textBlock = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1] : null;
    if (textBlock) break;

    lastDiagnostics = {
      page: pageNumber,
      attempt,
      stopReason: response.stop_reason,
      contentTypes: response.content.map((b) => b.type),
    };
    console.warn(
      `⚠️ [${pageNumber}ページ(画像)] AIからテキスト応答が得られませんでした(試行${attempt}/${MAX_ATTEMPTS_PER_PAGE})。stop_reason=${response.stop_reason}, content types=${JSON.stringify(
        lastDiagnostics.contentTypes
      )}`
    );
  }

  if (!textBlock) {
    throw new Error(
      `${pageNumber}ページ目(画像)のAIチェックで、テキスト応答が取得できませんでした(${MAX_ATTEMPTS_PER_PAGE}回試行)。診断情報: ${JSON.stringify(lastDiagnostics)}`
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
      const repaired = repairTruncatedJson(rawJson);
      if (repaired) {
        console.warn(
          `⚠️ [${pageNumber}ページ(画像)] AI応答の一部が途中で切れていたため、自動修復して処理を続行しました。`
        );
        aiResult = repaired;
        wasTruncated = true;
      } else {
        throw new Error(`${pageNumber}ページ目(画像)のAI応答のJSON解析に失敗しました: ${err.message}\n生の応答: ${textBlock.text}`);
      }
    }
  }

  return {
    pageNumber,
    summary: aiResult.summary || '',
    findings: (aiResult.findings || []).map((f) => ({ ...f, source: f.source || 'ai-vision' })),
    unclearItems: aiResult.unclearItems || [],
    expertChecklist: aiResult.expertChecklist || [],
    truncated: wasTruncated,
  };
}

/**
 * 配列の各要素に対して非同期処理を行うが、同時実行数を limit 件までに制限する。
 * (Promise.allをそのまま使うと、ページ数が多い見積書で一気に全ページ分のAPI呼び出しが
 *  飛んでしまい、レート制限に当たりやすくなるため)
 */
async function runWithConcurrencyLimit(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * 見積書の構造化データをAIで一次チェックする。
 * 内部的には「1ページ=1回のAI呼び出し」に分割して処理し、最後に結果を結合する
 * (行数が多い見積書でも、各ページの単価チェックが疎かにならないようにするため)。
 * @param {Array<PageData>} structuredPages pdfRows.extractStructuredPdf() が返す pages 配列
 * @param {object} [context] 追加情報(工事種別など、わかれば精度が上がる)
 * @param {string} [context.workType] 例: "外壁塗装", "リフォーム", "注文住宅"
 * @param {import('pg').Pool} [context.pool] DB接続プール。渡された場合、過去の見積り実績(estimate_line_items)
 *   から単価統計を集計し、「学習型」としてプロンプトに含める。渡されない/取得失敗時は従来通り(AIの一般知識のみ)で動作する。
 * @param {Buffer} [context.pdfBuffer] 元のPDFバッファ。テキスト情報を持たない(スキャン・写真の)ページがある場合、
 *   そのページだけを画像としてClaudeに読ませるフォールバックに使う。渡されない場合、該当ページはチェックされない。
 * @returns {Promise<object>} { summary, findings, unclearItems, expertChecklist }
 *   findings には、コード側の機械チェック(arithmeticCheck・crossPageDuplicateCheck)の結果もマージして含まれる。
 */
async function reviewEstimate(structuredPages, context = {}) {
  if (!Array.isArray(structuredPages) || structuredPages.length === 0) {
    throw new Error('structuredPages が空です。PDFからの構造化抽出に失敗している可能性があります。');
  }

  // 学習型AI添削: 過去に処理した見積りの単価実績を集計しておく(ページごとに絞り込んで使う)。
  let allStats = [];
  if (context.pool) {
    try {
      allStats = await fetchPriceStatsGroupedByItem(context.pool);
    } catch (err) {
      console.error('⚠️ 学習型単価統計の取得に失敗しました(通常モードで続行します):', err.message);
    }
  }

  // テキストが抽出できた(通常の)ページと、画像のみでテキストが無いページを分ける。
  // 後者は pdfRows.js の行抽出では何も取れない(hasTextLayer === false)ため、
  // ページ画像としてClaudeのビジョン機能に直接読ませるフォールバックに回す。
  const pagesWithRows = structuredPages.filter((p) => p.rows && p.rows.length > 0);
  const scannedPages = structuredPages.filter((p) => (!p.rows || p.rows.length === 0) && p.hasTextLayer === false);
  const pagesToReview = pagesWithRows.length > 0 || scannedPages.length > 0 ? pagesWithRows : structuredPages;

  if (scannedPages.length > 0 && !context.pdfBuffer) {
    console.error(
      `⚠️ ${scannedPages.length}ページがテキスト無し(画像のみ)と判定されましたが、context.pdfBufferが渡されていないため、画像読み取りフォールバックを実行できません。`
    );
  }

  const textPageResults = await runWithConcurrencyLimit(pagesToReview, PAGE_CONCURRENCY, (page) =>
    reviewSinglePage(page, { workType: context.workType, allStats })
  );

  const scannedPageResults =
    scannedPages.length > 0 && context.pdfBuffer
      ? await runWithConcurrencyLimit(scannedPages, PAGE_CONCURRENCY, (page) =>
          reviewSingleScannedPage(context.pdfBuffer, page.pageNumber, { workType: context.workType })
        )
      : [];

  const pageResults = [...textPageResults, ...scannedPageResults].sort((a, b) => a.pageNumber - b.pageNumber);

  const arithmeticFindings = arithmeticCheck(structuredPages);
  const duplicateFindings = crossPageDuplicateCheck(structuredPages);
  const aiFindings = pageResults.flatMap((r) => r.findings);

  // 機械チェックとAIチェックが同じ項目を重複して指摘した場合、機械チェックの結果を優先して残す
  const machineFindings = [...arithmeticFindings, ...duplicateFindings];
  const dedupedAiFindings = aiFindings.filter(
    (af) =>
      !machineFindings.some((mf) => mf.page === af.page && mf.itemText && af.itemText && mf.itemText === af.itemText)
  );

  const findings = [...machineFindings, ...dedupedAiFindings].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return 0;
  });

  const summary = pageResults
    .map((r) => (r.summary ? `【${r.pageNumber}ページ】${r.summary}` : null))
    .filter(Boolean)
    .join('\n');

  const unclearItems = [...new Set(pageResults.flatMap((r) => r.unclearItems))];
  const expertChecklist = [...new Set(pageResults.flatMap((r) => r.expertChecklist))];
  const truncated = pageResults.some((r) => r.truncated);

  return {
    summary,
    findings,
    unclearItems,
    expertChecklist,
    truncated,
  };
}

module.exports = { reviewEstimate, arithmeticCheck, crossPageDuplicateCheck, SYSTEM_PROMPT };

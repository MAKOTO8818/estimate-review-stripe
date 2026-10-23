/**
 * aiReview.js の「AIの返答をJSONとして読み込む処理」の動作確認スクリプト
 * 実行: node aiReview.test.js
 *
 * 実際のAnthropic APIは呼ばない。APIの応答(response.content)を模したデータと、
 * 決まった応答を順番に返す「偽のクライアント」を使って確認する。
 */
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key'; // クライアント生成時のエラー回避用(APIは呼ばない)

const assert = require('assert');
const { _internal } = require('./aiReview');
const { collectFinalAnswerText, parseAiJsonResponse, normalizeAiResult, runPageReviewConversation, reviewSinglePage } =
  _internal;

// テスト中の警告ログは、件数だけ数えて画面には出さない(結果を見やすくするため)
const originalWarn = console.warn;
const originalError = console.error;
let warnings = [];
function silenceLogs() {
  warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  console.error = () => {};
}
function restoreLogs() {
  console.warn = originalWarn;
  console.error = originalError;
}

/** 決まった応答を順番に返す偽のAnthropicクライアント。呼び出し内容も記録する。 */
function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(JSON.parse(JSON.stringify(params)));
        if (calls.length > responses.length) throw new Error('想定より多くAPIが呼ばれました');
        return responses[calls.length - 1];
      },
    },
  };
}

// --- テスト用の応答データ ---

// web検索を使ったときの応答。最終回答のJSONが、引用(citations)の位置で3つのテキストブロックに分かれている。
const citationSplitContent = [
  { type: 'text', text: 'メーカー品の相場を調べます。' },
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'LIXIL フェンスAB YL2-K型 価格' } },
  { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
  {
    type: 'text',
    text:
      '{"summary": "外構工事のページです。", "findings": [{"page": "2", "itemText": "LIXIL/フェンスAB YL2-K型", ' +
      '"concern": "単価は',
  },
  {
    type: 'text',
    text: 'メーカー定価の約7割で',
    citations: [{ type: 'web_search_result_location', url: 'https://example.com/lixil', title: '価格表' }],
  },
  {
    type: 'text',
    text:
      '、相場内です。", "basis": "価格表サイトによる(web検索結果に基づく)", "severity": "low", "expertQuestion": "数量の根拠をご確認ください。"}, ' +
      '{"page": "2", "itemText": "土間コンクリート", "concern": "単価が相場より高い可能性があります。", "basis": "一般的な相場は1万円/m²前後", ' +
      '"severity": "medium", "expertQuestion": "厚みと配筋の仕様をご確認ください。"}], "unclearItems": [], "expertChecklist": ["土間の仕様"]}',
  },
];

const FINDING_1 =
  '{"page": 3, "itemText": "足場", "concern": "妥当です。", "basis": "相場内", "severity": "low", "expertQuestion": "なし"}';
const FINDING_2 =
  '{"page": 3, "itemText": "高圧洗浄", "concern": "妥当です。", "basis": "相場内", "severity": "low", "expertQuestion": "なし"}';
const COMPLETE_JSON = `{"summary": "塗装工事のページです。", "findings": [${FINDING_1}, ${FINDING_2}], "unclearItems": [], "expertChecklist": []}`;
// 出力の上限(max_tokens)で、3件目の指摘の途中で切れた応答
const TRUNCATED_JSON =
  `{"summary": "塗装工事のページです。", "findings": [${FINDING_1}, ${FINDING_2}, ` +
  '{"page": 3, "itemText": "外壁塗装", "concern": "単価が相場より';

// 実行するテスト一覧
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------
// ① 引用で分かれたJSON
// ---------------------------------------------------------------
test('①引用で分かれたJSON: 検索後のテキストブロックを全部つなげて読める', () => {
  const text = collectFinalAnswerText(citationSplitContent);
  assert.ok(!text.includes('相場を調べます'), '検索前の説明文は含めない');
  const { aiResult, wasTruncated } = parseAiJsonResponse(text, '2ページ');
  assert.strictEqual(wasTruncated, false);
  assert.strictEqual(aiResult.findings.length, 2);
  assert.strictEqual(aiResult.findings[0].concern, '単価はメーカー定価の約7割で、相場内です。');
  assert.strictEqual(aiResult.summary, '外構工事のページです。');
});

test('①(比較)以前の「最後のブロックだけ読む」方法では指摘が0件になっていた', () => {
  const textBlocks = citationSplitContent.filter((b) => b.type === 'text');
  const lastOnly = textBlocks[textBlocks.length - 1].text;
  const { aiResult } = parseAiJsonResponse(lastOnly, '2ページ');
  // 断片の中の「2件目の指摘オブジェクト」だけを全体と誤認し、findings が存在しない状態になる
  assert.strictEqual((aiResult.findings || []).length, 0);
});

test('①検索を使わなかった応答(テキスト1つだけ)はそのまま読める', () => {
  const text = collectFinalAnswerText([{ type: 'text', text: COMPLETE_JSON }]);
  assert.strictEqual(parseAiJsonResponse(text, '3ページ').aiResult.findings.length, 2);
});

test('①JSONの後ろに説明文が別ブロックで続いても読める', () => {
  const text = collectFinalAnswerText([...citationSplitContent, { type: 'text', text: '\n以上です。' }]);
  assert.strictEqual(parseAiJsonResponse(text, '2ページ').aiResult.findings.length, 2);
});

// ---------------------------------------------------------------
// ② 途中で切れたJSON / max_tokens の検出とやり直し
// ---------------------------------------------------------------
test('②途中で切れたJSON: 完成している2件だけ救出し、切れたことを記録する', () => {
  const { aiResult, wasTruncated } = parseAiJsonResponse(TRUNCATED_JSON, '3ページ');
  assert.strictEqual(wasTruncated, true);
  assert.deepStrictEqual(
    aiResult.findings.map((f) => f.itemText),
    ['足場', '高圧洗浄']
  );
});

test('②max_tokensで切れたら、ログに残してそのページだけ1回やり直す(やり直しで成功)', async () => {
  const client = fakeClient([
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: TRUNCATED_JSON }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: COMPLETE_JSON }] },
  ]);
  const result = await runPageReviewConversation({
    client,
    system: 'system',
    userContent: '3ページのデータ',
    pageLabel: '3ページ',
  });
  assert.strictEqual(client.calls.length, 2, 'APIは2回(最初+やり直し1回)呼ばれる');
  assert.strictEqual(result.hitMaxTokens, false);
  assert.strictEqual(result.text, COMPLETE_JSON);
  assert.ok(warnings.some((w) => w.includes('max_tokens')), 'max_tokensで切れたことがログに残る');
  const retryContent = client.calls[1].messages[0].content;
  assert.ok(retryContent.startsWith('3ページのデータ') && retryContent.includes('再実行'), 'やり直し時は短くする指示を付ける');
});

test('②画像ページ(ブロック配列のメッセージ)でも、やり直し時に指示が付け加えられる', async () => {
  const client = fakeClient([
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: TRUNCATED_JSON }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: COMPLETE_JSON }] },
  ]);
  const userContent = [{ type: 'text', text: '画像ページです' }];
  await runPageReviewConversation({ client, system: 's', userContent, pageLabel: '3ページ(画像)' });
  const retryContent = client.calls[1].messages[0].content;
  assert.strictEqual(retryContent.length, 2);
  assert.ok(retryContent[1].text.includes('再実行'));
  assert.strictEqual(userContent.length, 1, '元のメッセージは書き換えない');
});

test('②やり直しても切れた場合は、それ以上呼ばずに切れた回答から救出する(ページ全体の処理)', async () => {
  const client = fakeClient([
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: TRUNCATED_JSON }] },
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: TRUNCATED_JSON }] },
  ]);
  const page = {
    pageNumber: 3,
    rows: [{ item: '足場', qty: '100', unit: 'm2', unitPrice: '800', amount: '80,000' }],
  };
  const result = await reviewSinglePage(page, { allStats: [], client });
  assert.strictEqual(client.calls.length, 2, 'やり直しは1回だけ');
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.findings.length, 2);
});

// ---------------------------------------------------------------
// ③ "high" | "medium" | "low" が混ざったJSON
// ---------------------------------------------------------------
test('③"high" | "medium" | "low" が混ざっていても読め、medium として扱う', () => {
  const text =
    '{"summary": "s", "findings": [' +
    '{"page": 1, "itemText": "解体工事", "concern": "c", "basis": "b", "severity": "high" | "medium" | "low", "expertQuestion": "q"}, ' +
    '{"page": 1, "itemText": "諸経費", "concern": "c", "basis": "b", "severity": "high", "expertQuestion": "q"}' +
    '], "unclearItems": [], "expertChecklist": []}';
  const { aiResult, wasTruncated } = parseAiJsonResponse(text, '1ページ');
  assert.strictEqual(wasTruncated, false);
  assert.deepStrictEqual(
    aiResult.findings.map((f) => f.severity),
    ['medium', 'high']
  );
});

test('③プロンプトの出力例が、正しいJSONの形になっている', () => {
  const { SYSTEM_PROMPT } = require('./aiReview');
  const example = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf('# 出力形式'));
  const jsonPart = example.slice(example.indexOf('{'), example.lastIndexOf('}') + 1);
  const parsed = JSON.parse(jsonPart);
  assert.strictEqual(typeof parsed.findings[0].severity, 'string');
});

// ---------------------------------------------------------------
// ⑤ 文字列の中の改行・制御文字
// ---------------------------------------------------------------
test('⑤文字列の中に生の改行・タブがあっても読める', () => {
  const text =
    '{\n  "summary": "1行目\n2行目",\n  "findings": [\n    {"page": 1, "itemText": "仮設工事", ' +
    '"concern": "単価が高い可能性があります。\n内訳をご確認ください。", "basis": "相場\t参考", "severity": "medium", "expertQuestion": "q"}\n  ],\n' +
    '  "unclearItems": [],\n  "expertChecklist": []\n}';
  assert.throws(() => JSON.parse(text), '修正前の JSON.parse では失敗する例であること');
  const { aiResult, wasTruncated } = parseAiJsonResponse(text, '1ページ');
  assert.strictEqual(wasTruncated, false);
  assert.strictEqual(aiResult.summary, '1行目\n2行目');
  assert.strictEqual(aiResult.findings[0].concern, '単価が高い可能性があります。\n内訳をご確認ください。');
  assert.strictEqual(aiResult.findings[0].basis, '相場\t参考');
});

test('⑤改行と半角引用符の混入が同時に起きていても読める', () => {
  const text =
    '{"summary": "s", "findings": [{"page": 1, "itemText": "一式工事", ' +
    '"concern": "記載が"一式"のみです。\n内訳が不明です。", "basis": "b", "severity": "medium", "expertQuestion": "q"}], ' +
    '"unclearItems": [], "expertChecklist": []}';
  const { aiResult } = parseAiJsonResponse(text, '1ページ');
  assert.strictEqual(aiResult.findings[0].concern, '記載が"一式"のみです。\n内訳が不明です。');
});

// ---------------------------------------------------------------
// ⑥ page を数値にそろえる / findings が配列でない場合
// ---------------------------------------------------------------
test('⑥pageが文字列("4" / "4ページ" / "４")でも数値にそろう。無い・読めない場合はチェック中のページ番号', () => {
  const aiResult = {
    findings: [{ page: '4' }, { page: '4ページ' }, { page: '４' }, { page: 4 }, {}, { page: '不明' }],
  };
  const { findings } = normalizeAiResult(aiResult, 4, '4ページ');
  assert.deepStrictEqual(
    findings.map((f) => f.page),
    [4, 4, 4, 4, 4, 4]
  );
});

test('⑥findingsが配列でなければ空の配列として扱う(配列内のオブジェクト以外も除外)', () => {
  for (const bad of [{ page: 1, itemText: 'x' }, '指摘なし', null, 3]) {
    assert.deepStrictEqual(normalizeAiResult({ findings: bad }, 1, '1ページ').findings, []);
  }
  assert.deepStrictEqual(normalizeAiResult({ findings: [null, '文字', { page: 1 }] }, 1, '1ページ').findings, [{ page: 1 }]);
  const empty = normalizeAiResult(null, 1, '1ページ');
  assert.deepStrictEqual(empty, { summary: '', findings: [], unclearItems: [], expertChecklist: [] });
});

// ---------------------------------------------------------------
// 総合: 引用で分かれた応答を、ページ全体の処理(reviewSinglePage)に通す
// ---------------------------------------------------------------
test('総合: 引用で分かれた応答でも、ページの処理結果に2件の指摘が数値のpage付きで入る', async () => {
  const client = fakeClient([{ stop_reason: 'end_turn', content: citationSplitContent }]);
  const page = {
    pageNumber: 2,
    rows: [{ item: '土間コンクリート', qty: '10', unit: 'm2', unitPrice: '15,000', amount: '150,000' }],
  };
  const result = await reviewSinglePage(page, { allStats: [], client });
  assert.strictEqual(client.calls.length, 1);
  assert.strictEqual(result.truncated, false);
  assert.deepStrictEqual(
    result.findings.map((f) => [f.page, f.itemText, f.source]),
    [
      [2, 'LIXIL/フェンスAB YL2-K型', 'ai'],
      [2, '土間コンクリート', 'ai'],
    ]
  );
});

test('回帰: 正しいJSON・```json で囲まれたJSONは、これまで通りそのまま読める', () => {
  for (const text of [COMPLETE_JSON, '```json\n' + COMPLETE_JSON + '\n```']) {
    const { aiResult, wasTruncated } = parseAiJsonResponse(text, '3ページ');
    assert.strictEqual(wasTruncated, false);
    assert.strictEqual(aiResult.findings.length, 2);
  }
});

(async () => {
  let passed = 0;
  for (const t of tests) {
    silenceLogs();
    try {
      await t.fn();
      restoreLogs();
      passed++;
      console.log(`✅ ${t.name}`);
    } catch (err) {
      restoreLogs();
      console.log(`❌ ${t.name}\n   ${err.message}`);
    }
  }
  const allPassed = passed === tests.length;
  console.log(allPassed ? `\n全テスト成功(${passed}件)` : `\n失敗したテストがあります(${passed}/${tests.length}件成功)`);
  process.exit(allPassed ? 0 : 1);
})();

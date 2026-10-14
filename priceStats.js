/**
 * 過去の見積りデータから「単価の実績統計」を集計し、AI添削を学習型にするためのモジュール。
 *
 * estimate_line_items テーブル(過去に処理した全見積りの行データを蓄積しているテーブル。
 * これまでは書き込まれるだけで一度も読み出されておらず、「学習型AI添削」が実質機能していなかった)
 * から、項目名(item_text)ごとに単価を集計し、
 *   - 件数(サンプル数)
 *   - 平均単価
 *   - 単価の範囲(最小〜最大)
 * を算出する。件数が少ない(信頼できない)統計はAIに渡さない。
 *
 * 個社の見積り内容そのもの(会社名・金額の総額など)は一切渡さず、
 * 「項目名+単価」という一般的な相場情報のみを集計対象とする。
 */

const MIN_SAMPLE_COUNT = 3; // この件数未満の項目は「まだ参考にならない」として使わない
const MAX_STATS_IN_PROMPT = 15; // プロンプトに含める統計の総数の上限(トークン節約・ノイズ防止)
const MAX_ROWS_TO_SCAN = 20000; // 直近何件の行データまで集計対象にするか

function parseNumericPrice(text) {
  if (text === null || text === undefined) return null;
  const cleaned = String(text).replace(/[,，]/g, '').trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0 || n > 100000000) return null; // 異常値(0以下・1億円超)は除外
  return n;
}

/**
 * DBに蓄積された過去の行データから、item_text ごとの単価統計一覧を作る。
 * @param {import('pg').Pool} pool
 * @returns {Promise<Array<{itemText: string, unit: string|null, count: number, avg: number, min: number, max: number}>>}
 */
async function fetchPriceStatsGroupedByItem(pool) {
  if (!pool) return [];

  try {
    const { rows } = await pool.query(
      `SELECT item_text, unit, unit_price
       FROM estimate_line_items
       WHERE item_text IS NOT NULL AND item_text != ''
         AND unit_price IS NOT NULL AND unit_price != ''
       ORDER BY created_at DESC
       LIMIT $1`,
      [MAX_ROWS_TO_SCAN]
    );

    const groups = new Map(); // key: item_text(trim), value: { prices: number[], units: Map<string, number> }

    for (const r of rows) {
      const key = String(r.item_text).trim();
      if (!key) continue;

      const price = parseNumericPrice(r.unit_price);
      if (price === null) continue;

      if (!groups.has(key)) {
        groups.set(key, { prices: [], units: new Map() });
      }
      const g = groups.get(key);
      g.prices.push(price);
      if (r.unit) {
        g.units.set(r.unit, (g.units.get(r.unit) || 0) + 1);
      }
    }

    const stats = [];
    for (const [itemText, g] of groups.entries()) {
      if (g.prices.length < MIN_SAMPLE_COUNT) continue;

      const sum = g.prices.reduce((a, b) => a + b, 0);
      const avg = sum / g.prices.length;
      const min = Math.min(...g.prices);
      const max = Math.max(...g.prices);

      let topUnit = null;
      let topUnitCount = -1;
      for (const [u, c] of g.units.entries()) {
        if (c > topUnitCount) {
          topUnitCount = c;
          topUnit = u;
        }
      }

      stats.push({ itemText, unit: topUnit, count: g.prices.length, avg, min, max });
    }

    return stats;
  } catch (err) {
    console.error('⚠️ 過去単価統計の取得に失敗しました(学習データなしで続行します):', err.message);
    return [];
  }
}

/**
 * 今回の見積りの各行(item_text)と、過去統計を単純な部分一致でマッチングする。
 * 誤った紐付けを避けるため、2文字未満の項目名はマッチ対象にしない。
 * 1つの過去統計が複数行に重複して使われないようにする。
 */
function matchStatsToPages(pages, allStats) {
  if (!Array.isArray(allStats) || allStats.length === 0) return [];

  const matchedStats = [];
  const usedItemTexts = new Set();

  for (const page of pages) {
    for (const row of page.rows || []) {
      const itemText = (row.item || '').trim();
      if (itemText.length < 2) continue;

      let best = null;
      for (const s of allStats) {
        if (!s.itemText || s.itemText.length < 2) continue;
        if (usedItemTexts.has(s.itemText)) continue;
        if (itemText.includes(s.itemText) || s.itemText.includes(itemText)) {
          if (!best || s.count > best.count) best = s;
        }
      }

      if (best) {
        usedItemTexts.add(best.itemText);
        matchedStats.push({ rowItemText: itemText, ...best });
      }
    }
  }

  matchedStats.sort((a, b) => b.count - a.count);
  return matchedStats.slice(0, MAX_STATS_IN_PROMPT);
}

/**
 * AIへのプロンプトに埋め込むための、人間が読めるテキストブロックを作る。
 * 統計が1件もない場合は null を返す(プロンプトに余計な空ブロックを入れない)。
 */
function buildPriceStatsPromptBlock(matchedStats) {
  if (!matchedStats || matchedStats.length === 0) return null;

  const lines = matchedStats.map((s) => {
    const avgRounded = Math.round(s.avg).toLocaleString('ja-JP');
    const minRounded = Math.round(s.min).toLocaleString('ja-JP');
    const maxRounded = Math.round(s.max).toLocaleString('ja-JP');
    const unitText = s.unit ? `/${s.unit}` : '';
    return `- 「${s.itemText}」: 本サービスで過去に処理した見積り${s.count}件の実績から算出した平均単価 ${avgRounded}円${unitText}(実績範囲: ${minRounded}〜${maxRounded}円)`;
  });

  return [
    '【本サービスの過去実績データに基づく単価統計】',
    ...lines,
    '※これはAIの学習知識による一般論ではなく、本サービスで実際に処理された過去の見積りから集計した実データです。',
    '該当する項目については、この実績データを一般的な相場観より優先的に参照し、現在の見積りの単価と比較してください。',
  ].join('\n');
}

module.exports = {
  fetchPriceStatsGroupedByItem,
  matchStatsToPages,
  buildPriceStatsPromptBlock,
  parseNumericPrice,
  MIN_SAMPLE_COUNT,
};

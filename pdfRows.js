/**
 * PDF構造化抽出ユーティリティ (pdfjs-dist版)
 *
 * pdf-parseは「フラットな文字列」しか返せないため、
 * 「どの数字がどの項目の単価・数量・金額なのか」をAIが正確に判断できなかった。
 * このモジュールは、PDF内の各文字列の「位置(座標)」まで取得し、
 * 同じ行(y座標が近い単語群)をグルーピングして、
 * 項目名・数量・単位・単価・金額に自動分解する。
 *
 * 特定のPDFフォーマット(列のx座標など)にハードコードしていないため、
 * 見積書のフォーマットが取引先ごとに違っても、ある程度汎用的に機能する。
 *
 * 前提: npm install pdfjs-dist
 */

const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// 先頭が数字で、カンマ・ピリオド・ハイフンのみを含むトークンを「数値」とみなす
const NUM_RE = /^[0-9][0-9,.\-]*$/;

/**
 * 全角の数字・カンマ・ピリオド・マイナスを半角に変換する。
 * 一部のPDF作成ソフトは金額・数量を全角数字で出力するため、これを変換しないと
 * NUM_RE に一致せず「数値」として認識できず、単価・金額が一切抽出できなくなる
 * (項目名の一部として読み込まれてしまう)。英字・漢字部分には影響しない。
 */
function toHalfWidth(tok) {
  return tok
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/，/g, ',')
    .replace(/．/g, '.')
    .replace(/－/g, '-')
    .replace(/^[¥￥]/, ''); // 金額の先頭に付く円マークを除去(付いたままだと数値と認識できず、
    // 金額の列がまるごと読み取れなくなる。実際のPDFでかなりの頻度で発生していた)
}

// 「小計」「合計」「消費税」「見積№」など、工事の項目(行)ではなく集計・書類情報の行を見分ける。
// これらは項目名のあとに数字が1つだけ(小計・合計額など)続くことが多く、そのまま行として
// 扱うと「数量=金額」のような不自然な値になり、AIがそれを"データの誤り"として指摘する
// ノイズの元になっていた(本来チェックすべき工事項目の指摘が埋もれてしまう)。
const STRUCTURAL_ITEM_RE = /^(小計|合計|消費税|値引|税込|税別|NET|見積金額|御見積金額|見積№|見積番号|№|Ｎｏ|No\.?|ＮＯ)/;

function isStructuralRow(itemText) {
  const t = String(itemText || '').trim();
  if (!t) return true;
  return STRUCTURAL_ITEM_RE.test(t);
}

/**
 * カンマ区切りを含む数値文字列を number にパースする。パースできない場合は null。
 */
function parseLooseNumber(str) {
  if (str === null || str === undefined) return null;
  const cleaned = String(str).replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// 同じ行とみなすy座標の許容誤差(pt)
const ROW_Y_TOLERANCE = 3;

/**
 * PDFバッファから、ページごとの構造化データを抽出する
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{ pageCount: number, pages: Array<PageData> }>}
 */
async function extractStructuredPdf(pdfBuffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableFontFace: true,
    useSystemFonts: false,
  });
  const pdf = await loadingTask.promise;
  const pages = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();

    // スマホのスキャンアプリ等で作られたPDFは、ページ全体の文字が
    // (見た目は正しく表示されていても)データ上は90度/180度/270度
    // 回転した向きで記録されていることがある。まずページ全体として
    // 一番多い向き(支配的な回転角)を検出し、それを打ち消す形で
    // 座標を読み取ることで、どの向きのPDFでも正しく行を認識できるようにする。
    const rotationDeg = detectDominantRotation(textContent);

    const words = extractWordsFromTextContent(textContent, rotationDeg);
    const rows = groupWordsIntoRows(words);
    const parsedRows = parseRows(rows).filter((r) => !isStructuralRow(r.item));

    // スキャナーで読み込んだ/写真を貼り付けただけの「画像のみのPDF」は、
    // ページ自体にテキスト情報が一切含まれていない(textContent.items が空)。
    // この場合は行の抽出を試みても何も取れないため、呼び出し側(aiReview.js)で
    // 「このページは画像としてAIの画像認識機能に読ませる」フォールバック処理に
    // 切り替えるための目印として hasTextLayer を持たせる。
    const hasTextLayer = textContent.items.some((item) => item.str && item.str.trim());

    pages.push({
      pageNumber: pageNum,
      width: viewport.width,
      height: viewport.height,
      rotationDeg, // pdfAnnotate.js側で、正規化座標を実際のページ座標に戻すために使う
      hasTextLayer,
      rows: parsedRows,
    });

    page.cleanup();
  }

  return { pageCount: pdf.numPages, pages };
}

/**
 * ページ内の文字の大半がどの向き(0/90/180/270度)で記録されているかを判定する。
 * 文字数(重み)で多数決を取ることで、スタンプ等のノイズに引っ張られにくくする。
 */
function detectDominantRotation(textContent) {
  const weightByAngle = { 0: 0, 90: 0, 180: 0, 270: 0 };

  for (const item of textContent.items) {
    const raw = item.str;
    if (!raw || !raw.trim()) continue;

    const [a, b] = item.transform;
    if (a === 0 && b === 0) continue;

    let deg = (Math.atan2(b, a) * 180) / Math.PI;
    deg = ((deg % 360) + 360) % 360;

    let nearest = 0;
    let nearestDiff = Infinity;
    for (const candidate of [0, 90, 180, 270]) {
      const diff = Math.min(Math.abs(deg - candidate), 360 - Math.abs(deg - candidate));
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearest = candidate;
      }
    }
    weightByAngle[nearest] += raw.trim().length;
  }

  let best = 0;
  let bestWeight = -1;
  for (const candidate of [0, 90, 180, 270]) {
    if (weightByAngle[candidate] > bestWeight) {
      bestWeight = weightByAngle[candidate];
      best = candidate;
    }
  }
  return best;
}

/**
 * ページの支配的な回転角を打ち消す向きに座標を回転し、
 * 「読む向きが常に+x方向」になる正規化座標系に変換する。
 */
function normalizePoint(x, y, rotationDeg) {
  switch (rotationDeg) {
    case 90:
      return { x: y, y: -x };
    case 180:
      return { x: -x, y: -y };
    case 270:
      return { x: -y, y: x };
    default:
      return { x, y };
  }
}

/**
 * normalizePoint の逆変換。正規化座標(行の認識用)から、
 * 実際のPDFページ座標(pdf-libで描画する際に使う座標系)に戻す。
 */
function denormalizePoint(x, y, rotationDeg) {
  switch (rotationDeg) {
    case 90:
      return { x: -y, y: x };
    case 180:
      return { x: -x, y: -y };
    case 270:
      return { x: y, y: -x };
    default:
      return { x, y };
  }
}

/**
 * pdfjsのtextContent.itemsから「単語」レベルの位置情報付きトークンを作る。
 * 1つのitemに複数の単語(スペース区切り)が含まれる場合は、
 * 文字数比率でx座標を按分して分割する(簡易的な近似)。
 * 座標は、ページの支配的な回転角を打ち消した「正規化座標系」(読む向きが+x)で返す。
 */
function extractWordsFromTextContent(textContent, rotationDeg) {
  const words = [];

  for (const item of textContent.items) {
    const raw = item.str;
    if (!raw || !raw.trim()) continue;

    const transform = item.transform; // [a, b, c, d, e, f]

    // 文字の向き(ベースラインの角度)が、ページの支配的な向きから
    // 大きく外れている場合は、スタンプ・ノイズ・OCRの誤検出とみなして除外する。
    // (許容範囲は広め(±20度)に取り、スキャンの傾き程度では除外されないようにする)
    const angleRad = Math.atan2(transform[1], transform[0]);
    let angleDeg = (angleRad * 180) / Math.PI;
    angleDeg = ((angleDeg % 360) + 360) % 360;
    const diffFromDominant = Math.min(
      Math.abs(angleDeg - rotationDeg),
      360 - Math.abs(angleDeg - rotationDeg)
    );
    if (diffFromDominant > 20) continue;

    // 原点(文字の開始位置)を正規化座標系に変換する
    const origin = normalizePoint(transform[4], transform[5], rotationDeg);
    const x0 = origin.x;
    const y = origin.y; // 正規化座標系でのベースラインy座標
    const width = item.width || 0;
    const height = Math.hypot(transform[2], transform[3]) || Math.abs(item.height) || 10;

    const totalLen = raw.length || 1;
    const tokens = raw.split(/(\s+)/).filter((t) => t.length > 0);

    let charOffset = 0;
    for (const tok of tokens) {
      const tokLen = tok.length;
      const startFrac = charOffset / totalLen;
      const endFrac = (charOffset + tokLen) / totalLen;
      charOffset += tokLen;

      if (!tok.trim()) continue;

      words.push({
        text: toHalfWidth(tok),
        // 正規化座標系では、読む向きは常に+x方向になる
        x0: x0 + width * startFrac,
        x1: x0 + width * endFrac,
        y,
        height,
      });
    }
  }

  return words;
}

/**
 * 単語群を、近いy座標同士でグルーピングして「行」にする。
 */
function groupWordsIntoRows(words) {
  const rows = [];

  for (const w of words) {
    let row = rows.find((r) => Math.abs(r.y - w.y) <= ROW_Y_TOLERANCE);
    if (!row) {
      row = { y: w.y, words: [] };
      rows.push(row);
    }
    row.words.push(w);
  }

  rows.sort((a, b) => b.y - a.y);
  return rows;
}

/**
 * 各行の単語トークンを「数値 / 非数値」に分類し、
 * 項目名・数量・単位・単価・金額に分解する。
 * (列のx座標を固定値でハードコードせず、トークンの並び順だけで判定する)
 */
function parseRows(rows) {
  const result = [];

  for (const row of rows) {
    const ws = row.words.slice().sort((a, b) => a.x0 - b.x0);
    const texts = ws.map((w) => w.text);

    const numIdx = [];
    texts.forEach((t, i) => {
      if (NUM_RE.test(t)) numIdx.push(i);
    });

    const itemTokens = numIdx.length === 0 ? texts : texts.slice(0, numIdx[0]);
    const itemText = itemTokens.join('');
    if (!itemText) continue;

    let qty = null;
    let unit = null;
    let unitPrice = null;
    let unitPriceDerived = false;
    let amount = null;

    if (numIdx.length > 0) {
      const nums = numIdx.map((i) => texts[i]);
      qty = nums[0];
      amount = nums[nums.length - 1];
      if (nums.length >= 3) {
        unitPrice = nums[nums.length - 2];
      } else if (nums.length === 2) {
        // 「数量」と「金額」の2つしか印字されておらず、単価が別の列として
        // 明記されていない見積書も多い。この場合も 単価 = 金額 ÷ 数量 で
        // 逆算できれば補完する(AIが単価チェックできる行を増やすため)。
        const qtyNum = parseLooseNumber(qty);
        const amountNum = parseLooseNumber(amount);
        if (qtyNum && amountNum && qtyNum !== 0) {
          const derived = amountNum / qtyNum;
          if (Number.isFinite(derived) && derived > 0) {
            unitPrice = String(Math.round(derived * 100) / 100);
            unitPriceDerived = true;
          }
        }
      }
      const firstNumIdx = numIdx[0];
      const nextIsAlsoNumeric = numIdx.length >= 2 && firstNumIdx + 1 === numIdx[1];
      if (firstNumIdx + 1 < texts.length && !nextIsAlsoNumeric) {
        unit = texts[firstNumIdx + 1];
      }
    }

    const rightmostX1 = ws.reduce((max, w) => Math.max(max, w.x1), 0);
    const yTop = ws.reduce((max, w) => Math.max(max, w.y + w.height), -Infinity);
    const yBottom = ws.reduce((min, w) => Math.min(min, w.y), Infinity);

    result.push({
      item: itemText,
      qty,
      unit,
      unitPrice,
      unitPriceDerived,
      amount,
      rightmostX1,
      yTop,
      yBottom,
      yCenter: (yTop + yBottom) / 2,
    });
  }

  return result;
}

module.exports = { extractStructuredPdf, NUM_RE, denormalizePoint };

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

    const words = extractWordsFromTextContent(textContent);
    const rows = groupWordsIntoRows(words);
    const parsedRows = parseRows(rows);

    pages.push({
      pageNumber: pageNum,
      width: viewport.width,
      height: viewport.height,
      rows: parsedRows,
    });

    page.cleanup();
  }

  return { pageCount: pdf.numPages, pages };
}

/**
 * pdfjsのtextContent.itemsから「単語」レベルの位置情報付きトークンを作る。
 * 1つのitemに複数の単語(スペース区切り)が含まれる場合は、
 * 文字数比率でx座標を按分して分割する(簡易的な近似)。
 */
function extractWordsFromTextContent(textContent) {
  const words = [];

  for (const item of textContent.items) {
    const raw = item.str;
    if (!raw || !raw.trim()) continue;

    const transform = item.transform; // [a, b, c, d, e, f]
    const x0 = transform[4];
    const y = transform[5]; // ベースラインy座標(PDF座標系、左下原点)
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
        text: tok,
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
    let amount = null;

    if (numIdx.length > 0) {
      const nums = numIdx.map((i) => texts[i]);
      qty = nums[0];
      amount = nums[nums.length - 1];
      if (nums.length >= 3) {
        unitPrice = nums[nums.length - 2];
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
      amount,
      rightmostX1,
      yTop,
      yBottom,
      yCenter: (yTop + yBottom) / 2,
    });
  }

  return result;
}

module.exports = { extractStructuredPdf, NUM_RE };

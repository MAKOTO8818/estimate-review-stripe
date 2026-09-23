/**
 * PDFのページ数・テキスト抽出ユーティリティ
 *
 * 前提: npm install pdf-parse
 */

const pdfParse = require('pdf-parse');

/**
 * PDFバッファからページ数とテキストを抽出する
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{ pageCount: number, text: string }>}
 */
async function extractPdfInfo(pdfBuffer) {
  const data = await pdfParse(pdfBuffer);
  return {
    pageCount: data.numpages,
    text: data.text,
  };
}

module.exports = { extractPdfInfo };

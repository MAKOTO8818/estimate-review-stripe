/**
 * PDF添削(注釈書き込み)モジュール
 *
 * AIチェック結果(findings)を、元のPDFの「該当箇所に直接」色付け・番号マーカーとして書き込み、
 * さらに末尾に「詳細一覧(凡例)ページ」を追加する。
 *
 * 前提:
 *   - npm install pdf-lib @pdf-lib/fontkit
 *   - 日本語埋め込みフォント(TrueType, 再配布可能なもの): fonts/ipag.ttf
 */

const fs = require('fs');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const SEVERITY_COLOR = {
  high: rgb(0.82, 0.11, 0.11),
  medium: rgb(0.87, 0.55, 0.1),
  low: rgb(0.14, 0.42, 0.82),
};
const SEVERITY_LABEL = {
  high: '重要',
  medium: '確認推奨',
  low: '参考',
};

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 42;
const LINE_HEIGHT = 15;

async function annotatePdf(originalPdfBuffer, structuredPages, findings, fontPath) {
  const pdfDoc = await PDFDocument.load(originalPdfBuffer);
  pdfDoc.registerFontkit(fontkit);

  const fontBytes = fs.readFileSync(fontPath);
  const jpFont = await pdfDoc.embedFont(fontBytes, { subset: true });

  const pagesByNumber = new Map(structuredPages.map((p) => [p.pageNumber, p]));

  const matched = [];
  const unmatchedFindings = [];
  let seq = 0;

  for (const finding of findings) {
    const pageData = pagesByNumber.get(finding.page);
    const row = pageData ? findMatchingRow(pageData.rows, finding.itemText) : null;

    if (!row) {
      unmatchedFindings.push(finding);
      continue;
    }

    seq += 1;
    matched.push({ ...finding, seq, row });
  }

  const pdfPages = pdfDoc.getPages();

  for (const m of matched) {
    const pageIndex = m.page - 1;
    if (pageIndex < 0 || pageIndex >= pdfPages.length) continue;

    const page = pdfPages[pageIndex];
    const { width } = page.getSize();
    const color = SEVERITY_COLOR[m.severity] || SEVERITY_COLOR.medium;

    const cx = Math.min(m.row.rightmostX1 + 16, width - 18);
    const cy = m.row.yCenter;

    page.drawCircle({
      x: cx,
      y: cy,
      size: 9,
      color: rgb(1, 1, 1),
      borderColor: color,
      borderWidth: 1.6,
      opacity: 0.9,
    });

    const label = String(m.seq);
    const labelWidth = jpFont.widthOfTextAtSize(label, 9);
    page.drawText(label, {
      x: cx - labelWidth / 2,
      y: cy - 3.2,
      size: 9,
      font: jpFont,
      color,
    });

    page.drawLine({
      start: { x: Math.max(m.row.rightmostX1 - 200, MARGIN), y: m.row.yBottom - 1 },
      end: { x: m.row.rightmostX1 + 2, y: m.row.yBottom - 1 },
      thickness: 0.8,
      color,
      opacity: 0.5,
    });
  }

  appendLegendPages(pdfDoc, jpFont, matched, unmatchedFindings);

  const outBytes = await pdfDoc.save();
  return { buffer: Buffer.from(outBytes), matchedCount: matched.length, unmatchedFindings };
}

function findMatchingRow(rows, itemText) {
  if (!itemText || !itemText.trim()) return null;

  const exact = rows.find((r) => r.item && r.item === itemText);
  if (exact) return exact;

  const partial = rows.find(
    (r) => r.item && r.item.trim() && (r.item.includes(itemText) || itemText.includes(r.item))
  );
  return partial || null;
}

function wrapText(font, text, maxWidth, size) {
  const lines = [];
  let current = '';
  for (const ch of String(text)) {
    const test = current + ch;
    if (font.widthOfTextAtSize(test, size) > maxWidth && current) {
      lines.push(current);
      current = ch;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function appendLegendPages(pdfDoc, jpFont, matched, unmatchedFindings) {
  let page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
  let y = A4_HEIGHT - MARGIN;

  const ensureSpace = (neededLines) => {
    if (y - neededLines * LINE_HEIGHT < MARGIN) {
      page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
      y = A4_HEIGHT - MARGIN;
      drawHeading();
    }
  };

  const drawHeading = () => {
    page.drawText('AI添削 詳細一覧', { x: MARGIN, y, size: 16, font: jpFont, color: rgb(0, 0, 0) });
    y -= 26;
  };

  drawHeading();

  if (matched.length === 0) {
    page.drawText('特筆すべき指摘事項はありませんでした。', {
      x: MARGIN,
      y,
      size: 11,
      font: jpFont,
      color: rgb(0.2, 0.2, 0.2),
    });
    y -= LINE_HEIGHT;
  }

  for (const m of matched) {
    const color = SEVERITY_COLOR[m.severity] || SEVERITY_COLOR.medium;
    const severityLabel = SEVERITY_LABEL[m.severity] || '確認推奨';

    const headerLines = wrapText(
      jpFont,
      `【${m.seq}】(${m.page}ページ目 / ${severityLabel}) ${m.itemText}`,
      A4_WIDTH - MARGIN * 2,
      11
    );
    const bodyRaw = [
      m.concern ? `指摘: ${m.concern}` : null,
      m.basis ? `根拠: ${m.basis}` : null,
      m.expertQuestion ? `施主への確認事項: ${m.expertQuestion}` : null,
    ].filter(Boolean);

    const bodyLines = bodyRaw.flatMap((l) => wrapText(jpFont, l, A4_WIDTH - MARGIN * 2 - 10, 10));

    ensureSpace(headerLines.length + bodyLines.length + 2);

    for (const hl of headerLines) {
      page.drawText(hl, { x: MARGIN, y, size: 11, font: jpFont, color });
      y -= LINE_HEIGHT;
    }
    for (const bl of bodyLines) {
      page.drawText(bl, { x: MARGIN + 12, y, size: 10, font: jpFont, color: rgb(0.25, 0.25, 0.25) });
      y -= LINE_HEIGHT;
    }
    y -= 8;
  }

  if (unmatchedFindings.length > 0) {
    ensureSpace(unmatchedFindings.length * 2 + 3);
    page.drawText('※以下は該当箇所の自動特定ができなかった指摘です(番号なし):', {
      x: MARGIN,
      y,
      size: 10,
      font: jpFont,
      color: rgb(0.4, 0.4, 0.4),
    });
    y -= LINE_HEIGHT;

    for (const f of unmatchedFindings) {
      const lines = wrapText(
        jpFont,
        `(${f.page}ページ) ${f.itemText || '(項目不明)'}: ${f.concern || ''}`,
        A4_WIDTH - MARGIN * 2,
        9
      );
      ensureSpace(lines.length + 1);
      for (const l of lines) {
        page.drawText(l, { x: MARGIN + 8, y, size: 9, font: jpFont, color: rgb(0.4, 0.4, 0.4) });
        y -= LINE_HEIGHT - 2;
      }
    }
  }
}

module.exports = { annotatePdf };

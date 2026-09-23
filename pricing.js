/**
 * 料金計算ロジック
 *
 * ルール(2026-09-21 決定事項):
 * - 初めての利用者(LINE初回登録): 1ページ目無料、2ページ目以降1ページ500円
 * - 2回目以降の利用者: 無料なし、全ページ1ページ500円
 *
 * JPYはStripeの「ゼロ・ディシマル通貨」なので、unit_amount はそのまま円の整数値。
 * (USDのようにセント換算(×100)する必要はない)
 */

const YEN_PER_PAGE = 500;

/**
 * @param {number} pageCount 見積書のページ数(1以上の整数)
 * @param {boolean} isFirstTimeUser 初めての利用者かどうか(LINEユーザーIDの利用履歴で判定)
 * @returns {{ amount: number, breakdown: string }} amount: 請求金額(円), breakdown: 内訳の説明文
 */
function calculatePrice(pageCount, isFirstTimeUser) {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error(`pageCount は1以上の整数である必要があります: ${pageCount}`);
  }

  if (isFirstTimeUser) {
    const billablePages = Math.max(pageCount - 1, 0);
    const amount = billablePages * YEN_PER_PAGE;
    const breakdown = `初回利用: ${pageCount}ページ中1ページ無料、残り${billablePages}ページ×${YEN_PER_PAGE}円 = ${amount}円`;
    return { amount, breakdown };
  }

  const amount = pageCount * YEN_PER_PAGE;
  const breakdown = `2回目以降の利用: ${pageCount}ページ×${YEN_PER_PAGE}円 = ${amount}円`;
  return { amount, breakdown };
}

module.exports = { calculatePrice, YEN_PER_PAGE };

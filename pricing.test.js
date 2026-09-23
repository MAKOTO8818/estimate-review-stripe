/**
 * 料金計算ロジックの動作確認スクリプト
 * 実行: node pricing.test.js
 */
const { calculatePrice } = require('./pricing');

const cases = [
  { pageCount: 1, isFirstTimeUser: true, expect: 0 },
  { pageCount: 3, isFirstTimeUser: true, expect: 1000 },
  { pageCount: 1, isFirstTimeUser: false, expect: 500 },
  { pageCount: 3, isFirstTimeUser: false, expect: 1500 },
];

let allPassed = true;

for (const c of cases) {
  const { amount, breakdown } = calculatePrice(c.pageCount, c.isFirstTimeUser);
  const passed = amount === c.expect;
  allPassed = allPassed && passed;
  console.log(
    `${passed ? '✅' : '❌'} pages=${c.pageCount} firstTime=${c.isFirstTimeUser} -> ${amount}円 (期待値: ${c.expect}円) | ${breakdown}`
  );
}

console.log(allPassed ? '\n全テスト成功' : '\n失敗したテストがあります');
process.exit(allPassed ? 0 : 1);

/**
 * scripts/faq-proposal.mjs の純粋関数の単体テスト（`node --test scripts/*.test.mjs`）。
 *
 * 契約はフォームの label（.github/ISSUE_TEMPLATE/faq-proposal.yml）。
 * ここで組み立てる本文は、GitHub が Issue Form から起票するときの形
 * （`### <label>` の見出し＋値・未入力は `_No response_`・checkboxes は `- [x] …`）に合わせてある。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIssueForm, targetDate, missingLanguages, buildComment } from "./faq-proposal.mjs";

/** GitHub が組む本文の形（見出し → 値）を再現する */
function issueBody(sections) {
  return sections.map(([heading, value]) => `### ${heading}\n\n${value}\n`).join("\n");
}

const FULL = [
  ["カード名", "Wuthering Heights (wuthering_heights)"],
  ["質問（英語）", "Can I move a minion onto Wuthering Heights?"],
  ["回答（英語）", "Yes, but it costs an extra step."],
  ["質問（日本語）", "嵐が丘にミニオンを移動できますか？"],
  ["回答（日本語）", "できますが、追加で1ステップかかります。"],
  ["根拠", "公式FAQ の該当箇所"],
  ["元となった議論・投稿の日付", "2026-09-01"],
  ["クレジット表記（任意）", "○○ Discord #rules-questions の議論を基に再構成"],
  ["特に見てほしい点", "「ステップ」の訳語が既訳と揃っているか"],
  ["確認", "- [x] 元の投稿を引用せず再構成した／投稿者の名前を出していない\n- [ ] 公式FAQ・Judge FAQ と矛盾しないことを確認した"],
];

test("フォームの見出しがすべて対応する鍵に入る", () => {
  const fields = parseIssueForm(issueBody(FULL));
  assert.equal(fields.card, "Wuthering Heights (wuthering_heights)");
  assert.equal(fields.qEn, "Can I move a minion onto Wuthering Heights?");
  assert.equal(fields.aEn, "Yes, but it costs an extra step.");
  assert.equal(fields.qJa, "嵐が丘にミニオンを移動できますか？");
  assert.equal(fields.aJa, "できますが、追加で1ステップかかります。");
  assert.equal(fields.basis, "公式FAQ の該当箇所");
  assert.equal(fields.date, "2026-09-01");
  assert.equal(fields.credit, "○○ Discord #rules-questions の議論を基に再構成");
  assert.equal(fields.focus, "「ステップ」の訳語が既訳と揃っているか");
  assert.deepEqual(fields.extra, {});
});

test("未入力（_No response_）は空文字になる", () => {
  const fields = parseIssueForm(issueBody([
    ["カード名", "Merlin"],
    ["質問（英語）", "_No response_"],
    ["回答（英語）", "_No response_"],
    ["クレジット表記（任意）", "_No response_"],
    ["元となった議論・投稿の日付", "_No response_"],
  ]));
  assert.equal(fields.card, "Merlin");
  assert.equal(fields.qEn, "");
  assert.equal(fields.aEn, "");
  assert.equal(fields.credit, "");
  assert.equal(fields.date, "");
});

test("複数行の値は改行と空行を保つ（前後の空行だけ落とす）", () => {
  const fields = parseIssueForm(issueBody([
    ["根拠", "1行目\n2行目\n\n段落を空けた3行目"],
    ["特に見てほしい点", "  前後に空白  "],
  ]));
  assert.equal(fields.basis, "1行目\n2行目\n\n段落を空けた3行目");
  assert.equal(fields.focus, "前後に空白");
});

test("コードフェンスの中の ### は見出しにしない", () => {
  const basis = [
    "公式の文面を引く:",
    "```",
    "### 質問（日本語）",
    "これは見出しではない",
    "```",
    "以上。",
  ].join("\n");
  const fields = parseIssueForm(issueBody([
    ["根拠", basis],
    ["質問（日本語）", "本物の見出しはこちら"],
  ]));
  assert.equal(fields.basis, basis);
  assert.equal(fields.qJa, "本物の見出しはこちら");
});

test("~~~ のフェンス・情報つきフェンスでも同じ", () => {
  const fields = parseIssueForm(issueBody([
    ["根拠", "~~~text\n### 回答（英語）\n~~~"],
    ["特に見てほしい点", "```md\n### カード名\n```"],
  ]));
  assert.equal(fields.aEn, "");
  assert.equal(fields.card, "");
  assert.match(fields.basis, /### 回答（英語）/);
  assert.match(fields.focus, /### カード名/);
});

test("checkboxes は { checked, label } の配列になる", () => {
  const fields = parseIssueForm(issueBody(FULL));
  assert.deepEqual(fields.confirm, [
    { checked: true, label: "元の投稿を引用せず再構成した／投稿者の名前を出していない" },
    { checked: false, label: "公式FAQ・Judge FAQ と矛盾しないことを確認した" },
  ]);
});

test("checkboxes が1つも無ければ空配列", () => {
  const fields = parseIssueForm(issueBody([["確認", "_No response_"]]));
  assert.deepEqual(fields.confirm, []);
});

test("知らない見出しは extra に残す（捨てない）", () => {
  const fields = parseIssueForm(issueBody([
    ["カード名", "Druid"],
    ["補足", "フォームに無い欄を足して起票された場合"],
  ]));
  assert.equal(fields.card, "Druid");
  assert.deepEqual(fields.extra, { 補足: "フォームに無い欄を足して起票された場合" });
});

test("空の本文・本文なしでも鍵は揃う", () => {
  for (const body of ["", null, undefined, "見出しの無いただの文章"]) {
    const fields = parseIssueForm(body);
    assert.equal(fields.card, "");
    assert.equal(fields.basis, "");
    assert.deepEqual(fields.confirm, []);
    assert.deepEqual(fields.extra, {});
  }
});

test("目処の日付は起票 + 7 日を JST で", () => {
  assert.equal(targetDate("2026-09-13T01:23:45Z"), "2026-09-20");
  assert.equal(targetDate("2026-09-13T00:00:00Z"), "2026-09-20");
});

test("目処の日付は UTC 15:00（JST 翌日 0:00）で1日ずれる", () => {
  assert.equal(targetDate("2026-09-13T14:59:59Z"), "2026-09-20");
  assert.equal(targetDate("2026-09-13T15:00:00Z"), "2026-09-21");
});

test("目処の日付は月・年をまたいでも正しい", () => {
  assert.equal(targetDate("2026-12-28T15:00:00Z"), "2027-01-05"); // JST 12-29 + 7日
  assert.equal(targetDate("2026-02-20T02:00:00Z"), "2026-02-27");
});

test("目処の日付はオフセット付きの表記でも同じ結果（実行環境のTZに依らない）", () => {
  // Date.parse と UTC の足し算だけで作るので、ローカル時刻の解釈は入らない
  assert.equal(targetDate("2026-09-13T15:00:00+09:00"), "2026-09-20"); // = 2026-09-13T06:00:00Z
  assert.equal(targetDate("2026-09-13T23:59:59+09:00"), "2026-09-20"); // = 2026-09-13T14:59:59Z（境界の手前）
  assert.equal(targetDate("2026-09-14T00:00:00+09:00"), "2026-09-21"); // = 2026-09-13T15:00:00Z（境界）
});

test("読めない起票日時は例外", () => {
  assert.throws(() => targetDate("きのう"), /日付として読めません/);
  assert.throws(() => targetDate(undefined), /日付として読めません/);
});

test("片言語の判定 — 揃っていない側のラベルを返す", () => {
  const en = { qEn: "Q", aEn: "A", qJa: "", aJa: "" };
  const ja = { qEn: "", aEn: "", qJa: "問", aJa: "答" };
  const both = { qEn: "Q", aEn: "A", qJa: "問", aJa: "答" };
  assert.deepEqual(missingLanguages(en), ["needs-ja"]);
  assert.deepEqual(missingLanguages(ja), ["needs-en"]);
  assert.deepEqual(missingLanguages(both), []);
  assert.deepEqual(missingLanguages({ qEn: "", aEn: "", qJa: "", aJa: "" }), ["needs-en", "needs-ja"]);
});

test("片言語の判定 — Q だけ・A だけ・空白だけは「揃っていない」", () => {
  assert.deepEqual(missingLanguages({ qEn: "Q", aEn: "", qJa: "問", aJa: "答" }), ["needs-en"]);
  assert.deepEqual(missingLanguages({ qEn: "Q", aEn: "A", qJa: "", aJa: "答" }), ["needs-ja"]);
  assert.deepEqual(missingLanguages({ qEn: "Q", aEn: "A", qJa: "問", aJa: "   \n " }), ["needs-ja"]);
  assert.deepEqual(missingLanguages({}), ["needs-en", "needs-ja"]);
});

test("起票された本文からそのまま片言語を判定できる", () => {
  const fields = parseIssueForm(issueBody([
    ["質問（英語）", "_No response_"],
    ["回答（英語）", "_No response_"],
    ["質問（日本語）", "嵐が丘にミニオンを移動できますか？"],
    ["回答（日本語）", "できますが、追加で1ステップかかります。"],
  ]));
  assert.deepEqual(missingLanguages(fields), ["needs-en"]);
  assert.deepEqual(missingLanguages(parseIssueForm(issueBody(FULL))), []);
});

test("案内には印・目処の日付が2箇所・👍 と 😕 が入り、👎 は使わない", () => {
  const comment = buildComment({ number: 42, targetDate: "2026-09-20", missing: [] });
  assert.match(comment, /^<!-- faq-proposal-notice -->/);
  assert.equal(comment.match(/2026-09-20/g).length, 2);
  assert.match(comment, /👍/);
  assert.match(comment, /😕/);
  assert.ok(!comment.includes("👎"), "👎 は使わない");
  assert.match(comment, /#42/);
});

test("案内は「締切ではない」と非公式であることを言う", () => {
  const comment = buildComment({ number: 1, targetDate: "2026-09-20" });
  assert.match(comment, /締切ではありません/);
  assert.match(comment, /それ以降のご意見も歓迎/);
  assert.match(comment, /収録後でも直します/);
  assert.match(comment, /非公式/);
  assert.match(comment, /公式裁定・英語原文が優先/);
});

test("案内はレビューの観点 3 つを挙げる", () => {
  const comment = buildComment({ number: 1, targetDate: "2026-09-20" });
  assert.match(comment, /1\. 裁定:/);
  assert.match(comment, /2\. 文面:/);
  assert.match(comment, /3\. 和訳:/);
  assert.match(comment, /どれか一つだけでも/);
});

test("片言語のときだけ、付けたラベルの意味を添える", () => {
  const none = buildComment({ number: 7, targetDate: "2026-09-20", missing: [] });
  assert.ok(!none.includes("needs-en"), "揃っているときはラベルの話をしない");
  assert.ok(!none.includes("needs-ja"));

  const en = buildComment({ number: 7, targetDate: "2026-09-20", missing: ["needs-en"] });
  assert.match(en, /英語の質問・回答が揃っていない/);
  assert.match(en, /`needs-en`/);
  assert.ok(!en.includes("needs-ja"));

  const both = buildComment({ number: 7, targetDate: "2026-09-20", missing: ["needs-en", "needs-ja"] });
  assert.match(both, /英語・日本語の質問・回答が揃っていない/);
  assert.match(both, /`needs-en` `needs-ja`/);
});

/**
 * 独立検証で足した否定テスト（scripts/faq-proposal.test.mjs は編集していない）。
 *
 * 見張るのは「起きてはいけないこと」:
 *   1. GITHUB_TOKEN が無いときに GitHub へ一切出ていかないこと（＝手元の確認で書き込まない）
 *   2. 印（<!-- faq-proposal-notice -->）が必ず本文の先頭にあり、二重投稿の見張りが効くこと
 *   3. ラベルが無い Issue・issue を含まないイベントで何もしないこと
 *   4. 本文の分解が崩れても、片言語の判定や他の欄を巻き添えにしないこと
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseIssueForm, targetDate, missingLanguages, buildComment, headingKey } from "./faq-proposal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "faq-proposal.mjs");
const NOTICE_MARK = "<!-- faq-proposal-notice -->";

/* ---- 1. トークン無しでは GitHub へ出ていかない ----
   fetch を「呼ばれたら落ちる」に差し替えた状態で本体を走らせ、正常終了することで確かめる
   （--import は入口のモジュールより先に走るので、本体の読み込み時点で罠が仕掛かっている） */

function runScript({ event, env = {} }) {
  const dir = mkdtempSync(path.join(tmpdir(), "faq-proposal-"));
  try {
    const eventPath = path.join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify(event));
    const guard = path.join(dir, "no-network.mjs");
    writeFileSync(guard, `globalThis.fetch = () => { console.error("NETWORK-CALLED"); process.exit(9); };\n`);
    const result = { code: 0, out: "" };
    try {
      result.out = execFileSync(process.execPath, ["--import", `file://${guard}`, SCRIPT], {
        env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: "issues", GITHUB_EVENT_PATH: eventPath, ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      result.code = e.status ?? 1;
      result.out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    assert.ok(!result.out.includes("NETWORK-CALLED"), `GitHub へ出ていった:\n${result.out}`);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const issueEvent = (over = {}) => ({
  action: "opened",
  issue: {
    number: 42,
    created_at: "2026-09-13T01:23:45Z",
    labels: [{ name: "faq-proposal" }, { name: "needs-review" }],
    body: "### カード名\n\nMerlin\n\n### 質問（英語）\n\nQ\n\n### 回答（英語）\n\nA\n",
    ...over,
  },
});

test("GITHUB_TOKEN が無ければ GitHub へ出ていかず、案内とラベルを表示して正常終了する", () => {
  const r = runScript({ event: issueEvent() });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /GITHUB_TOKEN 未設定/);
  assert.match(r.out, /2026-09-20/, "目処（起票+7日・JST）が出る");
  assert.match(r.out, /needs-ja/, "日本語が無いので needs-ja を挙げる");
  assert.ok(!r.out.includes("needs-en"), "英語は揃っているので needs-en は挙げない");
});

test("ラベル faq-proposal が無ければ何もしない（本文を読みにも行かない）", () => {
  const r = runScript({ event: issueEvent({ labels: [{ name: "translation" }] }) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ラベル faq-proposal が無いため何もしない/);
});

test("labeled で付いたラベルが faq-proposal なら動く（本文のラベル一覧に無くても）", () => {
  const event = { ...issueEvent({ labels: [] }), action: "labeled", label: { name: "faq-proposal" } };
  const r = runScript({ event });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /GITHUB_TOKEN 未設定/);
});

test("issue を含まないイベントは黙って終わる", () => {
  const r = runScript({ event: { action: "opened" } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /issue を含まないイベント/);
});

test("イベントの場所が未設定・壊れたJSONなら異常終了（黙って成功しない）", () => {
  const r = runScript({ event: issueEvent(), env: { GITHUB_EVENT_PATH: "" } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /GITHUB_EVENT_PATH が未設定/);
});

test("起票日時が読めなければ異常終了（目処の日付を捏造しない）", () => {
  const r = runScript({ event: issueEvent({ created_at: "きのう" }) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /日付として読めません|収録案の案内に失敗/);
});

/* ---- 2. 二重投稿の見張り（印） ---- */

test("印は本文の先頭にあり、1 度だけ出る（includes で見つけられる形）", () => {
  const comment = buildComment({ number: 7, targetDate: "2026-09-20", missing: ["needs-ja"] });
  assert.ok(comment.startsWith(NOTICE_MARK), "先頭に無いと引用時に崩れる");
  assert.equal(comment.split(NOTICE_MARK).length - 1, 1);
  assert.ok(comment.includes(NOTICE_MARK));
});

test("案内は引数が欠けても落ちない（番号・日付が無くても文になる）", () => {
  for (const args of [undefined, {}, { number: 1 }, { targetDate: "2026-09-20" }]) {
    const comment = buildComment(args);
    assert.ok(comment.startsWith(NOTICE_MARK));
    assert.match(comment, /レビューのお願い/);
  }
});

test("片言語の一文はラベルを付けたときだけ添える", () => {
  assert.ok(!buildComment({ number: 1, targetDate: "2026-09-20", missing: [] }).includes("needs-"));
  const ja = buildComment({ number: 1, targetDate: "2026-09-20", missing: ["needs-ja"] });
  assert.match(ja, /日本語の質問・回答が揃っていない/);
  assert.match(ja, /`needs-ja`/);
  const both = buildComment({ number: 1, targetDate: "2026-09-20", missing: ["needs-en", "needs-ja"] });
  assert.match(both, /英語・日本語/);
});

test("案内は締切と読める語や 👎 を使わない", () => {
  const comment = buildComment({ number: 1, targetDate: "2026-09-20", missing: ["needs-en"] });
  for (const word of ["👎", "締切です", "期限", "却下", "承認が必要"]) {
    assert.ok(!comment.includes(word), `「${word}」は使わない: ${comment}`);
  }
});

test("英語の段落も締切と読める書き方をしない（日本語と同じ事実に留める）", () => {
  const en = buildComment({ number: 1, targetDate: "2026-09-20", missing: ["needs-en"] }).split("\n---\n")[1];
  assert.match(en, /not a deadline/, "「締切ではない」は英語でも必ず言う");
  for (const phrase of ["by the deadline", "will be rejected", "you must", "approval is required", "closes on"]) {
    assert.ok(!en.toLowerCase().includes(phrase), `英語で「${phrase}」とは言わない: ${en}`);
  }
});

test("英語の段落は日本語の後ろ（印と日本語の定型文を押しのけない）", () => {
  const comment = buildComment({ number: 1, targetDate: "2026-09-20" });
  assert.ok(comment.startsWith(NOTICE_MARK));
  assert.ok(comment.indexOf("レビューのお願い") < comment.indexOf("English"), "日本語が先");
  assert.equal(comment.split("\n---\n").length, 2, "日英の区切りは1つだけ");
});

/* ---- 見出しの照合（日英併記の label ⇔ 旧見出し） ---- */

test("併記の見出しでも旧見出しでも同じ結果（値が別の欄へ移らない）", () => {
  const now = parseIssueForm("### 根拠 / Basis\n\n値\n\n### 確認 / Confirmation\n\n- [x] 済");
  const old = parseIssueForm("### 根拠\n\n値\n\n### 確認\n\n- [x] 済");
  assert.deepEqual(now, old);
  assert.equal(now.basis, "値");
  assert.deepEqual(now.confirm, [{ checked: true, label: "済" }]);
});

test("` / ` が日本語側に無い見出し（`/` だけ・全角の／）は欄に入れず extra に残す", () => {
  for (const heading of ["根拠/Basis", "根拠 ／ Basis", "根拠／Basis", "根拠　/　Basis"]) {
    const fields = parseIssueForm(`### ${heading}\n\n値`);
    assert.equal(fields.basis, "", `「${heading}」を根拠として読んではいけない`);
    assert.deepEqual(fields.extra, { [heading]: "値" }, `「${heading}」の値は extra に残る`);
  }
});

test("英語側だけの見出し（日本語が無い）は欄に入らない", () => {
  const fields = parseIssueForm("### Basis / 根拠\n\n値");
  assert.equal(fields.basis, "", "照合するのは ` / ` の前だけ — 後ろに日本語があっても拾わない");
  assert.deepEqual(fields.extra, { "Basis / 根拠": "値" });
});

test("headingKey は文字列以外・空でも落ちない", () => {
  assert.equal(headingKey(undefined), "");
  assert.equal(headingKey(null), "");
  assert.equal(headingKey(0), "0");
  assert.equal(headingKey(" / Card"), "/ Card", "先に前後の空白を落とすので ` / ` は残らない（対応表に無い＝extra 行き）");
  assert.equal(headingKey("カード名 / Card / 別名"), "カード名", "最初の ` / ` で切る");
});

/* ---- 3. 目処の日付の境界 ---- */

test("JST の境界（UTC 14:59:59 / 15:00:00）で 1 日動く", () => {
  assert.equal(targetDate("2026-09-13T14:59:59Z"), "2026-09-20");
  assert.equal(targetDate("2026-09-13T15:00:00Z"), "2026-09-21");
  assert.equal(targetDate("2026-09-13T15:00:00.001Z"), "2026-09-21");
});

test("年またぎ・うるう年でもずれない", () => {
  assert.equal(targetDate("2026-12-31T15:00:00Z"), "2027-01-08"); // JST 2027-01-01 + 7
  assert.equal(targetDate("2028-02-25T00:00:00Z"), "2028-03-03");
  assert.equal(targetDate("2027-02-25T00:00:00Z"), "2027-03-04");
});

test("読めない起票日時は必ず例外（空文字や Invalid Date を返さない）", () => {
  for (const bad of ["", null, undefined, "きのう", "2026-13-45", {}, []]) {
    assert.throws(() => targetDate(bad), /日付として読めません/, JSON.stringify(bad));
  }
});

/* ---- 4. 本文の分解の境界 ---- */

test("同じ見出しが2度あれば後勝ち（値が混ざらない）", () => {
  const fields = parseIssueForm("### 根拠\n\n1つ目\n\n### 根拠\n\n2つ目");
  assert.equal(fields.basis, "2つ目");
});

test("値が無い見出し・見出しが連続しても空文字になる", () => {
  const fields = parseIssueForm("### 質問（英語）\n### 回答（英語）\n\nA");
  assert.equal(fields.qEn, "");
  assert.equal(fields.aEn, "A");
});

test("_No response_ に語が足されていれば値として残す", () => {
  assert.equal(parseIssueForm("### 根拠\n\n_No response_").basis, "");
  assert.equal(parseIssueForm("### 根拠\n\n_No response_ です").basis, "_No response_ です");
});

test("### の直後に空白が無い行・#### は見出しにしない", () => {
  assert.equal(parseIssueForm("###根拠\n\n値").basis, "");
  assert.equal(parseIssueForm("### 根拠\n\n#### 小見出し\n本文").basis, "#### 小見出し\n本文");
});

test("閉じないコードフェンスは末尾まで値（後続の見出しを拾わない）", () => {
  const fields = parseIssueForm("### 根拠\n\n```\n### 質問（英語）\nずっと中");
  assert.equal(fields.qEn, "");
  assert.match(fields.basis, /### 質問（英語）/);
});

test("チェックは大文字 X・* 印・字下げでも読め、形の違うものは拾わない", () => {
  const fields = parseIssueForm("### 確認\n\n- [X] 大文字\n* [x] アスタリスク\n  - [ ] 字下げ\n- [y] 不正\n- [] 括弧が空");
  assert.deepEqual(fields.confirm, [
    { checked: true, label: "大文字" },
    { checked: true, label: "アスタリスク" },
    { checked: false, label: "字下げ" },
  ]);
});

test("本文が文字列でなくても落ちない", () => {
  for (const body of [0, false, {}, [], 12345]) {
    const fields = parseIssueForm(body);
    assert.equal(typeof fields.card, "string");
    assert.deepEqual(fields.confirm, []);
  }
});

test("CRLF・巨大な本文でも欄が混ざらない", () => {
  assert.equal(parseIssueForm("### 根拠\r\n\r\n1行目\r\n2行目\r\n").basis, "1行目\n2行目");
  const big = "あ".repeat(200000);
  const fields = parseIssueForm(`### 根拠\n\n${big}\n\n### 特に見てほしい点\n\n末尾`);
  assert.equal(fields.basis.length, big.length);
  assert.equal(fields.focus, "末尾");
});

test("片言語の判定は文字列以外の値でも「揃っていない」に倒す", () => {
  assert.deepEqual(missingLanguages(null), ["needs-en", "needs-ja"]);
  assert.deepEqual(missingLanguages(undefined), ["needs-en", "needs-ja"]);
  assert.deepEqual(missingLanguages({ qEn: 1, aEn: 2, qJa: [], aJa: {} }), ["needs-en", "needs-ja"]);
});

test("コードフェンスで Q/A の節が飲まれても、片言語の判定は「無い」に倒れる（勝手に揃っていることにしない）", () => {
  const body = "### 質問（英語）\n\n```\n### 回答（英語）\nA\n\n### 質問（日本語）\n問\n";
  const fields = parseIssueForm(body);
  assert.deepEqual(missingLanguages(fields), ["needs-en", "needs-ja"]);
});

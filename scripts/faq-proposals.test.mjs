/**
 * scripts/faq-proposals.mjs の単体テスト（`node --test scripts/*.test.mjs`）。
 *
 * 見張るのは配信データの契約（サイト側 sorcerers-den が読む形）:
 *   { generated, items: [{ n, url, slug, created, due }] } — 題名・本文・投稿者名は入れない
 * と、「中身が同じなら書かない」（cron のたびに generated だけのコミットを積まない）こと。
 * GitHub とのやりとりは fetch を差し替えた子プロセスで確かめる（本物の API は叩かない）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { jstDay, dueDay, slugOfCard, buildFeed, sameFeed, normalizeName } from "./faq-proposals.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "faq-proposals.mjs");
const SLUGS = JSON.parse(readFileSync(path.join(HERE, "..", "data", "slugs.json"), "utf8"));

/** GitHub の Issue 一覧の応答を1件ぶん作る */
const issue = (over = {}) => ({
  number: 16,
  html_url: "https://github.com/delverdaze/sorcerers-knowledge/issues/16",
  title: "[FAQ案] Wuthering Heights（試験起票・動作確認）",
  user: { login: "delverdaze" },
  state: "open",
  created_at: "2026-09-14T02:58:49Z",
  labels: [{ name: "faq-proposal" }, { name: "needs-review" }],
  body: "### カード名 / Card\n\nWuthering Heights (wuthering_heights)\n\n### 根拠 / Basis\n\n出典\n",
  ...over,
});

/* ---- 日付（JST・目処） ---- */

test("起票日は JST の暦日（UTC 15:00 で日が変わる）", () => {
  assert.equal(jstDay("2026-09-13T01:23:45Z"), "2026-09-13");
  assert.equal(jstDay("2026-09-13T14:59:59Z"), "2026-09-13");
  assert.equal(jstDay("2026-09-13T15:00:00Z"), "2026-09-14");
  assert.equal(jstDay("2026-09-13T23:59:59+09:00"), "2026-09-13");
});

test("読めない日時は空文字（日付を捏造しない）", () => {
  for (const bad of ["", null, undefined, "きのう", "2026-13-45", {}]) {
    assert.equal(jstDay(bad), "", JSON.stringify(bad));
    assert.equal(dueDay(bad), "", JSON.stringify(bad));
  }
});

test("目処は起票 +7 日（案内コメントの日付と同じ計算）", () => {
  assert.equal(dueDay("2026-09-14T02:58:49Z"), "2026-09-21");
  assert.equal(dueDay("2026-09-13T15:00:00Z"), "2026-09-21");
  assert.equal(dueDay("2026-12-28T15:00:00Z"), "2027-01-05");
});

/* ---- カード名欄からの slug ---- */

test("`Name (slug)` の slug が実在すれば、それを使う（英語名より優先）", () => {
  assert.equal(slugOfCard("Wuthering Heights (wuthering_heights)", SLUGS), "wuthering_heights");
  assert.equal(slugOfCard("嵐が丘 (wuthering_heights)", SLUGS), "wuthering_heights");
  assert.equal(slugOfCard("（merlin）", SLUGS), "merlin", "全角の括弧でも拾う");
  assert.equal(slugOfCard("(2026-09-01) Merlin (merlin)", SLUGS), "merlin", "実在するものだけを選ぶ");
  assert.equal(slugOfCard("Merlin (wuthering_heights)", SLUGS), "wuthering_heights", "括弧の slug が英語名に優先する");
});

test("括弧が無ければ英語名で引く（フォームの見本どおりに書かれた収録案）", () => {
  assert.equal(slugOfCard("Wuthering Heights", SLUGS), "wuthering_heights");
  assert.equal(slugOfCard("Wuthering Heights / 嵐が丘", SLUGS), "wuthering_heights", "「英語名 / 和名」の書き方");
  assert.equal(slugOfCard("嵐が丘 / Wuthering Heights", SLUGS), "wuthering_heights", "順番が逆でも");
  assert.equal(slugOfCard("Wuthering Heights ／ 嵐が丘", SLUGS), "wuthering_heights", "全角のスラッシュでも");
  assert.equal(slugOfCard("Wuthering Heights/嵐が丘", SLUGS), "wuthering_heights", "空白の無いスラッシュでも");
  assert.equal(slugOfCard("  Wuthering Heights  ", SLUGS), "wuthering_heights", "前後の空白は関係ない");
});

test("英語名の照合は大文字小文字・アポストロフィ・分音記号の揺れを吸収する", () => {
  assert.equal(slugOfCard("a midsummer nights dream", SLUGS), "a_midsummer_nights_dream");
  assert.equal(slugOfCard("A Midsummer Night’s Dream", SLUGS), "a_midsummer_nights_dream", "曲がったアポストロフィ");
  assert.equal(slugOfCard("BABA YAGA'S HUT", SLUGS), "baba_yagas_hut");
  assert.equal(slugOfCard("Brocéliande", SLUGS), "broceliande");
  assert.equal(slugOfCard("Broceliande", SLUGS), "broceliande", "分音記号が無くても同じ札");
  assert.equal(slugOfCard("Älvalinne Dryads / アルヴァリンネのドライアド", SLUGS), "alvalinne_dryads");
  assert.equal(slugOfCard("Ｍｅｒｌｉｎ", SLUGS), "merlin", "全角で書かれても（NFKD）");
});

test("決められないときは null（和名だけ・当たらない・複数に当たる）", () => {
  assert.equal(slugOfCard("嵐が丘", SLUGS), null, "和名だけでは引かない");
  assert.equal(slugOfCard("マーリン / 嵐が丘", SLUGS), null);
  assert.equal(slugOfCard("Not A Real Card", SLUGS), null, "当たらなければ null");
  assert.equal(slugOfCard("Wuthering Heights (wuthering heights)", SLUGS), null, "括弧の綴りが実在せず、全体としても札名にならない");
  assert.equal(slugOfCard("Merlin / Wuthering Heights", SLUGS), null, "2枚に当たったら選ばない");
  assert.equal(slugOfCard("Wuthering Heights と Merlin の話", SLUGS), null, "札名が並んだ文からは引かない");
  assert.equal(slugOfCard("Merlin (not_a_real_card)", SLUGS), null, "実在しない括弧付きは当て推量しない");
  assert.equal(slugOfCard("Merlin's", SLUGS), null, "部分一致では引かない（ならした文字列の完全一致だけ）");
  assert.equal(slugOfCard("Wuthering", SLUGS), null);
});

test("和文の飾りは照合の邪魔をしない（ならすと英数字だけが残るため）", () => {
  // 正規化（Den の normalizeName と同じ）が日本語を落とすので、英数字の並びが札名と
  // ちょうど一致すれば引ける。別の札に化けることはない（一致は完全一致だけ）
  assert.equal(slugOfCard("Wuthering Heights（嵐が丘）", SLUGS), "wuthering_heights");
  assert.equal(slugOfCard("Wuthering Heights の境界", SLUGS), "wuthering_heights");
});

test("ならし方は Den の normalizeName と同じ規則", () => {
  assert.equal(normalizeName("A Midsummer Night's Dream"), "amidsummernightsdream");
  assert.equal(normalizeName("Brocéliande"), "broceliande");
  assert.equal(normalizeName("Älvalinne Dryads"), "alvalinnedryads");
  assert.equal(normalizeName("嵐が丘"), "", "日本語だけなら空 ＝ 照合の相手にならない");
  assert.equal(normalizeName(null), "");
  assert.equal(normalizeName(12), "12");
});

test("slug は実在で判定する（JS の既定のプロパティを拾わない）", () => {
  for (const bad of ["(constructor)", "(toString)", "(__proto__)", "(hasOwnProperty)"]) {
    assert.equal(slugOfCard(bad, SLUGS), null, bad);
  }
});

test("カード名が無い・文字列でなくても落ちない", () => {
  for (const bad of ["", null, undefined, 0, {}, []]) {
    assert.equal(slugOfCard(bad, SLUGS), null, JSON.stringify(bad));
  }
  assert.equal(slugOfCard("Merlin (merlin)", null), null, "slugs が無ければ null");
});

/* ---- 配信データの組み立て ---- */

test("1件の形 — 鍵は n / url / slug / created / due だけ", () => {
  const feed = buildFeed([issue()], SLUGS, { generated: "2026-09-14T06:00:00Z" });
  assert.deepEqual(feed, {
    generated: "2026-09-14T06:00:00Z",
    items: [{
      n: 16,
      url: "https://github.com/delverdaze/sorcerers-knowledge/issues/16",
      slug: "wuthering_heights",
      created: "2026-09-14",
      due: "2026-09-21",
    }],
  });
});

test("題名・本文・投稿者名は入れない（モデレーション前のテキストをサイトに載せない）", () => {
  const text = JSON.stringify(buildFeed([issue({
    title: "[FAQ案] 荒らしの題名",
    user: { login: "someone_else" },
    body: "### カード名 / Card\n\n荒らしの文章",
  })], SLUGS));
  for (const leak of ["FAQ案", "someone_else", "荒らし", "needs-review", "title", "body", "user"]) {
    assert.ok(!text.includes(leak), `${leak} が配信データに混ざった: ${text}`);
  }
});

test("旧見出し（日本語だけ）の本文でも slug を読める", () => {
  const feed = buildFeed([issue({ body: "### カード名\n\nWuthering Heights (wuthering_heights)\n" })], SLUGS);
  assert.equal(feed.items[0].slug, "wuthering_heights");
});

test("括弧の slug が無くても、英語名で書かれていれば引ける", () => {
  const feed = buildFeed([issue({ body: "### カード名 / Card\n\nWuthering Heights / 嵐が丘\n" })], SLUGS);
  assert.equal(feed.items[0].slug, "wuthering_heights");
});

test("カード名から slug が決められなければ null（札の名前はサイト側が引く）", () => {
  const feed = buildFeed([issue({ body: "### カード名 / Card\n\n嵐が丘\n" })], SLUGS);
  assert.equal(feed.items[0].slug, null);
  assert.ok("slug" in feed.items[0], "鍵は必ず置く");
});

test("pull request は除く（Issues API は PR も返す）", () => {
  const feed = buildFeed([
    issue({ number: 20, pull_request: { url: "https://api.github.com/…/pulls/20" } }),
    issue({ number: 16 }),
  ], SLUGS);
  assert.deepEqual(feed.items.map((i) => i.n), [16]);
});

test("新しい順に並ぶ（同じ日なら番号の大きい方が先）", () => {
  const feed = buildFeed([
    issue({ number: 10, created_at: "2026-09-01T00:00:00Z" }),
    issue({ number: 30, created_at: "2026-09-14T00:00:00Z" }),
    issue({ number: 31, created_at: "2026-09-14T05:00:00Z" }),
    issue({ number: 20, created_at: "2026-09-10T00:00:00Z" }),
  ], SLUGS);
  assert.deepEqual(feed.items.map((i) => i.n), [31, 30, 20, 10]);
});

test("100件を超えたら新しい方から100件", () => {
  const many = Array.from({ length: 120 }, (_, i) =>
    issue({ number: i + 1, created_at: `2026-${String((i % 12) + 1).padStart(2, "0")}-01T00:00:00Z` }));
  const feed = buildFeed(many, SLUGS);
  assert.equal(feed.items.length, 100);
  assert.equal(feed.items[0].created, "2026-12-01");
});

test("日付が読めない件は落とす（目処を捏造しない）", () => {
  const feed = buildFeed([issue({ number: 9, created_at: "きのう" }), issue({ number: 16 })], SLUGS);
  assert.deepEqual(feed.items.map((i) => i.n), [16]);
});

test("壊れた応答でも形は崩れない", () => {
  for (const bad of [null, undefined, {}, "", 0]) {
    const feed = buildFeed(bad, SLUGS);
    assert.deepEqual(feed.items, [], JSON.stringify(bad));
    assert.match(feed.generated, /^\d{4}-\d{2}-\d{2}T/);
  }
  const feed = buildFeed([null, {}, { number: "x", created_at: "2026-09-14T00:00:00Z" }, { number: 0 }], SLUGS);
  assert.deepEqual(feed.items, []);
});

test("html_url が無ければ番号から組む（リンク先を捏造しない範囲で補う）", () => {
  const feed = buildFeed([issue({ html_url: undefined })], SLUGS, { repo: "delverdaze/sorcerers-knowledge" });
  assert.equal(feed.items[0].url, "https://github.com/delverdaze/sorcerers-knowledge/issues/16");
  const evil = buildFeed([issue({ html_url: "javascript:alert(1)" })], SLUGS);
  assert.match(evil.items[0].url, /^https:\/\/github\.com\//, "https 以外の URL は使わない");
});

/* ---- 同じなら書かない ---- */

test("generated が違っても items が同じなら「同じ」", () => {
  const a = buildFeed([issue()], SLUGS, { generated: "2026-09-14T06:00:00Z" });
  const b = buildFeed([issue()], SLUGS, { generated: "2026-09-15T06:00:00Z" });
  assert.ok(sameFeed(a, b));
});

test("1件でも違えば「違う」・前が無ければ「違う」", () => {
  const a = buildFeed([issue()], SLUGS);
  assert.ok(!sameFeed(a, buildFeed([issue({ number: 17 })], SLUGS)));
  assert.ok(!sameFeed(a, buildFeed([], SLUGS)));
  assert.ok(!sameFeed(null, a));
  assert.ok(!sameFeed({}, a));
  assert.ok(!sameFeed(a, buildFeed([issue({ body: "### カード名 / Card\n\nMerlin (merlin)" })], SLUGS)), "slug だけの違いも見る");
});

/* ---- 本体（fetch を差し替えた子プロセス） ---- */

function run({ env = {}, out, issues = [issue()], status = 200 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "faq-proposals-"));
  try {
    const stub = path.join(dir, "stub-fetch.mjs");
    writeFileSync(stub, `globalThis.fetch = async (url) => {
      console.log("FETCH " + url);
      return new Response(${JSON.stringify(JSON.stringify(issues))}, { status: ${status}, headers: { "content-type": "application/json" } });
    };\n`);
    const result = { code: 0, out: "" };
    try {
      result.out = execFileSync(process.execPath, ["--import", `file://${stub}`, SCRIPT, ...(out ? [out] : [])], {
        env: { PATH: process.env.PATH, GITHUB_TOKEN: "tok_TEST", ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      result.code = e.status ?? 1;
      result.out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withOut(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "faq-proposals-out-"));
  try {
    return fn(path.join(dir, "faq-proposals.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("収録案を取って契約どおりの JSON を書く（叩くのは open + faq-proposal の一覧だけ）", () => {
  withOut((out) => {
    const r = run({ out });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /FETCH https:\/\/api\.github\.com\/repos\/delverdaze\/sorcerers-knowledge\/issues\?labels=faq-proposal&state=open&per_page=100\n/);
    assert.equal(r.out.match(/FETCH /g).length, 1, "叩くのは1回だけ");
    const feed = JSON.parse(readFileSync(out, "utf8"));
    assert.match(feed.generated, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.deepEqual(feed.items, [{
      n: 16,
      url: "https://github.com/delverdaze/sorcerers-knowledge/issues/16",
      slug: "wuthering_heights",
      created: "2026-09-14",
      due: "2026-09-21",
    }]);
    assert.ok(readFileSync(out, "utf8").endsWith("\n"), "末尾は改行（差分が汚れないように）");
  });
});

test("中身が同じなら書かない（generated だけのコミットを積まない）", () => {
  withOut((out) => {
    assert.equal(run({ out }).code, 0);
    const first = readFileSync(out, "utf8");
    const again = run({ out });
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /変更なし/);
    assert.equal(readFileSync(out, "utf8"), first, "generated も書き換えない");

    const changed = run({ out, issues: [issue(), issue({ number: 17, created_at: "2026-09-15T00:00:00Z" })] });
    assert.equal(changed.code, 0, changed.out);
    assert.equal(JSON.parse(readFileSync(out, "utf8")).items.length, 2);
  });
});

test("収録案が1件も無ければ空の一覧を書く（前の一覧を残さない）", () => {
  withOut((out) => {
    run({ out });
    const r = run({ out, issues: [] });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).items, []);
  });
});

test("GITHUB_TOKEN が無ければ「必要」と言って異常終了し、GitHub へは行かない", () => {
  withOut((out) => {
    const r = run({ out, env: { GITHUB_TOKEN: "" } });
    assert.equal(r.code, 1);
    assert.match(r.out, /GITHUB_TOKEN が必要です/);
    assert.ok(!r.out.includes("FETCH "), "トークン無しで外へ出てはいけない");
    assert.ok(!existsSync(out), "書き出しもしない");
  });
});

test("GitHub が失敗を返したら異常終了（古い一覧を空で上書きしない）", () => {
  withOut((out) => {
    run({ out });
    const before = readFileSync(out, "utf8");
    const r = run({ out, status: 500, issues: { message: "Server Error" } });
    assert.equal(r.code, 1);
    assert.match(r.out, /GitHub API失敗|集計に失敗/);
    assert.equal(readFileSync(out, "utf8"), before, "前の一覧はそのまま");
  });
});

test("一覧でない応答（オブジェクト）も失敗として止まる", () => {
  withOut((out) => {
    const r = run({ out, issues: { message: "Not Found" } });
    assert.equal(r.code, 1);
    assert.match(r.out, /一覧ではありません|集計に失敗/);
    assert.ok(!existsSync(out));
  });
});

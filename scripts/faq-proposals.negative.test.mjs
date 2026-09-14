/**
 * 独立検証で足した否定テスト（scripts/faq-proposals.test.mjs は編集していない）。
 *
 * 見張るのは「通る道」ではなく「通ってはいけない道」。この配信データはサイト（sorcerers-den）の
 * 手引きとカード頁にそのまま並ぶので、ここを抜けたものが読者の目に触れる:
 *   1. pull request が Issue に紛れない
 *   2. 閉じた Issue・別ラベルの Issue が混ざらない（絞りは問い合わせ側にある — その URL を固定する）
 *   3. 日時が読めないものに目処を捏造しない・実行環境のタイムゾーンで日付がずれない
 *   4. 巨大な・敵性の本文が 1 文字も配信データに漏れない（モデレーション前のテキストを載せない規約）
 *   5. `(slug)` の偽物・複数一致で別の札に化けない
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFeed, jstDay, dueDay, slugOfCard } from "./faq-proposals.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "faq-proposals.mjs");
const SLUGS = JSON.parse(readFileSync(path.join(HERE, "..", "data", "slugs.json"), "utf8"));

const issue = (over = {}) => ({
  number: 16,
  html_url: "https://github.com/delverdaze/sorcerers-knowledge/issues/16",
  title: "[FAQ案] Wuthering Heights",
  user: { login: "delverdaze" },
  state: "open",
  created_at: "2026-09-14T02:58:49Z",
  labels: [{ name: "faq-proposal" }, { name: "needs-review" }],
  body: "### カード名 / Card\n\nWuthering Heights (wuthering_heights)\n",
  ...over,
});

/* ---- 1. pull request の混入 ---- */

test("pull_request が付いていれば、中身が Issue そっくりでも除く", () => {
  for (const pr of [{ url: "https://api.github.com/…/pulls/20" }, {}, { html_url: "x" }, "yes", 1, []]) {
    const feed = buildFeed([issue({ number: 20, pull_request: pr }), issue({ number: 16 })], SLUGS);
    assert.deepEqual(feed.items.map((i) => i.n), [16], JSON.stringify(pr));
  }
});

test("pull_request が無い・null の件は Issue として通す（GitHub は Issue に鍵を置かない）", () => {
  for (const pr of [undefined, null, false, 0, ""]) {
    const feed = buildFeed([issue({ pull_request: pr })], SLUGS);
    assert.deepEqual(feed.items.map((i) => i.n), [16], JSON.stringify(pr));
  }
});

/* ---- 2. 閉じた Issue・別ラベル ---- */

test("閉じた Issue・別ラベルを除くのは問い合わせ側の仕事（buildFeed は state/labels を見ない）", () => {
  /* ここを「見ない」と決めた以上、問い合わせの URL が唯一の絞りになる。
     別の入力元（webhook の payload 等）から組むように変えるなら、ここに絞りを足すこと */
  const feed = buildFeed([issue({ state: "closed", labels: [{ name: "wontfix" }] })], SLUGS);
  assert.equal(feed.items.length, 1, "buildFeed 自身は絞らない — だから下の URL の固定が要る");
  assert.ok(!JSON.stringify(feed).includes("closed") && !JSON.stringify(feed).includes("wontfix"), "state も labels も配信データには出ない");
});

test("問い合わせは open かつ faq-proposal に固定（閉じた案・別ラベルがサイトに出ない唯一の砦）", () => {
  withOut((out) => {
    const r = run({ out, issues: [issue()] });
    assert.equal(r.code, 0, r.out);
    const url = /FETCH (\S+)/.exec(r.out)?.[1];
    assert.ok(url, r.out);
    const q = new URL(url).searchParams;
    assert.equal(q.get("state"), "open", "閉じた収録案を「レビュー中」と言わない");
    assert.equal(q.get("labels"), "faq-proposal", "別ラベルの Issue を収録案として並べない");
    assert.equal(q.get("per_page"), "100");
    assert.match(new URL(url).pathname, /^\/repos\/delverdaze\/sorcerers-knowledge\/issues$/);
  });
});

/* ---- 3. 日時 ---- */

test("読めない日時の件は落ちる（目処を捏造しない）", () => {
  for (const bad of ["", " ", null, undefined, "きのう", "2026-13-45T00:00:00Z", {}, [], true, NaN]) {
    const feed = buildFeed([issue({ created_at: bad })], SLUGS);
    assert.deepEqual(feed.items, [], JSON.stringify(bad));
  }
  /* 暦に無い日（2/30）は JS の緩い解釈で翌月へ繰り上がる。GitHub は常に実在する日時を返すので
     実害は無いが、「落ちる」とは言えないことを書き残す */
  assert.equal(buildFeed([issue({ created_at: "2026-02-30T00:00:00Z" })], SLUGS).items[0].created, "2026-03-02");
});

test("GitHub の書き方（末尾 Z）なら、実行環境のタイムゾーンで日付が動かない", () => {
  const saved = process.env.TZ;
  try {
    const seen = new Set();
    for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati", "Pacific/Niue"]) {
      process.env.TZ = tz;
      const feed = buildFeed([issue({ created_at: "2026-09-13T15:00:00Z" })], SLUGS);
      seen.add(`${feed.items[0].created}/${feed.items[0].due}`);
      assert.equal(jstDay("2026-09-13T14:59:59Z"), "2026-09-13", tz);
      assert.equal(dueDay("2026-09-13T15:00:00Z"), "2026-09-21", tz);
    }
    assert.deepEqual([...seen], ["2026-09-14/2026-09-21"], "タイムゾーンで日付が変わってはいけない");
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test("目処は必ず起票日 + 7 日（うるう年・年またぎでもずれない）", () => {
  for (const [at, created, due] of [
    ["2026-12-28T15:00:00Z", "2026-12-29", "2027-01-05"],
    ["2028-02-22T00:00:00Z", "2028-02-22", "2028-02-29"],
    ["2026-09-13T14:59:59Z", "2026-09-13", "2026-09-20"],
  ]) {
    const item = buildFeed([issue({ created_at: at })], SLUGS).items[0];
    assert.equal(item.created, created, at);
    assert.equal(item.due, due, at);
  }
});

/* ---- 4. 本文の漏れ ---- */

test("巨大な本文でも配信データに一片も漏れない（1MB・見出しだらけ）", () => {
  const noise = "荒".repeat(200_000);
  const body = [
    "### カード名 / Card",
    "",
    "Wuthering Heights (wuthering_heights)",
    "",
    ...Array.from({ length: 2000 }, (_, i) => `### 見出し${i}\n\n${noise.slice(0, 400)}`),
  ].join("\n");
  assert.ok(body.length > 800_000, `本文の長さ ${body.length}`);
  const started = Date.now();
  const feed = buildFeed([issue({ body })], SLUGS);
  assert.ok(Date.now() - started < 5000, "1件の解析に何秒もかけない");
  assert.equal(feed.items[0].slug, "wuthering_heights");
  const text = JSON.stringify(feed);
  assert.ok(!text.includes("荒") && !text.includes("見出し"), "本文が漏れた");
  assert.ok(text.length < 400, `配信データは 1 件ぶんだけ: ${text.length} 文字`);
});

test("敵性の題名・本文・投稿者名は配信データに出ない（サイトはこれをそのまま描く）", () => {
  const feed = buildFeed([issue({
    title: '</script><img src=x onerror=alert(1)>',
    user: { login: "attacker", avatar_url: "https://evil.example/a.png" },
    body: "### カード名 / Card\n\n<img src=x onerror=alert(1)> (wuthering_heights)\n\n### 根拠 / Basis\n\nhttps://evil.example",
    labels: [{ name: "faq-proposal" }],
  })], SLUGS);
  const text = JSON.stringify(feed);
  for (const leak of ["<img", "onerror", "attacker", "evil.example", "script"]) {
    assert.ok(!text.includes(leak), `${leak} が漏れた: ${text}`);
  }
  assert.deepEqual(Object.keys(feed.items[0]).sort(), ["created", "due", "n", "slug", "url"]);
});

test("url は必ず github.com の自リポジトリの Issue（html_url を鵜呑みにしない）", () => {
  for (const html_url of [
    "javascript:alert(1)",
    "http://github.com/delverdaze/sorcerers-knowledge/issues/16",
    "//evil.example/16",
    "",
    null,
    123,
    {},
  ]) {
    const item = buildFeed([issue({ html_url })], SLUGS).items[0];
    assert.equal(item.url, "https://github.com/delverdaze/sorcerers-knowledge/issues/16", JSON.stringify(html_url));
  }
});

test("repo の指定が変でも、組み立てた url は https で始まる", () => {
  const item = buildFeed([issue({ html_url: undefined })], SLUGS, { repo: "delverdaze/sorcerers-knowledge" }).items[0];
  assert.ok(item.url.startsWith("https://github.com/"));
});

/* ---- 5. `(slug)` の偽物・複数一致 ---- */

test("`(slug)` は「カード名」欄のものだけ（他の欄・コードフェンスの中は効かない）", () => {
  const other = buildFeed([issue({ body: "### カード名 / Card\n\n嵐が丘\n\n### 根拠 / Basis\n\nMerlin (merlin) の裁定より\n" })], SLUGS);
  assert.equal(other.items[0].slug, null, "根拠欄の (slug) を札にしてはいけない");

  const later = buildFeed([issue({ body: "### カード名 / Card\n\n嵐が丘\n\n### 特に見てほしい点 / What to look at\n\nMerlin (merlin) と比べてほしい\n" })], SLUGS);
  assert.equal(later.items[0].slug, null, "後ろの欄の (slug) も札にしない");

  /* コードフェンスの中の `###` は見出しにならない ＝ その行は「カード名」欄の値の一部として残る。
     フォームの「カード名」は 1 行の input なので、こう書けるのは本文を手で書き換えたときだけで、
     そのとき拾う (merlin) は「その人が自分の欄に書いた値」。並ぶのは札名だけなので実害は無い */
  const fenced = buildFeed([issue({ body: "### カード名 / Card\n\n嵐が丘\n\n```\n### カード名\n\nMerlin (merlin)\n```\n" })], SLUGS);
  assert.equal(fenced.items[0].slug, "merlin", "フェンスの中は見出しにならず、カード名欄の値のまま");
});

test("実在しない `(slug)`・綴り違い・入れ子の括弧で別の札に化けない", () => {
  for (const card of [
    "Merlin (not_a_real_card)",
    "Merlin (MERLIN)",
    "Merlin ( merlin2 )",
    "Merlin (merlin/evil)",
    "Merlin (__proto__)",
    "Merlin (constructor)",
    "Merlin (toString)",
  ]) {
    const got = slugOfCard(card, SLUGS);
    assert.ok(got === null || got === "merlin", `${card} → ${got}`);
  }
  /* 括弧が slug として実在しなくても、ならすと札の英語名そのものになる書き方は引ける
     （日本語は正規化で落ちるため）。別の札に化けているわけではない */
  assert.equal(slugOfCard("嵐が丘 (wuthering heights)", SLUGS), "wuthering_heights");
  assert.equal(slugOfCard("嵐が丘 (arashigaoka)", SLUGS), null, "英語名にならない綴りは引かない");
  /* 括弧が実在しないときは欄の全体をならして照合する。「Merlin (not_a_real_card)」は
     ならすと merlinnotarealcard で、どの札名とも一致しない ＝ null（英語名だけを拾い直したりしない） */
  assert.equal(slugOfCard("Merlin (not_a_real_card)", SLUGS), null, "括弧が邪魔をしても当て推量しない");
  assert.equal(slugOfCard("知らない札 (not_a_real_card)", SLUGS), null, "どちらでも決まらなければ null");
});

test("複数の札名に当たったら選ばない（当て推量で別の札の頁へ送らない）", () => {
  assert.equal(slugOfCard("Merlin / Wuthering Heights", SLUGS), null);
  assert.equal(slugOfCard("Merlin ／ Wuthering Heights ／ Flood", SLUGS), null);
  assert.equal(slugOfCard("Merlin / Merlin", SLUGS), "merlin", "同じ札が並んだだけなら 1 枚（当たりは集合）");
  assert.equal(slugOfCard("Merlin / マーリン / Merlin", SLUGS), "merlin");
  /* 括弧が 1 つでも実在すれば、ほかに札名が並んでいても括弧が勝つ */
  assert.equal(slugOfCard("Merlin / Wuthering Heights (merlin)", SLUGS), "merlin");
});

test("「カード名」欄が 2 度あれば後勝ち（フォーム外の追記で先頭だけを見ない）", () => {
  const feed = buildFeed([issue({ body: "### カード名 / Card\n\nMerlin\n\n### カード名 / Card\n\nWuthering Heights\n" })], SLUGS);
  assert.equal(feed.items[0].slug, "wuthering_heights");
});

/* ---- 本体（fetch を差し替えた子プロセス） ---- */

function run({ env = {}, out, issues = [issue()], status = 200, raw = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "faq-proposals-neg-"));
  try {
    const stub = path.join(dir, "stub-fetch.mjs");
    const payload = raw ?? JSON.stringify(issues);
    writeFileSync(stub, `globalThis.fetch = async (url) => {
      console.log("FETCH " + url);
      return new Response(${JSON.stringify(payload)}, { status: ${status}, headers: { "content-type": "application/json" } });
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
  const dir = mkdtempSync(path.join(tmpdir(), "faq-proposals-neg-out-"));
  try {
    return fn(path.join(dir, "faq-proposals.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("壊れた JSON の応答でも、前の一覧を空で潰さずに止まる", () => {
  withOut((out) => {
    run({ out });
    const before = readFileSync(out, "utf8");
    const r = run({ out, raw: "{ぐちゃぐちゃ" });
    assert.equal(r.code, 1, r.out);
    assert.equal(readFileSync(out, "utf8"), before, "前の一覧はそのまま");
  });
});

test("認証失敗（401/403/429）でも前の一覧を空で潰さない", () => {
  for (const status of [401, 403, 429, 502]) {
    withOut((out) => {
      run({ out });
      const before = readFileSync(out, "utf8");
      const r = run({ out, status, issues: { message: "nope" } });
      assert.equal(r.code, 1, `${status}: ${r.out}`);
      assert.equal(readFileSync(out, "utf8"), before, `${status}: 前の一覧はそのまま`);
    });
  }
});

test("トークンが空白だけでも「必要」として止まる手前で外へ出ない", () => {
  withOut((out) => {
    const r = run({ out, env: { GITHUB_TOKEN: "" } });
    assert.equal(r.code, 1);
    assert.ok(!r.out.includes("FETCH "));
    assert.ok(!existsSync(out));
  });
});

test("応答が空配列でも、書くのは空の一覧だけ（前のファイルが壊れていても直す）", () => {
  withOut((out) => {
    writeFileSync(out, "{壊れた控え");
    const r = run({ out, issues: [] });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).items, []);
  });
});

test("トークンは出力にも例外にも書かない（ログに残らない）", () => {
  withOut((out) => {
    const r = run({ out, status: 500, issues: { message: "Bad credentials" }, env: { GITHUB_TOKEN: "tok_SECRET_VALUE" } });
    assert.equal(r.code, 1);
    assert.ok(!r.out.includes("tok_SECRET_VALUE"), `トークンが出力に漏れた:\n${r.out}`);
  });
});

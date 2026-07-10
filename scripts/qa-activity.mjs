/**
 * カード別Q&A（giscus / GitHub Discussions）の活動状況を data/qa-activity.json に集計する。
 *
 * サイト（sorcerers-den）TOPページの「議論中のカード」リストのデータ源。
 * このリポジトリの main にコミットするだけで、サイトが
 * raw.githubusercontent.com 経由で取得する（CDNキャッシュ約5分）。
 * サイト側の再デプロイは不要。背景と運用手順は sorcerers-den リポジトリの
 * aidlc-docs/operations/qa-activity-feed.md を参照。
 *
 * GitHub Actions（.github/workflows/qa-activity.yml）から
 * discussion / discussion_comment イベントと毎日のcronで実行される。
 * ローカル実行: GITHUB_TOKEN=$(gh auth token) node scripts/qa-activity.mjs
 *
 * 出力仕様（サイト側 app.js の renderQaActivity と対）:
 *   { generated: ISO8601, threads: [{ slug, url, n, last, answered }] }
 *   - カードスレッド（title = "card:<slug>"）のみ。要望・雑談スレッドは含めない
 *   - n: 人間の投稿数（giscus botが作るスレッド本文は数えない。返信も含む）
 *   - last: 最新の人間の投稿日時（この降順でソート済み）
 *   - answered: Q&Aカテゴリの「回答済みマーク」が付いているか
 *   - コメント本文は意図的に含めない — モデレーション前のテキストを
 *     サイトのTOPページに載せないため（カード名と件数だけなら荒らされても表面は汚れない）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN が必要です（ローカルは GITHUB_TOKEN=$(gh auth token) node scripts/qa-activity.mjs）");
  process.exit(1);
}

const [owner, name] = (process.env.GITHUB_REPOSITORY ?? "delverdaze/sorcerers-knowledge").split("/");
const MAX_THREADS = 200; // JSONの肥大化防止。TOPページの新着リスト用途にはこれで十分

// comments は last:100（新しい側）— last の算出が最新投稿を取りこぼさないようにする。
// 100件超の巨大スレッドでは n が古い側の返信分だけ少なめに出るが、件数表示の用途では許容
const QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    discussions(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        title url isAnswered createdAt
        author { __typename }
        comments(last: 100) {
          totalCount
          nodes { createdAt replies(last: 1) { totalCount nodes { createdAt } } }
        }
      }
    }
  }
}`;

async function gql(variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "sorcerers-den-qa-activity",
    },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    throw new Error(`GraphQL失敗: ${res.status} ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

const threads = [];
let cursor = null;
do {
  const page = (await gql({ owner, name, cursor })).repository.discussions;
  for (const d of page.nodes) {
    const m = /^card:(.+)$/.exec(d.title.trim());
    if (!m) continue;
    // giscus はスレッド本文をbot名義で作る（人間の発言は常にコメント側）。
    // GitHub上で直接スレッドを立てた場合だけ本文も1投稿と数える
    let n = d.author?.__typename === "Bot" ? 0 : 1;
    let last = n ? d.createdAt : "";
    const bump = (ts) => { if (ts && ts > last) last = ts; };
    n += d.comments.totalCount;
    for (const c of d.comments.nodes) {
      bump(c.createdAt);
      n += c.replies.totalCount;
      bump(c.replies.nodes[0]?.createdAt);
    }
    if (!n || !last) continue; // 投稿が全部消されたスレッドはリストに出さない
    threads.push({ slug: m[1], url: d.url, n, last, answered: d.isAnswered === true });
  }
  cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
} while (cursor);

threads.sort((a, b) => b.last.localeCompare(a.last));

const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "qa-activity.json");
const next = { generated: new Date().toISOString(), threads: threads.slice(0, MAX_THREADS) };

// 実質的な変化がなければ書き換えない — cron実行のたびに generated だけ変わった
// コミットが積まれるのを防ぐ（ワークフロー側は git diff で変更有無を見る）
try {
  const prev = JSON.parse(readFileSync(outPath, "utf8"));
  if (JSON.stringify(prev.threads) === JSON.stringify(next.threads)) {
    console.log(`変更なし（${next.threads.length}スレッド）`);
    process.exit(0);
  }
} catch {
  // 初回（ファイルなし・壊れたJSON）はそのまま書き出す
}

writeFileSync(outPath, `${JSON.stringify(next, null, 2)}\n`);
console.log(`data/qa-activity.json を更新（${next.threads.length}スレッド）`);

/**
 * カード別Q&A（giscus / GitHub Discussions）の新規投稿をDiscordへ通知する。
 *
 * 通知には X (Twitter) の投稿画面を本文入りで開く Web Intent リンクを含める。
 * X API の従量課金（リンク付き投稿 $0.20/件）を避けつつ、管理人の1タップで
 * @sorcersden から告知できるようにするための「半自動」方式。自動投稿ではないので
 * X の Automation Rules にも抵触しない。
 * 背景と運用手順: sorcerers-den リポジトリ aidlc-docs/operations/qa-x-notification.md
 *
 * GitHub Actions（.github/workflows/qa-notify.yml）から
 * discussion / discussion_comment の created イベントで起動される。
 * DISCORD_WEBHOOK_URL 未設定時は送信せず、組み立てた内容を表示して正常終了する
 * （ローカル確認用・シークレット未設定でもワークフローを落とさない）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SITE_ORIGIN = "https://sorcerers-den.pages.dev";
const TWEET_EXCERPT_MAX = 60; // 和名/英名併記＋URLを足しても280(重み付き)に収まる上限
const DISCORD_EXCERPT_MAX = 150;

const eventName = process.env.GITHUB_EVENT_NAME ?? "discussion_comment";
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));

const discussion = event.discussion;
// discussion イベントはスレッド新規作成、discussion_comment はその中の発言
const post = eventName === "discussion_comment" ? event.comment : discussion;

// giscus は初回投稿時にページ情報を本文としたスレッドを bot 名義で作り、
// 利用者の発言は常にコメントとして届く。bot 起点のイベントは通知しない
if (post.user?.type === "Bot") {
  console.log(`bot（${post.user.login}）の投稿のためスキップ`);
  process.exit(0);
}

/** markdown/HTML をおおまかに落として1行の抜粋にする */
function excerpt(text, max) {
  const plain = (text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

/**
 * カードスレッド（title = "card:<slug>"）ならカード名とページURLを解決する。
 * 表示名はサイトのOGP（og:title = 「和名 / 英名」）から取る — slug→表示名の
 * ロジックを二重管理しないため。取得失敗時は data/slugs.json の英名、最後は slug。
 */
async function resolveCard(title) {
  const match = /^card:(.+)$/.exec(title.trim());
  if (!match) return null;
  const slug = match[1];
  const url = `${SITE_ORIGIN}/?card=${encodeURIComponent(slug)}`;
  try {
    const res = await fetch(url, { headers: { "user-agent": "sorcerers-den-qa-notify" } });
    const og = /<meta property="og:title" content="([^"]*)"/.exec(await res.text());
    if (og?.[1]) return { slug, name: og[1], url };
  } catch {
    // 名前解決に失敗しても通知自体は出す
  }
  const slugsPath = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "slugs.json");
  const slugs = JSON.parse(readFileSync(slugsPath, "utf8"));
  return { slug, name: slugs[slug] ?? slug, url };
}

const card = await resolveCard(discussion.title ?? "");
// 非カードスレッドはタイトルが最長256字ありうるため表示用・ツイート用それぞれ短縮する
const displayName = excerpt(card?.name ?? discussion.title, 80);
const pageUrl = card?.url ?? discussion.html_url;
const threadUrl = post.html_url ?? discussion.html_url;
const author = post.user?.login ?? "unknown";
const kind = eventName === "discussion" ? "スレッド" : "書き込み";

const tweetText = [
  `『${excerpt(displayName, 40)}』のQ&Aに新しい${kind}があります。`,
  `「${excerpt(post.body, TWEET_EXCERPT_MAX)}」`,
  pageUrl,
].join("\n");
// markdownのマスクリンク [t](url) は URL 内の ")" で壊れる。encodeURIComponent は
// !'()* を素通しするため、リンクに埋める URL は括弧類を明示的にエスケープする
const encodeForLink = (url) =>
  url.replace(/[()*']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const intentUrl = encodeForLink(`https://x.com/intent/post?text=${encodeURIComponent(tweetText)}`);

// embed ではなく content（プレーン本文）で送る — クライアント設定で埋め込み表示を
// 切っていても本文が見え、スマホのプッシュ通知プレビューにも文面が出るため。
// URL を <> で囲むのはリンクプレビュー（embed化）の抑制。全体は2000字制限に対し
// intentUrl(上限約1500)＋抜粋150で最悪でも収まる長さに設計してある
const content = [
  `**『${displayName}』に新しい${kind}**`,
  `「${excerpt(post.body, DISCORD_EXCERPT_MAX)}」 — ${author}`,
  `📣 [Xで告知する（本文入力済み・ポストを押すだけ）](<${intentUrl}>)`,
  ...(card ? [`🃏 [カードページを開く](<${encodeForLink(pageUrl)}>)`] : []),
  `💬 [スレッドを開く](<${encodeForLink(threadUrl)}>)`,
].join("\n");

const payload = { content };

const webhook = process.env.DISCORD_WEBHOOK_URL;
if (!webhook) {
  console.log("DISCORD_WEBHOOK_URL 未設定 — 送信せず内容のみ表示:");
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const res = await fetch(webhook, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});
if (!res.ok) {
  console.error(`Discord送信失敗: ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`Discordへ通知した: ${discussion.title} (${author})`);

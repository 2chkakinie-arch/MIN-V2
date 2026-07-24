const express = require("express");
const path = require("path");
const yts = require("youtube-search-api");
const fetch = require("node-fetch");
const cookieParser = require("cookie-parser");
const https = require("https");
const crypto = require("crypto");
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

/* =====================================================================
 *  MIN-Tube-Pro V3  —  完全再構築コア
 *  - youtube-search-api 2.0.1 (NextPage 方式の正しいページング)
 *  - Orby-API プロバイダ (映像ストリーム + コメント / 並列フォールバック)
 *  - Orby-MAX 画質選択 (映像+音声同期)
 *  - nie-ai (scira-gemini-3.1-flash-lite) 暗号化プロキシ
 *  - チャンネルアバターの正確な取得 + キャッシュ
 * ===================================================================== */

// ---- 汎用: タイムアウト付き fetch (AbortController ベース) ----
function fetchWithAbort(url, options = {}, timeout = 6000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9"
};

/* =====================================================================
 *  Orby-API プロバイダ
 * ===================================================================== */
const ORBY_HOSTS = [
  "https://orby-api.vercel.app",
  "https://orby-api.onrender.com"
];

// Orby: 画質ラベルの正規化  "mp4 (1080p)" -> "1080p" / "480p" 等
function orbyQualityLabel(fmt) {
  const q = String(fmt.qualityLabel || fmt.quality || "").trim();
  const m = q.match(/(\d{3,4}p)/);
  if (m) return m[1];
  if (/audio/i.test(fmt.mimeType || "")) {
    const kb = q.match(/(\d+)\s*kb/i);
    return kb ? `audio ${kb[1]}kbps` : "audio";
  }
  return q || "unknown";
}

// Orby: format オブジェクト -> 種別判定
function orbyIsVideoOnly(f) { return f.hasVideo && !f.hasAudio; }
function orbyIsAudioOnly(f) { return f.hasAudio && !f.hasVideo; }
function orbyIsMuxed(f)     { return f.hasVideo && f.hasAudio; }

// Orby: 単一ホストから JSON を取得
async function orbyFetchJson(pathAndQuery, timeout = 9000) {
  let lastErr = null;
  for (const host of ORBY_HOSTS) {
    try {
      const r = await fetchWithAbort(host + pathAndQuery, { headers: COMMON_HEADERS }, timeout);
      if (!r.ok) { lastErr = new Error(`Orby HTTP ${r.status} @ ${host}`); continue; }
      const j = await r.json();
      if (j && j.ok !== false) { j.__host = host; return j; }
      lastErr = new Error(`Orby ok=false @ ${host}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Orby: all hosts failed");
}

// Orby: 標準ストリーム (chosen = 360p muxed) を videoData 形式に変換
async function orbyGetVideo(videoId) {
  const j = await orbyFetchJson(`/orby/yt/${videoId}?format=json`, 9000);
  const chosen = j.chosen || (j.formats || []).find(orbyIsMuxed) || (j.formats || [])[0];
  if (!chosen || !chosen.url) throw new Error("Orby: no playable stream");
  return {
    provider: "Orby-API",
    stream_url: chosen.url,
    highstreamUrl: chosen.url,
    audioUrl: "",
    videoId: videoId,
    // Orby は videoDetails が空なので、メタは呼び出し側で yts から補完する
    channelId: (j.videoDetails && j.videoDetails.channelId) || "",
    channelName: (j.videoDetails && (j.videoDetails.author || j.videoDetails.channelName)) || "",
    channelImage: "",
    videoTitle: (j.videoDetails && j.videoDetails.title) || "",
    videoDes: (j.videoDetails && (j.videoDetails.shortDescription || j.videoDetails.description)) || "",
    videoViews: (j.videoDetails && j.videoDetails.viewCount) || 0,
    likeCount: 0,
    __orbyChosen: chosen
  };
}

// Orby: 全ストリーム (Orby-MAX) を正規化して返す（画質選択用）
async function orbyGetAllStreams(videoId) {
  const j = await orbyFetchJson(`/orby/yt/${videoId}?format=json&provider=Orby-MAX`, 12000);
  const formats = Array.isArray(j.formats) ? j.formats : [];

  const videoStreams = [];   // 映像 (muxed も含む)
  const audioStreams = [];   // 音声のみ

  for (const f of formats) {
    if (!f.url) continue;
    const label = orbyQualityLabel(f);
    if (f.hasVideo) {
      videoStreams.push({
        itag: f.itag,
        url: f.url,
        quality: label,
        heightNum: parseInt((label.match(/(\d+)p/) || [])[1] || "0", 10),
        mimeType: f.mimeType || "",
        container: /webm/i.test(f.mimeType || "") ? "webm" : "mp4",
        hasAudio: !!f.hasAudio,
        hasVideo: true
      });
    } else if (f.hasAudio) {
      audioStreams.push({
        itag: f.itag,
        url: f.url,
        quality: label,
        mimeType: f.mimeType || "",
        container: /webm|opus/i.test(f.mimeType || "") ? "webm" : "m4a",
        bitrate: parseInt((label.match(/(\d+)\s*kb/i) || [])[1] || "0", 10)
      });
    }
  }

  // 映像: 高さ降順 → mp4 優先 → 同条件なら音声込み(muxed)を優先
  videoStreams.sort((a, b) =>
    (b.heightNum - a.heightNum)
    || ((a.container === "mp4" ? 0 : 1) - (b.container === "mp4" ? 0 : 1))
    || ((b.hasAudio ? 1 : 0) - (a.hasAudio ? 1 : 0))
  );
  // 音声: 最高ビットレートの mp4(m4a) を優先（<video> の互換性が高い）
  audioStreams.sort((a, b) => {
    const am = a.container === "m4a" ? 1 : 0;
    const bm = b.container === "m4a" ? 1 : 0;
    return (bm - am) || (b.bitrate - a.bitrate);
  });

  const bestAudio = audioStreams[0] || null;

  return {
    ok: true,
    videoId,
    provider: "Orby-MAX",
    host: j.__host,
    // 各画質。360p 以下の muxed(itag18) はそのまま音声込み。それ以外は音声別トラックが必要。
    videoStreams,
    audioStreams,
    bestAudioUrl: bestAudio ? bestAudio.url : ""
  };
}

// Orby: コメント取得 (ページネーション対応)
async function orbyGetComments(videoId, page = 1) {
  const j = await orbyFetchJson(`/orby/yt/comments/${videoId}?page=${page}`, 9000);
  const comments = (j.comments || []).map(c => ({
    commentId: c.commentId,
    author: c.author,
    authorThumbnail: c.authorThumbnail || "",
    authorChannelId: c.authorChannelId || "",
    content: c.text || "",
    text: c.text || "",
    publishedTime: c.publishedTime || "",
    likeCount: c.likeCount || 0,
    likeCountText: c.likeCountText || "",
    replyCount: c.replyCount || 0,
    isPinned: !!c.isPinned,
    isHearted: !!c.isHearted,
    // フロント互換: authorThumbnails 配列形式も同梱
    authorThumbnails: c.authorThumbnail ? [{ url: c.authorThumbnail }] : []
  }));
  return {
    ok: true,
    videoId,
    page: j.page || page,
    commentCount: comments.length,
    hasNextPage: j.hasNextPage !== undefined ? !!j.hasNextPage : (comments.length > 0),
    comments
  };
}

/* =====================================================================
 *  チャンネルアバター解決 (search 結果に正しいチャンネル画像を付与)
 * ===================================================================== */
const channelAvatarCache = new Map(); // channelId -> { url, expiry }
const CHANNEL_AVATAR_TTL = 6 * 60 * 60 * 1000; // 6時間

// search item から channelId (UC...) を抽出
function extractChannelId(item) {
  const ne = item?.shortBylineText?.runs?.[0]?.navigationEndpoint
          || item?.longBylineText?.runs?.[0]?.navigationEndpoint
          || item?.ownerText?.runs?.[0]?.navigationEndpoint;
  const bid = ne?.browseEndpoint?.browseId;
  if (bid && /^UC[\w-]+$/.test(bid)) return bid;
  const url = ne?.commandMetadata?.webCommandMetadata?.url || "";
  const m = url.match(/UC[\w-]{20,}/);
  return m ? m[0] : null;
}

// channelId からアバター URL を解決（YouTubeチャンネルページを軽量取得 + キャッシュ）
async function resolveChannelAvatar(channelId) {
  if (!channelId) return "";
  const now = Date.now();
  const cached = channelAvatarCache.get(channelId);
  if (cached && cached.expiry > now) return cached.url;

  try {
    const r = await fetchWithAbort(
      `https://www.youtube.com/channel/${channelId}`,
      { headers: COMMON_HEADERS },
      5000
    );
    if (!r.ok) throw new Error("HTTP " + r.status);
    const html = await r.text();
    let url = "";
    // 1) og:image (最も確実)
    let m = html.match(/<meta property="og:image" content="([^"]+)"/);
    if (m && /yt3\.|ggpht/.test(m[1])) url = m[1];
    // 2) avatar.thumbnails
    if (!url) {
      m = html.match(/"avatar":\{"thumbnails":\[\{"url":"(https:\/\/(?:yt3|yt4)[^"]+?)"/);
      if (m) url = m[1];
    }
    // 3) 汎用 yt3 URL
    if (!url) {
      m = html.match(/(https:\/\/yt3\.googleusercontent\.com\/[\w\-=/.]+?=s\d+[^"\\]*)/);
      if (m) url = m[1];
    }
    // エスケープ解除
    url = url.replace(/\\u003d/g, "=").replace(/\\\//g, "/").replace(/\\u0026/g, "&");
    channelAvatarCache.set(channelId, { url, expiry: now + CHANNEL_AVATAR_TTL });
    return url;
  } catch (e) {
    channelAvatarCache.set(channelId, { url: "", expiry: now + 10 * 60 * 1000 });
    return "";
  }
}

// search item を正規化（channelId / channelThumbnail を付与）
function normalizeSearchItem(item) {
  const channelId = extractChannelId(item);
  return {
    ...item,
    channelId: channelId || item.channelId || "",
    channelTitle: item.channelTitle || item.shortBylineText?.runs?.[0]?.text || ""
  };
}

// 検索結果配列にアバターを一括付与（並列 + キャッシュ）
async function enrichWithAvatars(items) {
  const videos = items.filter(it => it && it.type === "video");
  await Promise.all(videos.map(async (it) => {
    const cid = extractChannelId(it) || it.channelId;
    it.channelId = cid || "";
    it.channelThumbnail = cid ? await resolveChannelAvatar(cid) : "";
    it.channelTitle = it.channelTitle || it.shortBylineText?.runs?.[0]?.text || "";
  }));
  return items;
}

/* =====================================================================
 *  nie-ai (scira-gemini-3.1-flash-lite) 暗号化プロキシ
 *  クライアントには生の URL / モデル名を見せない
 * ===================================================================== */
const NIE_AI_URL = "https://nie-ai.vercel.app/v1/chat/completions";
const NIE_AI_MODEL = "scira-gemini-3.1-flash-lite";

/* =====================================================================
 *  Supabase（共有プレイリストキャッシュ）
 *  Gemini が生成したプレイリストを全ユーザーで共有し、同じ要件の生成要求が
 *  来たら再生成せず復元する（＝クレジット節約 & 一貫性 & 高速化）。
 *  テーブルが未作成でも動くよう、失敗は握りつぶして通常のGemini生成に落とす。
 * ===================================================================== */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://vrfffnpxhxmeeirwewdd.supabase.co";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_gWyCUJmoo8_mlnWP9uT8Cg_jAdLuqz2";
const SUPA_REST = SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1";
const SUPA_HEADERS = { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" };

// 生成要件を正規化してキャッシュキー化（表記ゆれを吸収）
function playlistCacheKey({ mode, channel, title, keywords }) {
  const norm = (s) => String(s || "").toLowerCase().normalize("NFKC").replace(/[\s　【】「」()!！?？\[\].,、。・-]/g, "").trim();
  if (mode === "channel") return "channel:" + norm(channel);
  const base = keywords ? ("kw:" + norm(keywords)) : ("ctx:" + norm(title) + "|" + norm(channel));
  return base.slice(0, 220);
}

// 既存の共有プレイリストを探す（あれば items を返す）
async function supaFindPlaylist(cacheKey) {
  try {
    const url = SUPA_REST + "/shared_playlists?cache_key=eq." + encodeURIComponent(cacheKey) + "&select=label,items,mode&limit=1";
    const r = await fetchWithAbort(url, { headers: SUPA_HEADERS }, 6000);
    if (!r.ok) return null;
    const rows = await r.json();
    if (Array.isArray(rows) && rows[0] && Array.isArray(rows[0].items) && rows[0].items.length >= 3) {
      return rows[0];
    }
    return null;
  } catch (e) { return null; }
}

// 新規生成した共有プレイリストを保存（重複キーは無視）
async function supaSavePlaylist(cacheKey, { label, mode, items }) {
  try {
    await fetchWithAbort(SUPA_REST + "/shared_playlists", {
      method: "POST",
      headers: { ...SUPA_HEADERS, "Prefer": "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({ cache_key: cacheKey, label: label || "", mode: mode || "context", items })
    }, 6000);
  } catch (e) { /* テーブル未作成などは無視 */ }
}

// nie-ai を呼び出す（scira は稀に空応答を返すためリトライ）
async function callNieAI(messages, { temperature = 0.75, maxTokens = 1000, retries = 3 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetchWithAbort(NIE_AI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: NIE_AI_MODEL,
          messages,
          temperature,
          max_tokens: maxTokens
        })
      }, 30000);
      if (!r.ok) { lastErr = new Error("nie-ai HTTP " + r.status); continue; }
      const data = await r.json();
      const content = data?.choices?.[0]?.message?.content || "";
      if (content && content.trim()) return content.trim();
      lastErr = new Error("nie-ai empty content");
    } catch (e) { lastErr = e; }
    await new Promise(res => setTimeout(res, 400)); // バックオフ
  }
  throw lastErr || new Error("nie-ai failed");
}

/* =====================================================================
 *  AI が出力したタイトル列 → 実在動画へ解決するユーティリティ
 *  (ホーム✨/チャンネル自動生成/関連の+プレイリスト で共用)
 * ===================================================================== */
function parseAiTitles(raw) {
  if (!raw) return [];
  let t = String(raw).replace(/```[\s\S]*?```/g, " ").replace(/^\s*[-*\d+.)\s]+/gm, "");
  const parts = t.split(".").map(s => s.trim()).filter(s => s.length >= 3);
  const titles = [];
  const seen = new Set();
  for (const p of parts) {
    let title = p.replace(/^[\s\-*\u30fb•●○▶▷☞☛]+/, "").trim();
    if (title.length < 3 || title.length > 120) continue;
    if (/^(こちら|以下|それでは|了解|わかりました|note|note:|playlist)/i.test(title)) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
  }
  return titles.slice(0, 14);
}

// 1タイトル → 実在動画1件（チャンネル/プレイリストは除外）
async function resolveOneVideo(query) {
  try {
    const r = await yts.GetListByKeyword(query, false, 6);
    const items = Array.isArray(r?.items) ? r.items : [];
    const it = items.find(x => x && x.type === "video" && x.id && !String(x.id).startsWith("UC"));
    if (!it) return null;
    return {
      id: it.id,
      title: it.title || query,
      channelTitle: it.channelTitle || it.shortBylineText?.runs?.[0]?.text || "",
      thumbnail: it.thumbnail?.thumbnails?.[1]?.url || it.thumbnail?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg`,
      lengthText: it.length?.simpleText || it.lengthText || ""
    };
  } catch (e) { return null; }
}

// タイトル列を並列(制限付き)で動画に解決し重複除去
async function resolveTitlesToVideos(titles, { concurrency = 5, excludeIds = [] } = {}) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < titles.length) {
      const my = cursor++;
      const r = await resolveOneVideo(titles[my]);
      if (r) results.push({ ...r, _idx: my });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  results.sort((a, b) => a._idx - b._idx);
  const seen = new Set(excludeIds);
  const unique = [];
  for (const r of results) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    delete r._idx;
    unique.push(r);
  }
  return unique;
}

/* =====================================================================
 *  動画メタデータ解決 (title / channelName / channelId / description)
 *  Orby はメタが空なので noembed + yts search で補完する
 * ===================================================================== */
const videoMetaCache = new Map(); // videoId -> { data, expiry }
const VIDEO_META_TTL = 60 * 60 * 1000;

// 数値を YouTube 風に整形 (1234567 -> 123万 / 4001423536 -> 40億)
function formatCountJa(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (Math.floor(n / 1e7) / 10).toString().replace(/\.0$/, "") + "億";
  if (n >= 1e4) return (Math.floor(n / 1e3) / 10).toString().replace(/\.0$/, "") + "万";
  return n.toLocaleString("ja-JP");
}

// Orby /meta エンドポイントから確実にメタ取得
async function orbyGetMeta(videoId) {
  try {
    const j = await orbyFetchJson(`/orby/yt/meta/${videoId}`, 8000);
    const m = j.metadata || {};
    return {
      title: m.title || "",
      author: m.author || "",
      channelId: m.channelId || "",
      description: m.description || "",
      views: Number(m.viewCount) || 0,
      likes: Number(m.likeCount) || 0,
      comments: Number(m.commentCount) || 0,
      lengthSeconds: Number(m.lengthSeconds) || 0
    };
  } catch (e) { return null; }
}

async function resolveVideoMeta(videoId) {
  const now = Date.now();
  const cached = videoMetaCache.get(videoId);
  if (cached && cached.expiry > now) return cached.data;

  const meta = {
    title: "", channelName: "", channelId: "", description: "",
    views: 0, likes: 0, comments: 0
  };

  // 並列: Orby /meta (数値系に強い) + noembed (title/author に強い)
  const [orbyMeta, noembed] = await Promise.all([
    orbyGetMeta(videoId),
    (async () => {
      try {
        const r = await fetchWithAbort(
          `https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`,
          { headers: COMMON_HEADERS }, 4000
        );
        if (r.ok) { const d = await r.json(); if (d && !d.error) return d; }
      } catch (e) {}
      return null;
    })()
  ]);

  if (orbyMeta) {
    meta.title = orbyMeta.title || "";
    meta.channelName = orbyMeta.author || "";
    meta.channelId = orbyMeta.channelId || "";
    meta.description = orbyMeta.description || "";
    meta.views = orbyMeta.views || 0;
    meta.likes = orbyMeta.likes || 0;
    meta.comments = orbyMeta.comments || 0;
  }
  if (noembed) {
    meta.title = meta.title || noembed.title || "";
    meta.channelName = meta.channelName || noembed.author_name || "";
  }

  // channelId が空なら yts 検索で特定（アバター解決に必要）
  if (!meta.channelId || !meta.channelName || !meta.title) {
    try {
      const q = meta.title || videoId;
      const sr = await yts.GetListByKeyword(q, false, 12);
      const match = (sr.items || []).find(it => it.id === videoId);
      if (match) {
        meta.title = meta.title || match.title || "";
        meta.channelName = meta.channelName || match.channelTitle || match.shortBylineText?.runs?.[0]?.text || "";
        meta.channelId = meta.channelId || extractChannelId(match) || "";
      }
    } catch (e) {}
  }

  videoMetaCache.set(videoId, { data: meta, expiry: now + VIDEO_META_TTL });
  return meta;
}

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

const API_HEALTH_CHECKER = "https://raw.githubusercontent.com/Minotaur-ZAOU/test/refs/heads/main/min-tube-api.json";
const TEMP_API_LIST = "https://raw.githubusercontent.com/Minotaur-ZAOU/test/refs/heads/main/min-tube-api.json";
const RAPID_API_HOST = 'ytstream-download-youtube-videos.p.rapidapi.com';
const videoCache = new Map();
const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0"
];

const keys = [
  process.env.RAPIDAPI_KEY_1 || '69e2995a79mshcb657184ba6731cp16f684jsn32054a070ba5',
  process.env.RAPIDAPI_KEY_2 || 'ece95806fdmshe322f47bce30060p1c3411jsn41a3d4820039',
  process.env.RAPIDAPI_KEY_3 || '41c9265bc6msha0fa7dfc1a63eabp18bf7cjsne6ef10b79b38'
];

const PROXY_DIR = path.join(__dirname, 'proxy');


app.use(express.static(path.join(__dirname, "public")));
app.use(cookieParser());

let apiListCache = [];

async function updateApiListCache() {
  try {
    const response = await fetch(API_HEALTH_CHECKER);
    if (response.ok) {
      const mainApiList = await response.json();
      if (Array.isArray(mainApiList) && mainApiList.length > 0) {
        apiListCache = mainApiList;
        console.log("API List updated.");
      }
    }
  } catch (err) {
    console.error("API update failed.");
  }
}

updateApiListCache();
setInterval(updateApiListCache, 1000 * 60 * 10);

function fetchWithTimeout(url, options = {}, timeout = 5000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
    )
  ]);
}

setInterval(() => {
    const now = Date.now();
    for (const [videoId, cachedItem] of videoCache.entries()) {
        if (cachedItem.expiry < now) {
            videoCache.delete(videoId);
        }
    }
}, 300000);

// 【変更】偽装(人間確認)画面と humanVerified Cookie 認証を撤廃。
// 直接 home.html を表示する（本家 YouTube 同様、余計なゲートを挟まない）。
// 互換のため、もし過去バージョンで humanVerified を要求していた場合に備え、
// ここで一度だけ Cookie を立てて以後の古い判定を全て通過させる。
app.use((req, res, next) => {
  if (!req.cookies || req.cookies.humanVerified !== "true") {
    try { res.cookie("humanVerified", "true", { maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: false }); } catch (e) {}
  }
  next();
});

// --- API ENDPOINTS ---

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

/* =====================================================================
 *  検索ページング用セッションキャッシュ
 *  youtube-search-api 2.0.1 は「nextPage オブジェクト」を NextPage() に
 *  渡す方式でないと 2ページ目以降が取得できない（旧 4引数方式は無効）。
 *  クエリごとに nextPage トークンを保持して正しくページ送りする。
 * ===================================================================== */
const searchPageCache = new Map(); // key: `${query}` -> { nextPage, expiry }
const SEARCH_PAGE_TTL = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of searchPageCache.entries()) if (v.expiry < now) searchPageCache.delete(k);
}, 5 * 60 * 1000);

// クエリを limit 件取得。page>0 のときは保持済み nextPage を使って続きを取得
async function fetchSearchPage(query, page = 0, limit = 20) {
  const key = query;
  if (page === 0) {
    const r = await yts.GetListByKeyword(query, false, limit);
    if (r && r.nextPage) searchPageCache.set(key, { nextPage: r.nextPage, expiry: Date.now() + SEARCH_PAGE_TTL });
    return r;
  }
  const cached = searchPageCache.get(key);
  if (cached && cached.nextPage) {
    try {
      const r = await yts.NextPage(cached.nextPage, false, limit);
      if (r && r.nextPage) searchPageCache.set(key, { nextPage: r.nextPage, expiry: Date.now() + SEARCH_PAGE_TTL });
      else searchPageCache.delete(key);
      return r;
    } catch (e) {
      // nextPage が失効している場合は先頭から取り直す
      searchPageCache.delete(key);
    }
  }
  // フォールバック: 先頭ページ
  const r = await yts.GetListByKeyword(query, false, limit);
  if (r && r.nextPage) searchPageCache.set(key, { nextPage: r.nextPage, expiry: Date.now() + SEARCH_PAGE_TTL });
  return r;
}

app.get("/api/trending", async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  try {
    // ニュースは画面映えせず気が滅入るので大幅に減らし、ゲーム実況/エンタメ中心に。
    const trendingSeeds = [
      "ゲーム実況 人気", "実況プレイ 最新", "人気急上昇",
      "Music Video Official", "話題の動画", "神プレイ ゲーム",
      "エンタメ 人気", "Top Hits", "面白い動画"
    ];

    const seed1 = trendingSeeds[(page * 2) % trendingSeeds.length];
    const seed2 = trendingSeeds[(page * 2 + 1) % trendingSeeds.length];

    const [res1, res2] = await Promise.all([
      yts.GetListByKeyword(seed1, false, 25),
      yts.GetListByKeyword(seed2, false, 25)
    ]);

    let combined = [...(res1.items || []), ...(res2.items || [])];
    const finalItems = [];
    const seenIdsServer = new Set();

    for (const item of combined) {
      if (item.type === 'video' && !seenIdsServer.has(item.id)) {
        seenIdsServer.add(item.id);
        finalItems.push(normalizeSearchItem(item));
      }
    }

    const result = finalItems.sort(() => 0.5 - Math.random());
    await enrichWithAvatars(result);
    res.json({ items: result });
    
  } catch (err) {
    console.error("Trending API Error:", err);
    res.json({ items: [] });
  }
});


app.get("/api/search", async (req, res, next) => {
  const query = req.query.q;
  const page = parseInt(req.query.page) || 0;
  if (!query) return res.status(400).json({ error: "Query required" });
  try {
    const results = await fetchSearchPage(query, page, 20);
    const items = (results.items || []).map(normalizeSearchItem);
    await enrichWithAvatars(items);
    res.json({ items, nextPage: page + 1 });
  } catch (err) {
    console.error("Search API Error:", err);
    res.json({ items: [], nextPage: page + 1 });
  }
});


app.get("/api/recommendations", async (req, res) => {
  const { title, channel, id } = req.query;
  try {
    const cleanKwd = title
      .replace(/[【】「」()!！?？\[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const words = cleanKwd.split(' ').filter(w => w.length >= 2);
    const mainTopic = words.length > 0 ? words.slice(0, 2).join(' ') : cleanKwd;

    const [topicRes, channelRes, relatedRes] = await Promise.all([
      yts.GetListByKeyword(`${mainTopic}`, false, 12),
      yts.GetListByKeyword(`${channel}`, false, 8),
      yts.GetListByKeyword(`${mainTopic} 関連`, false, 8)
    ]);

    let rawList = [
      ...(topicRes.items || []),
      ...(channelRes.items || []),
      ...(relatedRes.items || [])
    ];

    const seenIds = new Set([id]); 
    const seenNormalizedTitles = new Set();
    const finalItems = [];

    for (const item of rawList) {
      if (!item.id || item.type !== 'video') continue;
      if (seenIds.has(item.id)) continue;

      // タイトルの正規化による「重複内容」の排除
      const normalized = item.title.toLowerCase()
        .replace(/\s+/g, '')
        .replace(/official|lyrics|mv|musicvideo|video|公式|実況|解説/g, '');

      const titleSig = normalized.substring(0, 12);
      if (seenNormalizedTitles.has(titleSig)) continue;

      seenIds.add(item.id);
      seenNormalizedTitles.add(titleSig);
      finalItems.push(normalizeSearchItem(item));

      if (finalItems.length >= 24) break; 
    }

    const result = finalItems.sort(() => 0.5 - Math.random());
    await enrichWithAvatars(result);
    res.json({ items: result });
  } catch (err) {
    console.error("Rec Engine Error:", err);
    res.json({ items: [] });
  }
});

app.get("/video/:id", async (req, res, next) => {
const videoId = req.params.id;
try {
let videoData = null;
let commentsData = { commentCount: 0, comments: [] };
let successfulApi = null;

const protocol = req.headers['x-forwarded-proto'] || 'http';
const host = req.headers.host;

// ---- ストリーム取得: 既存プロバイダ群 + Orby-API を並列フォールバック ----
// まず既存の API リストを順に試し、全滅したら Orby-API にフォールバックする。
for (const apiBase of apiListCache) {
  try {
    videoData = await Promise.any([
      fetchWithTimeout(`${apiBase}/api/video/${videoId}`, {}, 5000)
        .then(res => res.ok ? res.json() : Promise.reject())
        .then(data => data.stream_url ? data : Promise.reject()),
      fetchWithTimeout(`${protocol}://${host}/sia-dl/${videoId}`, {}, 5000)
        .then(res => res.ok ? res.json() : Promise.reject())
        .then(data => data.stream_url ? data : Promise.reject()),

      // Orby-API を並列候補に追加（他が遅い/失敗時の即応フォールバック）
      orbyGetVideo(videoId).catch(() => Promise.reject()),

      new Promise((resolve, reject) => {
        setTimeout(() => {
          fetchWithTimeout(`${protocol}://${host}/ai-fetch/${videoId}`, {}, 5000)
            .then(res => res.ok ? res.json() : Promise.reject())
            .then(data => data.stream_url ? resolve(data) : reject())
            .catch(reject);
        }, 2000);
      })
    ]);


    // コメント: プロバイダ標準 -> だめなら Orby にフォールバック
    try {
      const cRes = await fetchWithTimeout(`${apiBase}/api/comments/${videoId}`, {}, 3000);
      if (cRes.ok) commentsData = await cRes.json();
      if (!commentsData || !Array.isArray(commentsData.comments) || commentsData.comments.length === 0) {
        commentsData = await orbyGetComments(videoId, 1);
      }
    } catch (e) {
      try { commentsData = await orbyGetComments(videoId, 1); } catch (e2) {}
    }

    successfulApi = apiBase;
    break;

  } catch (e) {
    try {
      const rapidRes = await fetchWithTimeout(`${protocol}://${host}/rapid/${videoId}`, {}, 5000);
      if (rapidRes.ok) {
        const rapidData = await rapidRes.json();
        if (rapidData.stream_url) {
          videoData = rapidData;
          
          try {
            const cRes = await fetchWithTimeout(`${apiBase}/api/comments/${videoId}`, {}, 3000);
            if (cRes.ok) commentsData = await cRes.json();
            if (!commentsData || !Array.isArray(commentsData.comments) || commentsData.comments.length === 0) {
              commentsData = await orbyGetComments(videoId, 1);
            }
          } catch (e) {
            try { commentsData = await orbyGetComments(videoId, 1); } catch (e2) {}
          }

          successfulApi = apiBase; 
          break; 
        }
      }
    } catch (rapidErr) {}
    continue;
  }
}

// ---- 最終フォールバック: すべて失敗したら Orby-API 単独で取得 ----
if (!videoData || !videoData.stream_url) {
  try {
    videoData = await orbyGetVideo(videoId);
    successfulApi = "Orby-API";
    try { commentsData = await orbyGetComments(videoId, 1); } catch (e) {}
  } catch (e) {
    console.error("Orby final fallback failed:", e.message);
  }
}

if (!videoData) {
  videoData = { videoTitle: "再生できない動画", stream_url: "youtube-nocookie" };
}

// ---- メタデータ補完: title/channel/views/likes/desc が空にならないよう確実に補う ----
// 数値(再生回数・高評価)は空バグが多いので常に meta を取得して欠損分を埋める
try {
  const needMeta = !videoData.videoTitle || !videoData.channelName || !videoData.channelImage
                || !videoData.videoDes || !videoData.videoViews || !videoData.likeCount;
  if (needMeta) {
    const meta = await resolveVideoMeta(videoId);
    if (meta) {
      videoData.videoTitle = videoData.videoTitle || meta.title;
      videoData.channelName = videoData.channelName || meta.channelName;
      videoData.channelId   = videoData.channelId   || meta.channelId;
      videoData.videoDes    = videoData.videoDes    || meta.description;
      if (!videoData.videoViews || Number(videoData.videoViews) === 0) videoData.videoViews = meta.views;
      if (!videoData.likeCount || Number(videoData.likeCount) === 0)   videoData.likeCount = meta.likes;
      videoData.commentCount = videoData.commentCount || meta.comments;
      if (!videoData.channelImage && meta.channelId) {
        videoData.channelImage = await resolveChannelAvatar(meta.channelId);
      }
    }
  }
  if (!videoData.channelImage && videoData.channelId) {
    videoData.channelImage = await resolveChannelAvatar(videoData.channelId);
  }
} catch (metaErr) { console.warn("meta enrich failed:", metaErr.message); }

// videoData を安全にデフォルト補完 + 表示用フォーマット
videoData.videoTitle  = videoData.videoTitle  || "動画";
videoData.channelName = videoData.channelName || "Unknown";
videoData.videoDes    = videoData.videoDes    || "";
videoData.videoViews  = Number(videoData.videoViews) || 0;
videoData.likeCount   = Number(videoData.likeCount) || 0;
videoData.viewsText   = videoData.videoViews > 0 ? formatCountJa(videoData.videoViews) : "";
videoData.likesText   = videoData.likeCount > 0 ? formatCountJa(videoData.likeCount) : "";
if (!commentsData) commentsData = { commentCount: 0, comments: [] };
if (!Array.isArray(commentsData.comments)) commentsData.comments = [];
let isShortForm = videoData.videoTitle.includes('#');

if (isShortForm) {
    try {
        const shortCheckRes = await fetchWithTimeout(
            `${protocol}://${host}/short-check/${videoId}`,
            {},
            5000
        );

        if (shortCheckRes.ok) {
            const shortCheckData = await shortCheckRes.json();

            isShortForm = shortCheckData.isShort === true;
        } else {
            isShortForm = false;
        }

    } catch (e) {
        console.warn('ショート判定失敗:', e);
        isShortForm = false;
    }
}

    if (isShortForm) {
const shortsHtml = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${videoData.videoTitle}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; color: #fff; font-family: "Roboto", sans-serif; overflow: hidden; }
        .shorts-wrapper { position: relative; width: 100%; height: 100%; display: flex; justify-content: center; align-items: center; background: #000; }
        .video-container { position: relative; height: 94vh; aspect-ratio: 9/16; background: #000; border-radius: 12px; overflow: hidden; box-shadow: 0 0 20px rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 10; }
        @media (max-width: 600px) { .video-container { height: 100%; width: 100%; border-radius: 0; } }
        /* 動画を常に最前面へ */
        video, iframe { width: 100%; height: 100%; object-fit: cover; border: none; position: relative; z-index: 11; visibility: hidden; }
        .progress-container { position: absolute; bottom: 0; left: 0; width: 100%; height: 2px; background: rgba(255,255,255,0.2); z-index: 25; }
        .progress-bar { height: 100%; background: #ff0000; width: 0%; transition: width 0.1s linear; }
        .bottom-overlay { position: absolute; bottom: 0; left: 0; width: 100%; padding: 100px 16px 24px; background: linear-gradient(transparent, rgba(0,0,0,0.8)); z-index: 20; pointer-events: none; }
        .bottom-overlay * { pointer-events: auto; }
        .channel-info { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
        .channel-info img { width: 32px; height: 32px; border-radius: 50%; }
        .channel-name { font-weight: 500; font-size: 15px; }
        .subscribe-btn { background: #fff; color: #000; border: none; padding: 6px 12px; border-radius: 18px; font-size: 12px; font-weight: bold; cursor: pointer; margin-left: 8px; }
        .video-title { font-size: 14px; line-height: 1.4; margin-bottom: 8px; font-weight: 400; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .side-bar { position: absolute; right: 8px; bottom: 80px; display: flex; flex-direction: column; gap: 16px; align-items: center; z-index: 30; }
        .action-btn { display: flex; flex-direction: column; align-items: center; cursor: pointer; }
        .btn-icon { width: 44px; height: 44px; background: rgba(255,255,255,0.12); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; transition: 0.2s; margin-bottom: 4px; }
        .btn-icon:active { transform: scale(0.9); background: rgba(255,255,255,0.25); }
        .action-btn span { font-size: 11px; text-shadow: 0 1px 2px rgba(0,0,0,0.8); font-weight: 400; }
        .swipe-hint { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,0.6); padding: 12px 20px; border-radius: 30px; display: flex; align-items: center; gap: 10px; z-index: 50; opacity: 0; pointer-events: none; transition: opacity 0.5s; border: 1px solid rgba(255,255,255,0.2); }
        .swipe-hint.show { opacity: 1; animation: bounce 2s infinite; }
        @keyframes bounce { 0%, 100% { transform: translate(-50%, -50%); } 50% { transform: translate(-50%, -60%); } }
        .comments-panel { position: absolute; bottom: 0; left: 0; width: 100%; height: 70%; background: #181818; border-radius: 16px 16px 0 0; z-index: 40; transform: translateY(100%); transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); display: flex; flex-direction: column; }
        .comments-panel.open { transform: translateY(0); }
        .comments-header { padding: 16px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
        .comments-body { flex: 1; overflow-y: auto; padding: 16px; }
        .comment-item { display: flex; gap: 12px; margin-bottom: 18px; }
        .comment-avatar { width: 32px; height: 32px; border-radius: 50%; }
        .top-nav { position: absolute; top: 16px; left: 16px; z-index: 35; display: flex; align-items: center; color: white; text-decoration: none; }
        .top-nav i { font-size: 20px; filter: drop-shadow(0 0 4px rgba(0,0,0,0.5)); }
        .loading-screen { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #000; z-index: 100; display: flex; align-items: center; justify-content: center; opacity: 1; transition: 0.3s; }
        .loading-screen.fade { opacity: 0; pointer-events: none; }
    </style>
</head>
<body>
    <div id="loader" class="loading-screen"><i class="fas fa-circle-notch fa-spin fa-2x"></i></div>
    <div class="shorts-wrapper">
        <div class="video-container">
            <a href="/" class="top-nav"><i class="fas fa-arrow-left"></i></a>
            <div id="swipeHint" class="swipe-hint"><i class="fas fa-hand-pointer"></i><span>下にスワイプして次の動画へ移動</span></div>
            
            ${videoData.stream_url !== "youtube-nocookie" 
                ? `<video id="videoPlayer" data-src="${videoData.stream_url}" loop playsinline></video>` 
                : `<iframe id="videoIframe" data-src="https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&controls=0&loop=1&playlist=${videoId}&modestbranding=1&rel=0" allow="autoplay"></iframe>`}
            
            <div class="progress-container"><div id="progressBar" class="progress-bar"></div></div>
            <div class="side-bar">
                <div class="action-btn"><div class="btn-icon"><i class="fas fa-thumbs-up"></i></div><span>${videoData.likeCount || '評価'}</span></div>
                <div class="action-btn"><div class="btn-icon"><i class="fas fa-thumbs-down"></i></div><span>低評価</span></div>
                <div class="action-btn" onclick="toggleComments()"><div class="btn-icon"><i class="fas fa-comment-dots"></i></div><span>${commentsData.commentCount || 0}</span></div>
                <div class="action-btn"><div class="btn-icon"><i class="fas fa-share"></i></div><span>共有</span></div>
                <div class="action-btn"><div class="btn-icon" style="background:none;"><img src="${videoData.channelImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=random&color=fff&size=64&bold=true`}" style="width:30px; height:30px; border-radius:4px; border:2px solid #fff;" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=555&color=fff&size=64&bold=true'"></div></div>
            </div>
            <div class="bottom-overlay">
                <div class="channel-info"><img src="${videoData.channelImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=random&color=fff&size=64&bold=true`}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=555&color=fff&size=64&bold=true'"><a href="/channel/${encodeURIComponent(videoData.channelName)}" style="text-decoration:none;color:inherit;"><span class="channel-name">@${videoData.channelName}</span></a><button id="shortSubBtn" class="subscribe-btn" onclick="toggleShortSub()">登録</button></div>
                <div class="video-title">${videoData.videoTitle}</div>
            </div>
            <div id="commentsPanel" class="comments-panel">
                <div class="comments-header"><h3 style="margin:0; font-size:16px;">コメント</h3><i class="fas fa-times" style="cursor:pointer;" onclick="toggleComments()"></i></div>
                <div class="comments-body">
                    ${commentsData.comments.length > 0 ? commentsData.comments.map(c => `<div class="comment-item"><img class="comment-avatar" src="${c.authorThumbnails?.[0]?.url || 'https://via.placeholder.com/32'}"><div><div style="font-size:12px; color:#aaa; font-weight:bold;">${c.author}</div><div style="font-size:14px; margin-top:2px;">${c.content}</div></div></div>`).join('') : '<p style="text-align:center; color:#888;">コメントはありません</p>'}
                </div>
            </div>
        </div>
    </div>
    <script>
        let startY = 0;
        const loader = document.getElementById('loader');
        const commentsPanel = document.getElementById('commentsPanel');
        const swipeHint = document.getElementById('swipeHint');
        const progressBar = document.getElementById('progressBar');

        window.onload = async () => {
            // 設定から保存された再生方法を取得
            const savedMode = localStorage.getItem('playbackMode') || 'googlevideo';

            async function initShortsPlayer() {
                const videoEl = document.getElementById('videoPlayer');
                const iframeEl = document.getElementById('videoIframe');

                if (savedMode === 'youtube-nocookie') {
                    // youtube-nocookie: video要素があればiframeに差し替え
                    const targetIframe = iframeEl || document.createElement('iframe');
                    if (!iframeEl) {
                        targetIframe.id = 'videoIframe';
                        targetIframe.setAttribute('allow', 'autoplay');
                        targetIframe.setAttribute('allowfullscreen', '');
                        targetIframe.style.cssText = 'width:100%; height:100%; object-fit:cover; border:none; position:relative; z-index:11;';
                        if (videoEl) videoEl.replaceWith(targetIframe);
                        else document.querySelector('.video-container').insertBefore(targetIframe, document.querySelector('.progress-container'));
                    }
                    targetIframe.src = \`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&controls=0&loop=1&playlist=${videoId}&modestbranding=1&rel=0\`;
                    targetIframe.style.visibility = 'visible';

                } else if (savedMode !== 'googlevideo' && videoEl) {
                    // DL-Pro などその他のモード: エンドポイントからURLを取得して再生
                    const endpointMap = { 'DL-Pro': '/360/${videoId}' };
                    const endpoint = endpointMap[savedMode];
                    if (endpoint) {
                        try {
                            const res = await fetch(endpoint);
                            if (res.ok) {
                                const url = await res.text();
                                videoEl.src = url;
                                videoEl.style.visibility = 'visible';
                                videoEl.play().catch(() => {});
                                videoEl.ontimeupdate = () => { const p = (videoEl.currentTime / videoEl.duration) * 100; progressBar.style.width = p + '%'; };
                                return;
                            }
                        } catch (e) {
                            console.warn('ショート: エンドポイント取得失敗、googlevideoにフォールバック', e);
                        }
                    }
                    // フォールバック: googlevideo
                    if (videoEl.dataset.src) {
                        videoEl.src = videoEl.dataset.src;
                        videoEl.style.visibility = 'visible';
                        videoEl.play().catch(() => {});
                        videoEl.ontimeupdate = () => { const p = (videoEl.currentTime / videoEl.duration) * 100; progressBar.style.width = p + '%'; };
                    }

                } else {
                    // デフォルト: googlevideo (またはサーバーがnocookieを返した場合はiframe)
                    if (videoEl && videoEl.dataset.src) {
                        videoEl.src = videoEl.dataset.src;
                        videoEl.style.visibility = 'visible';
                        videoEl.play().catch(() => {});
                        videoEl.ontimeupdate = () => { const p = (videoEl.currentTime / videoEl.duration) * 100; progressBar.style.width = p + '%'; };
                    }
                    if (iframeEl && iframeEl.dataset.src) {
                        iframeEl.src = iframeEl.dataset.src;
                        iframeEl.style.visibility = 'visible';
                    }
                }
            }

            await initShortsPlayer();
            loader.classList.add('fade');
            swipeHint.classList.add('show');
            setTimeout(() => { swipeHint.classList.remove('show'); }, 300);
        };

        function toggleComments() { commentsPanel.classList.toggle('open'); }
        // チャンネル登録機能（ショート）
        const SHORT_CHANNEL = "${videoData.channelName || ''}";
        const SHORT_SUB_KEY = 'subscribed_' + SHORT_CHANNEL;
        const shortSubBtn = document.getElementById('shortSubBtn');
        function updateShortSubBtn() {
          const isSub = localStorage.getItem(SHORT_SUB_KEY) === 'true';
          shortSubBtn.textContent = isSub ? '登録済み' : '登録';
          shortSubBtn.style.background = isSub ? 'rgba(255,255,255,0.3)' : '#fff';
          shortSubBtn.style.color = isSub ? '#fff' : '#000';
        }
        function toggleShortSub() {
          const isSub = localStorage.getItem(SHORT_SUB_KEY) === 'true';
          if (isSub) localStorage.removeItem(SHORT_SUB_KEY);
          else localStorage.setItem(SHORT_SUB_KEY, 'true');
          updateShortSubBtn();
        }
        updateShortSubBtn();
        async function loadNextShort() {
            if (commentsPanel.classList.contains('open')) return;
            loader.classList.remove('fade');
            try {
                const params = new URLSearchParams({ title: "${videoData.videoTitle}", channel: "${videoData.channelName}", id: "${videoId}" });
                const res = await fetch(\`/api/recommendations?\${params.toString()}\`);
                const data = await res.json();
                const nextShort = data.items.find(item => item.title.includes('#')) || data.items[0];
                if (nextShort) { window.location.href = '/video/' + nextShort.id; } else { window.location.href = '/'; }
            } catch (e) { window.location.href = '/'; }
        }
        window.addEventListener('touchstart', e => startY = e.touches[0].pageY);
        window.addEventListener('touchend', e => { const endY = e.changedTouches[0].pageY; if (startY - endY > 100) loadNextShort(); });
        window.addEventListener('wheel', e => { if (e.deltaY > 50) loadNextShort(); }, { passive: true });
        document.addEventListener('click', (e) => { if (commentsPanel.classList.contains('open') && !commentsPanel.contains(e.target) && !e.target.closest('.action-btn')) { toggleComments(); } });
    </script>
</body>
</html>`;
      return res.send(shortsHtml);
    }

    // --- STANDARD VIDEO MODE HTML (V3 完全再構築) ---
    const streamEmbedPlaceholder = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;"><div class="spinner"></div></div>`;

    // サーバー側で JSON 化しておく値（XSS/構文崩れ防止）
    const SAFE = {
      videoId: JSON.stringify(videoId),
      title: JSON.stringify(videoData.videoTitle || ""),
      channel: JSON.stringify(videoData.channelName || ""),
      channelId: JSON.stringify(videoData.channelId || ""),
      channelImage: JSON.stringify(videoData.channelImage || ""),
      streamUrl: JSON.stringify(videoData.stream_url || ""),
      description: JSON.stringify(videoData.videoDes || "")
    };

    const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${videoData.videoTitle} - YouTube</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
    <style>
        :root { --bg-main:#0f0f0f; --bg-secondary:#272727; --bg-hover:#3f3f3f; --text-main:#f1f1f1; --text-sub:#aaaaaa; --yt-red:#ff0000; --blue:#3ea6ff; }
        * { box-sizing:border-box; }
        body { margin:0; padding:0; background:var(--bg-main); color:var(--text-main); font-family:"Roboto","Arial",sans-serif; overflow-x:hidden; }
        a { color:inherit; }
        .navbar { position:fixed; top:0; width:100%; height:56px; background:var(--bg-main); display:flex; align-items:center; justify-content:space-between; padding:0 16px; box-sizing:border-box; z-index:1000; }
        .nav-left { display:flex; align-items:center; gap:16px; }
        .logo { display:flex; align-items:center; color:white; text-decoration:none; font-weight:bold; font-size:20px; letter-spacing:-1px; }
        .logo i { color:var(--yt-red); font-size:28px; margin-right:4px; }
        .nav-right-cluster { display:flex; align-items:center; gap:8px; }
        .nav-icon-btn { background:none; border:none; width:40px; height:40px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:background .15s; padding:0; }
        .nav-icon-btn:hover { background:var(--bg-secondary); }
        .nav-icon-btn svg { width:24px; height:24px; fill:var(--text-main); }
        .nav-avatar { width:32px; height:32px; border-radius:50%; background:linear-gradient(135deg,#3ea6ff,#065fd4); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:15px; text-decoration:none; }
        .nav-center { flex:0 1 640px; display:flex; position:relative; }
        .search-bar { display:flex; width:100%; background:#121212; border:1px solid #303030; border-radius:40px 0 0 40px; padding:0 16px; }
        .search-bar input { width:100%; background:transparent; border:none; color:white; height:40px; font-size:16px; outline:none; }
        .search-btn { background:#222; border:1px solid #303030; border-left:none; border-radius:0 40px 40px 0; width:64px; height:42px; color:white; cursor:pointer; }
        .autocomplete-dropdown { position:absolute; top:calc(100% + 4px); left:0; width:calc(100% - 64px); background:#212121; border-radius:12px; box-shadow:0 4px 32px rgba(0,0,0,0.5); z-index:2000; overflow:hidden; display:none; padding:8px 0; border:1px solid #303030; }
        .autocomplete-item { padding:8px 16px; display:flex; align-items:center; gap:12px; cursor:pointer; color:white; font-size:16px; }
        .autocomplete-item:hover { background:#3f3f3f; }
        .autocomplete-item i { color:#aaa; font-size:14px; }
        .container { margin-top:56px; display:flex; justify-content:center; padding:24px; gap:24px; max-width:1754px; margin-left:auto; margin-right:auto; }
        .main-content { flex:1; min-width:0; max-width:1280px; position:relative; }
        .sidebar { width:402px; flex-shrink:0; }
        .player-container { width:100%; aspect-ratio:16/9; background:black; border-radius:12px; overflow:hidden; position:relative; z-index:100; }
        .video-title { font-size:20px; font-weight:700; margin:12px 0 8px; line-height:28px; }
        .owner-row { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; flex-wrap:wrap; gap:8px; }
        .owner-info { display:flex; align-items:center; gap:12px; }
        .owner-info img { width:40px; height:40px; border-radius:50%; object-fit:cover; background:#333; }
        .channel-name { font-weight:600; font-size:16px; }
        .channel-sub { font-size:12px; color:var(--text-sub); }
        .btn-sub { background:white; color:black; border:none; padding:0 16px; height:36px; border-radius:18px; font-weight:600; cursor:pointer; margin-left:6px; }
        .actions-cluster { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
        .action-btn { background:var(--bg-secondary); border:none; color:white; padding:0 16px; height:36px; border-radius:18px; cursor:pointer; font-size:14px; font-weight:500; display:flex; align-items:center; gap:6px; transition:background .15s; }
        .action-btn:hover { background:var(--bg-hover); }
        .like-group { display:flex; align-items:center; background:var(--bg-secondary); border-radius:18px; overflow:hidden; }
        .like-group .action-btn { background:transparent; border-radius:0; }
        .like-group .like-btn { padding-right:12px; }
        .like-group .dislike-btn { padding:0 14px; }
        .like-divider { width:1px; height:22px; background:rgba(255,255,255,0.2); }
        .action-btn.ask { background:transparent; border:1px solid #303030; color:#fff; font-weight:600; }
        .action-btn.ask .ask-diamond { background:linear-gradient(135deg,#4285f4,#9b72cb,#d96570); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; font-size:15px; }
        .action-btn.ask:hover { background:var(--bg-secondary); }
        .description-box { background:var(--bg-secondary); border-radius:12px; padding:12px; font-size:14px; margin-bottom:24px; cursor:pointer; transition:background .2s; }
        .description-box:hover { background:#323232; }
        .description-content { max-height:60px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; margin-top:8px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
        .description-box.expanded .description-content { max-height:none; -webkit-line-clamp:unset; display:block; }
        .description-show-more { font-weight:700; margin-top:8px; font-size:14px; }
        .comments-header { display:flex; align-items:center; gap:24px; margin:8px 0 24px; }
        .comment-item { display:flex; gap:16px; margin-bottom:20px; }
        .comment-avatar { width:40px; height:40px; border-radius:50%; background:#333; object-fit:cover; flex-shrink:0; }
        .comment-author { font-weight:500; font-size:13px; margin-bottom:2px; display:inline-block; }
        .comment-time { color:var(--text-sub); font-size:12px; margin-left:6px; }
        .comment-text { font-size:14px; line-height:1.4; white-space:pre-wrap; word-break:break-word; }
        .comment-likes { font-size:12px; color:var(--text-sub); margin-top:6px; display:flex; align-items:center; gap:6px; }
        .comment-pinned { font-size:12px; color:var(--text-sub); margin-bottom:4px; }
        #commentsSentinel { height:40px; display:flex; align-items:center; justify-content:center; }
        .rec-item { display:flex; gap:8px; margin-bottom:8px; cursor:pointer; text-decoration:none; color:inherit; padding:6px; border-radius:12px; transition:background .15s; }
        .rec-item:hover { background:var(--bg-secondary); }
        .rec-thumb { width:168px; height:94px; flex-shrink:0; border-radius:8px; overflow:hidden; background:#222; position:relative; }
        .rec-thumb img { width:100%; height:100%; object-fit:cover; }
        .rec-info { display:flex; flex-direction:column; }
        .rec-title { font-size:14px; font-weight:600; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; margin-bottom:4px; }
        .rec-meta { font-size:12px; color:var(--text-sub); }
        .server-dropdown-container { position:relative; display:inline-block; }
        .btn-server, .btn-quality { background:var(--bg-secondary); color:var(--text-main); border:none; padding:0 14px; height:36px; border-radius:18px; font-weight:500; cursor:pointer; display:flex; align-items:center; gap:8px; font-size:14px; transition:background .2s; }
        .btn-server:hover, .btn-quality:hover { background:var(--bg-hover); }
        .server-menu, .quality-menu { display:none; position:absolute; top:calc(100% + 8px); left:0; background:var(--bg-secondary); border-radius:12px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.6); z-index:300; min-width:220px; border:1px solid #333; max-height:340px; overflow-y:auto; }
        .server-menu.show, .quality-menu.show { display:block; }
        .server-option, .quality-option { padding:11px 16px; cursor:pointer; font-size:14px; transition:background .15s; display:flex; align-items:center; justify-content:space-between; }
        .server-option:hover, .quality-option:hover { background:var(--bg-hover); }
        .server-option.active, .quality-option.active { background:#333; }
        .server-option.active::before, .quality-option.active::before { content:'✓'; margin-right:8px; color:var(--blue); }
        .quality-badge { font-size:10px; padding:1px 5px; border-radius:3px; background:var(--yt-red); color:#fff; font-weight:700; margin-left:8px; }
        .video-loading-overlay { position:absolute; inset:0; background:rgba(0,0,0,0.75); z-index:150; display:flex; flex-direction:column; align-items:center; justify-content:center; color:white; opacity:0; pointer-events:none; transition:opacity .3s ease; backdrop-filter:blur(2px); }
        .video-loading-overlay.active { opacity:1; pointer-events:auto; }
        /* 制限検知 → 音声ストリーム切替の通知バナー */
        .restrict-banner { position:absolute; left:50%; top:16px; transform:translateX(-50%) translateY(-16px); z-index:200; background:linear-gradient(135deg,#1f1147,#3a1f6b); border:1px solid rgba(162,107,255,0.5); color:#fff; padding:12px 18px; border-radius:12px; font-size:13.5px; font-weight:600; display:flex; align-items:center; gap:10px; box-shadow:0 8px 32px rgba(0,0,0,0.6); opacity:0; pointer-events:none; transition:opacity .3s, transform .3s; max-width:90%; text-align:left; line-height:1.5; }
        .restrict-banner.show { opacity:1; transform:translateX(-50%) translateY(0); }
        .restrict-banner .rb-orb { width:20px; height:20px; border-radius:50%; flex-shrink:0; background:conic-gradient(#a26bff,#4f8bff,#ff6bd6,#a26bff); animation:spin 1.4s linear infinite; }
        /* 音声のみモードのビジュアライザ画面 */
        .audio-mode { position:absolute; inset:0; z-index:20; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px; background:radial-gradient(ellipse at 50% 35%, #241546 0%, #0b0b12 70%); color:#fff; text-align:center; padding:20px; }
        .audio-mode .am-disc { width:120px; height:120px; border-radius:50%; background:conic-gradient(#a26bff,#4f8bff,#ff6bd6,#a26bff); display:flex; align-items:center; justify-content:center; box-shadow:0 0 40px rgba(162,107,255,0.5); animation:spin 6s linear infinite; }
        .audio-mode.paused .am-disc { animation-play-state:paused; }
        .audio-mode .am-disc svg { width:44px; height:44px; fill:#fff; }
        .audio-mode .am-bars { display:flex; gap:5px; align-items:flex-end; height:40px; }
        .audio-mode .am-bars span { width:5px; background:linear-gradient(#a26bff,#4f8bff); border-radius:3px; animation:ambar 1s ease-in-out infinite; }
        .audio-mode.paused .am-bars span { animation-play-state:paused; height:8px !important; }
        @keyframes ambar { 0%,100%{ height:8px; } 50%{ height:40px; } }
        .audio-mode .am-title { font-size:15px; font-weight:700; max-width:80%; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
        .audio-mode .am-badge { font-size:11.5px; color:#c8aaff; letter-spacing:.5px; display:flex; align-items:center; gap:6px; }
        .audio-mode .am-controls { display:flex; align-items:center; gap:18px; margin-top:4px; }
        .audio-mode .am-btn { background:rgba(255,255,255,0.08); border:none; color:#fff; width:52px; height:52px; border-radius:50%; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background .15s; }
        .audio-mode .am-btn:hover { background:rgba(255,255,255,0.18); }
        .audio-mode .am-btn svg { width:26px; height:26px; fill:#fff; }
        .audio-mode .am-btn.play { width:64px; height:64px; background:#fff; }
        .audio-mode .am-btn.play svg { fill:#1a1a1a; width:30px; height:30px; }
        .audio-mode .am-seek { width:min(80%,420px); display:flex; align-items:center; gap:10px; font-size:11px; color:#bbb; }
        .audio-mode .am-seek input { flex:1; accent-color:#a26bff; }
        .spinner { border:4px solid rgba(255,255,255,0.1); width:50px; height:50px; border-radius:50%; border-top-color:var(--yt-red); animation:spin 1s ease-in-out infinite; margin-bottom:16px; }
        @keyframes spin { to { transform:rotate(360deg); } }

        /* Shorts shelf */
        .shorts-shelf-container { margin-top:24px; border-top:2px solid var(--bg-secondary); padding-top:20px; margin-bottom:24px; }
        .shorts-shelf-title { display:flex; align-items:center; font-size:18px; font-weight:700; margin-bottom:16px; }
        .shorts-shelf-title svg { margin-right:8px; width:24px; height:24px; }
        .shorts-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:12px; }
        .short-card { text-decoration:none; color:inherit; }
        .short-thumb { aspect-ratio:9/16; border-radius:12px; overflow:hidden; background:#222; }
        .short-thumb img { width:100%; height:100%; object-fit:cover; }
        .short-title { font-size:14px; font-weight:500; line-height:1.4; margin-top:8px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }

        /* Auto-next toast */
        .autonext-toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%) translateY(120px); background:#212121; border:1px solid #3f3f3f; border-radius:12px; padding:14px 18px; z-index:5000; display:flex; align-items:center; gap:14px; box-shadow:0 8px 32px rgba(0,0,0,0.6); transition:transform .35s cubic-bezier(.2,.9,.2,1); max-width:360px; }
        .autonext-toast.show { transform:translateX(-50%) translateY(0); }
        .autonext-toast img { width:88px; height:50px; border-radius:6px; object-fit:cover; }
        .autonext-toast .an-title { font-size:13px; font-weight:600; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
        .autonext-toast .an-sub { font-size:11px; color:var(--text-sub); margin-top:2px; }
        .autonext-toast .an-cancel { background:none; border:1px solid #555; color:#fff; border-radius:16px; padding:4px 10px; font-size:12px; cursor:pointer; }
        .an-ring { width:34px; height:34px; flex-shrink:0; }

        /* Mix (Gemini generating effect) */
        /* Mix 再生パネル（YouTube本家風・フラットな濃いグレー） */
        .mix-card { border-radius:12px; overflow:hidden; margin-bottom:16px; background:#212121; border:1px solid #303030; }
        .mix-header { display:flex; align-items:flex-start; gap:10px; padding:14px 16px 12px; border-bottom:1px solid #303030; }
        .mix-header .mix-icon { width:24px; height:24px; margin-top:2px; flex-shrink:0; }
        .mix-title-txt { font-weight:700; font-size:16px; line-height:1.3; }
        .mix-sub-txt { font-size:12px; color:var(--text-sub); margin-top:3px; }
        .mix-head-actions { display:flex; flex-direction:column; gap:2px; margin-left:auto; }
        .mix-close, .mix-more { background:none; border:none; color:var(--text-main); font-size:14px; cursor:pointer; width:32px; height:32px; border-radius:50%; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
        .mix-close:hover, .mix-more:hover { background:rgba(255,255,255,0.1); }
        .mix-body { padding:6px; max-height:420px; overflow-y:auto; }
        .mix-body::-webkit-scrollbar { width:6px; } .mix-body::-webkit-scrollbar-thumb { background:#5a5a5a; border-radius:3px; }
        .mix-item { display:flex; gap:8px; padding:6px 8px; border-radius:8px; text-decoration:none; color:inherit; align-items:center; transition:background .15s; position:relative; }
        .mix-item:hover { background:var(--bg-hover); }
        .mix-item.playing { background:rgba(255,255,255,0.08); }
        .mix-thumb-box { position:relative; flex-shrink:0; }
        .mix-dur { position:absolute; bottom:3px; right:3px; background:rgba(0,0,0,0.8); color:#fff; font-size:10px; font-weight:600; padding:1px 3px; border-radius:3px; }
        .mix-idx { width:20px; text-align:center; font-size:12px; color:var(--text-sub); flex-shrink:0; display:flex; align-items:center; justify-content:center; }
        .mix-thumb { width:80px; height:46px; border-radius:6px; object-fit:cover; flex-shrink:0; background:#222; }
        .mix-it-title { font-size:13px; font-weight:500; line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
        .mix-it-ch { font-size:11px; color:var(--text-sub); margin-top:2px; }
        /* Gemini shimmer skeleton */
        .gem-gen { padding:16px 14px; }
        .gem-line { height:12px; border-radius:6px; margin:10px 0; background:linear-gradient(90deg,#2a2a2a 25%,#3d3d55 37%,#2a2a2a 63%); background-size:400% 100%; animation:gemShimmer 1.4s ease infinite; }
        .gem-line.w1{width:90%} .gem-line.w2{width:75%} .gem-line.w3{width:82%} .gem-line.w4{width:60%}
        @keyframes gemShimmer { 0%{background-position:100% 0} 100%{background-position:-100% 0} }
        .gem-orb { width:44px; height:44px; margin:0 auto 6px; border-radius:50%; background:conic-gradient(from 0deg,#4285f4,#9b72cb,#d96570,#4285f4); animation:spin 2.4s linear infinite; filter:blur(1px); }
        .gem-orb-wrap { text-align:center; padding:10px 0 4px; }
        .gem-caption { text-align:center; font-size:12px; color:#c8aaff; margin-bottom:6px; }

        /* Ask panel (YouTube風) */
        .ask-panel { position:fixed; right:0; top:0; height:100%; width:min(400px,100vw); background:var(--bg-main); border-left:1px solid #272727; z-index:6000; transform:translateX(100%); transition:transform .28s cubic-bezier(.2,.9,.2,1); display:flex; flex-direction:column; }
        .ask-panel.open { transform:translateX(0); }
        .ask-head { padding:14px 16px; display:flex; align-items:center; justify-content:space-between; }
        .ask-head .ask-brand { display:flex; align-items:center; gap:10px; font-weight:600; font-size:16px; }
        .ask-diamond-lg { background:linear-gradient(135deg,#4285f4,#9b72cb,#d96570); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; font-size:18px; }
        .ask-close { background:none; border:none; width:40px; height:40px; border-radius:50%; cursor:pointer; display:flex; align-items:center; justify-content:center; }
        .ask-close:hover { background:var(--bg-secondary); }
        .ask-close svg { width:22px; height:22px; fill:var(--text-main); }
        .ask-body { flex:1; overflow-y:auto; padding:8px 16px 16px; display:flex; flex-direction:column; gap:12px; }
        .ask-hero { text-align:center; padding:24px 12px 8px; }
        .ask-hero-diamond { font-size:40px; background:linear-gradient(135deg,#4285f4,#9b72cb,#d96570); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; margin-bottom:12px; }
        .ask-hero-title { font-size:17px; font-weight:600; margin-bottom:6px; }
        .ask-hero-sub { font-size:13px; color:var(--text-sub); line-height:1.5; }
        .ask-msg { max-width:90%; padding:10px 14px; border-radius:16px; font-size:14px; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
        .ask-msg.user { align-self:flex-end; background:var(--bg-secondary); border-bottom-right-radius:4px; }
        .ask-msg.ai { align-self:flex-start; background:transparent; padding-left:0; padding-right:0; }
        .ask-msg.ai.thinking { color:var(--text-sub); }
        .ask-suggest { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
        .ask-suggest button { background:transparent; border:1px solid #303030; color:var(--text-main); border-radius:20px; padding:10px 16px; font-size:13px; cursor:pointer; text-align:left; transition:background .15s; }
        .ask-suggest button:hover { background:var(--bg-secondary); }
        .ask-input-row { padding:12px 16px 16px; display:flex; gap:8px; align-items:center; }
        .ask-input-row input { flex:1; background:var(--bg-secondary); border:1px solid transparent; border-radius:24px; padding:0 18px; height:44px; color:var(--text-main); outline:none; font-size:14px; }
        .ask-input-row input:focus { border-color:#3ea6ff; }
        .ask-input-row button { background:var(--bg-secondary); border:none; color:var(--text-main); width:44px; height:44px; border-radius:50%; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:background .15s; }
        .ask-input-row button:hover { background:var(--bg-hover); }
        .ask-input-row button svg { width:22px; height:22px; fill:currentColor; }
        .ask-input-row button:disabled { opacity:.4; cursor:not-allowed; }
        .ask-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:5900; display:none; }
        .ask-backdrop.open { display:block; }
        /* コンパクト Mix カード (YouTube風・関連の一番下) */
        .compact-mix { margin-top:24px; border-radius:12px; overflow:hidden; }
        .compact-mix-inner { display:flex; gap:12px; padding:8px; border-radius:12px; text-decoration:none; color:inherit; transition:background .15s; cursor:pointer; }
        .compact-mix-inner:hover { background:var(--bg-secondary); }
        .cmix-thumb-wrap { position:relative; width:168px; flex-shrink:0; }
        .cmix-stack { position:relative; }
        .cmix-stack::before,.cmix-stack::after { content:''; position:absolute; left:50%; transform:translateX(-50%); border-radius:8px; }
        .cmix-stack::before { top:-6px; width:88%; height:12px; background:#3a3a3a; opacity:.5; }
        .cmix-stack::after { top:-3px; width:94%; height:12px; background:#4a4a4a; opacity:.8; }
        .cmix-thumb { position:relative; width:100%; aspect-ratio:16/9; border-radius:8px; overflow:hidden; background:#000; z-index:1; }
        .cmix-thumb img { width:100%; height:100%; object-fit:cover; }
        .cmix-badge { position:absolute; bottom:6px; right:6px; background:rgba(0,0,0,0.85); color:#fff; font-size:11px; font-weight:600; padding:3px 6px; border-radius:4px; display:flex; align-items:center; gap:4px; z-index:2; }
        .cmix-badge svg { width:13px; height:13px; fill:#fff; }
        .cmix-info { flex:1; min-width:0; padding-top:2px; }
        .cmix-title { font-size:15px; font-weight:700; line-height:1.3; margin-bottom:4px; }
        .cmix-artists { font-size:12.5px; color:var(--text-sub); line-height:1.5; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
        .cmix-gen { display:flex; align-items:center; gap:12px; padding:12px 8px; }
        .cmix-gen-orb { width:28px; height:28px; border-radius:50%; flex-shrink:0; background:conic-gradient(from 0deg,#5a7fd6,#8a7fc0,#c07f9a,#5a7fd6); animation:spin 2.6s linear infinite; opacity:.9; }
        .cmix-gen-txt { font-size:13px; font-weight:600; }
        .cmix-gen-sub { font-size:11px; color:var(--text-sub); margin-top:2px; }
        .compact-mix.pending .compact-mix-inner { position:relative; border:1px solid #303030; background:var(--bg-secondary); }
        .compact-mix.pending .compact-mix-inner:hover { background:var(--bg-hover); }
        /* 関連の一番下・目立たない「+プレイリスト」ボタン */
        .add-pl-btn { display:flex; align-items:center; justify-content:center; gap:7px; width:100%; margin:12px 0 4px; padding:9px 14px; background:transparent; border:1px solid #313131; color:var(--text-sub); border-radius:18px; font-size:13px; font-weight:500; cursor:pointer; font-family:inherit; transition:background .15s,color .15s,border-color .15s; }
        .add-pl-btn:hover { background:var(--bg-secondary); color:var(--text-main); border-color:#4a4a4a; }
        .add-pl-btn svg { width:15px; height:15px; fill:currentColor; }
        .add-pl-btn .spark { font-size:13px; }
        .add-pl-btn:disabled { opacity:.6; cursor:default; }
        /* Gemini 生成の特別カード（控えめに特別感） */
        .gemini-pl { position:relative; margin-top:12px; border-radius:14px; overflow:hidden; border:1px solid transparent;
          background:linear-gradient(#181818,#181818) padding-box, linear-gradient(120deg,#4285F4,#9b72cb,#d96570) border-box; }
        body.light-mode .gemini-pl { background:linear-gradient(#fff,#fff) padding-box, linear-gradient(120deg,#4285F4,#9b72cb,#d96570) border-box; }
        .gemini-pl .compact-mix-inner:hover { background:rgba(255,255,255,0.04); }
        .gemini-pl-tag { display:inline-flex; align-items:center; gap:5px; font-size:10.5px; font-weight:700; letter-spacing:.3px;
          background:linear-gradient(120deg,#4285F4,#9b72cb,#d96570); -webkit-background-clip:text; background-clip:text; color:transparent; margin-bottom:3px; }
        .gemini-pl-tag svg { width:12px; height:12px; }
        .cmix-dismiss { position:absolute; top:6px; right:6px; background:rgba(0,0,0,0.5); border:none; color:#fff; width:24px; height:24px; border-radius:50%; cursor:pointer; font-size:12px; line-height:1; display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity .15s; }
        .compact-mix.pending:hover .cmix-dismiss { opacity:1; }
        /* 設定モーダル (YouTube風) */
        .yt-modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:7000; display:flex; align-items:center; justify-content:center; }
        .yt-modal { background:#282828; border-radius:12px; width:min(440px,92vw); overflow:hidden; box-shadow:0 8px 40px rgba(0,0,0,0.6); }
        .yt-modal-head { padding:18px 24px; font-size:18px; font-weight:600; border-bottom:1px solid #3f3f3f; }
        .yt-modal-body { padding:8px 24px 20px; }
        .yt-setting-row { display:flex; align-items:center; justify-content:space-between; padding:16px 0; }
        .yt-setting-row + .yt-setting-row { border-top:1px solid #3f3f3f; }
        .yt-setting-label { font-weight:500; font-size:15px; }
        .yt-setting-desc { font-size:12.5px; color:var(--text-sub); margin-top:3px; max-width:280px; }
        .yt-switch { position:relative; width:46px; height:26px; flex-shrink:0; }
        .yt-switch input { opacity:0; width:0; height:0; }
        .yt-switch .slider { position:absolute; inset:0; background:#606060; border-radius:26px; transition:.2s; cursor:pointer; }
        .yt-switch .slider::before { content:''; position:absolute; width:20px; height:20px; left:3px; top:3px; background:#fff; border-radius:50%; transition:.2s; }
        .yt-switch input:checked + .slider { background:#3ea6ff; }
        .yt-switch input:checked + .slider::before { transform:translateX(20px); }
        .yt-modal-foot { padding:12px 24px 18px; text-align:right; }
        .yt-modal-foot button { background:none; border:none; color:#3ea6ff; font-weight:600; font-size:14px; padding:8px 16px; border-radius:18px; cursor:pointer; font-family:inherit; }
        .yt-modal-foot button:hover { background:rgba(62,166,255,0.1); }
        .dots::after { content:'…'; animation:dots 1.2s steps(4,end) infinite; }
        @keyframes dots { 0%{content:''} 25%{content:'.'} 50%{content:'..'} 75%{content:'...'} }

        @media (max-width:1000px) {
            .container { flex-direction:column; padding:0; }
            .main-content { max-width:100%; padding:16px; }
            .sidebar { width:100%; padding:16px; }
            .player-container { border-radius:0; }
            .nav-center { display:none; }
            .rec-thumb { width:160px; height:90px; }
        }
    </style>
</head>
<body>
<nav class="navbar">
    <div class="nav-left"><a href="/" class="logo"><i class="fab fa-youtube"></i>YouTube</a></div>
    <div class="nav-center">
        <form class="search-bar" onsubmit="event.preventDefault(); const q=this.querySelector('input').value.trim(); if(q) location.href='/?q='+encodeURIComponent(q);">
            <input type="text" id="searchInput" placeholder="検索" autocomplete="off">
            <button type="submit" class="search-btn"><i class="fas fa-search"></i></button>
        </form>
        <div id="autocompleteDropdown" class="autocomplete-dropdown"></div>
    </div>
    <div class="nav-right-cluster">
        <button class="nav-icon-btn" title="設定" onclick="openSettings()" aria-label="設定">
            <svg viewBox="0 0 24 24"><path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/></svg>
        </button>
        <a href="/" class="nav-avatar" title="ホーム">C</a>
    </div>
</nav>

<div class="container">
    <div class="main-content">
        <div class="player-container">
            <div id="playerWrapper" style="width:100%; height:100%;">${streamEmbedPlaceholder}</div>
            <div id="restrictBanner" class="restrict-banner"><div class="rb-orb"></div><span id="restrictBannerText">制限を検知しました。1秒後に音声ストリームのみに切り替わります…</span></div>
            <div id="videoLoadingOverlay" class="video-loading-overlay">
                <div class="spinner"></div>
                <div style="font-weight:700; font-size:16px;">動画サーバーに接続中...</div>
            </div>
        </div>
        <h1 class="video-title">${videoData.videoTitle}</h1>
        <div class="owner-row">
            <div class="owner-info">
                <a href="/channel/${encodeURIComponent(videoData.channelName)}" style="display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;">
                  <img id="ownerAvatar" src="${videoData.channelImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=random&color=fff&size=80&bold=true`}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=555&color=fff&size=80&bold=true'">
                  <div><div class="channel-name">${videoData.channelName}</div><div class="channel-sub" id="subCountTxt"></div></div>
                </a>
                <button id="subBtn" class="btn-sub" onclick="toggleSubscribeVideo()">チャンネル登録</button>
            </div>
            <div class="actions-cluster">
                <button class="action-btn ask" onclick="openAsk()"><span class="ask-diamond">◆</span> Ask</button>
                <div class="like-group">
                    <button class="action-btn like-btn" id="likeBtn" onclick="toggleLike()"><i class="fas fa-thumbs-up"></i> <span id="likeTxt">${videoData.likesText || '高評価'}</span></button>
                    <span class="like-divider"></span>
                    <button class="action-btn dislike-btn" title="低評価"><i class="fas fa-thumbs-down"></i></button>
                </div>
                <button class="action-btn"><i class="fas fa-share"></i> 共有</button>
                <div class="server-dropdown-container">
                    <button class="btn-quality" id="qualityBtn" onclick="toggleQualityMenu()"><i class="fas fa-gauge-high"></i> <span id="qualityLabel">画質</span> <i class="fas fa-chevron-down" style="font-size:11px;"></i></button>
                    <div id="qualityMenu" class="quality-menu"></div>
                </div>
                <div class="server-dropdown-container">
                    <button class="btn-server" onclick="toggleServerMenu()"><i class="fas fa-server"></i> サーバー <i class="fas fa-chevron-down" style="font-size:11px;"></i></button>
                    <div id="serverMenu" class="server-menu">
                        <div class="server-option active" onclick="changeServer('googlevideo','',event)">Googlevideo</div>
                        <div class="server-option" onclick="changeServer('youtube-nocookie','/nocookie/${videoId}',event)">Youtube-nocookie</div>
                        <div class="server-option" onclick="changeServer('DL-Pro','/360/${videoId}',event)">DL-Pro</div>
                        <div class="server-option" onclick="changeServer('YoutubeEdu-Kahoot','/kahoot-edu/${videoId}',event)">YoutubeEdu-Kahoot</div>
                        <div class="server-option" onclick="changeServer('YoutubeEdu-Scratch','/scratch-edu/${videoId}',event)">YoutubeEdu-Scratch</div>
                        <div class="server-option" onclick="changeServer('Youtube-Pro','/pro-stream/${videoId}',event)">Youtube-Pro</div>
                        <div class="server-option" onclick="changeServer('Elixir-Network','/stream-network/${videoId}',event)">Elixir-Network</div>
                    </div>
                </div>
            </div>
        </div>
        <div class="description-box" id="descriptionBox" onclick="toggleDescription(event)">
            <b>${videoData.viewsText ? videoData.viewsText + ' 回視聴' : '再生回数を取得中'}</b>
            <div class="description-content" id="descriptionContent">${(videoData.videoDes || '概要欄はありません').replace(/</g,'&lt;').replace(/\r\n|\n|\r/g, '<br>')}</div>
            <div class="description-show-more" id="descriptionToggleBtn">...もっと見る</div>
        </div>
        <div class="comments-header">
            <h3 style="margin:0;" id="commentsCountHead">コメント</h3>
        </div>
        <div id="commentsList"></div>
        <div id="commentsSentinel"></div>
    </div>
    <div class="sidebar">
        <div id="mixContainerTop"></div>
        <div id="recommendations"></div>
        <div id="mixContainer"></div>
        <div id="plGenSlot"></div>
        <div id="addPlaylistSlot"></div>
        <div id="shortsShelf" class="shorts-shelf-container" style="display:none;">
            <div class="shorts-shelf-title">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="red"><path d="M17.77,10.32l-1.2-.5L18,9.06a3.74,3.74,0,0,0-3.5-6.62L6,6.94a3.74,3.74,0,0,0,.23,6.74l1.2.49L6,14.93a3.75,3.75,0,0,0,3.5,6.63l8.5-4.5a3.74,3.74,0,0,0-.23-6.74Z"/><polygon points="10 14.65 15 12 10 9.35 10 14.65" fill="#fff"/></svg>
                Shorts
            </div>
            <div id="shortsGrid" class="shorts-grid"></div>
        </div>
    </div>
</div>

<!-- Auto-next toast -->
<div class="autonext-toast" id="autoNextToast">
    <svg class="an-ring" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="none" stroke="#3f3f3f" stroke-width="3"/><circle id="anRingProg" cx="18" cy="18" r="16" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-dasharray="100.5" stroke-dashoffset="100.5" transform="rotate(-90 18 18)"/></svg>
    <img id="anThumb" src="" alt="">
    <div style="flex:1;min-width:0;"><div style="font-size:11px;color:var(--text-sub);">まもなく次を再生</div><div class="an-title" id="anTitle"></div><div class="an-sub" id="anSub"></div></div>
    <button class="an-cancel" onclick="cancelAutoNext()">キャンセル</button>
</div>

<!-- Ask panel -->
<div class="ask-backdrop" id="askBackdrop" onclick="closeAsk()"></div>
<div class="ask-panel" id="askPanel">
    <div class="ask-head">
        <div class="ask-brand"><span class="ask-diamond-lg">◆</span> <span>この動画について質問する</span></div>
        <button class="ask-close" onclick="closeAsk()" aria-label="閉じる"><svg viewBox="0 0 24 24"><path d="M18.3 5.71L12 12.01l-6.3-6.3-1.41 1.41L10.59 13.4l-6.3 6.3 1.41 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.3z"/></svg></button>
    </div>
    <div class="ask-body" id="askBody">
        <div class="ask-hero">
            <div class="ask-hero-diamond">◆</div>
            <div class="ask-hero-title">この動画について何でも聞いてください</div>
            <div class="ask-hero-sub">タイトルと視聴者の上位コメントをもとに回答します。</div>
        </div>
        <div class="ask-suggest" id="askSuggest">
            <button onclick="askQuick(this)">この動画は何について？</button>
            <button onclick="askQuick(this)">要点を3つで教えて</button>
            <button onclick="askQuick(this)">みんなの感想は？</button>
        </div>
    </div>
    <div class="ask-input-row">
        <input type="text" id="askInput" placeholder="質問を入力..." onkeydown="if(event.key==='Enter')sendAsk()">
        <button id="askSend" onclick="sendAsk()" aria-label="送信"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
    </div>
</div>

<script>
    /* ===== サーバー注入データ ===== */
    const VIDEO_ID   = ${SAFE.videoId};
    const VIDEO_TITLE= ${SAFE.title};
    const VIDEO_CH   = ${SAFE.channel};
    const VIDEO_CHID = ${SAFE.channelId};
    const VIDEO_CHIMG= ${SAFE.channelImage};
    const STREAM_URL = ${SAFE.streamUrl};
    const VIDEO_DESC = ${SAFE.description};

    /* ===== 設定 (localStorage) ===== */
    const SETTINGS = {
      get autoNext(){ return localStorage.getItem('setting_autonext') === 'true'; },
      set autoNext(v){ localStorage.setItem('setting_autonext', v ? 'true':'false'); }
    };

    /* ===== 音声同期プレイヤー状態 ===== */
    let QUALITY_DATA = null;      // /api/qualities のレスポンス
    let currentQuality = null;    // 選択中の画質ラベル
    let syncAudioEl = null;       // 高画質時の別音声トラック
    let mainVideoEl = null;

    /* =================================================================
     *  サーバー / 画質メニュー
     * ================================================================= */
    function toggleServerMenu(){ document.getElementById('serverMenu').classList.toggle('show'); document.getElementById('qualityMenu').classList.remove('show'); }
    let qualityLoading=false;
    async function toggleQualityMenu(){
      const menu=document.getElementById('qualityMenu');
      document.getElementById('serverMenu').classList.remove('show');
      const willShow=!menu.classList.contains('show');
      menu.classList.toggle('show');
      // Orby-MAX は「画質」を押した時に初めて取得（負荷軽減）
      if(willShow && !QUALITY_DATA && !qualityLoading){
        qualityLoading=true;
        menu.innerHTML='<div class="quality-option" style="justify-content:center;"><div class="spinner" style="width:20px;height:20px;border-width:2px;margin:0;"></div></div>';
        await loadQualityMenu();
        qualityLoading=false;
      }
    }
    window.addEventListener('click', (e)=>{ if(!e.target.closest('.server-dropdown-container')){ document.querySelectorAll('.server-menu,.quality-menu').forEach(m=>m.classList.remove('show')); } });

    /* ===== チャンネル登録 ===== */
    const SUB_KEY_VIDEO = 'subscribed_' + VIDEO_CH;
    function updateSubBtnUI(){
      const isSub = localStorage.getItem(SUB_KEY_VIDEO) === 'true';
      const b = document.getElementById('subBtn');
      b.textContent = isSub ? '登録済み' : 'チャンネル登録';
      b.style.background = isSub ? '#272727' : 'white';
      b.style.color = isSub ? '#aaa' : 'black';
    }
    function toggleSubscribeVideo(){
      const isSub = localStorage.getItem(SUB_KEY_VIDEO) === 'true';
      if(isSub) localStorage.removeItem(SUB_KEY_VIDEO); else localStorage.setItem(SUB_KEY_VIDEO,'true');
      updateSubBtnUI();
    }
    updateSubBtnUI();

    let liked=false;
    function toggleLike(){ liked=!liked; document.getElementById('likeBtn').style.color = liked ? '#3ea6ff' : ''; }

    /* =================================================================
     *  プレイヤー生成 (サーバー切替 / 画質切替)
     * ================================================================= */
    function buildIframe(url){
      return \`<iframe id="mainIframe" src="\${url}" frameborder="0" allow="autoplay; encrypted-media; fullscreen" allowfullscreen style="width:100%;height:100%;position:relative;z-index:10;"></iframe>\`;
    }

    // googlevideo: 映像+音声を同期再生する <video>（+ 高画質時は隠し <audio>=別トラック mp3/m4a）
    // 高画質(itag>18)の映像には音声が無いため、別途取得した音声トラックを厳密に同期させる。
    let syncRafId = null;                 // 同期ループ (requestAnimationFrame)
    let savedVolume = 1;                  // ユーザー音量を保持
    let audioOnlyMode = false;            // 音声のみモードか
    let restrictHandled = false;          // 制限フォールバックを既に発火したか
    let playWatchdog = null;              // 再生開始ウォッチドッグ
    let currentServerName = 'googlevideo';

    function mountSyncedPlayer(videoUrl, audioUrl){
      const wrap = document.getElementById('playerWrapper');
      // 直前の同期ループ / 音声要素を確実に破棄
      teardownPlayers();

      wrap.innerHTML = \`
        <video id="mainPlayer" controls autoplay playsinline style="width:100%;height:100%;position:relative;z-index:10;background:#000;">
          <source src="\${videoUrl}" type="video/mp4">
        </video>\`;
      mainVideoEl = document.getElementById('mainPlayer');

      // 映像そのものの再生失敗（403/デコード不可/空）→ 音楽なら音声のみへ
      attachVideoFailureDetection(mainVideoEl);

      if(!audioUrl){
        // 音声込み(360p/itag18等) → そのまま再生
        mainVideoEl.muted = false;
        mainVideoEl.volume = savedVolume;
        attachEndedHandler(mainVideoEl);
        mainVideoEl.play && mainVideoEl.play().catch(()=>{});
        return;
      }

      /* ===== 別音声トラックを映像と厳密に同期 =====
       * 【修正】以前は 360P 以外で「音が出ない」問題があった:
       *   - a.play() が自動再生ポリシーで拒否されても再試行しなかった
       *   - 映像/音声の waiting でお互いを止め合いデッドロック → 音声が止まったまま
       *   - bestAudioUrl が期限切れ/空でも保険が無かった
       * ここを全面的に堅牢化する。 */
      const v = mainVideoEl;
      const a = document.createElement('audio');
      a.src = audioUrl;
      a.preload = 'auto';
      a.crossOrigin = 'anonymous';
      a.style.display = 'none';
      document.body.appendChild(a);
      syncAudioEl = a;

      v.muted = true;              // 実音声は audio トラックから
      a.volume = savedVolume;

      let audioReady = false;
      let userWantsPlay = true;    // 既定で再生を望む（autoplay）
      let audioFailed = false;

      const hardSync = ()=>{ try{ a.currentTime = v.currentTime; }catch(e){} };
      const tryPlayAudio = ()=>{ if(!audioFailed){ a.play().catch(()=>{}); } };

      const loop = ()=>{
        if(!syncAudioEl){ return; }
        if(!v.paused && audioReady && !audioFailed){
          // 映像が動いているのに音声が止まっていたら再開（デッドロック解消）
          if(a.paused) tryPlayAudio();
          const drift = a.currentTime - v.currentTime;
          if(Math.abs(drift) > 0.35){ hardSync(); a.playbackRate = 1; }
          else if(Math.abs(drift) > 0.06){ a.playbackRate = drift > 0 ? 0.95 : 1.05; }
          else { a.playbackRate = 1; }
        }
        syncRafId = requestAnimationFrame(loop);
      };

      // 音声トラックが一定時間で読めない/失敗 → プロキシ音声に差し替え、それも無理なら映像の内蔵音を使う
      let audioLoadTimer = setTimeout(()=>{
        if(!audioReady && !audioFailed){ swapAudioToProxy(); }
      }, 6000);

      function swapAudioToProxy(){
        // /audio-stream に切替（clipto→Orby フォールバック済みの安定音源）
        try{
          const proxied = '/audio-stream/' + VIDEO_ID;
          if(a.src.indexOf('/audio-stream/') === -1){
            a.src = proxied;
            a.load();
            tryPlayAudio();
            return;
          }
        }catch(e){}
        // プロキシもダメ → 最後の手段: 映像の内蔵音声を鳴らす（無音回避を最優先）
        audioFailed = true;
        try{ v.muted = false; v.volume = savedVolume; }catch(e){}
      }

      a.addEventListener('loadedmetadata', ()=>{ audioReady = true; clearTimeout(audioLoadTimer); hardSync(); tryPlayAudio(); });
      a.addEventListener('canplay', ()=>{ audioReady = true; clearTimeout(audioLoadTimer); if(v._pausedForAudio){ v._pausedForAudio=false; if(userWantsPlay) v.play().catch(()=>{}); } if(!v.paused) tryPlayAudio(); });
      a.addEventListener('canplaythrough', ()=>{ audioReady = true; clearTimeout(audioLoadTimer); });
      a.addEventListener('error', ()=>{ clearTimeout(audioLoadTimer); if(!audioFailed) swapAudioToProxy(); });

      v.addEventListener('play', ()=>{ userWantsPlay=true; hardSync(); tryPlayAudio(); });
      v.addEventListener('pause', ()=>{ userWantsPlay=false; a.pause(); });
      v.addEventListener('seeking', hardSync);
      v.addEventListener('seeked', ()=>{ hardSync(); if(!v.paused) tryPlayAudio(); });
      v.addEventListener('playing', ()=>{ hardSync(); if(!v.paused) tryPlayAudio(); });
      v.addEventListener('volumechange', ()=>{
        savedVolume = v.muted ? 0 : (v.volume||1);
        if(!audioFailed){ a.volume = v.muted ? 0 : v.volume; if(!v.muted) v.muted = true; }
      });
      // 映像がバッファ待ちのときだけ音声を止める（audio側waitingでは映像を止めない＝片方待ちの膠着を防止）
      v.addEventListener('waiting', ()=>{ if(!audioFailed) a.pause(); });

      attachEndedHandler(v);
      syncRafId = requestAnimationFrame(loop);
      v.play && v.play().catch(()=>{});
    }

    function teardownPlayers(){
      if(syncRafId){ cancelAnimationFrame(syncRafId); syncRafId=null; }
      if(playWatchdog){ clearTimeout(playWatchdog); playWatchdog=null; }
      if(syncAudioEl){ try{ syncAudioEl.pause(); syncAudioEl.src=''; syncAudioEl.remove(); }catch(e){} syncAudioEl=null; }
    }

    /* =================================================================
     *  制限検知 → 音声ストリーム自動フォールバック
     *  音楽動画は著作権で googlevideo / DL-Pro 等で再生できないことがある。
     *  「動画として埋め込めていない/再生が全く進まない」ことを検知したら、
     *  1秒の予告のあと自動で音声のみ (/audio-stream) に切替える。
     *  ・プレイリスト再生中は積極的に発火（音楽体験を止めない）
     *  ・プレイリスト外でも "露骨に" 再生できていなければ発火
     *  ・誤検知を避けるため「一度でも再生が進んだ」場合は発火しない
     * ================================================================= */
    function isMusicContext(){
      // プレイリスト(Mix)として再生中か、タイトル/チャンネルが音楽的か
      if(MIX_STATE && MIX_STATE.playlist && MIX_STATE.playlist.length) return true;
      const t=(VIDEO_TITLE||'')+' '+(VIDEO_CH||'');
      return /(official|mv|m\\/v|lyric|audio|feat|ft\\.|remix|cover|ミュージック|歌ってみた|カバー|ピアノ|piano|acoustic|vevo|- topic|song|music|オルゴール|弾いてみた)/i.test(t);
    }
    // 映像プレイヤーに失敗検知を仕込む
    function attachVideoFailureDetection(v){
      if(!v) return;
      let progressed = false;
      const markProgress = ()=>{ if(v.currentTime>0.4){ progressed=true; } };
      v.addEventListener('timeupdate', markProgress);

      // <video> の致命的エラー（デコード不可 / ソース無効 / ネットワーク）
      v.addEventListener('error', ()=>{ maybeFallbackToAudio('video-error'); });
      // <source> レベルのエラー
      const srcEl=v.querySelector('source');
      if(srcEl) srcEl.addEventListener('error', ()=>{ maybeFallbackToAudio('source-error'); });
      // stalled / suspend が続き、かつ全く進んでいない → 埋め込み失敗の可能性
      v.addEventListener('stalled', ()=>{ scheduleStallCheck(); });
      v.addEventListener('emptied', ()=>{ if(!progressed) maybeFallbackToAudio('emptied'); });

      let stallTimer=null;
      function scheduleStallCheck(){
        if(stallTimer) return;
        stallTimer=setTimeout(()=>{ stallTimer=null; if(!progressed && (v.readyState<2 || v.networkState===3)) maybeFallbackToAudio('stalled'); }, 3500);
      }

      // 起動ウォッチドッグ: 一定時間で1フレームも進まない = 露骨に再生できていない
      if(playWatchdog) clearTimeout(playWatchdog);
      // 音楽なら短め(積極的)、それ以外は長め(誤検知抑制)
      const grace = isMusicContext() ? 4500 : 8000;
      playWatchdog=setTimeout(()=>{
        if(!progressed && !audioOnlyMode){
          // 音楽なら即フォールバック。非音楽でも「readyStateが低く全く進まない」なら救済。
          if(isMusicContext() || v.readyState < 2) maybeFallbackToAudio('watchdog');
        }
      }, grace);
    }

    // フォールバック判定（対象サーバーが googlevideo / DL-Pro のとき）
    function maybeFallbackToAudio(reason){
      if(audioOnlyMode || restrictHandled) return;
      const eligibleServer = (currentServerName==='googlevideo' || currentServerName==='DL-Pro');
      // iframe系サーバーは対象外（自前<video>ではないため検知不可）
      if(!eligibleServer) return;
      // 音楽コンテキスト、または露骨な失敗(video-error/source-error/emptied)なら発火
      const blatant = (reason==='video-error'||reason==='source-error'||reason==='emptied');
      if(!isMusicContext() && !blatant) return;
      restrictHandled = true;
      showRestrictBannerThenAudio();
    }

    function showRestrictBannerThenAudio(){
      const banner=document.getElementById('restrictBanner');
      const txt=document.getElementById('restrictBannerText');
      if(txt) txt.textContent='再生の制限を検知しました。1秒後に音声ストリームのみに切り替わります…';
      if(banner) banner.classList.add('show');
      setTimeout(()=>{ if(banner) banner.classList.remove('show'); enterAudioOnly(); }, 1000);
    }

    // 音声のみモードへ突入（/audio-stream をソースにしたオーディオプレイヤー + ビジュアライザ）
    async function enterAudioOnly(){
      if(audioOnlyMode) return;
      audioOnlyMode = true;
      teardownPlayers();
      const wrap=document.getElementById('playerWrapper');
      const bars = Array.from({length:9}).map((_,i)=>\`<span style="animation-delay:\${(i*0.09).toFixed(2)}s;height:\${8+((i*7)%32)}px;"></span>\`).join('');
      wrap.innerHTML=\`
        <div class="audio-mode" id="audioMode">
          <div class="am-disc"><svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>
          <div class="am-bars">\${bars}</div>
          <div class="am-title">\${escHtml(VIDEO_TITLE)}</div>
          <div class="am-badge">🎧 音声ストリーム再生中（制限回避）</div>
          <div class="am-seek"><span id="amCur">0:00</span><input id="amSeek" type="range" min="0" max="1000" value="0"><span id="amDur">0:00</span></div>
          <div class="am-controls">
            <button class="am-btn" id="amBack" title="10秒戻る"><svg viewBox="0 0 24 24"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/></svg></button>
            <button class="am-btn play" id="amPlay" title="再生/一時停止"><svg viewBox="0 0 24 24" id="amPlayIcon"><path d="M8 5v14l11-7z"/></svg></button>
            <button class="am-btn" id="amFwd" title="10秒進む"><svg viewBox="0 0 24 24"><path d="M13 6v12l8.5-6L13 6zM4 18l8.5-6L4 6v12z"/></svg></button>
          </div>
        </div>\`;

      const audio=document.createElement('audio');
      audio.src='/audio-stream/'+VIDEO_ID;
      audio.preload='auto';
      audio.autoplay=true;
      audio.volume=savedVolume||1;
      audio.style.display='none';
      document.body.appendChild(audio);
      syncAudioEl=audio;

      const mode=document.getElementById('audioMode');
      const playIcon=document.getElementById('amPlayIcon');
      const seek=document.getElementById('amSeek');
      const curEl=document.getElementById('amCur');
      const durEl=document.getElementById('amDur');
      const fmt=(s)=>{ s=Math.floor(s||0); const m=Math.floor(s/60); const ss=('0'+(s%60)).slice(-2); return m+':'+ss; };
      const setIcon=(playing)=>{ playIcon.innerHTML = playing ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>' : '<path d="M8 5v14l11-7z"/>'; mode.classList.toggle('paused', !playing); };

      document.getElementById('amPlay').onclick=()=>{ if(audio.paused) audio.play().catch(()=>{}); else audio.pause(); };
      document.getElementById('amBack').onclick=()=>{ audio.currentTime=Math.max(0,audio.currentTime-10); };
      document.getElementById('amFwd').onclick=()=>{ audio.currentTime=Math.min(audio.duration||1e9,audio.currentTime+10); };
      audio.addEventListener('play', ()=>setIcon(true));
      audio.addEventListener('pause', ()=>setIcon(false));
      audio.addEventListener('loadedmetadata', ()=>{ durEl.textContent=fmt(audio.duration); });
      audio.addEventListener('timeupdate', ()=>{ if(audio.duration){ seek.value=Math.round(audio.currentTime/audio.duration*1000); curEl.textContent=fmt(audio.currentTime); } });
      seek.addEventListener('input', ()=>{ if(audio.duration){ audio.currentTime=seek.value/1000*audio.duration; } });
      // 音声が終わったら Mix の次へ（プレイリスト体験を維持）
      audio.addEventListener('ended', onVideoEnded);
      audio.play().catch(()=>{ setIcon(false); });
      setIcon(true);
      // 音声すら取得できない場合（極めて稀）: nocookie 埋め込みに退避
      audio.addEventListener('error', ()=>{
        const badge=mode && mode.querySelector('.am-badge');
        if(badge) badge.textContent='⚠️ 音声の取得に失敗しました。埋め込み再生に切替えます…';
        setTimeout(()=>{ wrap.innerHTML = buildIframe('https://www.youtube-nocookie.com/embed/'+VIDEO_ID+'?autoplay=1'); }, 1200);
      });
    }
    // 手動でも音声のみへ切替できるよう公開
    window.forceAudioOnly=()=>{ restrictHandled=true; enterAudioOnly(); };

    async function loadQualityMenu(){
      try{
        const res = await fetch('/api/qualities/'+VIDEO_ID);
        if(!res.ok) throw new Error('quality fetch fail');
        QUALITY_DATA = await res.json();
        renderQualityMenu();
      }catch(e){ console.warn('画質リスト取得失敗', e); document.getElementById('qualityBtn').style.display='none'; }
    }

    function renderQualityMenu(){
      if(!QUALITY_DATA || !QUALITY_DATA.videoStreams || !QUALITY_DATA.videoStreams.length){ document.getElementById('qualityBtn').style.display='none'; return; }
      // mp4 の映像を画質ごとに1つずつ（重複排除、高い順）
      const seen=new Set(); const list=[];
      for(const v of QUALITY_DATA.videoStreams){
        if(v.container!=='mp4') continue;
        if(seen.has(v.quality)) continue;
        seen.add(v.quality); list.push(v);
      }
      const menu=document.getElementById('qualityMenu');
      menu.innerHTML = list.map(v=>{
        const needsAudio = !v.hasAudio;
        return \`<div class="quality-option" data-q="\${v.quality}" data-itag="\${v.itag}" onclick="selectQuality('\${v.quality}',\${v.itag})">
          <span>\${v.quality}\${v.heightNum>=1080?' <span class="quality-badge">HD</span>':''}</span>
          <span style="font-size:11px;color:#888;">\${needsAudio?'映像+音声同期':'標準'}</span>
        </div>\`;
      }).join('');
    }

    function selectQuality(quality, itag){
      document.getElementById('qualityMenu').classList.remove('show');
      const v = QUALITY_DATA.videoStreams.find(s=>s.quality===quality && s.itag===itag && s.container==='mp4')
             || QUALITY_DATA.videoStreams.find(s=>s.quality===quality);
      if(!v){ return; }
      currentQuality = quality;
      document.getElementById('qualityLabel').textContent = quality;
      document.querySelectorAll('.quality-option').forEach(o=>o.classList.toggle('active', o.dataset.q===quality && o.dataset.itag==itag));

      const overlay=document.getElementById('videoLoadingOverlay'); overlay.classList.add('active');
      const wasTime = mainVideoEl ? mainVideoEl.currentTime : 0;
      const wasPaused = mainVideoEl ? mainVideoEl.paused : false;
      // 音声込みの画質(360p等)はそのまま。それ以外は必ず別音声を同期。
      // 【修正】bestAudioUrl が空でも無音にならないよう、自前プロキシ音声にフォールバック。
      const audioUrl = v.hasAudio ? '' : (QUALITY_DATA.bestAudioUrl || ('/audio-stream/' + VIDEO_ID));
      mountSyncedPlayer(v.url, audioUrl);
      if(mainVideoEl){
        mainVideoEl.addEventListener('loadedmetadata', ()=>{
          try{ mainVideoEl.currentTime = wasTime; }catch(e){}
          if(syncAudioEl){ try{ syncAudioEl.currentTime = wasTime; }catch(e){} }
          if(!wasPaused) mainVideoEl.play().catch(()=>{});
          overlay.classList.remove('active');
        }, {once:true});
        setTimeout(()=>overlay.classList.remove('active'), 4000);
      } else { overlay.classList.remove('active'); }
    }

    async function changeServer(serverName, endpointPath, event){
      localStorage.setItem('playbackMode', serverName);
      // 制限フォールバックの状態をサーバー切替のたびにリセット
      currentServerName = serverName;
      audioOnlyMode = false;
      restrictHandled = false;
      { const rb=document.getElementById('restrictBanner'); if(rb) rb.classList.remove('show'); }
      document.getElementById('serverMenu').classList.remove('show');
      document.querySelectorAll('.server-option').forEach(o=>o.classList.remove('active'));
      if(event && event.currentTarget) event.currentTarget.classList.add('active');
      else document.querySelectorAll('.server-option').forEach(o=>{ if(o.getAttribute('onclick').includes("'"+serverName+"'")) o.classList.add('active'); });

      const overlay=document.getElementById('videoLoadingOverlay'); overlay.classList.add('active');
      // 画質ボタンは googlevideo のときだけ有効
      document.getElementById('qualityBtn').style.display = (serverName==='googlevideo') ? 'flex' : 'none';

      try{
        if(serverName==='googlevideo'){
          if(STREAM_URL && STREAM_URL!=='youtube-nocookie'){
            mountSyncedPlayer(STREAM_URL, ''); // 標準360pは音声込み。画質はボタン押下時に取得
          } else {
            document.getElementById('playerWrapper').innerHTML = buildIframe('https://www.youtube-nocookie.com/embed/'+VIDEO_ID+'?autoplay=1');
          }
        } else if(serverName==='Youtube-Pro'){
          document.getElementById('playerWrapper').innerHTML = buildIframe(endpointPath);
        } else {
          const res = await fetch(endpointPath);
          if(!res.ok) throw new Error('server error');
          const url = (await res.text()).trim();
          const forceIframe = ['YoutubeEdu-Kahoot','YoutubeEdu-Scratch','youtube-nocookie','Elixir-Network'].includes(serverName) || url.includes('embed');
          if(forceIframe) document.getElementById('playerWrapper').innerHTML = buildIframe(url);
          else { mountSyncedPlayer(url, ''); }
        }
      }catch(e){ console.error(e); } finally { overlay.classList.remove('active'); }
    }

    /* =================================================================
     *  自動で次の動画を再生 (動画終了検知)
     * ================================================================= */
    let firstRecId = null;      // 関連動画の一番上
    let mixNextId = null;       // Mix 再生中の次の曲
    let autoNextTimer = null, autoNextTarget = null;

    function attachEndedHandler(el){
      if(!el) return;
      el.addEventListener('ended', onVideoEnded);
    }
    function onVideoEnded(){
      // Mix 再生中はプレイリストの次へ、それ以外は設定ONのとき関連動画トップへ
      const mixCtx = getMixContext();
      if(mixCtx && mixCtx.nextId){ triggerAutoNext(mixCtx.nextId, mixCtx.nextTitle, mixCtx.nextThumb, 'Mixの次の曲'); return; }
      if(SETTINGS.autoNext && firstRecId){ triggerAutoNext(firstRecId, firstRecTitle, 'https://i.ytimg.com/vi/'+firstRecId+'/mqdefault.jpg', '自動再生'); }
    }
    let firstRecTitle='';

    function triggerAutoNext(id,title,thumb,sub){
      autoNextTarget=id;
      const toast=document.getElementById('autoNextToast');
      document.getElementById('anThumb').src=thumb||('https://i.ytimg.com/vi/'+id+'/mqdefault.jpg');
      document.getElementById('anTitle').textContent=title||'次の動画';
      document.getElementById('anSub').textContent=sub||'';
      toast.classList.add('show');
      const ring=document.getElementById('anRingProg'); const total=100.5; let t=0; const dur=6000;
      ring.style.strokeDashoffset=total;
      const start=Date.now();
      clearInterval(autoNextTimer);
      autoNextTimer=setInterval(()=>{
        const p=Math.min(1,(Date.now()-start)/dur);
        ring.style.strokeDashoffset=total*(1-p);
        if(p>=1){ clearInterval(autoNextTimer); goToVideo(autoNextTarget); }
      },50);
    }
    function cancelAutoNext(){ clearInterval(autoNextTimer); document.getElementById('autoNextToast').classList.remove('show'); autoNextTarget=null; }
    function goToVideo(id){
      // Mix コンテキストを保持したまま遷移
      const mixCtx=getMixContext();
      if(mixCtx){ sessionStorage.setItem('mix_playlist', JSON.stringify(mixCtx.playlist)); sessionStorage.setItem('mix_index', String(mixCtx.nextIndex)); }
      location.href='/video/'+id;
    }

    /* =================================================================
     *  関連動画 + Mix プレイリスト
     * ================================================================= */
    // 検索ページで保存したチャンネルアバターを再利用（動画ページで再取得しない）
    function cachedAvatar(chId, chName){
      try{
        const map=JSON.parse(sessionStorage.getItem('channelAvatars')||'{}');
        if(chId && map[chId]) return map[chId];
        if(chName && map['name:'+chName]) return map['name:'+chName];
      }catch(e){}
      return '';
    }

    async function loadRecommendations(){
      try{
        const params=new URLSearchParams({title:VIDEO_TITLE, channel:VIDEO_CH, id:VIDEO_ID});
        const res=await fetch('/api/recommendations?'+params.toString());
        const data=await res.json();
        const items=data.items||[];
        const shorts=items.filter(i=>(i.title||'').includes('#'));
        const regulars=items.filter(i=>!(i.title||'').includes('#'));
        if(regulars[0]){ firstRecId=regulars[0].id; firstRecTitle=regulars[0].title; }
        document.getElementById('recommendations').innerHTML = regulars.map(item=>\`
          <a href="/video/\${item.id}" class="rec-item">
            <div class="rec-thumb"><img src="https://i.ytimg.com/vi/\${item.id}/mqdefault.jpg" loading="lazy"></div>
            <div class="rec-info">
              <div class="rec-title">\${escHtml(item.title)}</div>
              <div class="rec-meta">\${escHtml(item.channelTitle||'')}</div>
              <div class="rec-meta">\${escHtml(item.viewCountText||'')}</div>
            </div>
          </a>\`).join('');
        if(shorts.length){
          document.getElementById('shortsShelf').style.display='block';
          document.getElementById('shortsGrid').innerHTML = shorts.slice(0,4).map(item=>\`
            <a href="/video/\${item.id}" class="short-card">
              <div class="short-thumb"><img src="https://i.ytimg.com/vi/\${item.id}/hq720.jpg"></div>
              <div class="short-title">\${escHtml(item.title)}</div>
            </a>\`).join('');
        }
      }catch(e){ console.warn('rec fail',e); }
    }

    function escHtml(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

    /* ===== Mix プレイリスト (AI不使用・アルゴリズム / コンパクトYouTube風) ===== */
    let MIX_STATE = null;       // 再生中: {playlist, index, label}
    let MIX_SUGGEST = null;     // 提案(未再生): {items, label}
    const mixBadgeSvg = '<svg viewBox="0 0 24 24"><path d="M4 6h12v2H4zm0 4h12v2H4zm0 4h8v2H4zm10 0l6-3-6-3z"/></svg>';

    function getMixContext(){
      if(!MIX_STATE || !MIX_STATE.playlist || !MIX_STATE.playlist.length) return null;
      const idx=MIX_STATE.index;
      const nextIndex=idx+1;
      const next=MIX_STATE.playlist[nextIndex];
      return {
        playlist:MIX_STATE.playlist, index:idx, nextIndex,
        nextId: next?next.id:null, nextTitle: next?next.title:'', nextThumb: next?next.thumbnail:''
      };
    }

    // 【修正】Mix は再生中・提案・生成中いずれも「関連動画の上」(=YouTube本家と同じ)に表示する。
    // 以前は提案/生成中/保留を #mixContainer(=関連の下)に出していたため、
    // 後から読み込まれる関連動画に押しつぶされて一番下に潜り込むバグがあった。
    // 常に上段スロット(#mixContainerTop)を使い、下段は空のまま保つ。
    function mixSlot(){ return document.getElementById('mixContainerTop'); }
    function mixSlotTop(){ return document.getElementById('mixContainerTop'); }
    function clearBottomSlot(){ const b=document.getElementById('mixContainer'); if(b) b.innerHTML=''; }

    async function initMixOrDetect(){
      clearBottomSlot();
      // 1) 既に Mix 再生中（前ページから引き継ぎ）なら再生モードで表示
      const savedPl=sessionStorage.getItem('mix_playlist');
      const savedIdx=sessionStorage.getItem('mix_index');
      const savedLabel=sessionStorage.getItem('mix_label')||'';
      if(savedPl){
        try{
          const pl=JSON.parse(savedPl);
          // この動画がプレイリストに含まれる場合のみ「再生中」とみなす
          let idx=pl.findIndex(x=>x.id===VIDEO_ID);
          if(idx>=0 || (savedIdx!=null && pl[parseInt(savedIdx)] && pl[parseInt(savedIdx)].id===VIDEO_ID)){
            if(idx<0) idx=parseInt(savedIdx)||0;
            MIX_STATE={playlist:pl,index:idx,label:savedLabel};
            sessionStorage.setItem('mix_index',String(idx));
            clearPendingMix();
            // 【修正】プレイリストとして再生中なら、必ず展開して関連動画の一番上に固定する。
            renderMixPlaying();
            return;
          }
          // 【修正】プレイリストに含まれない動画に来た＝プレイリスト再生から外れた。
          // 音楽なら「新しいプレイリストを積極的に生成」するので、古い再生中Mixはここで破棄する。
          // （以前は"保留Mix"に格下げして居座り続け、新規生成をブロックしていた＝もどかしいバグ）
          sessionStorage.removeItem('mix_playlist');
          sessionStorage.removeItem('mix_index');
          sessionStorage.removeItem('mix_label');
          clearPendingMix();
        }catch(e){}
      }

      // 2) 音楽なら「毎回」新規 Mix を積極生成（MINV2 は軽量アルゴリズムなので即時生成できる）。
      //    以前のような "一度作ったら付きまとって二度と作られない" 挙動は撤廃。
      try{
        const q=new URLSearchParams({title:VIDEO_TITLE, channel:VIDEO_CH});
        renderMixGenerating();
        const r=await fetch('/api/mix/video/'+VIDEO_ID+'?'+q.toString());
        const j=await r.json();
        if(j.isMusic && j.items && j.items.length>=4){
          MIX_SUGGEST={items:j.items, label:'Mix - '+(j.artist||VIDEO_CH||'おすすめ')};
          renderMixSuggest();
        } else {
          if(mixSlot()) mixSlot().innerHTML='';
        }
      }catch(e){ if(mixSlot()) mixSlot().innerHTML=''; }
    }

    /* ===== 関連の一番下: 目立たない「+ プレイリスト」ボタン（Gemini生成） ===== */
    const geminiPlSvg = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2l2.35 6.35L21 10.7l-5.5 3.9L17 21l-5-3.6L7 21l1.5-6.4L3 10.7l6.65-2.35z" fill="currentColor"/></svg>';
    function renderAddPlaylistBtn(){
      const s=document.getElementById('addPlaylistSlot'); if(!s) return;
      s.innerHTML=\`<button class="add-pl-btn" id="addPlBtn"><span class="spark">✨</span> ＋プレイリスト</button>\`;
      const btn=document.getElementById('addPlBtn');
      if(btn) btn.addEventListener('click', generateGeminiPlaylist);
    }
    async function generateGeminiPlaylist(){
      const gen=document.getElementById('plGenSlot');
      const btn=document.getElementById('addPlBtn');
      if(btn){ btn.disabled=true; }
      if(gen){
        gen.innerHTML=\`
          <div class="gemini-pl"><div class="compact-mix" style="margin-top:0;"><div class="cmix-gen" style="padding:14px 12px;">
            <div class="cmix-gen-orb"></div>
            <div><div class="cmix-gen-txt">Gemini がプレイリストを生成中</div><div class="cmix-gen-sub">この動画に合う動画を選んでいます...</div></div>
          </div></div></div>\`;
      }
      try{
        const r=await fetch('/api/ai/playlist',{
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ mode:'context', title:VIDEO_TITLE, channel:VIDEO_CH, excludeIds:[VIDEO_ID] })
        });
        if(!r.ok) throw new Error('gen fail');
        const j=await r.json();
        if(!j.items || j.items.length<3) throw new Error('no items');
        renderGeminiPlaylistCard(j.label||('Gemini プレイリスト'), j.items);
      }catch(e){
        if(gen) gen.innerHTML=\`<div style="font-size:12.5px;color:var(--text-sub);margin-top:10px;text-align:center;">生成に失敗しました。もう一度お試しください。</div>\`;
        if(btn) btn.disabled=false;
      }
    }
    function renderGeminiPlaylistCard(label, items){
      const gen=document.getElementById('plGenSlot'); if(!gen) return;
      const cover=items[0]||{};
      const artists=[...new Set(items.map(i=>i.channelTitle).filter(Boolean))].slice(0,4).join('、');
      gen.innerHTML=\`
        <div class="gemini-pl">
          <div class="compact-mix" style="margin-top:0;">
            <div class="compact-mix-inner" id="geminiPlPlay">
              <div class="cmix-thumb-wrap"><div class="cmix-stack"><div class="cmix-thumb">
                <img src="\${escHtml(cover.thumbnail||('https://i.ytimg.com/vi/'+cover.id+'/mqdefault.jpg'))}" onerror="this.src='https://i.ytimg.com/vi/\${cover.id}/mqdefault.jpg'">
                <div class="cmix-badge">\${mixBadgeSvg} \${items.length}</div>
              </div></div></div>
              <div class="cmix-info">
                <div class="gemini-pl-tag">\${geminiPlSvg} Gemini 生成</div>
                <div class="cmix-title">\${escHtml(label)}</div>
                <div class="cmix-artists">\${escHtml(artists||'あなたへのおすすめ')}</div>
              </div>
            </div>
          </div>
        </div>\`;
      const el=document.getElementById('geminiPlPlay');
      if(el) el.addEventListener('click', ()=>{
        const pl=items.map(it=>({id:it.id,title:it.title,channelTitle:it.channelTitle,thumbnail:it.thumbnail,lengthText:it.lengthText}));
        sessionStorage.setItem('mix_playlist', JSON.stringify(pl));
        sessionStorage.setItem('mix_index','0');
        sessionStorage.setItem('mix_label', label);
        location.href='/video/'+pl[0].id;
      });
    }

    /* ===== 保留Mix（コンパクト・2回未クリックで消滅）ロジック =====
     * pending_mix = { playlist, label, seed:{id,title,channel}, views, dismissed }
     * ・関係ない動画/ホームでは compact bar として残す
     * ・表示のたび views++。views>=2 かつ未クリックなら dismissed=true で以後非表示
     * ・クリックされたら再生モードへ昇格し pending_mix は消す */
    function getPendingMix(){
      try{ return JSON.parse(sessionStorage.getItem('pending_mix')||'null'); }catch(e){ return null; }
    }
    function setPendingMix(p){ try{ sessionStorage.setItem('pending_mix', JSON.stringify(p)); }catch(e){} }
    function clearPendingMix(){ sessionStorage.removeItem('pending_mix'); }

    // 再生中だったMixを、別動画に来た時点で「保留」に降格
    function demoteToPendingMix(playlist, label){
      const existing=getPendingMix();
      // 既存の保留があってdismissed済みなら復活させない
      if(existing && existing.dismissed) return;
      const seedItem = playlist[0] || {};
      setPendingMix({
        playlist, label: label||('Mix - '+(seedItem.channelTitle||'おすすめ')),
        views: existing ? existing.views : 0,
        dismissed: false
      });
    }

    // 保留Mixがあればコンパクト表示（2回未クリックで消滅）。表示したら true
    function showPendingMixIfAny(){
      const p=getPendingMix();
      if(!p || p.dismissed || !p.playlist || !p.playlist.length) return false;
      // 表示回数を加算。2回目の表示まで許可、その後（3回目に入る前）に消滅
      p.views = (p.views||0) + 1;
      if(p.views > 2){ p.dismissed=true; setPendingMix(p); return false; }
      setPendingMix(p);
      renderPendingMixCompact(p);
      return true;
    }

    function renderPendingMixCompact(p){
      const s=mixSlot(); if(!s) return;
      const items=p.playlist;
      const cover=items[0]||{};
      const artists=[...new Set(items.map(i=>i.channelTitle).filter(Boolean))].slice(0,4).join('、');
      s.innerHTML=\`
        <div class="compact-mix pending">
          <div class="compact-mix-inner" id="pendingMixPlay">
            <div class="cmix-thumb-wrap"><div class="cmix-stack"><div class="cmix-thumb">
              <img src="\${escHtml(cover.thumbnail||('https://i.ytimg.com/vi/'+cover.id+'/mqdefault.jpg'))}" onerror="this.src='https://i.ytimg.com/vi/\${cover.id}/mqdefault.jpg'">
              <div class="cmix-badge">\${mixBadgeSvg} Mix</div>
            </div></div></div>
            <div class="cmix-info">
              <div class="cmix-title">\${escHtml(p.label)}</div>
              <div class="cmix-artists">\${escHtml(artists||'前回の Mix を続けて再生')}</div>
            </div>
            <button class="cmix-dismiss" title="非表示" onclick="event.stopPropagation(); dismissPendingMix();">✕</button>
          </div>
        </div>\`;
      const el=document.getElementById('pendingMixPlay');
      if(el) el.addEventListener('click',(e)=>{
        if(e.target.closest('.cmix-dismiss')) return;
        // クリック → 再生モードへ昇格
        const pl=p.playlist;
        sessionStorage.setItem('mix_playlist', JSON.stringify(pl));
        sessionStorage.setItem('mix_index','0');
        sessionStorage.setItem('mix_label', p.label);
        clearPendingMix();
        location.href='/video/'+pl[0].id;
      });
    }
    function dismissPendingMix(){
      const p=getPendingMix(); if(p){ p.dismissed=true; setPendingMix(p); }
      if(mixSlot()) mixSlot().innerHTML='';
    }

    // 生成中（落ち着いたデザイン・関連の一番下）
    function renderMixGenerating(){
      const s=mixSlot(); if(!s) return;
      s.innerHTML=\`
        <div class="compact-mix">
          <div class="cmix-gen">
            <div class="cmix-gen-orb"></div>
            <div><div class="cmix-gen-txt">MINV2-AI が Mix を作成中</div><div class="cmix-gen-sub">似た曲を選曲しています...</div></div>
          </div>
        </div>\`;
    }

    // 提案（未再生・コンパクトカード）
    function renderMixSuggest(){
      const s=mixSlot(); if(!s || !MIX_SUGGEST) return;
      const items=MIX_SUGGEST.items;
      const cover=items[0];
      const artists=[...new Set(items.map(i=>i.channelTitle).filter(Boolean))].slice(0,4).join('、');
      s.innerHTML=\`
        <div class="compact-mix">
          <div class="compact-mix-inner" id="cmixPlay">
            <div class="cmix-thumb-wrap"><div class="cmix-stack"><div class="cmix-thumb">
              <img src="\${escHtml(cover.thumbnail)}" onerror="this.src='https://i.ytimg.com/vi/\${cover.id}/mqdefault.jpg'">
              <div class="cmix-badge">\${mixBadgeSvg} Mix</div>
            </div></div></div>
            <div class="cmix-info">
              <div class="cmix-title">\${escHtml(MIX_SUGGEST.label)}</div>
              <div class="cmix-artists">\${escHtml(artists||'おすすめの楽曲')}</div>
            </div>
          </div>
        </div>\`;
      const el=document.getElementById('cmixPlay');
      if(el) el.addEventListener('click', ()=>{
        // 現在の動画を先頭にして Mix 開始
        const pl=[{id:VIDEO_ID,title:VIDEO_TITLE,channelTitle:VIDEO_CH,thumbnail:'https://i.ytimg.com/vi/'+VIDEO_ID+'/mqdefault.jpg'}];
        for(const it of items){ if(it.id!==VIDEO_ID && !pl.some(p=>p.id===it.id)) pl.push(it); }
        sessionStorage.setItem('mix_playlist', JSON.stringify(pl));
        sessionStorage.setItem('mix_index','0');
        sessionStorage.setItem('mix_label', MIX_SUGGEST.label);
        MIX_STATE={playlist:pl,index:0,label:MIX_SUGGEST.label};
        renderMixPlaying();
      });
    }

    // 再生中（YouTube本家風・現在位置ハイライト + 再生アイコン）
    // 再生中は「関連動画の上」に表示（本家 YouTube と同じ挙動）。下段スロットは空に。
    function renderMixPlaying(){
      const s=mixSlotTop(); if(!s || !MIX_STATE) return;
      clearBottomSlot();
      const {playlist,index,label}=MIX_STATE;
      const body=playlist.map((it,i)=>\`
        <a href="/video/\${it.id}" class="mix-item \${i===index?'playing':''}" onclick="event.preventDefault(); playMixAt(\${i});">
          <div class="mix-idx">\${i===index?'<svg viewBox="0 0 24 24" width="12" height="12" fill="#fff"><path d="M8 5v14l11-7z"/></svg>':(i+1)}</div>
          <div class="mix-thumb-box"><img class="mix-thumb" src="\${escHtml(it.thumbnail)}" onerror="this.src='https://i.ytimg.com/vi/\${it.id}/mqdefault.jpg'">\${it.lengthText?\`<span class="mix-dur">\${escHtml(it.lengthText)}</span>\`:''}</div>
          <div style="min-width:0;"><div class="mix-it-title">\${escHtml(it.title)}</div><div class="mix-it-ch">\${escHtml(it.channelTitle||'')}</div></div>
        </a>\`).join('');
      s.innerHTML=\`
        <div class="mix-card">
          <div class="mix-header">
            <svg class="mix-icon" viewBox="0 0 24 24" fill="var(--text-main)"><path d="M4 6h12v2H4zm0 4h12v2H4zm0 4h8v2H4zm10 0l6-3-6-3z"/></svg>
            <div style="flex:1;min-width:0;">
              <div class="mix-title-txt">\${escHtml(label||('Mix - '+VIDEO_CH))}</div>
              <div class="mix-sub-txt">YouTubeがあなたに作成したMix ・ \${index+1} / \${playlist.length}</div>
            </div>
            <div class="mix-head-actions">
              <button class="mix-close" onclick="closeMix(event)" title="Mixを終了"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
            </div>
          </div>
          <div class="mix-body">\${body}</div>
        </div>\`;
      // アクティブ項目までスクロール
      setTimeout(()=>{ const a=s.querySelector('.mix-item.playing'); if(a) a.scrollIntoView({block:'nearest'}); },100);
    }

    function closeMix(e){
      if(e) e.stopPropagation();
      sessionStorage.removeItem('mix_playlist');
      sessionStorage.removeItem('mix_index');
      sessionStorage.removeItem('mix_label');
      MIX_STATE=null;
      if(mixSlotTop()) mixSlotTop().innerHTML='';
      // 提案に戻す
      if(MIX_SUGGEST) renderMixSuggest(); else if(mixSlot()) mixSlot().innerHTML='';
    }

    function playMixAt(i){
      if(!MIX_STATE) return;
      const it=MIX_STATE.playlist[i]; if(!it) return;
      MIX_STATE.index=i;
      sessionStorage.setItem('mix_index',String(i));
      location.href='/video/'+it.id;
    }

    /* =================================================================
     *  コメント (無限スクロール: Orby-API ?page=n)
     * ================================================================= */
    let commentPage=0, commentLoading=false, commentEnd=false, commentTotal=0;
    async function loadComments(){
      if(commentLoading||commentEnd) return;
      commentLoading=true;
      commentPage++;
      const sentinel=document.getElementById('commentsSentinel');
      sentinel.innerHTML='<div class="spinner" style="width:24px;height:24px;border-width:3px;margin:0;"></div>';
      try{
        const r=await fetch('/api/comments/'+VIDEO_ID+'?page='+commentPage);
        const d=await r.json();
        const list=d.comments||[];
        if(list.length===0){ commentEnd=true; sentinel.innerHTML=''; commentLoading=false; return; }
        commentTotal+=list.length;
        document.getElementById('commentsCountHead').textContent='コメント '+commentTotal+(d.hasNextPage?'+':'')+' 件';
        const html=list.map(c=>\`
          <div class="comment-item">
            <img class="comment-avatar" src="\${escHtml(c.authorThumbnail||'')}" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent((c.author||'C').replace('@',''))}&background=555&color=fff&size=40'">
            <div style="min-width:0;">
              \${c.isPinned?'<div class="comment-pinned"><i class="fas fa-thumbtack"></i> チャンネル所有者により固定されています</div>':''}
              <div><span class="comment-author">\${escHtml(c.author||'')}</span><span class="comment-time">\${escHtml(c.publishedTime||'')}</span></div>
              <div class="comment-text">\${escHtml(c.content||c.text||'')}</div>
              <div class="comment-likes"><i class="fas fa-thumbs-up"></i> \${escHtml(c.likeCountText||String(c.likeCount||0))} \${c.replyCount?('・ 返信 '+c.replyCount):''}</div>
            </div>
          </div>\`).join('');
        document.getElementById('commentsList').insertAdjacentHTML('beforeend', html);
        if(d.hasNextPage===false) commentEnd=true;
        sentinel.innerHTML='';
      }catch(e){ commentEnd=true; sentinel.innerHTML=''; }
      commentLoading=false;
    }
    function initCommentScroll(){
      const io=new IntersectionObserver(es=>{ if(es[0].isIntersecting) loadComments(); },{rootMargin:'600px'});
      io.observe(document.getElementById('commentsSentinel'));
    }

    /* =================================================================
     *  Ask (◆) — 概要欄を読み込んで質問応答
     * ================================================================= */
    function openAsk(){ document.getElementById('askPanel').classList.add('open'); document.getElementById('askBackdrop').classList.add('open'); setTimeout(()=>document.getElementById('askInput').focus(),200); }
    function closeAsk(){ document.getElementById('askPanel').classList.remove('open'); document.getElementById('askBackdrop').classList.remove('open'); }
    function askQuick(btn){ document.getElementById('askInput').value=btn.textContent; sendAsk(); }
    let askBusy=false;
    async function sendAsk(){
      if(askBusy) return;
      const input=document.getElementById('askInput'); let q=input.value.trim(); if(!q) return;
      if(q.length>400) q=q.slice(0,400); // クライアント側も文字数制限（AI保護）
      const body=document.getElementById('askBody');
      const hero=body.querySelector('.ask-hero'); if(hero) hero.style.display='none';
      const sug=document.getElementById('askSuggest'); if(sug) sug.style.display='none';
      input.value='';
      body.insertAdjacentHTML('beforeend', '<div class="ask-msg user">'+escHtml(q)+'</div>');
      const thinking=document.createElement('div'); thinking.className='ask-msg ai thinking'; thinking.innerHTML='<span class="dots">考えています</span>'; body.appendChild(thinking); body.scrollTop=body.scrollHeight;
      askBusy=true; document.getElementById('askSend').disabled=true;
      try{
        const r=await fetch('/api/ai/ask/'+VIDEO_ID,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q,title:VIDEO_TITLE,channel:VIDEO_CH})});
        const d=await r.json();
        thinking.classList.remove('thinking'); thinking.textContent=d.answer||d.error||'回答を取得できませんでした。';
      }catch(e){ thinking.classList.remove('thinking'); thinking.textContent='エラーが発生しました。もう一度お試しください。'; }
      askBusy=false; document.getElementById('askSend').disabled=false; body.scrollTop=body.scrollHeight;
    }

    /* =================================================================
     *  設定モーダル
     * ================================================================= */
    function openSettings(){
      const wrap=document.createElement('div');
      wrap.className='yt-modal-backdrop';
      wrap.onclick=e=>{ if(e.target===wrap) wrap.remove(); };
      wrap.innerHTML=\`
        <div class="yt-modal">
          <div class="yt-modal-head">設定</div>
          <div class="yt-modal-body">
            <div class="yt-setting-row">
              <div>
                <div class="yt-setting-label">自動再生</div>
                <div class="yt-setting-desc">動画が終了したら、関連動画の一番上の動画を自動的に再生します。</div>
              </div>
              <label class="yt-switch"><input type="checkbox" id="setAutoNext" \${SETTINGS.autoNext?'checked':''}><span class="slider"></span></label>
            </div>
          </div>
          <div class="yt-modal-foot"><button id="ytModalClose">完了</button></div>
        </div>\`;
      document.body.appendChild(wrap);
      wrap.querySelector('#setAutoNext').addEventListener('change', e=>{ SETTINGS.autoNext=e.target.checked; });
      wrap.querySelector('#ytModalClose').addEventListener('click', ()=> wrap.remove());
    }

    /* =================================================================
     *  検索オートコンプリート
     * ================================================================= */
    const searchInput=document.getElementById('searchInput'), autocompleteDropdown=document.getElementById('autocompleteDropdown');
    let searchTimeout=null;
    if(searchInput){
      searchInput.addEventListener('input', e=>{
        const query=e.target.value.trim();
        if(!query){ autocompleteDropdown.style.display='none'; return; }
        clearTimeout(searchTimeout);
        searchTimeout=setTimeout(()=>{ const s=document.createElement('script'); s.src='https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q='+encodeURIComponent(query)+'&jsonp=handleAutocomplete'; document.body.appendChild(s); },200);
      });
    }
    window.handleAutocomplete=function(data){
      const sug=data[1]; if(!sug||!sug.length){ autocompleteDropdown.style.display='none'; return; }
      autocompleteDropdown.innerHTML=sug.map(s=>'<div class="autocomplete-item" data-q="'+encodeURIComponent(s[0])+'" onclick="selectSuggestion(this)"><i class="fas fa-search"></i><span>'+escHtml(s[0])+'</span></div>').join('');
      autocompleteDropdown.style.display='block';
    };
    window.selectSuggestion=function(el){ location.href='/?q='+el.getAttribute('data-q'); };
    document.addEventListener('click', e=>{ if(!e.target.closest('.nav-center')&&autocompleteDropdown) autocompleteDropdown.style.display='none'; });

    function toggleDescription(e){ if(e&&e.target.tagName==='A') return; const box=document.getElementById('descriptionBox'); const btn=document.getElementById('descriptionToggleBtn'); if(box.classList.contains('expanded')){ box.classList.remove('expanded'); btn.textContent='...もっと見る'; } else { box.classList.add('expanded'); btn.textContent='一部を表示'; } }

    /* =================================================================
     *  起動
     * ================================================================= */
    window.onload=()=>{
      // 検索から引き継いだアバターがあれば owner に反映
      if(!VIDEO_CHIMG){ const av=cachedAvatar(VIDEO_CHID, VIDEO_CH); if(av){ document.getElementById('ownerAvatar').src=av; } }
      loadRecommendations();
      initMixOrDetect();
      renderAddPlaylistBtn();
      loadComments();
      initCommentScroll();

      const savedMode=localStorage.getItem('playbackMode')||'googlevideo';
      const eps={ 'googlevideo':'', 'youtube-nocookie':'/nocookie/'+VIDEO_ID, 'DL-Pro':'/360/'+VIDEO_ID, 'YoutubeEdu-Kahoot':'/kahoot-edu/'+VIDEO_ID, 'YoutubeEdu-Scratch':'/scratch-edu/'+VIDEO_ID, 'Youtube-Pro':'/pro-stream/'+VIDEO_ID, 'Elixir-Network':'/stream-network/'+VIDEO_ID };
      const mode=eps.hasOwnProperty(savedMode)?savedMode:'googlevideo';
      changeServer(mode, eps[mode], null);
    };
</script>
</body>
</html>
    `;
    res.send(html);
  } catch (err) { next(err); }
});


app.get("/nothing/*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

app.post("/api/save-history", express.json(), (req, res) => {
  res.json({ success: true });
});
app.get('/rapid/:id', async (req, res) => {
  const videoId = req.params.id;
  const selectedKey = keys[Math.floor(Math.random() * keys.length)];

  const url = `https://${RAPID_API_HOST}/dl?id=${videoId}`;
  const options = {
    method: 'GET',
    headers: {
      'x-rapidapi-key': selectedKey,
      'x-rapidapi-host': RAPID_API_HOST,
      'Content-Type': 'application/json'
    }
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();

    if (data.status !== "OK") {
      return res.status(400).json({ error: "Failed to fetch video data" });
    }

    // --- 多分取得できないから消してもいい ---
    let channelImageUrl = data.channelThumbnail?.[0]?.url || data.author?.thumbnails?.[0]?.url;

    // 2. アバターURLを作成
    if (!channelImageUrl) {
      const name = encodeURIComponent(data.channelTitle || 'Youtube Channel');
      // UI Avatars を使用
      channelImageUrl = `https://ui-avatars.com/api/?name=${name}&background=random&color=fff&size=128`;
    }

    const highResStream = data.adaptiveFormats?.find(f => f.qualityLabel === '1080p') || data.adaptiveFormats?.[0];
    const audioStream = data.adaptiveFormats?.find(f => f.mimeType.includes('audio')) || data.adaptiveFormats?.[data.adaptiveFormats?.length - 1];

    const formattedResponse = {
      stream_url: data.formats?.[0]?.url || "",
      highstreamUrl: highResStream?.url || "",
      audioUrl: audioStream?.url || "",
      videoId: data.id,
      channelId: data.channelId,
      channelName: data.channelTitle,
      channelImage: channelImageUrl, 
      videoTitle: data.title,
      videoDes: data.description,
      videoViews: parseInt(data.viewCount) || 0,
      likeCount: data.likeCount || 0
    };

    res.json(formattedResponse);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// --- コメント追加読み込み用API (Orby-API ページネーション: スクロール検知で無限表示) ---
app.get("/api/comments/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  const page = parseInt(req.query.page) || 1;

  // 1) Orby-API を優先（?page=n で確実にページ送り）
  try {
    const data = await orbyGetComments(videoId, page);
    return res.json(data);
  } catch (e) {
    // 2) 既存プロバイダ (continuation 方式) にフォールバック
    const continuation = req.query.continuation || "";
    for (const apiBase of apiListCache) {
      try {
        const url = `${apiBase}/api/comments/${videoId}${continuation ? '?continuation=' + continuation : ''}`;
        const cRes = await fetchWithTimeout(url, {}, 3000);
        if (cRes.ok) {
          const data = await cRes.json();
          return res.json(data);
        }
      } catch (err) { continue; }
    }
  }
  res.json({ ok: false, comments: [], commentCount: 0, hasNextPage: false, error: "コメントの取得に失敗しました" });
});

/* =====================================================================
 *  Orby-MAX 画質選択 API  (googlevideo でも画質選択可能に)
 *  360p(itag18)=音声込み。それ以外は映像のみ → bestAudioUrl と同期再生する
 * ===================================================================== */
app.get("/api/qualities/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  try {
    const data = await orbyGetAllStreams(videoId);
    res.json(data);
  } catch (e) {
    console.error("Orby-MAX qualities error:", e.message);
    res.status(502).json({ ok: false, error: e.message, videoStreams: [], audioStreams: [] });
  }
});

/* =====================================================================
 *  音楽判定 (純アルゴリズム・AI不使用・怪しければ切り捨て)
 * ===================================================================== */
const MUSIC_POSITIVE = /(official\s*(music\s*)?video|\bmv\b|m\/v|【\s*mv\s*】|\blyric(s)?\b|official\s*audio|【\s*official\b|feat\.?|ft\.?|\bremix\b|\bcover\b|acoustic|(live|ライブ)\s*(performance|session|映像)|歌ってみた|ミュージックビデオ|\bost\b|vevo|full\s*album|mixtape|カバー|弾いてみた|ピアノ(演奏|カバー)?|piano\s*(cover|version)|\bacoustic\b|三味線|オルゴール)/i;
const MUSIC_NEGATIVE = /(tutorial|how\s*to|解説|実況|gameplay|game\s*play|レビュー|review|\bvlog\b|podcast|ラジオ|ニュース|\bnews\b|講座|使い方|検証|開封|unboxing|作り方|料理|レシピ|まとめ|ランキング|エピソード|\bep\.?\d|生配信|切り抜き|ゆっくり|会議|セミナー|授業|di?y)/i;
// 「アーティスト - 曲名」形式 (両側に十分な語)
const DASH_FORM = /[^\s\-–—]{2,}\s*[-–—]\s*[^\s\-–—]{2,}/;

// タイトル+チャンネルから音楽か厳格判定。怪しい(判定材料が弱い)場合は false。
function detectMusic(title, channel) {
  title = String(title || "");
  channel = String(channel || "");
  if (!title) return false;
  if (MUSIC_NEGATIVE.test(title)) return false;                 // 否定シグナル → 切り捨て
  if (/(- topic$|\bvevo\b|official\s*(artist|music))/i.test(channel)) return true; // 音楽系チャンネル
  if (MUSIC_POSITIVE.test(title)) return true;                  // 肯定シグナル
  // ダッシュ形式 + 短めタイトル(曲名は概ね短い) のみ音楽とみなす。それ以外は切り捨て。
  if (DASH_FORM.test(title) && title.length <= 60 && !MUSIC_NEGATIVE.test(channel)) return true;
  return false;
}

// 検索クエリが音楽系ジャンルか（ピアノ/歌ってみた/remix 等）
const MUSIC_QUERY_HINT = /(ピアノ|piano|歌ってみた|remix|リミックス|\bmv\b|カバー|cover|弾いてみた|作業用bgm|\bbgm\b|プレイリスト|playlist|音楽|\bsong(s)?\b|\bmusic\b|\bl(o|0)-?fi\b|オルゴール|アコースティック|acoustic|\bost\b|サントラ|j-?pop|k-?pop|edm|ボカロ|ボーカロイド|vocaloid|アニソン|オフィシャル|official\s*audio)/i;

// アーティスト名を推定（"Artist - Song" / "Song / Artist" / チャンネル名）
function guessArtist(title, channel) {
  title = String(title || ""); channel = String(channel || "");
  const dash = title.match(/^\s*([^-–—]{2,40})\s*[-–—]/);
  if (dash) return dash[1].trim();
  const chClean = channel.replace(/\s*-\s*topic$/i, "").replace(/vevo$/i, "").replace(/official.*$/i, "").trim();
  if (chClean && chClean.length <= 30) return chClean;
  return "";
}

/* =====================================================================
 *  暗号化 AI プロキシ (nie-ai / scira-gemini-3.1-flash-lite)
 *  クライアントは生の URL・モデル名を一切知らない
 *  ※ AI保護のため全エンドポイントに厳格な文字数制限を適用
 * ===================================================================== */
const AI_LIMITS = {
  questionMax: 400,     // Ask の質問
  msgTotalMax: 6000,    // chat の全メッセージ合計
  fieldMax: 300,        // title/channel 等の単一フィールド
  commentMax: 1200      // Ask に渡す上位コメント合計
};
function clip(s, n) { return String(s || "").slice(0, n); }

// (A) 汎用チャット (AIプレイリスト生成に使用) — 文字数ガード付き
app.post("/api/ai/chat", express.json({ limit: "32kb" }), async (req, res) => {
  try {
    let messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!messages) return res.status(400).json({ error: "messages required" });
    // メッセージ数と合計文字数を制限してAIを保護
    messages = messages.slice(0, 6).map(m => ({
      role: ["system", "user", "assistant"].includes(m.role) ? m.role : "user",
      content: clip(m.content, 3000)
    }));
    const total = messages.reduce((a, m) => a + m.content.length, 0);
    if (total > AI_LIMITS.msgTotalMax) {
      return res.status(413).json({ error: "入力が長すぎます" });
    }
    const temperature = typeof req.body.temperature === "number" ? Math.min(1, Math.max(0, req.body.temperature)) : 0.75;
    const maxTokens = Math.min(900, typeof req.body.max_tokens === "number" ? req.body.max_tokens : 700);
    const content = await callNieAI(messages, { temperature, maxTokens, retries: 3 });
    res.json({ content });
  } catch (e) {
    res.status(502).json({ error: "AI応答の取得に失敗しました", detail: e.message });
  }
});

// (B) 動画の「Ask」機能: タイトル + 上位コメントだけを読み込ませて回答（概要欄全文は使わない）
app.post("/api/ai/ask/:videoId", express.json({ limit: "16kb" }), async (req, res) => {
  const videoId = req.params.videoId;
  const question = clip(String(req.body?.question || "").trim(), AI_LIMITS.questionMax);
  if (!question) return res.status(400).json({ error: "question required" });
  try {
    let title = clip(req.body?.title, AI_LIMITS.fieldMax);
    let channel = clip(req.body?.channel, AI_LIMITS.fieldMax);
    if (!title) {
      const meta = await resolveVideoMeta(videoId);
      title = title || meta.title;
      channel = channel || meta.channelName;
    }
    // 上位コメントを取得（最大8件、合計文字数制限）
    let topComments = [];
    try {
      const c = await orbyGetComments(videoId, 1);
      topComments = (c.comments || []).slice(0, 8).map(x => `- ${clip(x.text, 150)}`);
    } catch (e) {}
    let commentsBlock = topComments.join("\n");
    if (commentsBlock.length > AI_LIMITS.commentMax) commentsBlock = commentsBlock.slice(0, AI_LIMITS.commentMax);

    const context =
      `動画タイトル: ${title || "(不明)"}\n` +
      `チャンネル: ${channel || "(不明)"}\n` +
      `視聴者の上位コメント:\n${commentsBlock || "(コメントなし)"}`;
    const messages = [
      { role: "system", content:
        "あなたはYouTube動画について答えるアシスタント『Ask』です。" +
        "与えられた『動画タイトル』と『視聴者の上位コメント』だけを根拠に、簡潔で分かりやすい日本語で答えてください。" +
        "情報が不足する質問には断定せず「その情報はここからは分かりません」と正直に答えてください。" +
        "回答は3〜5文程度。" },
      { role: "user", content: `${context}\n\n【質問】${question}` }
    ];
    const content = await callNieAI(messages, { temperature: 0.5, maxTokens: 600, retries: 3 });
    res.json({ answer: content });
  } catch (e) {
    res.status(502).json({ error: "Ask応答の取得に失敗しました", detail: e.message });
  }
});

// (C) AIプレイリスト生成（ホームの✨プレイリスト用）— 文字数ガード付き
app.post("/api/ai/mix", express.json({ limit: "16kb" }), async (req, res) => {
  const title = clip(String(req.body?.title || "").trim(), AI_LIMITS.fieldMax);
  const channel = clip(String(req.body?.channel || "").trim(), AI_LIMITS.fieldMax);
  if (!title) return res.status(400).json({ error: "title required" });
  try {
    const messages = [
      { role: "system", content:
        "あなたは音楽の Mix プレイリストを作るAIです。【厳守】\n" +
        "1. 前置き・挨拶・説明は一切書かない。\n" +
        "2. YouTubeに実在する有名で人気の楽曲だけを10曲前後、各タイトルの末尾に必ず「.」を付けて区切る。\n" +
        "3. 与えられた楽曲と同じアーティスト、または非常に近いジャンル/雰囲気の曲を選ぶ。\n" +
        "4. 出力形式の例: アーティスト名 - 曲名.アーティスト名 - 曲名.\n" +
        "5. アーティスト名を必ず含め、検索でヒットしやすい正確な公式タイトルにする。\n" +
        "6. 同じ曲の重複は禁止。渡された曲そのものは含めない。" },
      { role: "user", content:
        `再生中の楽曲:「${title}」${channel ? ` / アーティスト:「${channel}」` : ""}\n` +
        "同じアーティストや似たジャンルの曲でMixを作ってください。" }
    ];
    const content = await callNieAI(messages, { temperature: 0.8, maxTokens: 800, retries: 3 });
    res.json({ raw: content });
  } catch (e) {
    res.status(502).json({ error: "Mix生成に失敗しました", detail: e.message });
  }
});

// (C-2) 統合プレイリスト生成: Gemini(nie-ai) → タイトル解析 → 実在動画へ解決 → 完成品を返す
//   mode: "channel"（そのチャンネルの人気動画で構成） / "context"（seed動画/キーワードで構成）
//   これ1本で「チャンネル自動生成」「関連の+プレイリスト」を賄う。
app.post("/api/ai/playlist", express.json({ limit: "16kb" }), async (req, res) => {
  try {
    const mode = String(req.body?.mode || "context");
    const channel = clip(String(req.body?.channel || "").trim(), AI_LIMITS.fieldMax);
    const title = clip(String(req.body?.title || "").trim(), AI_LIMITS.fieldMax);
    const keywords = clip(String(req.body?.keywords || "").trim(), AI_LIMITS.fieldMax);
    const excludeIds = Array.isArray(req.body?.excludeIds) ? req.body.excludeIds.slice(0, 20).map(String) : [];

    let sysPrompt, userPrompt, label;
    if (mode === "channel") {
      if (!channel) return res.status(400).json({ error: "channel required" });
      label = channel + " のベスト";
      sysPrompt =
        "あなたは YouTube チャンネルの『ベスト再生リスト』を作る編集AIです。【厳守】\n" +
        "1. 前置き・挨拶・説明は一切書かない。\n" +
        "2. 指定チャンネルが実際に投稿している/関係する、YouTubeに実在する有名で代表的な動画のタイトルを10本前後、各タイトルの末尾に必ず「.」を付けて区切る。\n" +
        "3. 架空タイトルは禁止。検索でヒットしやすい、チャンネル名や具体的な内容を含む正確なタイトルにする。\n" +
        "4. 出力形式の例: タイトル1.タイトル2.タイトル3.\n" +
        "5. 重複禁止。";
      userPrompt = `チャンネル名:「${channel}」\nこのチャンネルの視聴者が喜ぶ、代表的で人気のある動画で再生リストを作ってください。`;
    } else {
      label = title ? ("Mix - " + (channel || title)) : (keywords ? ("プレイリスト - " + keywords) : "おすすめプレイリスト");
      sysPrompt =
        "あなたは最高のYouTube再生リストを作る編集AIです。【厳守】\n" +
        "1. 前置き・挨拶・説明は一切書かない。\n" +
        "2. YouTubeに実在する有名で人気の動画のタイトルを10本前後、各タイトルの末尾に必ず「.」を付けて区切る。\n" +
        "3. 架空タイトルは禁止。アーティスト名/チャンネル名など検索でヒットしやすい正確なタイトルにする。\n" +
        "4. 出力形式の例: タイトル1.タイトル2.\n" +
        "5. 重複禁止。渡された動画そのものは含めない。";
      userPrompt =
        (title ? `再生中の動画:「${title}」${channel ? ` / チャンネル:「${channel}」` : ""}\n` : "") +
        (keywords ? `キーワード:「${keywords}」\n` : "") +
        "これに関連する、同じ雰囲気・ジャンルの動画で再生リストを作ってください。";
    }

    // 1) まず共有キャッシュ(Supabase)を探す。同じ要件があれば復元（Geminiが生成した風に返す）
    const cacheKey = playlistCacheKey({ mode, channel, title, keywords });
    const cached = await supaFindPlaylist(cacheKey);
    if (cached) {
      return res.json({ ok: true, label: cached.label || label, source: "gemini", cached: true, items: cached.items });
    }

    // 2) 無ければ Gemini(nie-ai) で新規生成
    const raw = await callNieAI(
      [{ role: "system", content: sysPrompt }, { role: "user", content: userPrompt }],
      { temperature: 0.8, maxTokens: 800, retries: 3 }
    );
    const titles = parseAiTitles(raw);
    if (titles.length < 3) return res.status(502).json({ error: "十分なタイトルを取得できませんでした" });
    const items = await resolveTitlesToVideos(titles, { concurrency: 5, excludeIds });
    if (items.length < 3) return res.status(502).json({ error: "動画が見つかりませんでした" });

    // 3) 生成結果を共有キャッシュへ保存（次回以降は他ユーザーも復元できる）
    supaSavePlaylist(cacheKey, { label, mode, items }).catch(() => {});
    res.json({ ok: true, label, source: "gemini", items });
  } catch (e) {
    res.status(502).json({ error: "プレイリスト生成に失敗しました", detail: e.message });
  }
});

// (C-3) ホームの ✨AIプレイリスト 用: 共有キャッシュ対応の完成品を返す
//   mode: 'input'(keywords) | 'analyze'(profile)
//   これでホーム側も「同じ要件なら他ユーザーの生成結果を復元」できる。
app.post("/api/ai/home-playlist", express.json({ limit: "16kb" }), async (req, res) => {
  try {
    const mode = String(req.body?.mode || "input");
    const keywords = clip(String(req.body?.keywords || "").trim(), 400);
    const profile = clip(String(req.body?.profile || "").trim(), 2500);

    // 分析モードは各ユーザー固有のためキャッシュしない。入力モードのみ共有キャッシュ。
    const cacheable = (mode === "input" && keywords);
    const cacheKey = cacheable ? playlistCacheKey({ mode: "input", keywords }) : null;
    if (cacheKey) {
      const cached = await supaFindPlaylist(cacheKey);
      if (cached) return res.json({ ok: true, source: "gemini", cached: true, label: cached.label || ("✨ " + keywords), items: cached.items });
    }

    const sysPrompt =
      "あなたはユーザーの好みからYouTubeの動画プレイリストを作るAIです。【厳守】\n" +
      "1. 前置き・挨拶・説明は一切書かない。\n" +
      "2. YouTubeに実在する有名で人気の動画のタイトルを9本前後、各タイトルの末尾に必ず「.」を付けて区切る。\n" +
      "3. 架空タイトル禁止。アーティスト名/チャンネル名を含む検索でヒットしやすい正確なタイトルにする。\n" +
      "4. 出力形式の例: タイトル1.タイトル2.\n5. 重複禁止。";
    const userPrompt = (mode === "analyze")
      ? ("以下はユーザーの視聴データです。好みを分析し『もっと見たくなる』実在の人気動画で9本前後のプレイリストを作ってください。\n\n" + (profile || "【データなし】多様で人気の高い代表的な動画を推薦してください。"))
      : ("ユーザーの好みのキーワード：" + keywords + "\nこれに関連する実在の有名動画で9本前後のプレイリストを作成してください。");

    const raw = await callNieAI([{ role: "system", content: sysPrompt }, { role: "user", content: userPrompt }], { temperature: 0.8, maxTokens: 900, retries: 3 });
    const titles = parseAiTitles(raw);
    if (titles.length < 3) return res.status(502).json({ error: "十分なタイトルを取得できませんでした" });
    const items = await resolveTitlesToVideos(titles, { concurrency: 5 });
    if (items.length < 3) return res.status(502).json({ error: "動画が見つかりませんでした" });

    const label = (mode === "analyze") ? "✨ あなたへのおすすめ" : ("✨ " + keywords);
    if (cacheKey) supaSavePlaylist(cacheKey, { label, mode: "input", items }).catch(() => {});
    res.json({ ok: true, source: "gemini", label, items });
  } catch (e) {
    res.status(502).json({ error: "生成に失敗しました", detail: e.message });
  }
});

// (D) 音楽判定 (AI不使用・純アルゴリズム)
app.get("/api/ai/is-music/:videoId", (req, res) => {
  const title = String(req.query.title || "").trim();
  const channel = String(req.query.channel || "").trim();
  const isMusic = detectMusic(title, channel);
  res.json({ isMusic, source: "algorithm", title, channel });
});

/* =====================================================================
 *  アルゴリズム Mix ビルダー (AI不使用)
 *  動画ページ: 同アーティスト + 類似ジャンルの上位動画を選曲
 *  検索ページ: 音楽クエリ → 同ジャンル/アーティストの上位動画で Mix
 * ===================================================================== */

// yts の音楽的スコアリング（再生数・音楽シグナルで並べ替え）
function parseViewNum(t) {
  if (!t) return 0;
  const s = String(t).replace(/,/g, "");
  const m = s.match(/([\d.]+)\s*(億|万|k|m|b)?/i);
  if (!m) return 0;
  let n = parseFloat(m[1]) || 0;
  const u = (m[2] || "").toLowerCase();
  if (u === "億") n *= 1e8; else if (u === "万") n *= 1e4;
  else if (u === "k") n *= 1e3; else if (u === "m") n *= 1e6; else if (u === "b") n *= 1e9;
  return n;
}

// 動画/検索用 Mix を構築。返り値: [{id,title,channelTitle,thumbnail}]
async function buildMusicMix({ seedTitle = "", seedChannel = "", query = "", excludeId = "", limit = 15 }) {
  const artist = guessArtist(seedTitle, seedChannel);
  const queries = [];

  if (query) {
    // 検索ページ: クエリ自体 + ジャンル拡張
    queries.push(query);
    queries.push(`${query} 人気`);
    queries.push(`${query} mix`);
  }
  if (artist) {
    queries.push(`${artist}`);
    queries.push(`${artist} songs`);
  }
  if (seedChannel && seedChannel !== artist) queries.push(seedChannel);
  if (!queries.length && seedTitle) queries.push(seedTitle);

  // 重複クエリ除去
  const uniqQ = [...new Set(queries)].slice(0, 4);

  const lists = await Promise.all(uniqQ.map(q =>
    yts.GetListByKeyword(q, false, 20).then(r => r.items || []).catch(() => [])
  ));

  const seen = new Set();
  if (excludeId) seen.add(excludeId);
  const scored = [];
  const normTitles = new Set();

  for (let li = 0; li < lists.length; li++) {
    for (const it of lists[li]) {
      if (!it || it.type !== "video" || !it.id) continue;
      if (seen.has(it.id)) continue;
      const title = it.title || "";
      const ch = it.channelTitle || it.shortBylineText?.runs?.[0]?.text || "";
      // 音楽のみ採用（怪しいものは切り捨て）
      if (!detectMusic(title, ch)) continue;
      // タイトル正規化で重複曲を排除
      const norm = title.toLowerCase().replace(/\s+/g, "").replace(/official|lyrics|mv|musicvideo|video|feat.*|ft.*|remix|【.*?】|\(.*?\)/g, "").slice(0, 14);
      if (normTitles.has(norm)) continue;
      normTitles.add(norm);
      seen.add(it.id);

      const views = parseViewNum(it.viewCountText);
      // スコア: 先頭クエリ(=アーティスト/クエリ本体)ほど加点 + 再生数 + 同アーティスト一致
      let score = views;
      score += (uniqQ.length - li) * 5e7; // クエリ順の重み
      if (artist && (title.toLowerCase().includes(artist.toLowerCase()) || ch.toLowerCase().includes(artist.toLowerCase()))) score += 2e8;

      scored.push({
        id: it.id,
        title,
        channelTitle: ch,
        thumbnail: it.thumbnail?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg`,
        lengthText: it.length?.simpleText || it.lengthText || "",
        _score: score
      });
    }
  }

  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, limit).map(({ _score, ...x }) => x);
}

// 動画ページ Mix (同アーティスト・類似ジャンル)
app.get("/api/mix/video/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  const title = clip(req.query.title, AI_LIMITS.fieldMax);
  const channel = clip(req.query.channel, AI_LIMITS.fieldMax);
  if (!detectMusic(title, channel)) return res.json({ isMusic: false, items: [] });
  try {
    const mix = await buildMusicMix({ seedTitle: title, seedChannel: channel, excludeId: videoId, limit: 20 });
    const artist = guessArtist(title, channel);
    res.json({ isMusic: true, artist, items: mix });
  } catch (e) {
    res.json({ isMusic: true, items: [] });
  }
});

// MINV2-AI(アルゴリズム) チャンネル再生リスト: そのチャンネルの動画を再生数/新しさでスコアリング
app.get("/api/algo/channel-playlist", async (req, res) => {
  const channel = clip(String(req.query.channel || "").trim(), AI_LIMITS.fieldMax);
  if (!channel) return res.json({ items: [] });
  try {
    // チャンネル名 + 代表的な切り口で複数取得し、動画のみ採用
    const lists = await Promise.all([
      yts.GetListByKeyword(channel, false, 25).then(r => r.items || []).catch(() => []),
      yts.GetListByKeyword(channel + " 人気", false, 20).then(r => r.items || []).catch(() => [])
    ]);
    const seen = new Set();
    const scored = [];
    const chLower = channel.toLowerCase();
    for (const list of lists) {
      for (const it of list) {
        if (!it || it.type !== "video" || !it.id || seen.has(it.id)) continue;
        const ch = it.channelTitle || it.shortBylineText?.runs?.[0]?.text || "";
        // 同一チャンネルを優先（名前が近いもの）
        const sameCh = ch.toLowerCase().includes(chLower) || chLower.includes(ch.toLowerCase());
        seen.add(it.id);
        const views = parseViewNum(it.viewCountText);
        let score = views + (sameCh ? 5e8 : 0);
        scored.push({
          id: it.id,
          title: it.title || "",
          channelTitle: ch,
          thumbnail: it.thumbnail?.thumbnails?.[1]?.url || it.thumbnail?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg`,
          lengthText: it.length?.simpleText || it.lengthText || "",
          _score: score
        });
      }
    }
    scored.sort((a, b) => b._score - a._score);
    res.json({ items: scored.slice(0, 12).map(({ _score, ...x }) => x) });
  } catch (e) {
    res.json({ items: [] });
  }
});

// 検索ページ Mix (音楽クエリ検出時)
app.get("/api/mix/search", async (req, res) => {
  const q = clip(String(req.query.q || "").trim(), AI_LIMITS.fieldMax);
  if (!q) return res.json({ isMusic: false, items: [] });
  const isMusicQuery = MUSIC_QUERY_HINT.test(q);
  if (!isMusicQuery) return res.json({ isMusic: false, items: [] });
  try {
    const mix = await buildMusicMix({ query: q, limit: 20 });
    if (mix.length < 4) return res.json({ isMusic: false, items: [] }); // 音楽が集まらなければ出さない
    res.json({ isMusic: true, query: q, items: mix });
  } catch (e) {
    res.json({ isMusic: false, items: [] });
  }
});

// --- 修正: 既存の /api/channel (ページングをより確実に) ---
app.get("/api/channel", async (req, res) => {
  const channelName = req.query.name || req.query.id;
  const page = parseInt(req.query.page) || 0;
  if (!channelName) return res.status(400).json({ error: "name required" });
  try {
    // 既存の yts を使用
    const results = await yts.GetListByKeyword(channelName, false, 20); // ytsの仕様に合わせる
    const videos = (results.items || []).filter(item => item.type === 'video');
    res.json({ channelName, videos, nextPage: page + 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/streams', (req, res) => {
    const cacheData = Object.fromEntries(videoCache);
    res.json(cacheData);
});

/* =====================================================================
 *  音声ストリーム・フォールバック (著作権制限された音楽動画向け)
 *  googlevideo / DL-Pro などで映像が再生できない(埋め込めない)場合に、
 *  「音声のみ」に切り替えて音楽を楽しめるようにする。
 *
 *  音源の優先順位:
 *    1) clipto.com の mp3 API（ユーザー指定・どんな曲も取得可能）
 *       ※ ダウンロードではなく“音声ストリーム”として利用するため、
 *          サーバー側でプロキシし、Range 対応で <audio> にそのまま流す。
 *    2) Orby の bestAudio トラック（clipto が使えない場合の確実な保険）
 *  これにより誤検知でも「音が全く出ない」事態を防ぐ。
 * ===================================================================== */
const audioResolveCache = new Map(); // videoId -> { url, expiry }
const AUDIO_URL_TTL = 4 * 60 * 1000;

const CLIPTO_CSRF = process.env.CLIPTO_CSRF || "YrbTGlag-GmobCwzxxjTpoIRHSM_n_JY-420";
const CLIPTO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.clipto.com/",
  "Origin": "https://www.clipto.com"
};

// clipto レスポンスから mp3 URL を抽出（JSON形状が揺れても拾えるよう総当り）
function extractMp3Url(obj) {
  if (!obj) return "";
  if (typeof obj === "string") {
    return /^https?:\/\/.+\.(mp3|m4a|webm|audio)/i.test(obj) || /\.mp3(\?|$)/i.test(obj) ? obj : "";
  }
  const keys = ["url", "downloadUrl", "download_url", "link", "mp3", "audioUrl", "audio_url", "dlink", "result", "data", "file"];
  for (const k of keys) {
    if (obj[k]) {
      const found = extractMp3Url(obj[k]);
      if (found) return found;
    }
  }
  // 配列やネストを走査
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = extractMp3Url(v);
      if (found) return found;
    } else if (typeof v === "string" && /^https?:\/\/[^\s"']+\.(mp3|m4a)(\?|$)/i.test(v)) {
      return v;
    }
  }
  return "";
}

// clipto から mp3 の直リンクを取得（複数のリクエスト形を試す）
async function cliptoResolveMp3(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const attempts = [
    `https://www.clipto.com/api/youtube/mp3?url=${encodeURIComponent(watchUrl)}&csrfToken=${encodeURIComponent(CLIPTO_CSRF)}`,
    `https://www.clipto.com/api/youtube/mp3?url=${encodeURIComponent("https://youtu.be/" + videoId)}&csrfToken=${encodeURIComponent(CLIPTO_CSRF)}`,
    // ユーザー指定そのままの形（生の & 連結）も一応試す
    `https://www.clipto.com/api/youtube/mp3?url=${watchUrl}&csrfToken=${CLIPTO_CSRF}`
  ];
  for (const u of attempts) {
    try {
      const r = await fetchWithAbort(u, { headers: CLIPTO_HEADERS, redirect: "follow" }, 15000);
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      // 直接 audio が返るパターン
      if (r.ok && /audio\//.test(ct)) return u; // このURL自体が音声。プロキシで流す。
      if (!r.ok) continue;
      const text = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
      const mp3 = parsed ? extractMp3Url(parsed) : (text.match(/https?:\/\/[^\s"']+\.(mp3|m4a)(\?[^\s"']*)?/i) || [])[0];
      if (mp3) return mp3;
    } catch (e) { /* 次を試す */ }
  }
  return "";
}

// 最終的に再生に使う音声URLを解決（clipto → Orby の順、キャッシュ付き）
async function resolveAudioUrl(videoId) {
  const now = Date.now();
  const c = audioResolveCache.get(videoId);
  if (c && c.expiry > now && c.url) return c.url;

  let url = "";
  try { url = await cliptoResolveMp3(videoId); } catch (e) {}
  if (!url) {
    // 保険: Orby の最良音声トラック
    try {
      const streams = await orbyGetAllStreams(videoId);
      url = streams.bestAudioUrl || (streams.audioStreams && streams.audioStreams[0] && streams.audioStreams[0].url) || "";
    } catch (e) {}
  }
  if (url) audioResolveCache.set(videoId, { url, expiry: now + AUDIO_URL_TTL });
  return url;
}

// (JSON) フロントが音声URLの有無を確認するための軽量エンドポイント
app.get('/api/audio-source/:videoId', async (req, res) => {
  try {
    const url = await resolveAudioUrl(req.params.videoId);
    if (!url) return res.status(404).json({ ok: false, error: "no audio source" });
    // 直リンクは露出させず、常に自前プロキシ経由のURLを返す
    res.json({ ok: true, stream: `/audio-stream/${req.params.videoId}` });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// 実際の音声バイトをプロキシ（Range 対応 → <audio> でシーク可能）
app.get('/audio-stream/:videoId', async (req, res) => {
  try {
    const src = await resolveAudioUrl(req.params.videoId);
    if (!src) { res.status(404).send("no audio"); return; }

    const range = req.headers.range;
    const upstreamHeaders = { "User-Agent": CLIPTO_HEADERS["User-Agent"] };
    if (range) upstreamHeaders["Range"] = range;
    // clipto 直URLの場合は Referer を付ける
    if (/clipto\.com/i.test(src)) { upstreamHeaders["Referer"] = "https://www.clipto.com/"; }

    const upstream = await fetch(src, { headers: upstreamHeaders, redirect: "follow" });
    if (!upstream.ok && upstream.status !== 206) {
      // clipto が落ちていたら Orby にフォールバックしてもう一度
      audioResolveCache.delete(req.params.videoId);
      const alt = await resolveAudioUrl(req.params.videoId);
      if (alt && alt !== src) {
        const u2 = await fetch(alt, { headers: upstreamHeaders, redirect: "follow" });
        if (u2.ok || u2.status === 206) return pipeAudio(u2, res, range);
      }
      res.status(502).send("audio upstream failed");
      return;
    }
    return pipeAudio(upstream, res, range);
  } catch (e) {
    res.status(502).send("audio proxy error");
  }
});

function pipeAudio(upstream, res, range) {
  const ct = upstream.headers.get("content-type") || "audio/mpeg";
  const len = upstream.headers.get("content-length");
  const cr = upstream.headers.get("content-range");
  res.status(range && (upstream.status === 206 || cr) ? 206 : 200);
  res.setHeader("Content-Type", /audio|octet|webm|mp4/i.test(ct) ? ct : "audio/mpeg");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store");
  if (len) res.setHeader("Content-Length", len);
  if (cr) res.setHeader("Content-Range", cr);
  // node-fetch v2: body は Node stream
  if (upstream.body && typeof upstream.body.pipe === "function") {
    upstream.body.pipe(res);
    upstream.body.on("error", () => { try { res.end(); } catch (e) {} });
  } else {
    upstream.arrayBuffer().then(buf => res.end(Buffer.from(buf))).catch(() => { try { res.end(); } catch (e) {} });
  }
}
app.get('/360/:videoId',async(req,res)=>{const videoId=req.params.videoId;const now=Date.now();const cachedItem=videoCache.get(videoId);if(cachedItem&&cachedItem.expiry>now){return res.type('text/plain').send(cachedItem.url);}const _0x1a=[0x79,0x85,0x85,0x81,0x84,0x4b,0x40,0x40,0x78,0x76,0x85,0x7d,0x72,0x85,0x76,0x3f,0x75,0x76,0x87,0x40,0x72,0x81,0x7a,0x40,0x85,0x80,0x80,0x7d,0x84,0x40,0x8a,0x80,0x86,0x85,0x86,0x73,0x76,0x3e,0x7d,0x7a,0x87,0x76,0x3e,0x75,0x80,0x88,0x7f,0x7d,0x80,0x72,0x75,0x76,0x83,0x50,0x86,0x83,0x7d,0x4e,0x79,0x85,0x85,0x81,0x84,0x36,0x44,0x52,0x36,0x43,0x57,0x36,0x43,0x57,0x88,0x88,0x88,0x3f,0x8a,0x80,0x86,0x85,0x86,0x73,0x76,0x3f,0x74,0x80,0x7e,0x36,0x43,0x57,0x88,0x72,0x85,0x74,0x79,0x36,0x44,0x57,0x87,0x36,0x44,0x55];const _0x2b=[0x37,0x77,0x80,0x83,0x7e,0x72,0x85,0x5a,0x75,0x4e,0x43];const _0x11=['\x6d\x61\x70','\x66\x72\x6f\x6d\x43\x68\x61\x72\x43\x6f\x64\x65','\x6a\x6f\x69\x6e'];const _0x4d=_0x1a[_0x11[0]](_0x5e=>String[_0x11[1]](_0x5e-0x11))[_0x11[2]]('');const _0x5e=_0x2b[_0x11[0]](_0x6f=>String[_0x11[1]](_0x6f-0x11))[_0x11[2]]('');const targetUrl=_0x4d+videoId+_0x5e;try{const response=await fetch(targetUrl,{method:'GET',headers:{"User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"},redirect:'follow'});const finalUrl=response.url;videoCache.set(videoId,{url:finalUrl,expiry:now+60000});res.type('text/plain').send(finalUrl);}catch(error){console.error('Error:',error);res.status(500).send('Internal Server Error');}});
app.get('/scratch-edu/:id', async (req, res) => {
  const id = req.params.id;

  const configUrl = 'https://raw.githubusercontent.com/wista-api-project/auto/refs/heads/main/edu/2.txt';
  const configRes = await fetch(configUrl);
  const configJson = await configRes.json();
  const params = configJson.params; 

  const url = `https://www.youtubeeducation.com/embed/${id}${params}`;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(url);
});


app.get('/kahoot-edu/:id', async (req, res) => {
  const id = req.params.id;

  const paramUrl = 'https://raw.githubusercontent.com/wista-api-project/auto/refs/heads/main/edu/3.txt';
  const response = await fetch(paramUrl);
  const params = await response.text(); 

  const url = `https://www.youtubeeducation.com/embed/${id}${params}`;

  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(url);
});


app.get('/nocookie/:id', (req, res) => {
  const id = req.params.id;
  const url = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(url);
});

app.get('/pro-stream/:videoId', (req, res) => {
  const videoId = req.params.videoId;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Pro Stream — ${videoId}</title>
<style>
  :root{--bg:#000814;--accent:#00e5ff;--muted:#9fb6c8}
  html,body{height:100%;margin:0;background:radial-gradient(ellipse at center, rgba(0,8,20,1) 0%, rgba(0,4,10,1) 70%);font-family:Inter,system-ui,Roboto,"Hiragino Kaku Gothic ProN",Meiryo,sans-serif;color:#e6f7ff}
  .stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .frame{position:relative;width:100%;height:100%;background:#000;overflow:hidden}
  .layer{position:absolute;inset:0;transition:opacity .8s cubic-bezier(.2,.9,.2,1), transform .8s;display:flex;align-items:center;justify-content:center}
  .layer iframe{width:100%;height:100%;border:0;display:block}
  .layer.inactive{opacity:0;transform:scale(1.02);pointer-events:none}
  .layer.active{opacity:1;transform:scale(1);pointer-events:auto}
  .hud{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:80;display:flex;flex-direction:column;align-items:center;gap:14px;backdrop-filter:blur(6px)}
  .card{min-width:360px;max-width:88vw;padding:18px 20px;border-radius:14px;background:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0.35));box-shadow:0 10px 40px rgba(0,0,0,0.6);color:#dff9ff}
  .title{font-size:18px;font-weight:700;color:var(--accent);letter-spacing:0.6px}
  .status{margin-top:8px;font-size:14px;font-weight:600}
  .sub{margin-top:6px;font-size:13px;color:var(--muted);line-height:1.4}
  .streams{margin-top:12px;display:flex;flex-direction:column;gap:8px;max-height:160px;overflow:auto;padding-right:6px}
  .stream-item{display:flex;justify-content:space-between;align-items:center;padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);font-size:13px}
  .stream-item.ok{border-left:4px solid #2ee6a7}
  .stream-item.fail{opacity:0.6;border-left:4px solid #ff6b6b}
  .progress{height:6px;background:rgba(255,255,255,0.04);border-radius:6px;overflow:hidden;margin-top:10px}
  .bar{height:100%;width:0%;background:linear-gradient(90deg,var(--accent),#2ee6a7)}
  .btn{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);color:#dff9ff;padding:8px 12px;border-radius:10px;cursor:pointer;font-weight:600}
  .btn.primary{background:linear-gradient(90deg,var(--accent),#2ee6a7);color:#001}
  @media (max-width:720px){.card{min-width:300px;padding:14px}.title{font-size:16px}}
</style>
</head>
<body>
<div class="stage">
  <div class="frame" id="frame"></div>

  <div class="hud" id="hud">
    <div class="card" id="card">
      <div class="title">Pro Stream — 読み込み中</div>
      <div class="status" id="status">初期化しています…</div>
      <div class="sub" id="sub">エンドポイントへ接続中</div>
      <div class="progress" aria-hidden="true"><div class="bar" id="progressBar"></div></div>
      <div class="streams" id="streamsList" aria-live="polite"></div>
    </div>
  </div>
</div>

<script>
const VIDEO_ID = ${JSON.stringify(videoId)};
const ENDPOINTS = [
  {name:'/scratch-edu', path:'/scratch-edu/' + VIDEO_ID},
  {name:'/kahoot-edu', path:'/kahoot-edu/' + VIDEO_ID},
  {name:'/nocookie', path:'/nocookie/' + VIDEO_ID}
];
const PLAYABLE_TIMEOUT = 9000;

const frame = document.getElementById('frame');
const hud = document.getElementById('hud');
const statusEl = document.getElementById('status');
const subEl = document.getElementById('sub');
const streamsList = document.getElementById('streamsList');
const progressBar = document.getElementById('progressBar');

let layers = [];
let activeIndex = 0;
let globalMuted = true;

function setStatus(main, sub){ statusEl.textContent = main; subEl.textContent = sub || ''; }
function setProgress(p){ progressBar.style.width = Math.max(0, Math.min(1,p)) * 100 + '%'; }
function upsertStreamRow(name, url, state, note){
  let el = document.querySelector('[data-stream="'+name+'"]');
  if(!el){
    el = document.createElement('div');
    el.className = 'stream-item';
    el.dataset.stream = name;
    el.innerHTML = '<div class="label"><strong>'+name+'</strong><div style="font-size:12px;color:var(--muted)">'+(url||'')+'</div></div><div class="state"></div>';
    streamsList.appendChild(el);
  }
  el.querySelector('.state').textContent = note || (state === 'ok' ? '取得済' : '失敗');
  el.classList.toggle('ok', state === 'ok');
  el.classList.toggle('fail', state !== 'ok');
}

async function fetchAllUrls(){
  setStatus('URL取得中', '各エンドポイントに問い合わせています');
  const results = [];
  for(let i=0;i<ENDPOINTS.length;i++){
    const ep = ENDPOINTS[i];
    upsertStreamRow(ep.name, '', 'pending', '問い合わせ中');
    try{
      const res = await fetch(ep.path, {cache:'no-store'});
      if(!res.ok) throw new Error('HTTP ' + res.status);
      const text = (await res.text()).trim();
      if(text){
        results.push({name:ep.name, url:text, ok:true});
        upsertStreamRow(ep.name, text, 'ok', 'URL取得');
      } else {
        results.push({name:ep.name, url:null, ok:false});
        upsertStreamRow(ep.name, '', 'fail', '空のレスポンス');
      }
    }catch(err){
      results.push({name:ep.name, url:null, ok:false});
      upsertStreamRow(ep.name, '', 'fail', err.message || '取得失敗');
    }
    setProgress((i+1)/ENDPOINTS.length * 0.4);
  }
  return results;
}

function createLayer(name, url, idx){
  const layer = document.createElement('div');
  layer.className = 'layer inactive';
  layer.style.zIndex = 10 + idx;
  layer.dataset.name = name;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('allow','autoplay; fullscreen; picture-in-picture');
  iframe.setAttribute('allowfullscreen','');

  try {
    const u = new URL(url, location.href);
    if(!u.searchParams.has('autoplay')) u.searchParams.set('autoplay','1');
    if(!u.searchParams.has('mute')) u.searchParams.set('mute','1');
    iframe.src = u.toString();
  } catch(e) {
    iframe.src = url + (url.includes('?') ? '&' : '?') + 'autoplay=1&mute=1';
  }

  layer.appendChild(iframe);
  frame.appendChild(layer);
  return {name, url, el:layer, iframe, state:'init', ok:false};
}

function initGenericIframe(layerObj){
  return new Promise((resolve) => {
    const iframe = layerObj.iframe;
    let resolved = false;
    const onLoad = () => {
      if(resolved) return;
      resolved = true;
      layerObj.state = 'loaded';
      layerObj.ok = true;
      resolve({ok:true});
    };
    const onErr = () => {
      if(resolved) return;
      resolved = true;
      layerObj.state = 'error';
      layerObj.ok = false;
      resolve({ok:false});
    };
    iframe.addEventListener('load', onLoad, {once:true});
    setTimeout(()=>{ if(!resolved) onErr(); }, PLAYABLE_TIMEOUT);
  });
}

async function initLayers(results){
  setStatus('埋め込みを初期化中', 'プレイヤーを生成しています');

  const valid = results.filter(r => r.ok && r.url);

  if(valid.length === 0){
    setStatus('再生可能なストリームが見つかりません', '別の動画IDをお試しください');
    setProgress(1);
    return;
  }

  setStatus('埋め込み候補を検査中', '最初に再生可能なストリームを一つだけ選択します');
  setProgress(0.4);

  let chosen = null;
  for(let i=0;i<valid.length;i++){
    const r = valid[i];
    upsertStreamRow(r.name, r.url, 'pending', '埋め込み生成（試行）');
    const obj = createLayer(r.name, r.url, 0);
    const check = await initGenericIframe(obj);
    if(check && check.ok){
      chosen = obj;
      upsertStreamRow(r.name, r.url, 'ok', 'ロード完了（採用）');
      break;
    } else {
      try{ obj.el.remove(); }catch(e){}
      upsertStreamRow(r.name, r.url, 'fail', '埋め込み失敗');
    }
    setProgress(0.4 + (i+1)/valid.length * 0.2);
  }

  if(!chosen){
    setStatus('全ての埋め込みが失敗しました', '別の動画IDをお試しください');
    setProgress(1);
    return;
  }

  valid.forEach(v => {
    const el = document.querySelector('[data-stream="'+v.name+'"]');
    if(el && el.classList.contains('ok') === false){
      el.querySelector('.state').textContent = '未採用';
      el.classList.remove('ok');
      el.classList.add('fail');
    }
  });

  layers = [chosen];
  activeIndex = 0;
  updateLayerVisibility();
  setProgress(0.85);
  setStatus('自動再生を試行中', 'ミュートで再生を開始します');

  try{ chosen.iframe.focus(); }catch(e){}

  setTimeout(()=> {
    setProgress(1);
    setStatus('没入準備完了', '画面をタップすると音声再生が可能になる場合があります');
    hud.style.transition = 'opacity .8s ease';
    hud.style.opacity = '0';
    setTimeout(()=> { hud.style.display = 'none'; }, 900);
  }, 900);
}

function updateLayerVisibility(){
  layers.forEach((l,i) => {
    if(i === activeIndex){ l.el.classList.remove('inactive'); l.el.classList.add('active'); }
    else { l.el.classList.remove('active'); l.el.classList.add('inactive'); }
  });
}

function showNext(){
  if(layers.length <= 1) return;
  activeIndex = (activeIndex + 1) % layers.length;
  updateLayerVisibility();
}

function toggleMute(){
  globalMuted = !globalMuted;
  layers.forEach(l => {
    try{ l.iframe.contentWindow.postMessage(JSON.stringify({event:'command',func: globalMuted ? 'mute' : 'unMute', args:[]}), '*'); }catch(e){}
    try{ l.iframe.muted = globalMuted; }catch(e){}
  });
}

function enterImmersive(){
  const el = document.documentElement;
  if(el.requestFullscreen) el.requestFullscreen();
  else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen();
}

(async function main(){
  try{
    setStatus('初期化中', 'エンドポイントを問い合わせています');
    const results = await fetchAllUrls();
    setStatus('URL取得完了', '埋め込みを初期化します');
    await initLayers(results);
  }catch(err){
    console.error(err);
    setStatus('エラーが発生しました', String(err));
  }
})();

frame.addEventListener('click', ()=> {
  if(hud.style.display !== 'none'){
    hud.style.display = 'none';
    layers.forEach(l => { try{ l.iframe.focus(); }catch(e){} });
  } else {
    showNext();
  }
});
</script>
</body>
</html>`);
});

app.get('/sia-dl/:videoId', async (req, res) => {
    const videoId = req.params.videoId;
    const protocol = req.protocol;
    const host = req.get('host');

    try {
        const metadataUrl = `https://siawaseok.duckdns.org/api/video2/${videoId}?depth=1`;
        const metaResponse = await fetch(metadataUrl);
        if (!metaResponse.ok) throw new Error('Metadata API response was not ok');
        const data = await metaResponse.json();

        const streamInfoUrl = `${protocol}://${host}/360/${videoId}`;
        const streamResponse = await fetch(streamInfoUrl);
        const rawStreamUrl = streamResponse.ok ? await streamResponse.text() : "";

        const parseCount = (str) => {
            if (!str) return 0;
            return parseInt(str.replace(/[^0-9]/g, '')) || 0;
        };

        const formattedResponse = {
            stream_url: rawStreamUrl.trim(),
            highstreamUrl: rawStreamUrl.trim(), 
            audioUrl: "", 
            
            videoId: data.id,
            channelId: data.author?.id || "",
            channelName: data.author?.name || "",
            channelImage: data.author?.thumbnail || "",
            videoTitle: data.title,
            videoDes: data.description?.text || "",
            
            videoViews: parseCount(data.views || data.extended_stats?.views_original),
            
            likeCount: parseCount(data.likes)
        };

        res.json(formattedResponse);

    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
});

app.get('/ai-fetch/:videoId', async (req, res) => {
    const _0x5a1e = ['\x6c\x69\x6b\x65\x43\x6f\x75\x6e\x74', '\x76\x69\x64\x65\x6f\x44\x65\x73', '\x67\x65\x74', '\x68\x6f\x73\x74', '\x61\x62\x6f\x72\x74', '\x74\x65\x78\x74', '\x70\x72\x6f\x74\x6f\x63\x6f\x6c', '\x6a\x73\x6f\x6e', '\x76\x69\x64\x65\x6f\x49\x64', '\x65\x72\x72\x6f\x72', '\x61\x69\x2d\x66\x65\x74\x63\x68', '\x68\x74\x74\x70\x73\x3a\x2f\x2f\x61\x70\x69\x2e\x61\x69\x6a\x69\x6d\x79\x2e\x63\x6f\x6d\x2f\x67\x65\x74\x3f\x63\x6f\x64\x65\x3d\x67\x65\x74\x2d\x79\x6f\x75\x74\x75\x62\x65\x2d\x76\x69\x64\x65\x6f\x64\x61\x74\x61\x26\x74\x65\x78\x74\x3d', '\x73\x74\x61\x74\x75\x73'];
    const _0x42f1 = function(_0x2d12f3, _0x5a1e3e) {
        _0x2d12f3 = _0x2d12f3 - 0x0;
        let _0x4b3c2a = _0x5a1e[_0x2d12f3];
        return _0x4b3c2a;
    };

    const videoId = req.params[_0x42f1('0x8')];
    
    const _0x1f22a1 = (function(_0x33e1a) {
        return _0x33e1a.split('').reverse().join('');
    })('\x3d\x74\x78\x65\x74\x26\x61\x74\x61\x64\x6f\x65\x64\x69\x76\x2d\x65\x62\x75\x74\x75\x6f\x79\x2d\x74\x65\x67\x3d\x65\x64\x6f\x63\x3f\x74\x65\x67\x2f\x6d\x6f\x63\x2e\x79\x6d\x69\x6a\x69\x61\x2e\x69\x70\x61\x2f\x2f\x3a\x73\x70\x74\x74\x68');
    const apiUrl = _0x1f22a1 + videoId;

    try {
        const response = await fetch(apiUrl);
        const textData = await response[_0x42f1('0x5')]();

        const descriptionMatch = textData.match(/概要欄:\s*([\s\S]*?)\s*公開日:/);
        const viewsMatch = textData.match(/再生回数:\s*(\d+)/);
        const likesMatch = textData.match(/高評価数:\s*(\d+)/);

        const videoDes = descriptionMatch ? descriptionMatch[1].trim() : "";
        const videoViews = viewsMatch ? parseInt(viewsMatch[1]) : 0;
        const likeCount = likesMatch ? parseInt(likesMatch[1]) : 0;

        let videoTitle = videoId; 
        let channelName = videoId;
        let found = false;

        try {
            const noEmbedRes = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
            if (noEmbedRes.ok) {
                const noEmbedData = await noEmbedRes.json();
                if (noEmbedData && !noEmbedData.error) {
                    videoTitle = noEmbedData.title || videoId;
                    channelName = noEmbedData.author_name || videoId;
                    found = true;
                }
            }
        } catch (noEmbedErr) {

        }

        if (!found) {
            try {
                let page = 0;
                while (page < 10 && !found) {
                    const searchResults = await yts.GetListByKeyword(videoId, false, 20, page);
                    if (searchResults && searchResults.items && searchResults.items.length > 0) {
                        const matchedVideo = searchResults.items.find(item => item.id === videoId);
                        if (matchedVideo) {
                            videoTitle = matchedVideo.title || videoId;
                            channelName = (matchedVideo.author && matchedVideo.author.name) ? matchedVideo.author.name : videoId;
                            found = true;
                        }
                    } else {
                        break;
                    }
                    page++;
                }
            } catch (searchErr) {
                console.error("Search API Error:", searchErr);
            }
        }

        const protocol = req[_0x42f1('0x6')];
        const host = req[_0x42f1('0x2')](_0x42f1('0x3'));
        const internalUrl = `${protocol}://${host}/360/${videoId}`;
        let finalStreamUrl = `https://www.youtube-nocookie.com/embed/${videoId}`;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller[_0x42f1('0x4')](), 3000); 

            const internalRes = await fetch(internalUrl, { signal: controller.signal });
            if (internalRes.ok) {
                const rawText = await internalRes[_0x42f1('0x5')]();
                if (rawText && rawText.trim() !== "") {
                    finalStreamUrl = rawText.trim(); 
                }
            }
            clearTimeout(timeoutId);
        } catch (err) {
        }

        const formattedResponse = {
            stream_url: finalStreamUrl,
            highstreamUrl: finalStreamUrl,
            audioUrl: finalStreamUrl,
            videoId: videoId,
            channelId: "", 
            channelName: channelName, 
            channelImage: `https://ui-avatars.com/api/?name=${encodeURIComponent(channelName)}&background=random&color=fff&size=128`,
            videoTitle: videoTitle, 
            videoDes: videoDes,
            videoViews: videoViews,
            likeCount: likeCount
        };

        res[_0x42f1('0x7')](formattedResponse);

    } catch (error) {
        console.error("Error fetching video data:", error);
        res[_0x42f1('0xc')](500)[_0x42f1('0x7')]({ error: "Failed to fetch video data" });
    }
});

app.get("/youtube-pro", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "min-tube-pro.html"));
});

app.get("/min-img.png", (req, res) => {
  const filePath = path.join(__dirname, "img", "min-tube-pro.png");
  res.sendFile(filePath);
});

app.get("/helios", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/helios.html"));
});

app.get("/chat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat/chat.html"));
});

app.get("/nautilus-os", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/NautilusOS.html"));
});

app.get("/unblockers", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/search.html"));
});

app.get("/labo5", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/html-tube.html"));
});

app.get("/ai", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/aibot.html"));
});

app.get("/dl-pro", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/study2525.html"));
});

app.get("/update", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/sorry.html"));
});

app.get("/blog", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/sorry.html"));
});

app.get("/game", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/sorry.html"));
});
app.get("/minecraft", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "game/fun/Minecraft.html"));
});

app.get("/play", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "game/play.html"));
});
app.get("/anime", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/anime.html"));
});

app.get("/movie", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/sorry.html"));
});

app.get("/check", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/check.html"));
});

app.get("/use-api", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/sorry.html"));
});

app.get("/version", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "raw/version.json"));
});
app.get("/ai", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/ac.html"));
});
app.get("/vc", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/Vc.html"));
});
app.get("/code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/Code.html"));
});
app.get("/croxy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/croxy.html"));
});
app.get("/games.json", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "game/game.json"));
});
app.get("/gust", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/GUST.html"));
});
app.get("/easy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/easy.html"));
});

app.get("/urls", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/public-url.html"));
});

app.get("/own", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/own.html"));
});

app.get("/wista", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "wista.html"));
});

app.get("/sia", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sia/index.html"));
});

app.get("/k-tube", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/iframe/k-tube.html"));
});

app.get("/science", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/iframe/science.html"));
});

app.get("/earth", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/iframe/earth.html"));
});

app.get("/home-v2", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "test/home-v2-test.html"));
});

app.get("/sys-update", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/update.html"));
});

app.get("/classroom.192", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "img/classroom.192.png"));
});

app.get("/classroom.512", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "img/classroom.512.png"));
});


app.get("/manifest.json", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "manifest.json"));
});

app.get("/sw.js", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sw.js"));
});

app.get("/api/channel", async (req, res) => {
  const channelName = req.query.name || req.query.id;
  const page = parseInt(req.query.page) || 0;
  if (!channelName) return res.status(400).json({ error: "name required" });
  try {
    // 取得件数を20に設定
    const results = await yts.GetListByKeyword(channelName, false, 20, page);
    const videos = (results.items || []).filter(item => item.type === 'video');
    res.json({ channelName, videos, nextPage: page + 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/inv/channel/:name', async (req, res) => {
  const channelName = req.params.name;

  const url = `https://yt.chocolatemoo53.com/api/v1/search?q=${encodeURIComponent(
    channelName
  )}&type=channel`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: `Upstream error: ${response.statusText}` });
    }

    const data = await response.json();

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get("/channel/:channelName", (req, res) => {
  const channelName = decodeURIComponent(req.params.channelName);
  const initial = channelName.charAt(0).toUpperCase();
  const colors = ['#ff0000','#ff6d00','#ffab00','#00c853','#00b0ff','#651fff','#d500f9','#f50057'];
  const colorIndex = channelName.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length;
  const avatarBg = colors[colorIndex];

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${channelName.replace(/</g,'&lt;')} - MIN-Tube-Pro</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg:#0f0f0f; --surface:#212121; --card:#272727; --hover:#3f3f3f;
      --text:#f1f1f1; --text-sub:#aaaaaa; --text-sec:#717171;
      --red:#ff0000; --border:#303030; --avatar-bg:${avatarBg}; --nav-h:56px;
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    html { scroll-behavior:smooth; }
    body { background:var(--bg); color:var(--text); font-family:'Roboto',Arial,sans-serif; -webkit-font-smoothing:antialiased; }
    a { color:inherit; text-decoration:none; }

    /* ===== NAVBAR ===== */
    .navbar { position:fixed; top:0; width:100%; height:var(--nav-h); background:var(--bg); display:flex; align-items:center; padding:0 16px; z-index:1000; gap:8px; }
    .nav-left { display:flex; align-items:center; gap:8px; flex-shrink:0; }
    .icon-btn { background:none; border:none; color:var(--text); cursor:pointer; width:40px; height:40px; border-radius:50%; display:flex; align-items:center; justify-content:center; transition:background .15s; flex-shrink:0; }
    .icon-btn:hover { background:rgba(255,255,255,0.1); }
    .icon-btn svg { width:24px; height:24px; fill:var(--text); }
    .nav-logo { display:flex; align-items:center; gap:2px; }
    .nav-logo-icon { background:var(--red); border-radius:6px; width:34px; height:24px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
    .nav-logo-icon svg { width:16px; height:16px; fill:white; }
    .nav-logo-text { font-size:18px; font-weight:700; letter-spacing:-0.5px; margin-left:4px; }
    .nav-logo-sub { font-size:10px; color:var(--text-sub); font-weight:500; margin-left:1px; align-self:flex-end; margin-bottom:4px; }
    .nav-center { flex:1; display:flex; align-items:center; justify-content:center; max-width:640px; margin:0 auto; }
    .search-form { display:flex; width:100%; height:40px; border:1px solid var(--border); border-radius:20px; overflow:hidden; }
    .search-form:focus-within { border-color:#3ea6ff; }
    .search-form input { flex:1; background:var(--bg); border:none; color:var(--text); padding:0 16px; outline:none; font-size:15px; font-family:inherit; }
    .search-btn { background:var(--surface); border:none; border-left:1px solid var(--border); color:var(--text-sub); width:60px; cursor:pointer; display:flex; align-items:center; justify-content:center; }
    .search-btn:hover { background:var(--hover); }
    .search-btn svg { width:20px; height:20px; fill:currentColor; }
    .nav-right { display:flex; align-items:center; gap:4px; margin-left:auto; flex-shrink:0; }

    /* ===== BANNER ===== */
    .banner-wrap { margin-top:var(--nav-h); max-width:1284px; margin-left:auto; margin-right:auto; padding:16px 24px 0; }
    .channel-banner { width:100%; aspect-ratio:6.2/1; min-height:100px; max-height:220px; border-radius:16px; overflow:hidden; position:relative; background:linear-gradient(135deg, ${avatarBg}22 0%, #1a1a2e 50%, ${avatarBg}18 100%); }
    .channel-banner img { width:100%; height:100%; object-fit:cover; display:none; }
    .channel-banner img.loaded { display:block; }
    .channel-banner .banner-glow { position:absolute; inset:0; background:radial-gradient(ellipse at 25% 60%, ${avatarBg}33 0%, transparent 55%), radial-gradient(ellipse at 80% 30%, rgba(255,255,255,0.04) 0%, transparent 50%); }

    /* ===== HEADER ===== */
    .header-wrap { max-width:1284px; margin:0 auto; padding:0 24px; }
    .channel-header { display:flex; align-items:center; gap:24px; padding:24px 0 12px; }
    .channel-avatar { width:80px; height:80px; border-radius:50%; background:var(--avatar-bg); display:flex; align-items:center; justify-content:center; font-size:38px; font-weight:700; color:#fff; flex-shrink:0; overflow:hidden; position:relative; }
    @media (min-width:600px){ .channel-avatar { width:128px; height:128px; font-size:56px; } }
    .channel-avatar img { width:100%; height:100%; object-fit:cover; display:none; position:absolute; inset:0; }
    .channel-avatar img.loaded { display:block; }
    .avatar-initial { position:relative; z-index:1; }
    .channel-info { flex:1; min-width:0; }
    .channel-title-row { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
    .channel-title { font-size:clamp(20px,3.4vw,32px); font-weight:700; line-height:1.2; }
    .verified-badge { fill:var(--text-sub); width:15px; height:15px; }
    .channel-meta { font-size:14px; color:var(--text-sub); line-height:1.6; display:flex; flex-wrap:wrap; gap:4px 0; }
    .channel-meta .dot { margin:0 6px; }
    .channel-meta .strong { color:var(--text); font-weight:500; }
    .channel-description { font-size:14px; color:var(--text-sub); line-height:1.4; display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; overflow:hidden; max-width:560px; margin:6px 0 14px; cursor:pointer; }
    .channel-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .btn-subscribe { background:var(--text); color:#0f0f0f; border:none; border-radius:20px; padding:0 18px; height:40px; font-size:14px; font-weight:600; cursor:pointer; transition:opacity .15s; font-family:inherit; white-space:nowrap; display:flex; align-items:center; gap:7px; }
    .btn-subscribe:hover { opacity:.88; }
    .btn-subscribe.subscribed { background:var(--card); color:var(--text); }
    .btn-subscribe.subscribed:hover { background:var(--hover); }
    .btn-subscribe svg { width:17px; height:17px; fill:currentColor; }
    .btn-ghost { background:var(--card); color:var(--text); border:none; border-radius:20px; height:40px; padding:0 16px; font-size:14px; font-weight:600; cursor:pointer; display:flex; align-items:center; gap:7px; font-family:inherit; transition:background .15s; }
    .btn-ghost:hover { background:var(--hover); }
    .btn-ghost svg { width:18px; height:18px; fill:currentColor; }

    /* ===== TABS ===== */
    .tabs-wrap { max-width:1284px; margin:0 auto; padding:0 24px; border-bottom:1px solid var(--border); position:sticky; top:var(--nav-h); background:var(--bg); z-index:50; }
    .channel-tabs { display:flex; overflow-x:auto; scrollbar-width:none; }
    .channel-tabs::-webkit-scrollbar { display:none; }
    .tab { padding:0 18px; height:48px; cursor:pointer; font-size:15px; font-weight:500; color:var(--text-sub); border-bottom:2px solid transparent; transition:color .15s,border-color .15s; white-space:nowrap; display:flex; align-items:center; background:none; border-top:none; border-left:none; border-right:none; font-family:inherit; }
    .tab:hover { color:var(--text); }
    .tab.active { color:var(--text); border-bottom-color:var(--text); font-weight:600; }

    /* ===== CONTENT ===== */
    .content { max-width:1284px; margin:0 auto; padding:24px 24px 80px; }
    .section-title { font-size:20px; font-weight:700; margin:8px 0 16px; }

    /* ===== AUTO PLAYLIST ROW ===== */
    .pl-row { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:32px; }
    @media (max-width:820px){ .pl-row { grid-template-columns:1fr; } }
    .pl-card { border-radius:16px; overflow:hidden; border:1px solid var(--border); background:var(--surface); }
    .pl-card.gemini { border:1px solid transparent; background:linear-gradient(var(--surface),var(--surface)) padding-box, linear-gradient(120deg,#4285F4,#9b72cb,#d96570) border-box; }
    .pl-card-head { display:flex; align-items:center; gap:9px; padding:14px 16px 10px; }
    .pl-card-head .badge { display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:700; letter-spacing:.3px; padding:3px 9px; border-radius:20px; }
    .badge.gemini-badge { background:linear-gradient(120deg,#4285F4,#9b72cb,#d96570); color:#fff; }
    .badge.algo-badge { background:#2a2a35; color:#8ab4ff; border:1px solid #3a3a4a; }
    .pl-card-head .badge svg { width:13px; height:13px; }
    .pl-card-title { font-size:15px; font-weight:700; }
    .pl-card-sub { font-size:12px; color:var(--text-sub); }
    .pl-card-body { max-height:280px; overflow-y:auto; padding:4px 8px 10px; }
    .pl-card-body::-webkit-scrollbar { width:6px; } .pl-card-body::-webkit-scrollbar-thumb { background:#555; border-radius:3px; }
    .pl-item { display:flex; gap:10px; padding:6px 8px; border-radius:10px; align-items:center; transition:background .15s; cursor:pointer; }
    .pl-item:hover { background:var(--hover); }
    .pl-idx { width:20px; text-align:center; font-size:12px; color:var(--text-sec); flex-shrink:0; }
    .pl-thumb { position:relative; width:96px; aspect-ratio:16/9; border-radius:7px; overflow:hidden; background:#000; flex-shrink:0; }
    .pl-thumb img { width:100%; height:100%; object-fit:cover; }
    .pl-dur { position:absolute; bottom:3px; right:3px; background:rgba(0,0,0,.85); color:#fff; font-size:10px; font-weight:600; padding:1px 4px; border-radius:3px; }
    .pl-item-info { min-width:0; }
    .pl-item-title { font-size:13px; font-weight:500; line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
    .pl-item-ch { font-size:12px; color:var(--text-sub); margin-top:2px; }
    .pl-play-all { display:flex; align-items:center; justify-content:center; gap:7px; margin:6px 12px 12px; padding:9px; border-radius:20px; background:var(--text); color:#0f0f0f; border:none; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; }
    .pl-play-all svg { width:16px; height:16px; fill:currentColor; }
    /* 生成中アニメーション */
    .pl-gen { display:flex; align-items:center; gap:14px; padding:22px 18px; }
    .pl-gen-orb { width:34px; height:34px; border-radius:50%; flex-shrink:0; background:conic-gradient(from 0deg,#4285F4,#9b72cb,#d96570,#4285F4); animation:spin 2.4s linear infinite; }
    .pl-gen-orb.algo { background:conic-gradient(from 0deg,#8ab4ff,#5a7fd6,#3a4a7a,#8ab4ff); }
    .pl-gen-txt { font-size:14px; font-weight:600; }
    .pl-gen-sub { font-size:12px; color:var(--text-sub); margin-top:3px; }
    .pl-gen-bar { height:3px; border-radius:3px; background:#333; overflow:hidden; margin-top:9px; }
    .pl-gen-bar::after { content:''; display:block; height:100%; width:40%; border-radius:3px; background:linear-gradient(90deg,#4285F4,#9b72cb,#d96570); animation:slideBar 1.4s ease-in-out infinite; }
    .pl-gen-bar.algo::after { background:linear-gradient(90deg,#8ab4ff,#5a7fd6); }
    @keyframes slideBar { 0%{ transform:translateX(-120%);} 100%{ transform:translateX(320%);} }
    @keyframes spin { to { transform:rotate(360deg); } }
    .pl-skel { padding:10px 12px; }
    .pl-skel-row { display:flex; gap:10px; margin-bottom:12px; }
    .pl-skel-thumb { width:96px; height:54px; border-radius:7px; flex-shrink:0; }
    .pl-skel-lines { flex:1; }
    .pl-skel-line { height:10px; border-radius:4px; margin-bottom:7px; }
    .pl-skel-thumb,.pl-skel-line { background:linear-gradient(90deg,#242424 25%,#2f2f2f 50%,#242424 75%); background-size:200% 100%; animation:shimmer 1.3s infinite; }
    @keyframes shimmer { 0%{background-position:200% 0;} 100%{background-position:-200% 0;} }

    /* ===== VIDEO GRID ===== */
    .video-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:16px; row-gap:36px; }
    .video-card { display:flex; flex-direction:column; }
    .thumb { width:100%; aspect-ratio:16/9; border-radius:12px; overflow:hidden; background:#1a1a1a; position:relative; margin-bottom:11px; }
    .thumb img { width:100%; height:100%; object-fit:cover; display:block; transition:border-radius .2s,transform .2s; }
    .video-card:hover .thumb img { border-radius:0; }
    .duration-badge { position:absolute; bottom:6px; right:6px; background:rgba(0,0,0,.85); color:#fff; font-size:12px; font-weight:600; padding:2px 5px; border-radius:4px; }
    .card-meta { display:flex; gap:12px; align-items:flex-start; }
    .card-ch-avatar { width:36px; height:36px; border-radius:50%; background:var(--avatar-bg); flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:700; color:#fff; overflow:hidden; position:relative; }
    .card-info { flex:1; min-width:0; }
    .video-title { font-size:14px; font-weight:500; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; margin-bottom:5px; }
    .video-sub { font-size:13px; color:var(--text-sub); }

    .loading { display:flex; justify-content:center; padding:50px; }
    .spinner { border:3px solid #333; border-top-color:var(--red); border-radius:50%; width:36px; height:36px; animation:spin .8s linear infinite; }
    .empty { text-align:center; padding:60px; color:var(--text-sub); }

    @media (max-width:600px){
      .banner-wrap { padding:8px 12px 0; }
      .header-wrap { padding:0 16px; }
      .channel-header { flex-direction:column; align-items:center; text-align:center; gap:14px; padding:16px 0 8px; }
      .channel-meta { justify-content:center; }
      .channel-actions { justify-content:center; }
      .channel-description { text-align:center; margin-left:auto; margin-right:auto; }
      .tabs-wrap { padding:0 12px; }
      .content { padding:16px 12px 80px; }
      .video-grid { grid-template-columns:repeat(2,1fr); gap:10px; row-gap:22px; }
      .nav-center { display:none; }
    }
  </style>
</head>
<body>

<nav class="navbar">
  <div class="nav-left">
    <button class="icon-btn" onclick="history.back()" aria-label="戻る"><svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg></button>
    <a href="/" class="nav-logo">
      <div class="nav-logo-icon"><svg viewBox="0 0 68 48"><path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="#FF0000"/><path d="M45 24 27 14v20" fill="white"/></svg></div>
      <span class="nav-logo-text">YouTube</span><span class="nav-logo-sub">Pro</span>
    </a>
  </div>
  <div class="nav-center">
    <form class="search-form" onsubmit="event.preventDefault(); const q=this.querySelector('input').value.trim(); if(q) window.location.href='/?q='+encodeURIComponent(q);">
      <input type="text" placeholder="検索" name="q">
      <button type="submit" class="search-btn"><svg viewBox="0 0 24 24"><path d="M20.87 20.17l-5.59-5.59C16.35 13.35 17 11.75 17 10c0-3.87-3.13-7-7-7s-7 3.13-7 7 3.13 7 7 7c1.75 0 3.35-.65 4.58-1.71l5.59 5.59.7-.71zM10 16c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z"/></svg></button>
    </form>
  </div>
  <div class="nav-right">
    <a href="/" class="icon-btn" title="ホーム"><svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg></a>
  </div>
</nav>

<div class="banner-wrap">
  <div class="channel-banner"><div class="banner-glow"></div><img id="bannerImg" alt=""></div>
</div>

<div class="header-wrap">
  <div class="channel-header">
    <div class="channel-avatar" id="channelAvatar">
      <img id="channelAvatarImg" src="" alt="">
      <span class="avatar-initial" id="avatarInitial">${initial}</span>
    </div>
    <div class="channel-info">
      <div class="channel-title-row">
        <div class="channel-title" id="channelTitle">${channelName.replace(/</g,'&lt;')}</div>
        <svg class="verified-badge" viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zM10 17l-5-5 1.4-1.4 3.6 3.6 7.6-7.6L19 8l-9 9z"/></svg>
      </div>
      <div class="channel-meta">
        <span class="strong" id="channelHandle">@${channelName.toLowerCase().replace(/\s+/g,'').replace(/</g,'')}</span>
        <span id="subCount"></span>
        <span id="videoCountDisplay"></span>
      </div>
      <div class="channel-description" id="channelDescription" onclick="this.style.webkitLineClamp='unset'"></div>
      <div class="channel-actions">
        <button class="btn-subscribe" id="subscribeBtn" onclick="toggleSubscribe()"><span id="subLabel">チャンネル登録</span></button>
        <button class="btn-ghost" onclick="document.getElementById('plSection').scrollIntoView({behavior:'smooth'})"><svg viewBox="0 0 24 24"><path d="M4 6h12v2H4zm0 4h12v2H4zm0 4h8v2H4zm10 0l6-3-6-3z"/></svg> AI再生リスト</button>
      </div>
    </div>
  </div>
</div>

<div class="tabs-wrap">
  <div class="channel-tabs">
    <button class="tab active" data-tab="home">ホーム</button>
    <button class="tab" data-tab="videos">動画</button>
    <button class="tab" data-tab="playlists">再生リスト</button>
  </div>
</div>

<div class="content">
  <!-- AI 自動生成 再生リスト -->
  <div id="plSection">
    <div class="section-title">✨ このチャンネルの AI 再生リスト</div>
    <div class="pl-row">
      <div class="pl-card gemini" id="geminiCard">
        <div class="pl-card-head"><span class="badge gemini-badge"><svg viewBox="0 0 24 24" fill="none"><path d="M12 2l2.35 6.35L21 10.7l-5.5 3.9L17 21l-5-3.6L7 21l1.5-6.4L3 10.7l6.65-2.35z" fill="currentColor"/></svg> Gemini</span></div>
        <div id="geminiBody"></div>
      </div>
      <div class="pl-card" id="algoCard">
        <div class="pl-card-head"><span class="badge algo-badge">⚡ MINV2-AI</span></div>
        <div id="algoBody"></div>
      </div>
    </div>
  </div>

  <div class="section-title" id="videosTitle">動画</div>
  <div id="videoGrid" class="video-grid"></div>
  <div id="loading" class="loading"><div class="spinner"></div></div>
</div>

<script>
  const CHANNEL_NAME = ${JSON.stringify(channelName)};
  const initial = ${JSON.stringify(initial)};
  let currentPage = 0, isLoading = false, isEnd = false, totalLoaded = 0;
  let channelAvatarUrl = '';

  function esc(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  /* ===== 検索から引き継いだアバターを再利用（再取得の時間を短縮） ===== */
  function cachedAvatar(name){
    try{
      const map=JSON.parse(sessionStorage.getItem('channelAvatars')||'{}');
      if(map['name:'+name]) return map['name:'+name];
      // URLクエリ ?av= でも受け取る
      const p=new URLSearchParams(location.search);
      if(p.get('av')) return decodeURIComponent(p.get('av'));
    }catch(e){}
    return '';
  }
  function applyAvatar(url){
    if(!url) return;
    channelAvatarUrl = url;
    const img=document.getElementById('channelAvatarImg');
    img.onload=()=>{ img.classList.add('loaded'); document.getElementById('avatarInitial').style.display='none'; };
    img.src=url;
  }

  /* ===== 登録 ===== */
  const SUB_KEY='subscribed_'+CHANNEL_NAME;
  function updateSubscribeUI(){
    const isSub=localStorage.getItem(SUB_KEY)==='true';
    const btn=document.getElementById('subscribeBtn');
    const lbl=document.getElementById('subLabel');
    if(isSub){ lbl.textContent='登録済み'; btn.classList.add('subscribed'); }
    else{ lbl.textContent='チャンネル登録'; btn.classList.remove('subscribed'); }
  }
  function toggleSubscribe(){ localStorage.setItem(SUB_KEY, localStorage.getItem(SUB_KEY)!=='true'); updateSubscribeUI(); }

  function formatViews(v){ if(!v) return ''; return v.replace('views','回視聴').replace(/ago$/,'前'); }

  /* ===== 動画グリッド ===== */
  function renderVideos(videos){
    const grid=document.getElementById('videoGrid');
    if(videos.length===0 && totalLoaded===0){ grid.innerHTML='<div class="empty">動画が見つかりませんでした</div>'; return; }
    const html=videos.map(v=>\`
      <a href="/video/\${v.id}" class="video-card">
        <div class="thumb">
          <img src="https://i.ytimg.com/vi/\${v.id}/mqdefault.jpg" loading="lazy">
          \${v.lengthText?\`<div class="duration-badge">\${esc(v.lengthText)}</div>\`:''}
        </div>
        <div class="card-meta">
          <div class="card-ch-avatar">
            <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">\${initial}</span>
            \${channelAvatarUrl?\`<img src="\${channelAvatarUrl}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" onerror="this.remove()">\`:''}
          </div>
          <div class="card-info">
            <div class="video-title">\${esc(v.title||'')}</div>
            <div class="video-sub">\${esc(CHANNEL_NAME)}</div>
            <div class="video-sub">\${esc(formatViews(v.viewCountText)||'')}</div>
          </div>
        </div>
      </a>\`).join('');
    grid.insertAdjacentHTML('beforeend', html);
    totalLoaded += videos.length;
    const cd=document.getElementById('videoCountDisplay');
    if(cd) cd.textContent='動画 '+totalLoaded+' 本';
  }

  async function loadVideos(){
    if(isLoading||isEnd) return;
    isLoading=true;
    document.getElementById('loading').style.display='flex';
    try{
      const res=await fetch(\`/api/channel?name=\${encodeURIComponent(CHANNEL_NAME)}&page=\${currentPage}\`);
      const data=await res.json();
      if(!data.videos||data.videos.length===0){ isEnd=true; document.getElementById('loading').innerHTML='<p style="color:var(--text-sub);padding:16px;">すべて読み込みました</p>'; }
      else{ renderVideos(data.videos); currentPage=data.nextPage; }
    }catch(e){ isEnd=true; }
    finally{ isLoading=false; if(!isEnd) document.getElementById('loading').style.display='none'; }
  }
  function initInfiniteScroll(){
    const ob=new IntersectionObserver(es=>{ if(es[0].isIntersecting) loadVideos(); },{rootMargin:'500px'});
    ob.observe(document.getElementById('loading'));
  }

  /* ===== チャンネル情報 ===== */
  async function fetchChannelInfo(){
    try{
      const res=await fetch(\`/api/inv/channel/\${encodeURIComponent(CHANNEL_NAME)}\`);
      const data=await res.json();
      const c=Array.isArray(data)?data[0]:data;
      if(c){
        if(c.authorThumbnails?.length && !channelAvatarUrl){ applyAvatar(c.authorThumbnails[c.authorThumbnails.length-1].url); }
        if(c.authorBanners?.length){ const b=document.getElementById('bannerImg'); b.onload=()=>b.classList.add('loaded'); b.src=c.authorBanners[c.authorBanners.length-1].url; }
        if(c.description) document.getElementById('channelDescription').textContent=c.description;
        if(c.subCount) document.getElementById('subCount').innerHTML='<span class="dot">•</span>'+esc(c.subCount)+' 人の登録者';
      }
    }catch(e){}
  }

  /* ===== 再生リスト共通レンダリング ===== */
  const durIcon='<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  function skeleton(){ return '<div class="pl-skel">'+Array.from({length:4}).map(()=>'<div class="pl-skel-row"><div class="pl-skel-thumb"></div><div class="pl-skel-lines"><div class="pl-skel-line" style="width:90%"></div><div class="pl-skel-line" style="width:60%"></div></div></div>').join('')+'</div>'; }

  function renderGenerating(bodyId, kind){
    const el=document.getElementById(bodyId); if(!el) return;
    const isAlgo=kind==='algo';
    el.innerHTML=\`
      <div class="pl-gen">
        <div class="pl-gen-orb \${isAlgo?'algo':''}"></div>
        <div style="flex:1;">
          <div class="pl-gen-txt">\${isAlgo?'MINV2-AI が選曲/選定中':'Gemini が再生リストを生成中'}</div>
          <div class="pl-gen-sub">\${isAlgo?'再生数と話題性から自動構成しています…':'このチャンネルの代表作を選んでいます…'}</div>
          <div class="pl-gen-bar \${isAlgo?'algo':''}"></div>
        </div>
      </div>\`+skeleton();
  }

  function playPlaylist(items, label){
    const pl=items.map(it=>({id:it.id,title:it.title,channelTitle:it.channelTitle||CHANNEL_NAME,thumbnail:it.thumbnail||('https://i.ytimg.com/vi/'+it.id+'/mqdefault.jpg'),lengthText:it.lengthText||''})).filter(x=>x.id);
    if(!pl.length) return;
    sessionStorage.setItem('mix_playlist', JSON.stringify(pl));
    sessionStorage.setItem('mix_index','0');
    sessionStorage.setItem('mix_label', label);
    location.href='/video/'+pl[0].id;
  }

  function renderPlaylist(bodyId, items, label){
    const el=document.getElementById(bodyId); if(!el) return;
    if(!items||!items.length){ el.innerHTML='<div style="padding:20px;text-align:center;color:var(--text-sub);font-size:13px;">生成できませんでした</div>'; return; }
    const list=items.slice(0,10).map((it,i)=>\`
      <div class="pl-item" data-id="\${it.id}">
        <div class="pl-idx">\${i+1}</div>
        <div class="pl-thumb"><img src="\${esc(it.thumbnail||('https://i.ytimg.com/vi/'+it.id+'/mqdefault.jpg'))}" loading="lazy" onerror="this.src='https://i.ytimg.com/vi/\${it.id}/mqdefault.jpg'">\${it.lengthText?\`<span class="pl-dur">\${esc(it.lengthText)}</span>\`:''}</div>
        <div class="pl-item-info"><div class="pl-item-title">\${esc(it.title)}</div><div class="pl-item-ch">\${esc(it.channelTitle||CHANNEL_NAME)}</div></div>
      </div>\`).join('');
    el.innerHTML='<div class="pl-card-body">'+list+'</div><button class="pl-play-all">'+durIcon+' すべて再生</button>';
    el.querySelectorAll('.pl-item').forEach((row,i)=>row.addEventListener('click',()=>{ const arr=items.slice(); const first=arr.splice(i,1)[0]; playPlaylist([first,...arr], label); }));
    const pa=el.querySelector('.pl-play-all'); if(pa) pa.addEventListener('click',()=>playPlaylist(items,label));
  }

  /* Gemini 再生リスト自動生成 */
  async function genGeminiPlaylist(){
    renderGenerating('geminiBody','gemini');
    try{
      const r=await fetch('/api/ai/playlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'channel',channel:CHANNEL_NAME})});
      if(!r.ok) throw new Error('fail');
      const j=await r.json();
      renderPlaylist('geminiBody', j.items, j.label||(CHANNEL_NAME+' のベスト'));
    }catch(e){ document.getElementById('geminiCard').style.display='none'; checkPlSection(); }
  }
  /* MINV2-AI アルゴリズム再生リスト自動生成 */
  async function genAlgoPlaylist(){
    renderGenerating('algoBody','algo');
    try{
      const r=await fetch('/api/algo/channel-playlist?channel='+encodeURIComponent(CHANNEL_NAME));
      const j=await r.json();
      renderPlaylist('algoBody', j.items, 'MINV2-AI ・ '+CHANNEL_NAME);
    }catch(e){ document.getElementById('algoCard').style.display='none'; checkPlSection(); }
  }
  function checkPlSection(){
    const g=document.getElementById('geminiCard'), a=document.getElementById('algoCard');
    if(g.style.display==='none' && a.style.display==='none') document.getElementById('plSection').style.display='none';
  }

  /* タブ (簡易: 動画/ホームは同じグリッド、再生リストはAIセクションへ) */
  document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active')); t.classList.add('active');
    const tab=t.dataset.tab;
    if(tab==='playlists') document.getElementById('plSection').scrollIntoView({behavior:'smooth'});
    else document.getElementById('videosTitle').scrollIntoView({behavior:'smooth',block:'nearest'});
  }));

  async function init(){
    updateSubscribeUI();
    applyAvatar(cachedAvatar(CHANNEL_NAME)); // 検索から引き継ぎ即表示
    // 並列: 情報取得・動画・2種の再生リスト自動生成
    fetchChannelInfo();
    genGeminiPlaylist();
    genAlgoPlaylist();
    await loadVideos();
    initInfiniteScroll();
  }
  init();
</script>
</body>
</html>`;
  res.send(html);
});


app.get('/stream/inv/:videoId', async (req, res) => {
    const videoId = req.params.videoId;
    const now = Date.now();

    if (videoCache.has(videoId)) {
        const cached = videoCache.get(videoId);
        if (now < cached.expiry) {
            return res.type('text/plain').send(cached.url);
        }
    }

    const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
    
    try {
        const configRes = await fetch("https://raw.githubusercontent.com/mino-hobby-pro/min-tube-pro-local-txt/refs/heads/main/inv-check.txt");
        const extraParams = (await configRes.text()).trim(); 
        
        const targetUrl = `https://yt-comp5.chocolatemoo53.com/companion/latest_version?id=${videoId}${extraParams}`;

        const response = await fetch(targetUrl, {
            method: 'GET',
            headers: {
                "User-Agent": randomUA,
                "Accept": "*/*"
            },
            redirect: 'follow'
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const finalUrl = response.url;


        videoCache.set(videoId, {
            url: finalUrl,
            expiry: now + 60000
        });

        res.type('text/plain').send(finalUrl);

    } catch (error) {
        console.error('Error fetching the URL:', error.message);
        res.status(500).send('Internal Server Error');
    }
});

app.get("/img/:videoId", (req, res) => {
    const { videoId } = req.params;

    const url = `https://i3.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    https.get(url, (ytRes) => {
        if (ytRes.statusCode !== 200) {
            res.status(ytRes.statusCode).send("Failed to fetch image");
            return;
        }

        res.setHeader("Content-Type", "image/jpeg");

        // サーバー負荷を軽減するためそのままデータを転送してます
        ytRes.pipe(res);

    }).on("error", (err) => {
        console.error("Image proxy error:", err);
        res.status(500).send("Proxy error");
    });
});

app.get('/stream-network/:videoId', (req, res) => {
    const videoId = req.params.videoId;
    
    const host = req.get('host');
    
    // 強制的にhttpsURLスキームを返すためhttpしか対応していないとエラーを返します。。
    const baseUrl = `https://${host}`;
    
    const responseText = `${baseUrl}/proxy/embed.html#https://www.youtube-nocookie.com/embed/${videoId}`;
    
    res.send(responseText);
});

app.get("/abyss.png", (req, res) => {
  const filePath = path.join(__dirname, "img", "abyss.png");
  res.sendFile(filePath);
});



app.get('/get-other/:videoId', async (req, res) => {
    const { videoId } = req.params;
    
    const apiOrder = shuffleArray(Object.keys(apiHandlers));
    
    let result = null;
    let errors = [];

    for (const apiName of apiOrder) {
        try {
            console.log(`Trying API: ${apiName}`);
            result = await apiHandlers[apiName](videoId);
            if (result) {
                result.provider = apiName;
                break; 
            }
        } catch (error) {
            console.error(`❌ ${apiName} failed: ${error.message}`);
            errors.push({ api: apiName, error: error.message });
        }
    }

    if (!result) {
        return res.status(500).json({
            success: false,
            message: "えらー",
            details: errors
        });
    }

    try {
        const seenUrls = new Set();
        if (result.stream_url) seenUrls.add(result.stream_url);

        result.streamUrls = (result.streamUrls || []).filter(s => {
            if (!s.url || seenUrls.has(s.url)) return false;
            seenUrls.add(s.url);
            
            if (s.resolution) {
                s.resolution = String(s.resolution).replace(/ \(.+\)/g, '').trim();
                if (s.fps && s.resolution.endsWith(String(s.fps))) {
                    s.resolution = s.resolution.slice(0, -String(s.fps).length).trim();
                }
            }
            
            if (s.url.includes('.m3u8') || s.url.includes('manifest')) {
                s.container = 'm3u8';
            }
            return true;
        });

        const isInvalid = (url) => !url || url.includes('manifest') || url.includes('.m3u8');
        if (isInvalid(result.audioUrl)) {
            result.audioUrl = '';
            result.audioUrls = [];
        } else {
            result.audioUrls = (result.audioUrls || []).filter(s => !isInvalid(s.url));
        }

        return res.json({
            success: true,
            data: result
        });

    } catch (cleanError) {
        return res.json({
            success: true,
            data: result,
            note: "Cleaning process partially failed"
        });
    }
});

const calculateScore = (v) => {
    const [major, minor, patch] = v.split('.').map(Number);
    return (major * 1000) + (minor * 100) + (patch * 10);
};

app.get('/check-version', async (req, res) => {
    const remoteUrl = 'https://raw.githubusercontent.com/mino-hobby-pro/MIN-Tube-Pro/refs/heads/main/public/raw/version.json';
    const localPath = path.join(__dirname, 'public', 'raw', 'version.json');

    try {
        const [remoteRes, localRaw] = await Promise.all([
            fetch(remoteUrl),
            fs.promises.readFile(localPath, 'utf8')
        ]);

        if (!remoteRes.ok) throw new Error('Could not reach remote version server');
        
        const remoteData = await remoteRes.json();
        const localData = JSON.parse(localRaw);

        const latestVersion = remoteData.version;
        const currentVersion = localData.version;


        const latestScore = calculateScore(latestVersion);
        const currentScore = calculateScore(currentVersion);
        

        const updateDiff = Math.max(0, latestScore - currentScore);


        res.json({
            is_latest: currentScore >= latestScore,
            latest_version: latestVersion,
            current_version: currentVersion,
            updates_count: updateDiff,
            status: "success"
        });

    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

const memoryCache = new Map();
const CACHE_TTL = 10 * 60 * 100; 
const MAX_CACHE_SIZE = 50;      


function setCache(key, value) {
  if (memoryCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = memoryCache.keys().next().value;
    memoryCache.delete(oldestKey);
  }
  memoryCache.set(key, { data: value, timestamp: Date.now() });
}

const isValidId = (id) => /^[a-zA-Z0-9_-]{11}$/.test(id); 
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";


app.get("/short-check/:id", async (req, res) => {
  const videoId = req.params.id;

  if (!isValidId(videoId)) {
    return res.status(400).json({ error: "Invalid video ID format" });
  }

  const cacheKey = `short:${videoId}`;
  const cached = memoryCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    return res.json(cached.data);
  }

  try {
    const response = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: "HEAD",
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT }
    });

    if (response.status === 429) {
      return res.status(429).json({ error: "YouTube rate limit exceeded." });
    }

    let isShort = false;
    let exists = true;

    if (response.status === 200) {
      isShort = true;
    } else if (response.status === 302 || response.status === 303) {
      isShort = false; 
    } else if (response.status === 404) {
      exists = false;
    }

    const result = { videoId, exists, isShort };
    setCache(cacheKey, result);

    res.setHeader("Cache-Control", "public, max-age=180, s-maxage=300");
    return res.json(result);

  } catch (error) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


app.get("/api/1-search", async (req, res, next) => {
  const query = req.query.q;
  const startPage = Number(req.query.page) || 0;

  if (!query) {
    return res.status(400).json({ error: "Query required" });
  }

  try {
    const maxPages = 5;
    let foundVideo = null;

    for (let page = startPage; page < startPage + maxPages; page++) {
      const results = await yts.GetListByKeyword(query, false, 20, page);

      const items = Array.isArray(results?.items) ? results.items : [];

      for (const item of items) {
        const id = String(item?.id || "");

        if (id.startsWith("UC")) continue;

        foundVideo = item;
        break;
      }

      if (foundVideo) break;
    }

    if (!foundVideo) {
      return res.status(404).json({ error: "Video not found" });
    }

    res.json(foundVideo);

  } catch (err) {
    next(err);
  }
});

/**
 * PROXY_DIR/
 * ├── uv/ (sw.js, uv.bundle.js, etc.)
 * └── prxy/
 *     ├── baremux/ (index.js, worker.js, etc.)
 *     ├── epoxy/ (index.js, etc.)
 *     ├── libcurl/ (index.js, etc.)
 *     └── register-sw.mjs
 */
app.use('/proxy', express.static(PROXY_DIR));
app.use((req, res, next) => {
    if (res.headersSent) return next();

    const targetPath = path.join(PROXY_DIR, req.path);
    const normalizedPath = path.normalize(targetPath);

    if (!normalizedPath.startsWith(PROXY_DIR)) {
        return next();
    }

    if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isFile()) {
        return res.sendFile(targetPath);
    }

    next();
});


app.use((req, res) => res.status(404).sendFile(path.join(__dirname, "public", "error.html")));
app.use((err, req, res, next) => {
  res.status(500).sendFile(path.join(__dirname, "public", "error.html"));
});

app.listen(port, () => console.log(`Server is running on port \${port}`));

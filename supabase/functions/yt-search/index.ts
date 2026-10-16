// yt-search: YouTube search for the guest "Add a music video" form.
//
// One uncached search = search.list (100 units) + videos.list (1) + channels.list (1).
// The free quota is 10,000 units a day, so about 98 fresh searches. Cached queries are free.
// On any failure the phone falls back to "Paste a YouTube link", so nothing breaks.
// Phones send { ping: true } first; { ok: false } (or no function at all) starts them in paste mode.
//
// Deploy once:
//   1. Google Cloud: enable "YouTube Data API v3", create an API key, restrict it to that API.
//   2. supabase secrets set YOUTUBE_API_KEY=<key>
//   3. supabase db push            (or paste supabase/migrations/*_yt_search.sql into the SQL editor)
//   4. supabase functions deploy yt-search --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";

const API = "https://www.googleapis.com/youtube/v3";
const CACHE_MS = 7 * 24 * 3600e3;   // YouTube's terms: refresh or drop stored API data within 30 days
const PER_HOUR = 30;                // uncached searches per phone
const MAX_RESULTS = 10;
const ORIGINS = [/^https:\/\/scotttewel\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  try { key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default ?? key; } catch { /* legacy key */ }
  return url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
}
const db = adminClient();

type Row = {
  id: string; title: string; channel: string; channelId: string; avatar: string | null;
  subs: number | null; views: number | null; year: number | null; dur: string;
  licensed: boolean; age: boolean;
};

class YouTubeError extends Error {
  constructor(readonly status: number, readonly reason: string) { super(`${status} ${reason}`); }
}

async function yt(path: string, params: Record<string, string | number>) {
  const key = Deno.env.get("YOUTUBE_API_KEY") ?? "";
  const u = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries({ ...params, key })) u.searchParams.set(k, String(v));
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new YouTubeError(r.status, j?.error?.errors?.[0]?.reason ?? "unknown");
  return j;
}

const num = (s?: string) => (s == null || s === "" ? null : Number(s));
function duration(iso = "") {
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return "";
  const h = Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0), min = Number(m[3] ?? 0), s = Number(m[4] ?? 0);
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(min).padStart(2, "0")}:${ss}` : `${min}:${ss}`;
}

// deno-lint-ignore no-explicit-any
type Any = any;
async function lookup(q: string): Promise<Row[]> {
  const found = await yt("search", { part: "id", type: "video", videoEmbeddable: "true", regionCode: "US", maxResults: 15, q });
  const ids: string[] = (found.items ?? []).map((i: Any) => i.id?.videoId).filter(Boolean);
  if (!ids.length) return [];

  const vids = await yt("videos", { part: "snippet,contentDetails,statistics,status", id: ids.join(",") });
  const rank = new Map(ids.map((id, i) => [id, i]));
  const list: Any[] = (vids.items ?? [])
    .filter((v: Any) => v.snippet?.liveBroadcastContent === "none" && v.status?.embeddable !== false)
    .sort((a: Any, b: Any) => rank.get(a.id)! - rank.get(b.id)!)
    .slice(0, MAX_RESULTS);
  if (!list.length) return [];

  const chIds = [...new Set(list.map(v => v.snippet.channelId))];
  const chans = await yt("channels", { part: "snippet,statistics", id: chIds.join(",") });
  const ch = new Map<string, Any>((chans.items ?? []).map((c: Any) => [c.id, c]));

  return list.map(v => {
    const c = ch.get(v.snippet.channelId);
    return {
      id: v.id,
      title: v.snippet.title,
      channel: v.snippet.channelTitle,
      channelId: v.snippet.channelId,
      avatar: c?.snippet?.thumbnails?.default?.url ?? null,
      subs: c?.statistics?.hiddenSubscriberCount ? null : num(c?.statistics?.subscriberCount),
      views: num(v.statistics?.viewCount),
      year: Number(String(v.snippet.publishedAt ?? "").slice(0, 4)) || null,
      dur: duration(v.contentDetails?.duration),
      licensed: !!v.contentDetails?.licensedContent,
      age: v.contentDetails?.contentRating?.ytRating === "ytAgeRestricted",
    };
  });
}

// The daily quota resets at midnight Pacific. Remember a spent day so phones skip search until then.
// Stored as a cache row whose key can't collide: real queries are trimmed, so none starts with a space.
const QUOTA_KEY = " quota";
const ptDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
let spentDay = "";
async function quotaSpent() {
  if (spentDay === ptDay()) return true;
  if (!db) return false;
  const { data } = await db.from("yt_search_cache").select("results").eq("q", QUOTA_KEY).maybeSingle();
  if (data?.results?.day === ptDay()) spentDay = ptDay();
  return spentDay === ptDay();
}
async function markSpent() {
  spentDay = ptDay();
  await db?.from("yt_search_cache").upsert({ q: QUOTA_KEY, results: { day: spentDay }, fetched_at: new Date().toISOString() });
}

// Cache and rate-limit failures never block a search; they just skip the cache.
async function cached(q: string): Promise<Row[] | null> {
  if (!db) return null;
  const { data } = await db.from("yt_search_cache").select("results,fetched_at").eq("q", q).maybeSingle();
  return data && Date.now() - Date.parse(data.fetched_at) < CACHE_MS ? data.results : null;
}
async function overLimit(token: string) {
  if (!db) return false;
  const since = new Date(Date.now() - 3600e3).toISOString();
  const { count, error } = await db.from("yt_search_log").select("id", { count: "exact", head: true }).eq("token", token).gte("at", since);
  if (error) return false;
  if ((count ?? 0) >= PER_HOUR) return true;
  await db.from("yt_search_log").insert({ token });
  return false;
}
async function save(q: string, results: Row[]) {
  if (!db) return;
  const now = Date.now();
  await Promise.all([
    db.from("yt_search_cache").upsert({ q, results, fetched_at: new Date(now).toISOString() }),
    db.from("yt_search_cache").delete().lt("fetched_at", new Date(now - CACHE_MS).toISOString()),
    db.from("yt_search_log").delete().lt("at", new Date(now - 24 * 3600e3).toISOString()),
  ]);
}

export async function handle(req: Request): Promise<Response> {
  const origin = req.headers.get("origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (ORIGINS.some(r => r.test(origin))) headers["Access-Control-Allow-Origin"] = origin;
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, { error: "method" });

  const body = await req.json().catch(() => ({}));
  const configured = !!Deno.env.get("YOUTUBE_API_KEY");
  if (body?.ping) return reply(200, { ok: configured && !(await quotaSpent().catch(() => false)) });

  const q = String(body?.q ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
  const token = String(body?.token ?? "").slice(0, 64) || "anon";
  if (!q) return reply(400, { error: "query" });
  if (!configured) return reply(503, { error: "unconfigured" });

  const hit = await cached(q).catch(() => null);
  if (hit) return reply(200, { results: hit, cached: true });
  if (await quotaSpent().catch(() => false)) return reply(429, { error: "quota" });
  if (await overLimit(token).catch(() => false)) return reply(429, { error: "rate" });

  try {
    const results = await lookup(q);
    await save(q, results).catch(e => console.error("cache", e));
    return reply(200, { results });
  } catch (e) {
    if (e instanceof YouTubeError && /quota|limit/i.test(e.reason)) {
      // quotaExceeded / dailyLimitExceeded last until midnight Pacific; rateLimitExceeded passes in seconds.
      if (/quota|daily/i.test(e.reason)) await markSpent().catch(e => console.error("quota", e));
      return reply(429, { error: "quota" });
    }
    console.error(e);
    return reply(502, { error: "youtube" });
  }
}

Deno.serve(handle);

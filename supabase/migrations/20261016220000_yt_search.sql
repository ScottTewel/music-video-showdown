-- In-app YouTube search (supabase/functions/yt-search).
-- Only the Edge Function touches these tables, using the secret key. Phones never read them.

create table if not exists public.yt_search_cache (
  q          text primary key,             -- normalized query
  results    jsonb not null,
  fetched_at timestamptz not null default now()
);

-- One row per uncached search, for the per-phone hourly limit. Pruned after a day.
create table if not exists public.yt_search_log (
  id    bigint generated always as identity primary key,
  token text not null,
  at    timestamptz not null default now()
);
create index if not exists yt_search_log_token_at on public.yt_search_log (token, at);

alter table public.yt_search_cache enable row level security;
alter table public.yt_search_log enable row level security;
-- No policies on purpose: the publishable key gets nothing.
revoke all on public.yt_search_cache, public.yt_search_log from anon, authenticated;
grant select, insert, update, delete on public.yt_search_cache, public.yt_search_log to service_role;

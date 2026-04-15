# cbc-feed-worker

A Deno Deploy worker that republishes CBC's "The World This Hour" as a proper
podcast feed suitable for Overcast, Apple Podcasts, and other standard
aggregators.

- **Upstream:** `https://www.cbc.ca/podcasting/includes/hourlynews.xml`
- **Served feed:** `https://cbc-feed.deno.dev/feed.xml`

## Why this exists

CBC publishes "The World This Hour" as an hourly 5-minute news recap, but the
feed CBC serves is not usable as a normal podcast subscription. Two problems:

### 1. The feed contains only a single item

CBC's XML feed replaces its one `<item>` each hour rather than appending. A
subscriber polling that feed sees exactly one episode at any moment — whichever
hour CBC most recently published. If an aggregator misses a poll (or the user
opens the app a few hours later), the previous episodes are simply gone. There
is no catch-up, no back-catalog, and no guarantee that the episode currently
in the feed is the one the user last played.

### 2. `pubDate` is the original air time, not the publish time

CBC's `pubDate` reflects when the hour's newscast was *recorded / aired*,
which often sits several minutes (or more) behind the moment the episode
actually appears in the feed. Aggregators use `pubDate` to decide ordering
and "new episode" notifications, so:

- An episode that CBC puts in the feed at 14:07 UTC with a `pubDate` of
  13:00 UTC looks *older* than it is.
- Clients that dedupe or sort strictly by `pubDate` can skip over newer
  items that happen to carry stale timestamps.
- "New episode" notifications fire late, or not at all, relative to when
  the audio is actually available.

## What this worker does

On a `*/5 * * * *` cron, it:

1. Fetches CBC's single-item feed.
2. Parses the current episode and records the moment we first observed it
   (`fetchedAt`).
3. Atomically merges new episodes into a Deno KV-backed rolling list
   (capped at 48 entries; served feed is the most recent 3).
4. Regenerates a standards-compliant RSS feed on demand at `/feed.xml`,
   with:
   - Multiple recent items (so aggregators can backfill).
   - `pubDate` set to `max(fetchedAt, cbcPubDate)` — whichever is newer —
     so "new episode" ordering reflects when listeners can actually
     hear the audio, not when it was originally aired.
   - `itunes:type = episodic`, `itunes:episodeType = full`, and a
     `lastBuildDate` so aggregators treat freshness sensibly.
5. Pings Overcast's `/ping` endpoint whenever a new episode is merged,
   triggering an immediate crawl instead of waiting 5–30 minutes for
   Overcast's scheduler.

## Endpoints

- `GET /feed.xml` — the RSS feed (also available at `/feed`).
- `GET /` — plain-text status page with stored entry count and the
  most recent 10 episodes.

## Run locally

```sh
deno task dev
```

Then visit `http://localhost:8000/feed.xml`.

Set `FEED_SELF_URL` to override the canonical feed URL used in the
`<atom:link rel="self">` tag and in the Overcast ping.

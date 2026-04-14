import { XMLParser } from "npm:fast-xml-parser@5";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CBC_FEED_URL = "https://www.cbc.ca/podcasting/includes/hourlynews.xml";
const USER_AGENT = "CBC-Hourly-News-Monitor/2.0";
const MAX_EPISODES = 3;
const SELF_URL = Deno.env.get("FEED_SELF_URL") ??
  "https://cbc-feed.deno.dev/feed.xml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Entry {
  guid: string;
  title: string;
  description: string;
  summary: string;
  pubDate: string;
  pubDateISO: string;
  duration: string;
  audioUrl: string;
  audioLength: number;
  audioType: string;
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

const kv = await Deno.openKv();

async function getEntries(): Promise<Entry[]> {
  const result = await kv.get<Entry[]>(["entries"]);
  return result.value ?? [];
}

async function saveEntries(entries: Entry[]): Promise<void> {
  await kv.set(["entries"], entries);
}

async function saveFeedXml(xml: string): Promise<void> {
  await kv.set(["feed-xml"], xml);
}

async function getFeedXml(): Promise<string | null> {
  const result = await kv.get<string>(["feed-xml"]);
  return result.value;
}

// ---------------------------------------------------------------------------
// XML parsing — extract the current episode from CBC's feed
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

function parseEpisode(xml: string): Entry | null {
  const feed = parser.parse(xml);
  const channel = feed?.rss?.channel;
  if (!channel) return null;

  const items = Array.isArray(channel.item) ? channel.item : [channel.item];
  const item = items[0];
  if (!item) return null;

  const guid =
    typeof item.guid === "object" ? item.guid["#text"] : String(item.guid);
  if (!guid) return null;

  const pubDate = item.pubDate ?? "";
  let pubDateISO: string;
  try {
    pubDateISO = new Date(pubDate).toISOString();
  } catch {
    pubDateISO = new Date().toISOString();
  }

  return {
    guid,
    title: item.title ?? "",
    description: item.description ?? "",
    summary: item["itunes:summary"] ?? "",
    pubDate,
    pubDateISO,
    duration: item["itunes:duration"] ?? "",
    audioUrl: item.enclosure?.["@_url"] ?? "",
    audioLength: parseInt(item.enclosure?.["@_length"] ?? "0", 10),
    audioType: item.enclosure?.["@_type"] ?? "",
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Feed XML generation
// ---------------------------------------------------------------------------

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const timeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  hour12: true,
  timeZone: "America/Toronto",
  timeZoneName: "short",
});

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "America/Toronto",
});

function episodeTitle(pubDateISO: string): string {
  const date = new Date(pubDateISO);
  const time = timeFmt.format(date).replace(/(\d)\s+(AM|PM)/, "$1$2");
  return `The World This Hour: ${time} ${dateFmt.format(date)}`;
}

function generateFeedXml(entries: Entry[]): string {
  const recent = entries
    .slice()
    .sort((a, b) =>
      new Date(b.pubDateISO).getTime() - new Date(a.pubDateISO).getTime()
    )
    .slice(0, MAX_EPISODES);

  const items = recent
    .map(
      (entry) => `        <item>
            <guid isPermaLink="false">${esc(entry.guid)}</guid>
            <title>${esc(episodeTitle(entry.pubDateISO))}</title>
            <description>Catch up on the day's most important news from Canada and around the world in 5 minutes. Updated every hour, 24/7.</description>
            <itunes:summary>Catch up on the day's most important news from Canada and around the world in 5 minutes. Updated every hour, 24/7.</itunes:summary>
            <pubDate>${esc(entry.pubDate)}</pubDate>
            <itunes:duration>${esc(entry.duration)}</itunes:duration>
            <itunes:explicit>No</itunes:explicit>
            <enclosure url="${esc(entry.audioUrl)}" length="${entry.audioLength}" type="${esc(entry.audioType)}" />
        </item>`
    )
    .join("\n");

  const year = new Date().getFullYear();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom" version="2.0">
    <channel>
        <language>en-ca</language>
        <title>The World This Hour</title>
        <link>https://www.cbc.ca/radio/podcasts</link>
        <description>Catch up on the day's most important news from Canada and around the world in 5 minutes. Updated every hour, 24/7. Last ${MAX_EPISODES} episodes.</description>
        <itunes:summary>Catch up on the day's most important news from Canada and around the world in 5 minutes. Updated every hour, 24/7.</itunes:summary>
        <itunes:owner>
            <itunes:name>CBC</itunes:name>
            <itunes:email>podcasting@cbc.ca</itunes:email>
        </itunes:owner>
        <copyright>Copyright \u00A9 CBC ${year}</copyright>
        <itunes:category text="News" />
        <itunes:author>CBC</itunes:author>
        <itunes:image href="https://www.cbc.ca/radio/podcasts/images/theworldthishour-3000x3000.jpg"/>
        <itunes:explicit>No</itunes:explicit>
        <image>
            <title>The World This Hour</title>
            <url>https://www.cbc.ca/radio/podcasts/images/theworldthishour-3000x3000.jpg</url>
            <link>https://www.cbc.ca/radio/podcasts</link>
        </image>
        <atom:link href="${SELF_URL}" rel="self" type="application/rss+xml" />
${items}
    </channel>
</rss>
`;
}

// ---------------------------------------------------------------------------
// Cron — fetch CBC feed every 5 minutes
// ---------------------------------------------------------------------------

async function fetchFeed(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Fetching CBC feed...`);

  try {
    const response = await fetch(CBC_FEED_URL, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      console.log(`Feed returned ${response.status} ${response.statusText}`);
      return;
    }
    const xml = await response.text();
    const episode = parseEpisode(xml);
    if (!episode) {
      console.log("No episode found in feed");
      return;
    }

    const entries = await getEntries();
    const existing = entries.find((e) => e.guid === episode.guid);

    if (existing) {
      console.log(`Seen: ${episode.guid} (${episode.pubDate})`);
      return;
    }

    // New episode — add it and cap the list
    entries.push(episode);
    // Keep more than MAX_EPISODES in storage so we have history,
    // but the feed itself only shows the latest MAX_EPISODES.
    const maxStored = 48;
    if (entries.length > maxStored) {
      entries.splice(0, entries.length - maxStored);
    }

    await saveEntries(entries);

    const feedXml = generateFeedXml(entries);
    await saveFeedXml(feedXml);

    console.log(`New: ${episode.guid} (${episode.pubDate}) — feed updated`);
  } catch (err) {
    console.error(`Fetch error: ${err}`);
  }
}

Deno.cron("fetch-cbc-feed", "*/5 * * * *", fetchFeed);

// Run once on startup so the feed is populated immediately
await fetchFeed();

// ---------------------------------------------------------------------------
// HTTP server — serve the feed
// ---------------------------------------------------------------------------

Deno.serve({ port: 8000 }, async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === "/feed.xml" || url.pathname === "/feed") {
    const xml = await getFeedXml();
    if (!xml) {
      return new Response("Feed not yet available", { status: 503 });
    }
    return new Response(xml, {
      headers: {
        "content-type": "application/rss+xml; charset=utf-8",
        "cache-control": "public, max-age=120",
      },
    });
  }

  if (url.pathname === "/") {
    const entries = await getEntries();
    const recent = entries
      .slice()
      .sort((a, b) =>
        new Date(b.pubDateISO).getTime() - new Date(a.pubDateISO).getTime()
      )
      .slice(0, 10);

    const lines = recent.map((e) =>
      `${e.pubDate}  →  fetched ${e.fetchedAt}  ${e.guid}`
    );

    return new Response(
      `CBC World This Hour — Feed Monitor\n` +
      `Episodes stored: ${entries.length}\n` +
      `Feed: ${SELF_URL}\n\n` +
      `Recent episodes:\n${lines.join("\n")}\n`,
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  return new Response("Not found", { status: 404 });
});

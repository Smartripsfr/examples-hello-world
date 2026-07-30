// meta-scraper.ts
// Récupère le <title> et les meta tags (OG, Twitter, itemprop, JSON-LD) d'une page.
//
// Lancer :  deno run --allow-net --allow-env meta-scraper.ts
//
// USAGE NORMAL :
//   http://localhost:8000/?url=https://exemple.com/page
//
// MODE TEST (balaie une liste d'UA et dit lesquels passent) :
//   http://localhost:8000/?url=https://exemple.com/page&test=1
//   -> à lancer depuis ta machine locale (IP résidentielle) : si l'autorisation
//      anti-bot est vérifiée par IP, un serveur/datacenter sera bloqué quel que
//      soit l'UA.

const SCRAPE_API = Deno.env.get("SCRAPE_API"); // ignoré en mode test
const TIMEOUT_MS = 15_000;

const BASE_HEADERS: Record<string, string> = {
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
};

// UA de crawlers/bots à tester. Iframely est placé en premier : c'est l'UA
// utilisé en priorité en usage normal (fetchWithFallback l'essaie d'abord).
// Les autres servent de fallback si Iframely est bloqué, et la liste sert
// aussi au mode test.
const UA_LIST: { name: string; ua: string }[] = [
  { name: "Iframely", ua: "Iframely/1.3.1 (+https://iframely.com/docs/about)" },
  { name: "Googlebot", ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
  { name: "Googlebot-Mobile", ua: "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
  { name: "Google-InspectionTool", ua: "Mozilla/5.0 (compatible; Google-InspectionTool/1.0)" },
  { name: "Bingbot", ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)" },
  { name: "facebookexternalhit", ua: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" },
  { name: "facebookcatalog", ua: "facebookcatalog/1.0" },
  { name: "Twitterbot", ua: "Twitterbot/1.0" },
  { name: "LinkedInBot", ua: "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)" },
  { name: "Slackbot", ua: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" },
  { name: "Discordbot", ua: "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)" },
  { name: "WhatsApp", ua: "WhatsApp/2.23.20.0" },
  { name: "TelegramBot", ua: "TelegramBot (like TwitterBot)" },
  { name: "Applebot", ua: "Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)" },
  { name: "Pinterestbot", ua: "Mozilla/5.0 (compatible; Pinterestbot/1.0; +https://www.pinterest.com/bot.html)" },
  { name: "redditbot", ua: "Mozilla/5.0 (compatible; redditbot/1.0; +http://www.reddit.com/feedback)" },
  { name: "DuckDuckBot", ua: "DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)" },
  { name: "Yahoo-Slurp", ua: "Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)" },
  { name: "Embedly", ua: "Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)" },
  { name: "Chrome-desktop", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" },
];

Deno.serve(async (req) => {
  const { searchParams } = new URL(req.url);
  const targetUrl = searchParams.get("url");
  const isTest = searchParams.has("test");

  if (!targetUrl) return json({ error: "Le paramètre 'url' est manquant" }, 400);

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
    if (!/^https?:$/.test(parsedTarget.protocol)) throw new Error("protocole non supporté");
  } catch {
    return json({ error: "URL invalide", value: targetUrl }, 400);
  }

  // ---- Mode test : quel UA passe ? ----
  if (isTest) {
    const results = await testUserAgents(parsedTarget.toString());
    const winners = results.filter((r) => r.verdict === "OK").map((r) => r.name);
    return json({
      url: targetUrl,
      note: winners.length
        ? `UA qui renvoient le vrai contenu : ${winners.join(", ")}. Reprends-en un dans UA_LIST pour l'usage normal.`
        : "Aucun UA n'a renvoyé le vrai contenu depuis cette IP. Si tu es sur un serveur/datacenter, réessaie depuis ta machine locale.",
      results,
    });
  }

  // ---- Usage normal ----
  try {
    const result = await fetchWithFallback(parsedTarget.toString());

    if (!result.ok) {
      return json({
        error: result.reason === "challenge"
          ? "Bloqué par un challenge JavaScript (Cloudflare/anti-bot) — impossible sans rendu JS"
          : "Aucun user-agent n'a permis de récupérer une page exploitable",
        hint: "Lance le mode diagnostic avec &test=1 pour voir quel UA passe depuis ton IP.",
        url: targetUrl,
        lastAttempt: result.last,
      }, 502);
    }

    const metadata = parseHtml(result.html, targetUrl);
    metadata.jsonLd = extractJsonLd(result.html);
    metadata._debug = {
      via: SCRAPE_API ? "scrape_api" : "direct",
      userAgentUsed: result.userAgent,
      httpStatus: result.status,
      finalUrl: result.finalUrl,
    };
    return json(metadata);
  } catch (err) {
    return json({ error: "Impossible de récupérer l'URL", details: (err as Error).message }, 500);
  }
});

/* -------------------- Mode test -------------------- */

type TestResult = {
  name: string;
  status: number;
  challenge: boolean;
  hasOgTags: boolean;
  verdict: "OK" | "CHALLENGE" | "BLOCKED" | "ERROR";
  error?: string;
};

async function testUserAgents(url: string): Promise<TestResult[]> {
  const results = await Promise.all(UA_LIST.map(async ({ name, ua }): Promise<TestResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { ...BASE_HEADERS, "user-agent": ua },
        redirect: "follow",
        signal: controller.signal,
      });
      const html = await res.text();
      const challenge = looksChallenged(html);
      const hasOgTags = /<meta[^>]+property=["']og:/i.test(html);
      const verdict: TestResult["verdict"] =
        res.ok && !challenge && hasOgTags ? "OK" : challenge ? "CHALLENGE" : "BLOCKED";
      return { name, status: res.status, challenge, hasOgTags, verdict };
    } catch (err) {
      return { name, status: 0, challenge: false, hasOgTags: false, verdict: "ERROR", error: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }));

  const rank: Record<TestResult["verdict"], number> = { OK: 0, CHALLENGE: 1, BLOCKED: 2, ERROR: 3 };
  results.sort((a, b) => rank[a.verdict] - rank[b.verdict]);
  return results;
}

/* -------------------- Fetch avec fallback (usage normal) -------------------- */

type FetchOk = { ok: true; html: string; userAgent: string; status: number; finalUrl: string };
type FetchFail = {
  ok: false;
  reason: "challenge" | "http" | "none";
  last: { status: number; snippet: string; userAgent: string; challenge: boolean } | null;
};

function buildRequestUrl(target: string): string {
  if (SCRAPE_API) return SCRAPE_API.replace("{url}", encodeURIComponent(target));
  return target;
}

function looksChallenged(html: string): boolean {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").toLowerCase();
  if (title.includes("just a moment") || title.includes("attention required")) return true;
  return /challenges\.cloudflare\.com|cf-browser-verification|__cf_chl|_cf_chl_opt|turnstile|cf-mitigated/i.test(html);
}

// En usage normal (hors &test=1), on n'utilise QUE l'UA Iframely — pas de
// boucle de fallback sur les autres UA de la liste.
const IFRAMELY_UA = UA_LIST.find((u) => u.name === "Iframely")!.ua;

async function fetchWithFallback(url: string): Promise<FetchOk | FetchFail> {
  const requestUrl = buildRequestUrl(url);
  const ua = IFRAMELY_UA;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(requestUrl, {
      headers: { ...BASE_HEADERS, "user-agent": ua },
      redirect: "follow",
      signal: controller.signal,
    });
    const html = await res.text();
    const challenge = looksChallenged(html);
    const last: FetchFail["last"] = { status: res.status, snippet: html.slice(0, 300), userAgent: ua, challenge };

    if (res.ok && !challenge && /<meta\b/i.test(html)) {
      return { ok: true, html, userAgent: ua, status: res.status, finalUrl: res.url };
    }
    return { ok: false, reason: challenge ? "challenge" : "http", last };
  } catch (err) {
    return {
      ok: false,
      reason: "none",
      last: { status: 0, snippet: `fetch error: ${(err as Error).message}`, userAgent: ua, challenge: false },
    };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------- Parsing -------------------- */

function parseHtml(html: string, originalUrl: string) {
  const metadata: Record<string, unknown> = { url: originalUrl, title: "" };

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) metadata.title = decodeEntities(titleMatch[1].trim());

  const metaTagRegex = /<meta\b([^>]*)>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = metaTagRegex.exec(html))) {
    const attrs = parseAttributes(tagMatch[1]);
    const key = attrs.name || attrs.property || attrs.itemprop || attrs["http-equiv"];
    const content = attrs.content;

    if (key && content !== undefined) {
      const value = decodeEntities(content);
      const existing = metadata[key];
      if (existing !== undefined) {
        metadata[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        metadata[key] = value;
      }
    } else if (attrs.charset) {
      metadata.charset = attrs.charset;
    }
  }
  return metadata;
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z0-9:_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(raw))) {
    if (!m[1]) continue;
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

function extractJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try { blocks.push(JSON.parse(m[1].trim())); } catch { /* ignore */ }
  }
  return blocks;
}

function decodeEntities(str: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => named[name.toLowerCase()] ?? m);
}

/* -------------------- Réponse JSON -------------------- */

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });
}

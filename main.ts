// meta-scraper.ts
// Récupère le <title> et les meta tags (OG, Twitter, itemprop, JSON-LD) d'une page.
//
// Lancer :  deno run --allow-net --allow-env meta-scraper.ts
// Appeler : http://localhost:8000/?url=https://exemple.com/page
//
// ATTENTION anti-bot : les sites protégés par un challenge JS (Cloudflare
// "Just a moment...", DataDome...) ne peuvent PAS être franchis par un simple
// fetch, qui n'exécute pas de JavaScript. Il faut passer par un service qui
// résout le challenge, via la variable d'env SCRAPE_API ({url} = placeholder) :
//
//   ScrapingBee : SCRAPE_API="https://app.scrapingbee.com/api/v1/?api_key=XXX&render_js=true&stealth_proxy=true&url={url}"
//   ScraperAPI  : SCRAPE_API="http://api.scraperapi.com?api_key=XXX&render=true&ultra_premium=true&url={url}"
//   FlareSolverr (self-hosted) : à appeler différemment (POST), voir leur doc.
//
// Les paramètres render_js / render ET stealth_proxy / ultra_premium sont
// indispensables pour Cloudflare : sans eux, tu récupères la page de challenge.

const SCRAPE_API = Deno.env.get("SCRAPE_API");
const TIMEOUT_MS = 30_000; // le rendu JV d'un service anti-bot peut être lent

const BASE_HEADERS: Record<string, string> = {
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
};

type Agent = { ua: string; headers: Record<string, string> };

const AGENTS: Agent[] = [
  {
    ua: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    headers: {},
  },
  {
    ua: "Twitterbot/1.0",
    headers: {},
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    headers: {
      "sec-ch-ua":
        '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
    },
  },
];

Deno.serve(async (req) => {
  const { searchParams } = new URL(req.url);
  const targetUrl = searchParams.get("url");

  if (!targetUrl) return json({ error: "Le paramètre 'url' est manquant" }, 400);

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
    if (!/^https?:$/.test(parsedTarget.protocol)) throw new Error("protocole non supporté");
  } catch {
    return json({ error: "URL invalide", value: targetUrl }, 400);
  }

  try {
    const result = await fetchWithFallback(parsedTarget.toString());

    if (!result.ok) {
      return json(
        {
          error: result.reason === "challenge"
            ? "Bloqué par un challenge JavaScript (Cloudflare/anti-bot) — impossible sans rendu JS"
            : "Aucun user-agent n'a permis de récupérer une page exploitable",
          hint: result.reason === "challenge"
            ? (SCRAPE_API
                ? "Active le rendu JS sur ton service : render_js=true + stealth_proxy (ScrapingBee) ou render=true + ultra_premium=true (ScraperAPI)."
                : "fetch n'exécute pas de JS. Passe par SCRAPE_API avec rendu JS, un proxy résidentiel, ou FlareSolverr.")
            : (SCRAPE_API
                ? "Le service SCRAPE_API a échoué : vérifie clé/quota/paramètres."
                : "403 = anti-bot. Définis SCRAPE_API (voir en-tête du fichier)."),
          url: targetUrl,
          lastAttempt: result.last,
        },
        502,
      );
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

/* -------------------- Fetch avec fallback -------------------- */

type FetchOk = {
  ok: true;
  html: string;
  userAgent: string;
  status: number;
  finalUrl: string;
};
type FetchFail = {
  ok: false;
  reason: "challenge" | "http" | "none";
  last: { status: number; snippet: string; userAgent: string; challenge: boolean } | null;
};

function buildRequestUrl(target: string): string {
  if (SCRAPE_API) return SCRAPE_API.replace("{url}", encodeURIComponent(target));
  return target;
}

// Détecte les pages-piège anti-bot (challenge JS) plutôt que le vrai contenu.
function looksChallenged(html: string): boolean {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").toLowerCase();
  if (title.includes("just a moment") || title.includes("attention required")) return true;
  return /challenges\.cloudflare\.com|cf-browser-verification|__cf_chl|_cf_chl_opt|turnstile|cf-mitigated/i
    .test(html);
}

async function fetchWithFallback(url: string): Promise<FetchOk | FetchFail> {
  let last: FetchFail["last"] = null;
  let sawChallenge = false;
  const requestUrl = buildRequestUrl(url);

  for (const agent of AGENTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(requestUrl, {
        headers: { ...BASE_HEADERS, ...agent.headers, "user-agent": agent.ua },
        redirect: "follow",
        signal: controller.signal,
      });

      const html = await res.text();
      const challenge = looksChallenged(html);
      if (challenge) sawChallenge = true;
      last = { status: res.status, snippet: html.slice(0, 300), userAgent: agent.ua, challenge };

      // Succès seulement si : statut OK, pas de challenge, et des <meta> présents.
      if (res.ok && !challenge && /<meta\b/i.test(html)) {
        return { ok: true, html, userAgent: agent.ua, status: res.status, finalUrl: res.url };
      }
    } catch (err) {
      last = { status: 0, snippet: `fetch error: ${(err as Error).message}`, userAgent: agent.ua, challenge: false };
    } finally {
      clearTimeout(timer);
    }

    if (SCRAPE_API) break; // le service gère lui-même la rotation
  }

  return { ok: false, reason: sawChallenge ? "challenge" : (last ? "http" : "none"), last };
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
    try {
      blocks.push(JSON.parse(m[1].trim()));
    } catch {
      /* JSON-LD malformé : on ignore */
    }
  }
  return blocks;
}

function decodeEntities(str: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => named[name.toLowerCase()] ?? m);
}

/* -------------------- Réponse JSON -------------------- */

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

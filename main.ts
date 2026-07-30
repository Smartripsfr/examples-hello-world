// meta-scraper.ts
// Récupère le <title> et les meta tags (OG, Twitter, itemprop, JSON-LD) d'une page.
//
// Lancer :  deno run --allow-net --allow-env meta-scraper.ts
// Appeler : http://localhost:8000/?url=https://exemple.com/page
//
// Contournement anti-bot (recommandé pour les sites protégés type GetYourGuide) :
//   Poser une variable d'env SCRAPE_API pointant vers un service de scraping,
//   avec {url} comme placeholder pour l'URL cible (encodée automatiquement) :
//     ScraperAPI  : SCRAPE_API="http://api.scraperapi.com?api_key=XXX&url={url}"
//     ScrapingBee : SCRAPE_API="https://app.scrapingbee.com/api/v1/?api_key=XXX&url={url}"
//   Sans SCRAPE_API, le fetch va directement sur la cible (souvent 403 si anti-bot).

const SCRAPE_API = Deno.env.get("SCRAPE_API");
const TIMEOUT_MS = 15_000;

// En-têtes de base envoyés dans tous les cas.
const BASE_HEADERS: Record<string, string> = {
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
};

// Profils user-agent essayés dans l'ordre. Le profil navigateur ajoute les
// en-têtes "client hints" / "sec-fetch" cohérents avec un vrai Chrome.
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

  if (!targetUrl) {
    return json({ error: "Le paramètre 'url' est manquant" }, 400);
  }

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
    if (!/^https?:$/.test(parsedTarget.protocol)) {
      throw new Error("protocole non supporté");
    }
  } catch {
    return json({ error: "URL invalide", value: targetUrl }, 400);
  }

  try {
    const result = await fetchWithFallback(parsedTarget.toString());

    if (!result.ok) {
      return json(
        {
          error: "Aucun user-agent n'a permis de récupérer une page exploitable",
          hint: SCRAPE_API
            ? "Le service SCRAPE_API a aussi échoué : vérifie ta clé/quota."
            : "403 = anti-bot. Définis une variable d'env SCRAPE_API (voir en-tête du fichier).",
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
    return json(
      { error: "Impossible de récupérer l'URL", details: (err as Error).message },
      500,
    );
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
  last: { status: number; snippet: string; userAgent: string } | null;
};

// Construit l'URL réellement appelée : soit la cible directe, soit via SCRAPE_API.
function buildRequestUrl(target: string): string {
  if (SCRAPE_API) return SCRAPE_API.replace("{url}", encodeURIComponent(target));
  return target;
}

async function fetchWithFallback(url: string): Promise<FetchOk | FetchFail> {
  let last: FetchFail["last"] = null;
  const requestUrl = buildRequestUrl(url);

  for (const agent of AGENTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(requestUrl, {
        headers: {
          ...BASE_HEADERS,
          ...agent.headers,
          "user-agent": agent.ua,
        },
        redirect: "follow",
        signal: controller.signal,
      });

      const html = await res.text();
      last = { status: res.status, snippet: html.slice(0, 300), userAgent: agent.ua };

      if (res.ok && /<meta\b/i.test(html)) {
        return { ok: true, html, userAgent: agent.ua, status: res.status, finalUrl: res.url };
      }
    } catch (err) {
      last = { status: 0, snippet: `fetch error: ${(err as Error).message}`, userAgent: agent.ua };
    } finally {
      clearTimeout(timer);
    }

    // Via un service de scraping, inutile de tester d'autres UA : il gère lui-même.
    if (SCRAPE_API) break;
  }

  return { ok: false, last };
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

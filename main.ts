// main.ts
import { DOMParser, type Element } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

// Si tu as une clé ScraperAPI/ScrapingBee, mets-la dans les variables
// d'environnement de ton projet Deno Deploy sous le nom SCRAPER_API_KEY.
// Sinon laisse vide : le serveur essaiera un fetch direct avec des headers
// de navigateur réalistes.
const SCRAPER_API_KEY = Deno.env.get("SCRAPER_API_KEY") ?? "";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: JSON_HEADERS,
  });
}

// Headers imitant un vrai navigateur Chrome pour limiter les blocages anti-bot.
function browserHeaders(): HeadersInit {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.google.com/",
    "sec-ch-ua": `"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"Windows"`,
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "sec-fetch-dest": "document",
    "Upgrade-Insecure-Requests": "1",
  };
}

// Récupère le HTML soit directement, soit via un service de scraping tiers
// (ScraperAPI) si une clé est configurée et que le fetch direct échoue.
async function fetchHtml(
  targetUrl: string,
): Promise<{ html: string } | { error: string; status?: number }> {
  // 1. Tentative directe
  try {
    const res = await fetch(targetUrl, { headers: browserHeaders() });
    if (res.ok) {
      return { html: await res.text() };
    }
    // Si ça échoue (ex: 403) et qu'on a une clé de scraping, on tente le fallback.
    if (SCRAPER_API_KEY) {
      return await fetchViaScraperApi(targetUrl);
    }
    return { error: `Échec de récupération directe (status ${res.status})`, status: res.status };
  } catch (err) {
    if (SCRAPER_API_KEY) {
      return await fetchViaScraperApi(targetUrl);
    }
    return { error: `Erreur réseau lors du fetch direct: ${String(err)}` };
  }
}

// Fallback via ScraperAPI (https://www.scraperapi.com/) — gère la rotation
// d'IP et contourne la plupart des protections anti-bot.
// Adapte l'URL si tu utilises un autre service (ScrapingBee, Zyte, etc.).
async function fetchViaScraperApi(
  targetUrl: string,
): Promise<{ html: string } | { error: string; status?: number }> {
  const proxyUrl = `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}`;
  try {
    const res = await fetch(proxyUrl);
    if (!res.ok) {
      return { error: `Échec via ScraperAPI (status ${res.status})`, status: res.status };
    }
    return { html: await res.text() };
  } catch (err) {
    return { error: `Erreur réseau via ScraperAPI: ${String(err)}` };
  }
}

function extractMetaTags(html: string): Record<string, string> | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return null;

  const metaTags: Record<string, string> = {};

  const titleEl = doc.querySelector("title");
  if (titleEl) metaTags["title"] = titleEl.textContent.trim();

  doc.querySelectorAll("meta").forEach((meta) => {
    const el = meta as unknown as Element;
    const name = el.getAttribute("name") || el.getAttribute("property");
    const content = el.getAttribute("content");
    if (name && content) {
      metaTags[name] = content;
    }
  });

  const canonical = doc.querySelector("link[rel='canonical']");
  if (canonical) {
    metaTags["canonical"] = (canonical as unknown as Element).getAttribute("href") ?? "";
  }

  return metaTags;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Pré-vol CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  }

  const targetUrl = url.searchParams.get("url");

  if (!targetUrl) {
    return jsonResponse(
      { error: "Paramètre 'url' manquant. Ex: ?url=https://www.getyourguide.fr/..." },
      400,
    );
  }

  if (!targetUrl.includes("getyourguide.")) {
    return jsonResponse(
      { error: "Cette route n'accepte que des liens getyourguide.*" },
      400,
    );
  }

  const result = await fetchHtml(targetUrl);

  if ("error" in result) {
    return jsonResponse({ error: result.error }, result.status ?? 502);
  }

  const metaTags = extractMetaTags(result.html);

  if (!metaTags) {
    return jsonResponse({ error: "Impossible de parser le HTML" }, 500);
  }

  return jsonResponse({ url: targetUrl, metaTags });
});

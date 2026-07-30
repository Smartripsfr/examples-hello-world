// deno run --allow-net scraper.ts
// Compatible Deno Deploy

import { DOMParser, Element } from "jsr:@b-fuze/deno-dom";

/* -------------------------------------------------------------------------- */
/*                                Utilitaires                                 */
/* -------------------------------------------------------------------------- */

// Délai asynchrone
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// User-Agents variés pour brouiller les pistes
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
];

// Génère des headers réalistes
function buildHeaders() {
  const agent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  return {
    "accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "pragma": "no-cache",
    "upgrade-insecure-requests": "1",
    "user-agent": agent,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Cache                                    */
/* -------------------------------------------------------------------------- */

const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 1000 * 60 * 5; // 5 minutes

function getCached(url: string) {
  const entry = cache.get(url);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data;
  }
  return null;
}

function setCached(url: string, data: any) {
  cache.set(url, { data, timestamp: Date.now() });
}

/* -------------------------------------------------------------------------- */
/*                             Requête HTTP robuste                           */
/* -------------------------------------------------------------------------- */

async function robustFetch(url: string, retries = 2): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const headers = buildHeaders();
    const res = await fetch(url, { headers });

    if (
      res.ok &&
      res.headers.get("content-type")?.includes("text/html") &&
      res.status < 400
    ) {
      return res;
    }

    console.log(`⚠️ Tentative ${i + 1} échouée (${res.status})`);
    await delay(1000 + Math.random() * 1000);
  }
  throw new Error("Fetch échoué après plusieurs tentatives");
}

/* -------------------------------------------------------------------------- */
/*                               Extraction HTML                              */
/* -------------------------------------------------------------------------- */

async function getMeta(targetUrl: string) {
  const cached = getCached(targetUrl);
  if (cached) return { ...cached, cached: true };

  try {
    // Nettoyage simple des paramètres parasites
    const cleanedUrl = (() => {
      try {
        const u = new URL(targetUrl);
        const paramsToDelete = ["aid", "label", "sid", "all_sr_blocks"];
        for (const p of paramsToDelete) u.searchParams.delete(p);
        return u.toString();
      } catch (_) {
        return targetUrl;
      }
    })();

    const res = await robustFetch(cleanedUrl);
    const html = await res.text();

    // Vérification basique du contenu
    if (!html || !html.includes("<title")) {
      throw new Error("Page vide ou bloquée");
    }

    const doc = new DOMParser().parseFromString(html, "text/html");
    if (!doc) throw new Error("Échec du parsing HTML");

    // Extraction des balises meta
    const metaTags = doc.querySelectorAll("meta") as Element[];
    const result: Record<string, string> = {};

    for (const tag of metaTags) {
      const name = tag.getAttribute("name");
      const prop = tag.getAttribute("property");
      const content = tag.getAttribute("content");
      if (content) {
        if (name) result[name] = content;
        if (prop) result[prop] = content;
      }
    }

    // Titre + fallback description
    const title = doc.querySelector("title")?.textContent?.trim() ?? null;
    if (title) result.title = title;
    if (!result["description"] && result["og:description"])
      result["description"] = result["og:description"];

    // URL canonique
    result["og:url"] ??= cleanedUrl;

    const data = {
      ok: true,
      title: result.title ?? null,
      description: result.description ?? null,
      image: result["og:image"] ?? null,
      url: result["og:url"] ?? cleanedUrl,
      meta: result,
    };

    setCached(targetUrl, data);
    return data;
  } catch (e) {
    console.error("❌ Erreur scraper:", e.message);
    return { ok: false, error: e.message };
  }
}

/* -------------------------------------------------------------------------- */
/*                              Serveur Deno Deploy                           */
/* -------------------------------------------------------------------------- */

Deno.serve(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const target = searchParams.get("url");

  if (!target) {
    return new Response(JSON.stringify({ error: "Missing ?url" }), {
      status: 400,
      headers: corsHeaders(),
    });
  }

  const data = await getMeta(target);
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: corsHeaders(),
  });
});

function corsHeaders(): Headers {
  return new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
}

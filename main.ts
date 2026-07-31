// main.ts
import { DOMParser, type Element } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

function browserHeaders(cookie?: string): HeadersInit {
  const h: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "Upgrade-Insecure-Requests": "1",
  };
  if (cookie) h["Cookie"] = cookie;
  return h;
}

function extractCookieHeader(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return "";
  return setCookie.split(/,(?=[^;]+?=)/).map((c) => c.split(";")[0].trim()).join("; ");
}

async function tryFetch(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    const res = await fetch(url, init);
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

// Tentative 1 : warm-up + cookies + retries avec délai variable.
async function attemptDirectHtml(targetUrl: string): Promise<string | null> {
  const origin = new URL(targetUrl).origin;

  for (let attempt = 0; attempt < 3; attempt++) {
    const warmup = await tryFetch(origin, { headers: browserHeaders() });
    const cookie = warmup ? extractCookieHeader(warmup) : "";

    await new Promise((r) => setTimeout(r, 600 + Math.random() * 900));

    const res = await tryFetch(targetUrl, {
      headers: { ...browserHeaders(cookie), "Referer": origin + "/" },
    });
    if (res) return await res.text();

    // Pause croissante avant la prochaine tentative.
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  return null;
}

// Tentative 2 : version mobile du domaine, si elle existe et répond différemment.
async function attemptMobileHtml(targetUrl: string): Promise<string | null> {
  const u = new URL(targetUrl);
  const mobileUrl = targetUrl.replace(u.host, "m." + u.host.replace(/^www\./, ""));
  const res = await tryFetch(mobileUrl, { headers: browserHeaders() });
  return res ? await res.text() : null;
}

// Tentative 3 : endpoint JSON interne du site, si tu en as identifié un via
// les DevTools (onglet Network -> Fetch/XHR sur une page d'activité).
// Remplis PRODUCT_API_TEMPLATE une fois que tu as trouvé le bon format d'URL.
// Exemple hypothétique - à adapter avec la vraie URL trouvée dans DevTools :
// const PRODUCT_API_TEMPLATE = "https://www.getyourguide.com/api/tours/{slug}";
const PRODUCT_API_TEMPLATE = ""; // laisse vide tant que tu n'as pas identifié l'endpoint

async function attemptInternalApi(targetUrl: string): Promise<Record<string, string> | null> {
  if (!PRODUCT_API_TEMPLATE) return null;
  const slugMatch = targetUrl.match(/-t(\d+)\/?$/); // ex: ...-t297705/
  if (!slugMatch) return null;

  const apiUrl = PRODUCT_API_TEMPLATE.replace("{slug}", slugMatch[1]);
  const res = await tryFetch(apiUrl, {
    headers: { ...browserHeaders(), "Accept": "application/json" },
  });
  if (!res) return null;

  try {
    const data = await res.json();
    // Adapte le mapping ci-dessous une fois que tu connais la vraie forme du JSON.
    return {
      title: data.title ?? "",
      description: data.description ?? "",
      image: data.imageUrl ?? "",
    };
  } catch {
    return null;
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
    if (name && content) metaTags[name] = content;
  });

  const canonical = doc.querySelector("link[rel='canonical']");
  if (canonical) {
    metaTags["canonical"] = (canonical as unknown as Element).getAttribute("href") ?? "";
  }

  return metaTags;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });

  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return jsonResponse({ error: "Paramètre 'url' manquant." }, 400);
  }
  if (!targetUrl.includes("getyourguide.")) {
    return jsonResponse({ error: "Cette route n'accepte que des liens getyourguide.*" }, 400);
  }

  // Tentative 3 d'abord si configurée (la plus légère et la plus fiable si elle existe)
  const apiResult = await attemptInternalApi(targetUrl);
  if (apiResult) {
    return jsonResponse({ url: targetUrl, source: "internal_api", metaTags: apiResult });
  }

  // Tentative 1 : fetch direct HTML avec warm-up + retries
  let html = await attemptDirectHtml(targetUrl);
  let source = "direct";

  // Tentative 2 : fallback version mobile
  if (!html) {
    html = await attemptMobileHtml(targetUrl);
    source = "mobile";
  }

  if (!html) {
    return jsonResponse(
      {
        error:
          "Toutes les tentatives ont échoué (403 probable, blocage IP niveau bot-manager). " +
          "Aucune méthode purement Deno Deploy ne peut garantir un contournement fiable. " +
          "Voir suggestions : endpoint JSON interne du site, ou API partenaire officielle GetYourGuide.",
      },
      502,
    );
  }

  const metaTags = extractMetaTags(html);
  if (!metaTags) return jsonResponse({ error: "Impossible de parser le HTML" }, 500);

  return jsonResponse({ url: targetUrl, source, metaTags });
});

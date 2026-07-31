// main.ts
import { DOMParser, type Element } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

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

function browserHeaders(cookie?: string): HeadersInit {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "sec-ch-ua": `"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"Windows"`,
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "sec-fetch-dest": "document",
    "Upgrade-Insecure-Requests": "1",
  };
  if (cookie) headers["Cookie"] = cookie;
  return headers;
}

// Extrait les paires "nom=valeur" des en-têtes Set-Cookie renvoyés par le serveur.
function extractCookieHeader(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return "";
  // Peut contenir plusieurs cookies séparés par une virgule selon l'environnement;
  // on ne garde que la partie "nom=valeur" de chacun.
  return setCookie
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0].trim())
    .join("; ");
}

async function fetchWithWarmup(
  targetUrl: string,
): Promise<{ html: string } | { error: string; status?: number }> {
  const origin = new URL(targetUrl).origin;

  try {
    // Étape 1 : visite de la page d'accueil pour obtenir des cookies de session,
    // comme le ferait un vrai visiteur avant de naviguer vers une page produit.
    const warmupRes = await fetch(origin, { headers: browserHeaders() });
    const cookie = extractCookieHeader(warmupRes);

    // Petite pause pour ne pas enchaîner les requêtes de façon trop robotique.
    await new Promise((r) => setTimeout(r, 800 + Math.random() * 700));

    // Étape 2 : requête réelle avec les cookies récupérés + un Referer cohérent.
    const res = await fetch(targetUrl, {
      headers: {
        ...browserHeaders(cookie),
        "Referer": origin + "/",
      },
    });

    if (res.ok) {
      return { html: await res.text() };
    }
    return {
      error: `Échec de récupération (status ${res.status}). Probable blocage IP au niveau du bot-manager — voir suggestions de migration.`,
      status: res.status,
    };
  } catch (err) {
    return { error: `Erreur réseau: ${String(err)}` };
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
    return jsonResponse({ error: "Cette route n'accepte que des liens getyourguide.*" }, 400);
  }

  const result = await fetchWithWarmup(targetUrl);

  if ("error" in result) {
    return jsonResponse({ error: result.error }, result.status ?? 502);
  }

  const metaTags = extractMetaTags(result.html);

  if (!metaTags) {
    return jsonResponse({ error: "Impossible de parser le HTML" }, 500);
  }

  return jsonResponse({ url: targetUrl, metaTags });
});

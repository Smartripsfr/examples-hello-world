// main.ts
import { DOMParser } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const targetUrl = url.searchParams.get("url");

  // CORS (pratique si tu appelles ça depuis un front-end)
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (!targetUrl) {
    return new Response(
      JSON.stringify({ error: "Paramètre 'url' manquant. Ex: ?url=https://www.getyourguide.fr/..." }),
      { status: 400, headers }
    );
  }

  // Vérification basique qu'on cible bien getyourguide
  if (!targetUrl.includes("getyourguide.")) {
    return new Response(
      JSON.stringify({ error: "Cette route n'accepte que des liens getyourguide.*" }),
      { status: 400, headers }
    );
  }

  try {
    const res = await fetch(targetUrl, {
      headers: {
        // Certains sites bloquent les requêtes sans user-agent "navigateur"
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "fr-FR,fr;q=0.9",
      },
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Échec de récupération (status ${res.status})` }),
        { status: 502, headers }
      );
    }

    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");

    if (!doc) {
      return new Response(JSON.stringify({ error: "Impossible de parser le HTML" }), {
        status: 500,
        headers,
      });
    }

    const metaTags: Record<string, string> = {};

    // Titre standard
    const titleEl = doc.querySelector("title");
    if (titleEl) metaTags["title"] = titleEl.textContent.trim();

    // Toutes les balises <meta name="..."> et <meta property="...">
    doc.querySelectorAll("meta").forEach((meta) => {
      const el = meta as unknown as Element;
      const name = el.getAttribute("name") || el.getAttribute("property");
      const content = el.getAttribute("content");
      if (name && content) {
        metaTags[name] = content;
      }
    });

    // Canonical (souvent utile)
    const canonical = doc.querySelector("link[rel='canonical']");
    if (canonical) {
      metaTags["canonical"] = (canonical as unknown as Element).getAttribute("href") ?? "";
    }

    return new Response(JSON.stringify({ url: targetUrl, metaTags }, null, 2), {
      status: 200,
      headers,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Erreur lors du fetch", details: String(err) }),
      { status: 500, headers }
    );
  }
});

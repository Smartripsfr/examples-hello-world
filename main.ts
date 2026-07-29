Deno.serve(async (req) => {
  const { searchParams } = new URL(req.url);
  const targetUrl = searchParams.get("url");

  if (!targetUrl) {
    return json({ error: "Le paramètre 'url' est manquant" }, 400);
  }

  try {
    // 1. On garde l'URL telle quelle.
    //    (hl=fr est un paramètre Google, inutile/nuisible pour Airbnb.)
    //    Si tu veux forcer la langue Google, décommente les 2 lignes ci-dessous
    //    uniquement quand l'hôte est google.*
    const urlObj = new URL(targetUrl);
    if (urlObj.hostname.includes("google.")) {
      urlObj.searchParams.set("hl", "fr");
    }

    // 2. Fetch avec un User-Agent de bot d'aperçu social.
    //    Les sites (Airbnb, etc.) laissent souvent passer ces bots pour
    //    qu'ils récupèrent les balises og:, là où un UA "navigateur" depuis
    //    une IP datacenter se fait bloquer.
    const res = await fetch(urlObj.toString(), {
      headers: {
        "user-agent":
          "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        "accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "fr-FR,fr;q=0.9",
        // Cookie de consentement pour éviter les écrans RGPD Google
        "cookie": "CONSENT=YES+cb.20240117-07-p0.fr+FX+901;",
      },
      redirect: "follow",
    });

    const html = await res.text();

    // ---- DIAGNOSTIC : à regarder dans les logs Deno Deploy ----
    console.log("target:", urlObj.toString());
    console.log("status:", res.status);
    console.log("content-type:", res.headers.get("content-type"));
    console.log("html length:", html.length);
    console.log("snippet:", html.slice(0, 500));
    // ------------------------------------------------------------

    const metadata = parseHtml(html, targetUrl);

    // On expose le statut HTTP dans la réponse pour debug côté client
    metadata._status = res.status;

    return json(metadata);
  } catch (err) {
    return json(
      { error: "Impossible de récupérer l'URL", details: err.message },
      500
    );
  }
});

/* -------------------- Helpers -------------------- */

function parseHtml(html: string, originalUrl: string) {
  const metadata: Record<string, any> = {
    url: originalUrl,
    title: "",
  };

  // 1. Extraction du titre <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    metadata.title = titleMatch[1].trim();
  }

  // 2. Extraction de tous les meta tags
  const metaTagRegex = /<meta\s+([^>]+)>/gi;

  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = metaTagRegex.exec(html))) {
    const attrs: Record<string, string> = {};

    // Important : recréer le regex à chaque tag pour repartir de lastIndex = 0
    const attrRegex = /([a-zA-Z0-9:_-]+)\s*=\s*["']([^"']*)["']/gi;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(tagMatch[1]))) {
      attrs[attrMatch[1].toLowerCase()] = attrMatch[2];
    }

    const key =
      attrs.name ||
      attrs.property ||
      attrs.itemprop ||
      attrs["http-equiv"];

    const content = attrs.content;

    if (key && content !== undefined) {
      if (metadata[key]) {
        if (Array.isArray(metadata[key])) {
          metadata[key].push(content);
        } else {
          metadata[key] = [metadata[key], content];
        }
      } else {
        metadata[key] = content;
      }
    } else if (attrs.charset) {
      metadata["charset"] = attrs.charset;
    }
  }

  return metadata;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

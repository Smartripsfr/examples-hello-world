Deno.serve(async (req) => {
  const { searchParams } = new URL(req.url);
  const targetUrl = searchParams.get("url");

  if (!targetUrl) {
    return json({ error: "Le paramètre 'url' est manquant" }, 400);
  }

  try {
    // 1. On prépare l'URL pour forcer le français (hl=fr)
    const urlObj = new URL(targetUrl);
    urlObj.searchParams.set("hl", "fr");

    // 2. Fetch avec Headers pour simuler Safari iPhone
    const res = await fetch(urlObj.toString(), {
      headers: {
        // User-agent Safari iPhone
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
          "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
          "Version/17.0 Mobile/15E148 Safari/604.1",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "fr-FR,fr;q=0.9",
        // Cookie de consentement pour éviter les écrans RGPD Google
        "cookie": "CONSENT=YES+cb.20240117-07-p0.fr+FX+901;",
      },
      redirect: "follow",
    });

    const html = await res.text();
    const metadata = parseHtml(html, targetUrl);

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
  const attrRegex = /([a-zA-Z0-9:_-]+)\s*=\s*["']([^"']*)["']/gi;

  let tagMatch;
  while ((tagMatch = metaTagRegex.exec(html))) {
    const attrs: Record<string, string> = {};
    let attrMatch;

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

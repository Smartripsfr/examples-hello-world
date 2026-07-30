// meta-scraper.ts
// Récupère le <title> et les meta tags (OG, Twitter, itemprop, etc.) d'une page.
// Essaie plusieurs user-agents dans l'ordre et garde le premier qui renvoie
// une page exploitable (statut 2xx + présence de balises <meta>).
//
// Lancer :  deno run --allow-net meta-scraper.ts
// Appeler : http://localhost:8000/?url=https://exemple.com/page

const USER_AGENTS = [
  // Crawler social : le plus souvent whitelisté pour servir les OG tags
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Twitterbot/1.0",
  // Navigateur desktop réaliste en dernier recours
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
];

const TIMEOUT_MS = 10_000;

Deno.serve(async (req) => {
  const { searchParams } = new URL(req.url);
  const targetUrl = searchParams.get("url");

  if (!targetUrl) {
    return json({ error: "Le paramètre 'url' est manquant" }, 400);
  }

  // Validation de l'URL fournie
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
      // Aucun UA n'a donné une page exploitable : on renvoie le dernier
      // essai pour diagnostiquer (403 Cloudflare, challenge JS, etc.)
      return json(
        {
          error: "Aucun user-agent n'a permis de récupérer une page exploitable",
          url: targetUrl,
          lastAttempt: result.last,
        },
        502,
      );
    }

    const metadata = parseHtml(result.html, targetUrl);
    metadata.jsonLd = extractJsonLd(result.html);
    metadata._debug = {
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

async function fetchWithFallback(url: string): Promise<FetchOk | FetchFail> {
  let last: FetchFail["last"] = null;

  for (const ua of USER_AGENTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": ua,
          "accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "fr-FR,fr;q=0.9",
        },
        redirect: "follow",
        signal: controller.signal,
      });

      const html = await res.text();
      last = { status: res.status, snippet: html.slice(0, 300), userAgent: ua };

      // On garde la réponse si le statut est OK et qu'on voit des balises meta
      if (res.ok && /<meta\b/i.test(html)) {
        return {
          ok: true,
          html,
          userAgent: ua,
          status: res.status,
          finalUrl: res.url,
        };
      }
    } catch (err) {
      last = { status: 0, snippet: `fetch error: ${(err as Error).message}`, userAgent: ua };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, last };
}

/* -------------------- Parsing -------------------- */

function parseHtml(html: string, originalUrl: string) {
  const metadata: Record<string, unknown> = { url: originalUrl, title: "" };

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    metadata.title = decodeEntities(titleMatch[1].trim());
  }

  const metaTagRegex = /<meta\b([^>]*)>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = metaTagRegex.exec(html))) {
    const attrs = parseAttributes(tagMatch[1]);
    const key =
      attrs.name || attrs.property || attrs.itemprop || attrs["http-equiv"];
    const content = attrs.content;

    if (key && content !== undefined) {
      const value = decodeEntities(content);
      const existing = metadata[key];
      if (existing !== undefined) {
        metadata[key] = Array.isArray(existing)
          ? [...existing, value]
          : [existing, value];
      } else {
        metadata[key] = value;
      }
    } else if (attrs.charset) {
      metadata.charset = attrs.charset;
    }
  }

  return metadata;
}

// Gère les valeurs entre guillemets doubles, simples, ou sans guillemets.
function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex =
    /([a-zA-Z0-9:_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(raw))) {
    if (!m[1]) continue;
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

// Extraction bonus des blocs JSON-LD (prix, note, avis sur GetYourGuide).
function extractJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
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

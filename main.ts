import { DOMParser, Element } from "jsr:@b-fuze/deno-dom";

// Petite fonction delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const getMeta = async (url: string) => {
try {
// 🧼 Nettoyage des paramètres inutiles
const cleanedUrl = (() => {
try {
const u = new URL(url);
const paramsToDelete = ["aid", "label", "sid", "all_sr_blocks"];
for (const param of paramsToDelete) {
if (u.searchParams.has(param)) {
u.searchParams.delete(param);
}
}
console.log("✅ Cleaned URL:", u.toString());
return u.toString();
} catch (err) {
console.log("❌ URL cleanup failed:", err.message);
return url;
}
})();

const res = await fetch(cleanedUrl, {
headers: {
"accept": "text/html,application/xhtml+xml,application/xml",
"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

}
});

const html = await res.text();
const doc = new DOMParser().parseFromString(html, "text/html");
if (!doc) return { error: "HTML parsing failed" };

const result: Record<string, string> = {};
const metaTags = doc.querySelectorAll("meta") as Element[];

for (const tag of metaTags) {
const name = tag.getAttribute("name");
const property = tag.getAttribute("property");
const content = tag.getAttribute("content");
if (content) {
if (name) result[name] = content;
if (property) result[property] = content;
}
}

const title = doc.querySelector("title")?.textContent;
if (title) result.title = title;

// ✅ Ajout de og:url si non présent
if (!result["og:url"]) {
result["og:url"] = cleanedUrl;
}

return result;

return result;
} catch (e) {
return { error: e.message };
}
};

Deno.serve(async (req: Request): Promise<Response> => {
const url = new URL(req.url);
const target = url.searchParams.get("url");

if (!target) {
return new Response(JSON.stringify({ error: "Missing ?url param" }), {
status: 400,
headers: corsHeaders()
});
}

const meta = await getMeta(target);

return new Response(JSON.stringify(meta), {
status: 200,
headers: corsHeaders()
});
});

function corsHeaders(): Headers {
return new Headers({
"Content-Type": "application/json",
"Access-Control-Allow-Origin": "*"
});
}


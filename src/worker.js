// Caching proxy in front of the city's map and search servers (axiomgis.com).
// The city throttles clients that ask for many tiles or searches, and it answers a throttled request with HTTP 200 and an
// error body or an empty list. Good answers are cached here so each tile or search reaches the city once. Bad answers are
// never cached.
const ORIGIN = "https://www.axiomgis.com";
const ENTITIES = /^(PvWebUkopani|V_WEB_UKOPANI|V_WEB_GROBLJA)$/;
const TTL = { tile: 86400, search: 3600, list: 86400 };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

    if (url.pathname === "/tiles/ats" || url.pathname === "/tiles/wms") {
      if (url.searchParams.get("MAPSID") !== "ZagrebG") return new Response("Bad request", { status: 400 });
      const path = url.pathname === "/tiles/ats" ? "ats.ashx" : "wms.ashx";
      return proxy(req, ctx, `${ORIGIN}/${path}${url.search}`, "image", TTL.tile);
    }
    if (url.pathname.startsWith("/api/")) {
      const entity = url.pathname.slice(5);
      if (!ENTITIES.test(entity)) return new Response("Bad request", { status: 400 });
      return proxy(req, ctx, `${ORIGIN}/Zagreb/Trazilica.svc/${entity}${url.search}`, "json", entity === "V_WEB_GROBLJA" ? TTL.list : TTL.search);
    }
    return env.ASSETS.fetch(req);
  },
};

async function proxy(req, ctx, target, kind, ttl) {
  const cache = caches.default;
  const key = new Request(new URL(req.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) { const r = new Response(hit.body, hit); r.headers.set("X-Proxy-Cache", "HIT"); return r; }

  let up;
  try {
    up = await fetch(target, { headers: { Accept: req.headers.get("Accept") || "*/*", "User-Agent": "zagreb-groblja caching proxy" } });
  } catch {
    return new Response("Upstream unreachable", { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  const type = up.headers.get("Content-Type") || "";
  const body = await up.arrayBuffer();
  let good = up.ok;
  if (kind === "image") good = good && type.startsWith("image/");
  else {
    const text = new TextDecoder().decode(body);
    good = good && !text.includes('"odata.error"') && !/"value":\s*\[\s*\]/.test(text); // throttled searches come back empty
  }

  const headers = new Headers({
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": good ? `public, max-age=${ttl}` : "no-store",
    "X-Proxy-Cache": "MISS",
  });
  // A refused tile must look like a failure to the browser, so it retries. JSON errors pass through for the app to read.
  const status = kind === "image" && !good ? 502 : 200;
  const res = new Response(body, { status, headers });
  if (good) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

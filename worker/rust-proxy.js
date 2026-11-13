// MallowCord's source of truth is Cloudflare D1. The Rust service currently
// authenticates against its own Postgres session store, which is not shared
// with the Worker-created D1 sessions. Keep app API requests on the Worker
// until Rust is migrated to use the same D1-backed identity/session layer.
const RUST_ROUTES = [];

export function shouldProxyRustApi(path, method) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  return RUST_ROUTES.some(
    ([allowedMethod, pattern]) => allowedMethod === normalizedMethod && pattern.test(path),
  );
}

export async function proxyToRust(request, env) {
  const origin = String(env.RUST_API_ORIGIN || "").trim();
  const incoming = new URL(request.url);
  if (!origin || !shouldProxyRustApi(incoming.pathname, request.method)) return null;

  try {
    const base = new URL(origin);
    const localDevelopment = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
    if (
      (base.protocol !== "https:" && !(localDevelopment && base.protocol === "http:")) ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      base.username ||
      base.password
    ) {
      throw new Error("RUST_API_ORIGIN must be an HTTPS origin without a path.");
    }

    const target = new URL(incoming.pathname + incoming.search, base);
    const forwarded = new Request(target.toString(), request);
    forwarded.headers.delete("x-mallowcord-client-ip");
    const clientIp = request.headers.get("cf-connecting-ip");
    if (clientIp) forwarded.headers.set("x-mallowcord-client-ip", clientIp);
    return await fetch(forwarded);
  } catch (error) {
    console.error("MallowCord Rust API proxy failed", incoming.pathname, error);
    return new Response(JSON.stringify({ error: "rust_backend_unavailable" }), {
      status: 502,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
}

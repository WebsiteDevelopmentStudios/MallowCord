const RUST_ROUTES = [
  ["GET", /^\/api\/auth\/me$/],
  ["POST", /^\/api\/auth\/logout$/],
  ["GET", /^\/api\/account\/status$/],
  ["GET", /^\/api\/account\/profile$/],
  ["POST", /^\/api\/account\/profile$/],
  ["GET", /^\/api\/account\/preferences$/],
  ["POST", /^\/api\/account\/preferences$/],
  ["POST", /^\/api\/presence\/heartbeat$/],
  ["GET", /^\/api\/servers$/],
  ["GET", /^\/api\/servers\/[^/]+\/(?:channels|roles|members|settings|stats|sections)$/],
  ["POST", /^\/api\/servers\/[^/]+\/(?:channels|roles|sections)$/],
  ["POST", /^\/api\/servers\/[^/]+\/roles\/[^/]+$/],
  ["DELETE", /^\/api\/servers\/[^/]+\/roles\/[^/]+$/],
  ["POST", /^\/api\/servers\/[^/]+\/members\/[^/]+\/roles$/],
  ["POST", /^\/api\/servers\/[^/]+\/settings$/],
  ["PATCH", /^\/api\/servers\/[^/]+\/sections\/[^/]+$/],
  ["DELETE", /^\/api\/servers\/[^/]+\/sections\/[^/]+$/],
  ["GET", /^\/api\/channels\/[^/]+\/permissions$/],
  ["POST", /^\/api\/channels\/[^/]+\/permissions$/],
  ["DELETE", /^\/api\/channels\/[^/]+\/permissions$/],
  ["GET", /^\/api\/channels\/[^/]+\/messages$/],
  ["POST", /^\/api\/channels\/[^/]+\/messages$/],
  ["POST", /^\/api\/channels\/[^/]+\/attachments$/],
  ["GET", /^\/api\/attachments\/[^/]+$/],
  ["DELETE", /^\/api\/attachments\/[^/]+$/],
  ["POST", /^\/api\/messages\/[^/]+\/edit$/],
  ["POST", /^\/api\/messages\/[^/]+\/reactions$/],
  ["POST", /^\/api\/messages\/[^/]+\/forward$/],
  ["DELETE", /^\/api\/messages\/[^/]+$/],
  ["GET", /^\/api\/friends$/],
  ["POST", /^\/api\/friends\/request$/],
  ["POST", /^\/api\/friends\/[^/]+\/[^/]+$/],
  ["GET", /^\/api\/dms$/],
  ["POST", /^\/api\/dms\/open$/],
  ["GET", /^\/api\/dms\/[^/]+\/messages$/],
  ["POST", /^\/api\/dms\/[^/]+\/messages$/],
  ["GET", /^\/api\/realtime$/],
  ["GET", /^\/api\/notifications$/],
  ["POST", /^\/api\/notifications\/(?:read|clear)$/],
  ["GET", /^\/api\/notification-settings$/],
  ["POST", /^\/api\/notification-settings$/],
  ["POST", /^\/api\/integrations\/mallowbot\/discord\/sync$/],
  ["POST", /^\/api\/integrations\/mallowbot\/discord\/presence$/],
  ["POST", /^\/api\/integrations\/mallowbot\/discord\/messages$/],
  ["POST", /^\/api\/integrations\/mallowbot\/discord\/link\/claim$/],
  ["GET", /^\/api\/integrations\/mallowbot\/discord\/commands\/next$/],
  ["POST", /^\/api\/integrations\/mallowbot\/discord\/commands\/result$/],
  ["GET", /^\/api\/integrations\/mallowbot\/discord\/outbox$/],
  ["POST", /^\/api\/integrations\/mallowbot\/discord\/outbox\/[^/]+\/ack$/],
  ["GET", /^\/api\/integrations\/mallowbot\/users$/],
  ["POST", /^\/api\/integrations\/mallowbot\/users\/[^/]+\/(?:timeout|ban|unban|delete)$/],
  ["POST", /^\/api\/admin\/ip-ban$/],
  ["GET", /^\/api\/admin\/audit$/],
];

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

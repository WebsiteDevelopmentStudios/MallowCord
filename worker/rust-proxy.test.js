import assert from "node:assert/strict";
import test from "node:test";

import { proxyToRust, shouldProxyRustApi } from "./rust-proxy.js";

test("proxies API domains already implemented in Rust", () => {
  const cases = [
    ["GET", "/api/auth/me"],
    ["GET", "/api/auth/google"],
    ["GET", "/api/auth/google/callback"],
    ["GET", "/api/auth/discord"],
    ["GET", "/api/auth/discord/callback"],
    ["POST", "/api/auth/logout"],
    ["POST", "/api/auth/exchange"],
    ["POST", "/api/auth/username"],
    ["POST", "/api/account/contact/request"],
    ["POST", "/api/account/contact/confirm"],
    ["GET", "/api/discord/link/status"],
    ["POST", "/api/discord/link/start"],
    ["POST", "/api/bot/command"],
    ["GET", "/api/account/status"],
    ["POST", "/api/account/profile"],
    ["GET", "/api/servers"],
    ["POST", "/api/servers"],
    ["GET", "/api/servers/server-1/channels"],
    ["GET", "/api/servers/server-1/onboarding"],
    ["POST", "/api/servers/server-1/onboarding"],
    ["GET", "/api/servers/server-1/emojis"],
    ["POST", "/api/servers/server-1/emojis"],
    ["DELETE", "/api/servers/server-1/emojis/emoji-1"],
    ["PATCH", "/api/servers/server-1/sections/section-1"],
    ["POST", "/api/channels/channel-1/messages"],
    ["POST", "/api/messages/message-1/reactions"],
    ["GET", "/api/dms/conversation-1/messages"],
    ["POST", "/api/channels/channel-1/attachments"],
    ["GET", "/api/public/avatars/user-1"],
    ["GET", "/api/realtime"],
    ["GET", "/api/notifications"],
    ["GET", "/api/users/user-1/profile"],
    ["POST", "/api/integrations/mallowbot/discord/sync"],
    ["POST", "/api/integrations/mallowbot/discord/presence"],
    ["POST", "/api/integrations/mallowbot/discord/messages"],
    ["POST", "/api/integrations/mallowbot/discord/link/claim"],
    ["GET", "/api/integrations/mallowbot/discord/commands/next"],
    ["POST", "/api/integrations/mallowbot/discord/commands/result"],
    ["GET", "/api/integrations/mallowbot/discord/outbox"],
    ["POST", "/api/integrations/mallowbot/discord/outbox/outbox-1/ack"],
    ["GET", "/api/integrations/mallowbot/users"],
    ["POST", "/api/integrations/mallowbot/users/user-1/timeout"],
    ["POST", "/api/integrations/mallowbot/users/user-2/ban"],
    ["POST", "/api/integrations/mallowbot/users/user-3/unban"],
    ["POST", "/api/integrations/mallowbot/users/user-4/delete"],
    ["POST", "/api/admin/ip-ban"],
    ["GET", "/api/admin/audit"],
    ["GET", "/api/admin/errors"],
    ["DELETE", "/api/admin/errors"],
  ];

  for (const [method, path] of cases) {
    assert.equal(shouldProxyRustApi(path, method), true, `${method} ${path}`);
  }
});

test("keeps unported and unsupported routes on the Worker", () => {
  const cases = [
    ["GET", "/api/auth/google/token"],
    ["POST", "/api/auth/discord/callback"],
    ["GET", "/api/servers/server-1/invites"],
    ["GET", "/api/messages/message-1/reactions"],
    ["PUT", "/api/account/profile"],
  ];

  for (const [method, path] of cases) {
    assert.equal(shouldProxyRustApi(path, method), false, `${method} ${path}`);
  }
});


test("Rust proxy stays disabled until an origin is configured", async () => {
  const request = new Request("https://api.example.com/api/auth/me");
  assert.equal(await proxyToRust(request, {}), null);
});

test("Rust proxy forwards the existing cookie, body, and query string", async () => {
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (request) => {
    forwarded = request;
    return new Response("proxied", { status: 200 });
  };

  try {
    const body = JSON.stringify({ display_name: "Mallow" });
    const request = new Request(
      "https://api.example.com/api/account/profile?from=web",
      {
        method: "POST",
        headers: {
          cookie: "mallowcord_device=test-session",
          "cf-connecting-ip": "203.0.113.10",
          "x-mallowcord-client-ip": "198.51.100.2",
          "content-type": "application/json",
        },
        body,
      },
    );
    const response = await proxyToRust(request, {
      RUST_API_ORIGIN: "https://rust.example.com",
    });

    assert.equal(response.status, 200);
    assert.equal(forwarded.url, "https://rust.example.com/api/account/profile?from=web");
    assert.equal(forwarded.headers.get("cookie"), "mallowcord_device=test-session");
    assert.equal(forwarded.headers.get("x-mallowcord-client-ip"), "203.0.113.10");
    assert.equal(await forwarded.text(), body);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

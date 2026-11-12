import assert from "node:assert/strict";
import test from "node:test";

import { shouldProxyRustApi } from "./rust-proxy.js";

test("proxies API domains already implemented in Rust", () => {
  const cases = [
    ["GET", "/api/auth/me"],
    ["POST", "/api/auth/logout"],
    ["GET", "/api/account/status"],
    ["POST", "/api/account/profile"],
    ["GET", "/api/servers"],
    ["GET", "/api/servers/server-1/channels"],
    ["PATCH", "/api/servers/server-1/sections/section-1"],
    ["POST", "/api/channels/channel-1/messages"],
    ["POST", "/api/messages/message-1/reactions"],
    ["GET", "/api/dms/conversation-1/messages"],
    ["POST", "/api/channels/channel-1/attachments"],
    ["GET", "/api/notifications"],
    ["GET", "/api/admin/audit"],
  ];

  for (const [method, path] of cases) {
    assert.equal(shouldProxyRustApi(path, method), true, `${method} ${path}`);
  }
});

test("keeps unported and unsupported routes on the Worker", () => {
  const cases = [
    ["GET", "/api/auth/google"],
    ["GET", "/api/auth/discord/callback"],
    ["POST", "/api/auth/exchange"],
    ["POST", "/api/integrations/mallowbot/discord/sync"],
    ["POST", "/api/account/contact/request"],
    ["POST", "/api/admin/ip-ban"],
    ["POST", "/api/servers"],
    ["GET", "/api/servers/server-1/invites"],
    ["GET", "/api/messages/message-1/reactions"],
    ["PUT", "/api/account/profile"],
  ];

  for (const [method, path] of cases) {
    assert.equal(shouldProxyRustApi(path, method), false, `${method} ${path}`);
  }
});

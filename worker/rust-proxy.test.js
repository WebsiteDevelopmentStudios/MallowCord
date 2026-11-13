import assert from "node:assert/strict";
import test from "node:test";

import { proxyToRust, shouldProxyRustApi } from "./rust-proxy.js";

test("keeps D1-backed authenticated application routes on the Worker", () => {
  const cases = [
    ["GET", "/api/auth/me"],
    ["POST", "/api/auth/exchange"],
    ["GET", "/api/account/profile"],
    ["POST", "/api/account/profile"],
    ["GET", "/api/account/preferences"],
    ["POST", "/api/account/preferences"],
    ["GET", "/api/account/status"],
    ["POST", "/api/presence/heartbeat"],
    ["GET", "/api/servers"],
    ["GET", "/api/servers/server-1/channels"],
    ["GET", "/api/servers/server-1/members"],
    ["GET", "/api/channels/channel-1/messages"],
    ["GET", "/api/dms"],
    ["GET", "/api/friends"],
    ["GET", "/api/realtime"],
    ["GET", "/api/notifications"],
  ];

  for (const [method, path] of cases) {
    assert.equal(shouldProxyRustApi(path, method), false, `${method} ${path}`);
  }
});

test("does not proxy any request to a separate Postgres session store", async () => {
  const request = new Request("https://api.example.com/api/servers");
  assert.equal(await proxyToRust(request, {
    RUST_API_ORIGIN: "https://rust.example.com",
  }), null);
});

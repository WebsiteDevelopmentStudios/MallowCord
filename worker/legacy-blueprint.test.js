import test from "node:test";
import assert from "node:assert/strict";
import { LEGACY_MALLOW_SWAMP as blueprint } from "./legacy-blueprint.js";

test("legacy Mallow Swamp blueprint contains the recovered server structure", () => {
  assert.equal(blueprint.serverName, "Mallow Swamp");
  assert.equal(blueprint.roles.length, 70);
  assert.equal(blueprint.channels.length, 34);
  assert.equal(blueprint.categories.length, 10);
  assert.equal(blueprint.permissions.length, 117);
});

test("all permission targets resolve to reconstructed channels and roles", () => {
  const roleNames = new Set(blueprint.roles.map((role) => role.name));
  const channelNames = new Set(blueprint.channels.map((channel) => channel.name));
  for (const permission of blueprint.permissions) {
    assert.equal(permission.targetType, "role");
    assert.ok(roleNames.has(permission.targetRole), `Unknown role: ${permission.targetRole}`);
    assert.ok(channelNames.has(permission.channel), `Unknown channel: ${permission.channel}`);
    assert.ok(Array.isArray(permission.allow));
    assert.ok(Array.isArray(permission.deny));
  }
});

test("the blueprint contains no legacy database identifiers or member data", () => {
  for (const role of blueprint.roles) assert.equal("legacyId" in role, false);
  for (const channel of blueprint.channels) assert.equal("legacyId" in channel, false);
  assert.equal("users" in blueprint, false);
  assert.equal("messages" in blueprint, false);
  assert.equal("sessions" in blueprint, false);
});

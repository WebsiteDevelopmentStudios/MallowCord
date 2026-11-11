import test from "node:test";
import assert from "node:assert/strict";
import { convertPlaceholders, translateSql } from "./postgres-adapter.js";

test("converts D1 positional placeholders without changing quoted question marks", () => {
  assert.equal(convertPlaceholders("SELECT '?' AS literal, value FROM sample WHERE id=? AND note=\"?\" AND owner_id=?"),
    "SELECT '?' AS literal, value FROM sample WHERE id=$1 AND note=\"?\" AND owner_id=$2");
});

test("translates INSERT OR IGNORE to PostgreSQL conflict handling", () => {
  assert.equal(translateSql("INSERT OR IGNORE INTO memberships(server_id,user_id,joined_at) VALUES(?,?,?)"),
    "INSERT INTO memberships(server_id,user_id,joined_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING");
});

test("translates SQLite JSON and aggregation helpers", () => {
  const sql = translateSql("SELECT COALESCE(json_extract(pref.settings_json,'$.privacy.showOnlineStatus'),1)=0, group_concat(r.name, ', '), json_group_array(json_object('id',r.id)) FROM roles r");
  assert.match(sql, /COALESCE\(\(pref\.settings_json::jsonb #>> '\{privacy,showOnlineStatus\}'\)::boolean, true\)=false/);
  assert.match(sql, /string_agg\(r\.name, ', '\)/);
  assert.match(sql, /json_agg\(json_build_object\(/);
});

test("translates the one SQLite INSERT OR REPLACE statement", () => {
  assert.equal(translateSql("INSERT OR REPLACE INTO onboarding_completions(server_id,user_id,completed_at) VALUES(?,?,?)"),
    "INSERT INTO onboarding_completions(server_id,user_id,completed_at) VALUES($1,$2,$3) ON CONFLICT (server_id,user_id) DO UPDATE SET user_id=EXCLUDED.user_id,completed_at=EXCLUDED.completed_at");
});

import postgres from "postgres";

const clients = new WeakMap();

function convertPlaceholders(sql) {
  let out = "", quote = null, index = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i], next = sql[i + 1];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (next === quote) { out += next; i++; }
        else quote = null;
      } else if (ch === "\\" && quote !== "'") {
        if (next) { out += next; i++; }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch === "`" ? '"' : ch; out += quote; continue; }
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      if (end < 0) { out += sql.slice(i); break; }
      out += sql.slice(i, end + 1); i = end; continue;
    }
    if (ch === "?") { out += "$" + (++index); continue; }
    out += ch;
  }
  return out;
}

function translateSql(input) {
  let sql = String(input).trim().replace(/;\s*$/, "");
  const ignore = /^INSERT\s+OR\s+IGNORE\s+INTO\s+/i.test(sql);
  const replace = /^INSERT\s+OR\s+REPLACE\s+INTO\s+/i.test(sql);
  sql = sql.replace(/^INSERT\s+OR\s+(?:IGNORE|REPLACE)\s+INTO\s+/i, "INSERT INTO ");

  // SQLite JSON helpers used by member/profile responses.
  sql = sql.replace(/COALESCE\(json_extract\(pref\.settings_json,\s*'\$\.privacy\.showOnlineStatus'\),\s*1\)\s*=\s*0/gi,
    "COALESCE((pref.settings_json::jsonb #>> '{privacy,showOnlineStatus}')::boolean, true)=false");
  sql = sql.replace(/group_concat\(r\.name,\s*',\s*'\)/gi, "string_agg(r.name, ', ')");
  sql = sql.replace(/json_group_array\(json_object\(/gi, "json_agg(json_build_object(");

  if (ignore && !/\bON\s+CONFLICT\b/i.test(sql)) sql += " ON CONFLICT DO NOTHING";
  if (replace) {
    const m = sql.match(/^INSERT INTO\s+([\w"]+)\s*\(([^)]+)\)\s*VALUES\s*\(/i);
    if (m) {
      const cols = m[2].split(",").map(x => x.trim());
      const updates = cols.slice(1).map(col => `${col}=EXCLUDED.${col}`).join(",");
      sql += ` ON CONFLICT DO UPDATE SET ${updates || `${cols[0]}=EXCLUDED.${cols[0]}`}`;
    }
  }
  return convertPlaceholders(sql);
}

function resultMeta(count) {
  return { success: true, meta: { changes: Number(count || 0) } };
}

export function getDatabase(env) {
  if (env.MALLOWCORD_DB_BACKEND !== "neon") return env.DB;
  if (!env.NEON?.connectionString) throw new Error("Neon Hyperdrive binding NEON is not configured.");
  let client = clients.get(env);
  if (!client) {
    const sql = postgres(env.NEON.connectionString, {
      max: 5,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
      fetch_types: false,
      onnotice: () => {}
    });
    client = {
      prepare(statement) {
        let query = statement;
        let values = [];
        const bound = {
          get query() { return query; },
          get values() { return values; },
          bind(...args) { values = args; return bound; },
          async first(column) {
            const rows = await sql.unsafe(translateSql(query), values);
            const row = rows[0] || null;
            return column && row ? row[column] : row;
          },
          async all() {
            const rows = await sql.unsafe(translateSql(query), values);
            return { results: rows, success: true, meta: { changes: Number(rows.count || 0), duration: 0 } };
          },
          async run() {
            const rows = await sql.unsafe(translateSql(query), values);
            return resultMeta(rows.count);
          }
        };
        return bound;
      },
      async batch(statements) {
        return sql.begin(async tx => {
          const results = [];
          for (const statement of statements) {
            const query = statement?.query ?? statement?.sql ?? "";
            const values = statement?.values ?? [];
            const rows = await tx.unsafe(translateSql(query), values);
            results.push(resultMeta(rows.count));
          }
          return results;
        });
      }
    };
    clients.set(env, client);
  }
  return client;
}

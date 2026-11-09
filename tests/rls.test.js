import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sqlPath = new URL("../supabase/workout_snapshots.sql", import.meta.url);

test("Supabase schema enables RLS and defines owner-only CRUD policies", async () => {
  const sql = (await readFile(sqlPath, "utf8")).toLowerCase().replace(/\s+/g, " ");
  assert.match(sql, /alter table public\.workout_snapshots enable row level security/);
  for (const operation of ["select", "insert", "update", "delete"]) {
    assert.match(sql, new RegExp(`create policy [\\s\\S]*? for ${operation} to authenticated`));
  }
  const ownerGuard = /\(select auth\.uid\(\)\) = user_id/g;
  assert.ok((sql.match(ownerGuard) ?? []).length >= 5, "each USING/WITH CHECK must explicitly require an authenticated owner");
  assert.doesNotMatch(sql, /service_role/);
});

test("cloud table uses one optimistic-revision snapshot per auth user", async () => {
  const sql = await readFile(sqlPath, "utf8");
  assert.match(sql, /user_id uuid primary key references auth\.users\(id\) on delete cascade/i);
  assert.match(sql, /snapshot jsonb not null/i);
  assert.match(sql, /revision bigint not null/i);
  assert.match(sql, /updated_at timestamptz not null/i);
});

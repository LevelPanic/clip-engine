// The engine's SQLite databases (library/jobs.sqlite, reviews.sqlite, tracking.sqlite) are shared by
// the Studio and several daemons at once, so every one opens the same way: WAL, and a 5 s wait on a
// busy write instead of an error. Node only.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Open (or create) a database file in WAL mode with a 5 s busy wait. */
export function openDatabase(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return db;
}

/** Add the columns a table does not have yet: a migration that is safe to run on every open. Returns the ones added. */
export function addColumns(db: DatabaseSync, table: string, columns: Record<string, string>): string[] {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  const added: string[] = [];
  for (const [name, def] of Object.entries(columns)) {
    if (have.has(name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    added.push(name);
  }
  return added;
}

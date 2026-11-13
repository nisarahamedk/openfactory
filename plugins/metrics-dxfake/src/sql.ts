import { DxError, type Cell, type DxStore, type Row } from "./store.js";

/**
 * A deliberately tiny SQL dialect, enough to behave like DX custom tables for the
 * factory's needs. Only `custom.*` tables. Values are bound with $1, $2 ... params.
 *
 *   INSERT INTO custom.t (a, b) VALUES ($1, $2) [, ($3, $4)] ON CONFLICT (a) DO UPDATE
 *   SELECT * | a, b FROM custom.t [WHERE col = $1 [AND col2 = $2]] [ORDER BY col [ASC|DESC]] [LIMIT n]
 *
 * Anything else is rejected with a 400, so callers find out early that real DX
 * needs real SQL.
 */
export type SqlResult = { kind: "write"; inserted: number; updated: number } | { kind: "rows"; columns: string[]; rows: Row[] };

const IDENT = String.raw`[a-z_][a-z0-9_]*`;
const INSERT = new RegExp(
  String.raw`^insert\s+into\s+custom\.(${IDENT})\s*\(([^)]*)\)\s*values\s*(.+?)\s*(?:on\s+conflict\s*\(([^)]*)\)\s*do\s+update)?\s*;?$`,
  "is",
);
const SELECT = new RegExp(
  String.raw`^select\s+(.+?)\s+from\s+custom\.(${IDENT})(?:\s+where\s+(.+?))?(?:\s+order\s+by\s+(${IDENT})(?:\s+(asc|desc))?)?(?:\s+limit\s+(\d+))?\s*;?$`,
  "is",
);

function list(s: string): string[] {
  return s.split(",").map((x) => x.trim().toLowerCase()).filter((x) => x.length > 0);
}

function param(token: string, params: readonly Cell[]): Cell {
  const m = /^\$(\d+)$/.exec(token.trim());
  if (m === null) throw new DxError(400, `only $n parameters are allowed as values, got "${token.trim()}"`);
  const v = params[Number(m[1]) - 1];
  if (v === undefined) throw new DxError(400, `missing parameter ${token.trim()}`);
  return v;
}

/** Run one statement against the store. */
export function execSql(store: DxStore, sql: string, params: readonly Cell[]): SqlResult {
  const text = sql.trim();
  const ins = INSERT.exec(text);
  if (ins !== null) {
    const [, table = "", colText = "", valuesText = "", conflictText] = ins;
    const cols = list(colText);
    const tuples = [...valuesText.matchAll(/\(([^)]*)\)/g)].map((m) => (m[1] ?? "").split(","));
    if (tuples.length === 0) throw new DxError(400, "VALUES needs at least one tuple");
    const rows = tuples.map((t) => {
      if (t.length !== cols.length) throw new DxError(400, `expected ${cols.length} values, got ${t.length}`);
      return Object.fromEntries(cols.map((c, i) => [c, param(t[i] ?? "", params)]));
    });
    const key = conflictText === undefined ? cols : list(conflictText);
    return { kind: "write", ...store.upsert(table, key, rows) };
  }

  const sel = SELECT.exec(text);
  if (sel !== null) {
    const [, colText = "*", table = "", where, orderBy, dir, limit] = sel;
    let rows = store.rows(table);
    if (where !== undefined) {
      const conds = where.split(/\s+and\s+/i).map((c) => {
        const m = new RegExp(String.raw`^(${IDENT})\s*=\s*(\$\d+)$`, "i").exec(c.trim());
        if (m === null) throw new DxError(400, `only "col = $n" conditions joined by AND are supported, got "${c.trim()}"`);
        return { col: (m[1] ?? "").toLowerCase(), value: param(m[2] ?? "", params) };
      });
      rows = rows.filter((r) => conds.every((c) => r[c.col] === c.value));
    }
    if (orderBy !== undefined) {
      const sign = dir?.toLowerCase() === "desc" ? -1 : 1;
      const col = orderBy.toLowerCase();
      rows = [...rows].sort((a, b) => sign * compare(a[col] ?? null, b[col] ?? null));
    }
    if (limit !== undefined) rows = rows.slice(0, Number(limit));
    const columns = colText.trim() === "*" ? [...new Set(rows.flatMap((r) => Object.keys(r)))] : list(colText);
    return { kind: "rows", columns, rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))) };
  }

  throw new DxError(400, "unsupported statement: use INSERT INTO custom.<t> ... or SELECT ... FROM custom.<t>");
}

function compare(a: Cell, b: Cell): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/**
 * Result cells as text (Atlas data platform design 2026-10-18 §3.1, step 1.13). DuckDB-WASM returns
 * Arrow values: BIGINT as a JS bigint, HUGEINT (every integer `sum`) and DECIMAL as an Arrow BigNum
 * of unscaled digits, and lists, structs and maps as Arrow vectors and rows. Each is written exactly
 * (counts are evidence: `ac` and `an` never pass through a double); nested values become JSON whose
 * big integers and decimals are strings.
 */

/** apache-arrow's mark on its BigNum values (`util/bn`). */
const BIG_NUM = Symbol.for('isArrowBigNum');
/** apache-arrow `Type` ids of the types whose text depends on the column type. */
const DECIMAL = 7;
const STRUCT = 13;
const MAP = 17;

/** What a cell's text depends on in its Arrow `DataType`: a Decimal's scale, a nested type's fields. */
export interface CellType {
  readonly typeId: number;
  readonly scale?: number;
  readonly children?: readonly {
    readonly name: string;
    readonly type: CellType;
  }[];
}

/** `digits`, an unscaled integer, with `scale` digits after the decimal point. */
function scaled(digits: string, scale: number): string {
  if (scale <= 0) return digits;
  const sign = digits.startsWith('-') ? '-' : '';
  const magnitude = digits.slice(sign.length).padStart(scale + 1, '0');
  return `${sign}${magnitude.slice(0, -scale)}.${magnitude.slice(-scale)}`;
}

/** `value` as JSON-ready data, its big integers and decimals as exact strings. */
function plain(value: unknown, type: CellType | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (BIG_NUM in value)
    return scaled(
      String(value),
      type?.typeId === DECIMAL ? (type.scale ?? 0) : 0,
    );
  const fields = type?.children ?? [];
  if (type?.typeId === STRUCT) {
    // A StructRow iterates its fields as [name, value], in the type's order.
    const entries = [...(value as Iterable<[string, unknown]>)];
    return Object.fromEntries(
      entries.map(([name, item], index) => [
        name,
        plain(item, fields[index]?.type),
      ]),
    );
  }
  if (type?.typeId === MAP) {
    // A MapRow iterates [key, value]; its type holds one `entries` struct of key and value.
    const [key, item] = fields[0]?.type.children ?? [];
    return Object.fromEntries(
      [...(value as Iterable<[unknown, unknown]>)].map(([k, v]) => [
        String(plain(k, key?.type)),
        plain(v, item?.type),
      ]),
    );
  }
  if (Symbol.iterator in value)
    return Array.from(value as Iterable<unknown>, (item) =>
      plain(item, fields[0]?.type),
    );
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, plain(item, undefined)]),
  );
}

/** A result cell as text: `NULL` for a null, exact digits for big integers and decimals. */
export function formatCell(value: unknown, type?: CellType): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value !== 'object') return String(value);
  const data = plain(value, type);
  return typeof data === 'string' ? data : JSON.stringify(data);
}

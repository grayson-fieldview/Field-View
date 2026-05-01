// Cells beginning with these characters are interpreted as formulas by Excel,
// LibreOffice Calc, Google Sheets, etc. Prefix them with a single quote
// (the standard OWASP CSV-injection defense).
const FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function csvEscape(value: unknown): string {
  if (value == null) return "";
  let s = String(value);
  if (s.length > 0 && FORMULA_PREFIXES.has(s[0])) {
    s = `'${s}`;
  }
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsvRow(values: unknown[]): string {
  return values.map(csvEscape).join(",");
}

export function toCsv(rows: unknown[][]): string {
  return rows.map(toCsvRow).join("\r\n") + "\r\n";
}

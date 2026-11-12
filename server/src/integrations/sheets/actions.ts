import type { Context } from '../../engine/types.ts';
import { googleFetch } from '../google.ts';
import { withToken } from '../tokens.ts';

const valuesUrl = (id: string, range: string) =>
  `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`;

/** First row is the header; returns one object per following row. */
export async function readRows(config: Record<string, any>, _context: Context, userId?: string) {
  if (!config.spreadsheetId) throw new Error('Sheets node needs a spreadsheet ID');
  return withToken(userId, 'sheets', async (token) => {
    const res = await googleFetch(valuesUrl(config.spreadsheetId, config.range || 'Sheet1'), token);
    const [header = [], ...rows]: string[][] = res.values ?? [];
    return rows.map((r) => Object.fromEntries(header.map((h, i) => [h || `col${i + 1}`, r[i] ?? ''])));
  });
}

/** Accepts a 2D array, an array of objects (values in key order), or a JSON string of either. */
export function toRows(values: unknown): unknown[][] {
  const v = typeof values === 'string' ? JSON.parse(values) : values;
  if (!Array.isArray(v)) return [[v]];
  return v.map((row) => (Array.isArray(row) ? row : row && typeof row === 'object' ? Object.values(row) : [row]));
}

export async function writeRows(config: Record<string, any>, _context: Context, userId?: string) {
  if (!config.spreadsheetId) throw new Error('Sheets node needs a spreadsheet ID');
  const values = toRows(config.values);
  return withToken(userId, 'sheets', async (token) => {
    const res = await googleFetch(`${valuesUrl(config.spreadsheetId, config.range || 'Sheet1!A1')}?valueInputOption=USER_ENTERED`, token, {
      method: 'PUT',
      body: JSON.stringify({ values }),
    });
    return { updatedRange: res.updatedRange, updatedRows: res.updatedRows ?? values.length };
  });
}

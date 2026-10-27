import ExcelJS from "exceljs";

/**
 * Spreadsheet / CSV export helpers.
 *
 * Lifted out of salary.controller.js, where the CSV escaping, the BOM prefix and
 * the Content-Disposition pair were written inline and MONTHS was declared
 * a third time in the file. Twelve export endpoints in this expansion would each
 * have re-implemented them, and every one would have been subtly different.
 */

/** Excel's cap: a worksheet cannot exceed 1,048,576 rows. */
const MAX_EXCEL_ROWS = 1_048_576;

/**
 * Escape one CSV cell.
 *
 * A cell is quoted when it contains a comma, quote, or newline. Quotes are
 * doubled, which is RFC 4180. Without the doubling, a value like
 * `He said "hi"` produces a file Excel cannot parse — silently, so it shows up
 * as a mangled column rather than an error.
 */
export function escapeCsvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a full CSV string from a header row and data rows. */
export function buildCsv(headers = [], rows = []) {
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) lines.push(row.map(escapeCsvCell).join(","));
  return lines.join("\r\n");
}

/**
 * Send a CSV as a download.
 *
 * The leading U+FEFF BOM is what makes Excel read the file as UTF-8. Without it
 * Excel assumes the system codepage and mangles every Urdu string — this is a
 * Pakistani product with a full Urdu locale, so the BOM is not optional.
 */
export function sendCsv(res, { filename, headers, rows }) {
  const csv = buildCsv(headers, rows);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  // safeFilename, not the raw value: a quote or CRLF in a filename terminates
  // the Content-Disposition header early, which is response-header injection.
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(filename)}"`);
  return res.send("\uFEFF" + csv);
}

/** Strip characters that would break a Content-Disposition header. */
function safeFilename(name) {
  return String(name)
    .replace(/["\\\r\n]/g, "_")
    .slice(0, 120);
}

/**
 * Build an XLSX workbook as a Buffer.
 *
 * @param {Array<{name:string, headers:string[], rows:Array<Array<any>>, columnWidths?:number[]}>} sheets
 * @param {object} [opts] { creator, createdAt }
 */
export async function buildXlsx(sheets = [], opts = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = opts.creator || "Dverif";
  if (opts.createdAt) workbook.created = opts.createdAt;

  sheets.forEach((sheet, index) => {
    // Excel rejects these characters in a sheet name, and rejects duplicates.
    const name = safeFilename(sheet.name || `Sheet${index + 1}`).replace(/[\\/?*[\]:]/g, "-").slice(0, 31);
    const worksheet = workbook.addWorksheet(name);

    const headers = sheet.headers ?? [];
    if (headers.length) {
      const headerRow = worksheet.addRow(headers);
      headerRow.font = { bold: true };
      headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF2F7FF" },
      };
      // Freeze so a long report stays readable while scrolling.
      worksheet.views = [{ state: "frozen", ySplit: 1 }];
    }

    (sheet.rows ?? []).slice(0, MAX_EXCEL_ROWS).forEach((row) => worksheet.addRow(row));

    if (sheet.columnWidths?.length) {
      sheet.columnWidths.forEach((width, i) => {
        worksheet.getColumn(i + 1).width = width;
      });
    }

    // Autofilter makes an exported report sortable in Excel without any code.
    if (headers.length && (sheet.rows ?? []).length) {
      worksheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: headers.length },
      };
    }
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Send an XLSX buffer as a download. */
export function sendXlsx(res, { filename, buffer }) {
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(filename)}"`);
  res.setHeader("Content-Length", String(buffer.length));
  return res.send(buffer);
}

/** Send a PDF buffer as a download. */
export function sendPdf(res, { filename, buffer }) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(filename)}"`);
  res.setHeader("Content-Length", String(buffer.length));
  return res.send(buffer);
}

/**
 * Normalise a money value for display in an export.
 *
 * Money in this codebase is DECIMAL(14,2) and mysql2 returns it as a STRING, so
 * an unconverted export writes "15625.00" with no thousands separator and,
 * worse, lets Excel treat the column as text — a SUM over it silently returns 0.
 * Coercing to a number is what keeps the exported report usable.
 *
 * A BLANK becomes null (an empty cell), not 0. `Number("")` is 0 in JavaScript,
 * which would render a missing amount as a real zero and quietly misreport a
 * total. A genuine 0 stays 0.
 */
export function moneyCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Column widths that suit a typical HR report. */
export const DEFAULT_COLUMN_WIDTHS = [28, 16, 14, 14, 14, 18, 40];

export { safeFilename };
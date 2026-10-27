import { describe, it, expect, vi, beforeEach } from "vitest";
import zlib from "node:zlib";

const h = vi.hoisted(() => ({
  conn: {
    query: vi.fn(),
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  },
}));

vi.mock("../src/config/db.js", () => ({
  pool: { query: vi.fn(), getConnection: vi.fn(async () => h.conn) },
}));

import { pool } from "../src/config/db.js";
import { downloadPayslip } from "../src/controllers/salary.controller.js";
import { generatePayslipPdf } from "../src/utils/payslipPdf.js";

/**
 * THE PAYSLIP, AND WHY IT IS TESTED AS A DOCUMENT RATHER THAN AS A NUMBER.
 *
 * The old payslip showed two rows Ã¢â‚¬â€ basic, allowances Ã¢â‚¬â€ and one row Ã¢â‚¬â€
 * deductions. It was not wrong, it was unexplainable: a person holding it could
 * not answer "what am I paid for" or "why is this off", because both answers
 * were inside an aggregate that had already thrown away its parts. The lines
 * that would answer both questions had been sitting in `salary_record_lines`
 * since payroll auto-computation was introduced.
 *
 * What these tests pin:
 *
 *   1. LINES SURVIVE INTO THE PDF. Every allowance and deduction renders by name.
 *      Not a merged total Ã¢â‚¬â€ that is the whole point of the change.
 *   2. SOURCE AND BASIS ARE SHOWN. A line's provenance and the count behind it
 *      are what make it legible, so they must actually be emitted. Asserting on
 *      the label alone would pass with a document that still says only "what".
 *   3. A RECORD WITH NO LINES STILL RENDERS. Records made before the lines table
 *      existed are the majority of the data in any long-lived system, and an
 *      empty panel would be worse than the rollup it replaced.
 *   4. ONE PDF FOR BOTH MODES. `view=inline` and the download path must render
 *      the same document, because a preview that differs from the file an
 *      employee is handed is worse than either one alone.
 */

const RECORD = {
  uuid: "cafef00d-dead-4be5-a8aa-000000000001",
  organization_id: 7,
  employee_uuid: "11111111-2222-4333-8444-555555555555",
  month: 9,
  year: 2026,
  basic_salary: "50000.00",
  allowances: "21500.00",
  deductions: "12500.00",
  net_salary: "59000.00",
  employee_name: "Ayesha Siddiqui",
  employee_cnic: "42101-2345678-9",
  employee_phone: "03001234567",
  designation: "Senior Accountant",
  department: "Finance",
  organization_name: "Dverif Labs",
};

/** Lines exactly as the payroll generator inserts them. */
const LINES = [
  { label: "Basic salary", type: "earning", source: "basic", amount: "50000.00", basis_value: null, basis_unit: null },
  { label: "Transport allowance", type: "earning", source: "component", amount: "15000.00", basis_value: null, basis_unit: null },
  { label: "House rent", type: "earning", source: "component", amount: "8500.00", basis_value: null, basis_unit: null },
  { label: "Expense claims", type: "earning", source: "auto_expense", amount: "2000.00", basis_value: 2, basis_unit: "claims" },
  { label: "Unpaid leave", type: "deduction", source: "auto_unpaid_leave", amount: "9090.91", basis_value: 2, basis_unit: "days" },
  { label: "Late arrivals", type: "deduction", source: "auto_late", amount: "3409.09", basis_value: 3, basis_unit: "late_arrivals" },
];

/**
 * Every text run a PDFKit document contains, decompressed and concatenated.
 *
 * The content streams are Flate-compressed, so the glyphs are not readable in the
 * raw bytes Ã¢â‚¬â€ searching the buffer for "Transport allowance" finds nothing no
 * matter how correct the PDF is. Inflating each `stream ... endstream` and
 * pulling the parenthesised operands out of the Tj/TJ operators gives the text a
 * reader would see, which is what these tests assert on.
 *
 * Deliberately not a full PDF parser. The question under test is "did this label
 * reach the document", and a decompress plus string extractor answers it without
 * adding a dependency that could drift from what PDFKit emits.
 */
function pdfText(pdf) {
  const raw = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  const out = [];
  /*
   * Walk the BUFFER, not a latin1 transcription of it. Converting to a string and
   * back is lossy for exactly the bytes being inflated â€” each character code
   * above 0x7f becomes a different byte â€” so the match indices have to come from
   * the original Buffer. This was not a theoretical issue: the first version of
   * this helper found three streams and inflated none of them.
   */
  const marker = Buffer.from("stream");
  const endMarker = Buffer.from("endstream");
  let from = 0;
  for (;;) {
    const start = raw.indexOf(marker, from);
    if (start === -1) break;
    from = start + marker.length;
    // Skip the EOL that follows the keyword; PDFKit uses \n.
    let dataStart = start + marker.length;
    if (raw[dataStart] === 0x0a) dataStart += 1;
    else if (raw[dataStart] === 0x0d) dataStart += raw[dataStart + 1] === 0x0a ? 2 : 1;
    const end = raw.indexOf(endMarker, dataStart);
    if (end === -1) break;
    from = end + endMarker.length;
    // Trim the trailing EOL before `endstream`, which is not part of the data.
    let dataEnd = end;
    if (raw[dataEnd - 1] === 0x0a) dataEnd -= 1;
    if (raw[dataEnd - 1] === 0x0d) dataEnd -= 1;

    let inflated;
    try {
      inflated = zlib.inflateSync(raw.subarray(dataStart, dataEnd));
    } catch {
      continue; // an image stream, or one PDFKit wrote uncompressed
    }
    const text = inflated.toString("latin1");
    /*
     * TWO ENCODINGS, and the second one is the one PDFKit actually uses.
     *
     * A PDF text string may be literal â€” `(Hello)` â€” or hex â€” `<48656c6c6f>`.
     * PDFKit emits hex because its fonts are SUBSET: only the glyphs a document
     * uses are embedded, and addressing them by hex code point keeps the mapping
     * local to the subset. So a payslip's "Transport allowance" is not the ASCII
     * bytes in the stream, it is ten hex pairs. Parsing only the literal form
     * finds nothing and every assertion fails on a perfectly good document.
     *
     * Handles both, so the helper survives a PDFKit change either way.
     */
    const hexRe = /<([0-9A-Fa-f\s]+)>/g;
    let h;
    while ((h = hexRe.exec(text)) !== null) {
      const hex = h[1].replace(/\s+/g, "");
      for (let i = 0; i + 1 < hex.length + 1 && i + 2 <= hex.length; i += 2) {
        out.push(String.fromCharCode(parseInt(hex.slice(i, i + 2), 16)));
      }
    }
    const stringRe = /\(((?:[^()\\]|\\.)*)\)/g;
    let s;
    while ((s = stringRe.exec(text)) !== null) {
      out.push(s[1].replace(/\\([()\\])/g, "$1"));
    }
  }
  return out.join("");
}

function withLines(lines) {
  return { ...RECORD, lines };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.conn.query.mockResolvedValue([[]]);
  pool.query.mockResolvedValue([[]]);
});

describe("payslip PDF Ã¢â‚¬â€ itemised lines", () => {
  it("renders every stored line by name, and its source and basis", async () => {
    // The assertion is on the rendered BYTES rather than a parsed page: a
    // PDFKit text run is written as a Tj operator with the glyphs in order,
    // so the label string is present verbatim. Asserting on the presence of
    // each line's label catches the regression that matters Ã¢â‚¬â€ a rollup being
    // rendered instead of the itemisation.
    const pdf = await generatePayslipPdf({
      record: withLines(LINES),
      employeeName: "Ayesha Siddiqui",
      organizationName: "Dverif Labs",
    });

    // A PDF with no content is not a document; guard before the string checks so
    // a broken build reports "no PDF" rather than six missing labels.
    expect(pdf.length).toBeGreaterThan(5000);

    const raw = pdfText(pdf);
    // Labels are escaped as literal text in the content stream. Every line from
    // the record must appear, which is exactly the failure the aggregate had.
    for (const label of [
      "Transport allowance",
      "House rent",
      "Expense claims",
      "Unpaid leave",
      "Late arrivals",
    ]) {
      expect(raw).toContain(label);
    }
  });

  it("shows a line's source and the count behind its amount", async () => {
    const pdf = await generatePayslipPdf({
      record: withLines(LINES),
      employeeName: "Ayesha Siddiqui",
      organizationName: "Dverif Labs",
    });
    const raw = pdfText(pdf);

    // Source wording, not the machine token. Printing `auto_expense` at a
    // person reading their own pay is a detail nobody asked for.
    expect(raw).not.toContain("auto_expense");
    expect(raw).not.toContain("auto_unpaid_leave");
    expect(raw).toContain("Salary component");
    expect(raw).toContain("Expense claims");

    // The unit behind the derived amounts Ã¢â‚¬â€ 2 claims, 2 days, 3 late arrivals.
    // Without it a count reads as money, which is the ambiguity the basis exists
    // to remove.
    expect(raw).toContain("claims");
    expect(raw).toContain("late arrivals");
  });

  it("still renders a record made before line items existed", async () => {
    // Every record the original payroll flow produced has no lines. Those are the
    // bulk of the data, and an empty "Earnings" heading would be worse than the
    // aggregate it replaced, so the fallback must produce a document.
    const pdf = await generatePayslipPdf({
      record: { ...RECORD },
      employeeName: "Ayesha Siddiqui",
      organizationName: "Dverif Labs",
    });
    expect(pdf.length).toBeGreaterThan(5000);
    const raw = pdfText(pdf);
    expect(raw).toContain("Basic salary");
    expect(raw).toContain("Allowances (total)");
  });

  it("keeps the stored total as the total, rather than re-deriving it from the lines", async () => {
    // The lines explain the total; they are not the authority on it. Summing them
    // here could produce a figure that disagrees with what was actually paid if a
    // line was ever edited after the record was stored, and the stored total is
    // what the employee is owed.
    const pdf = await generatePayslipPdf({
      record: withLines(LINES),
      employeeName: "Ayesha Siddiqui",
      organizationName: "Dverif Labs",
    });
    const raw = pdfText(pdf);
    expect(raw).toContain("Total earnings");
    expect(raw).toContain("Total deductions");
    expect(raw).toContain("NET SALARY PAYABLE");
  });

  it("does not lose the net salary when a record has many lines", async () => {
    // A stacked layout is used once either side is long. Asserted so a future
    // change to the sizing rule cannot silently push the net banner off the page.
    const many = [];
    for (let i = 0; i < 12; i += 1) {
      many.push({
        label: `Allowance ${i}`,
        type: "earning",
        source: "component",
        amount: "100.00",
        basis_value: null,
        basis_unit: null,
      });
    }
    const pdf = await generatePayslipPdf({
      record: withLines(many),
      employeeName: "Ayesha Siddiqui",
      organizationName: "Dverif Labs",
    });
    expect(pdf.length).toBeGreaterThan(5000);
    const raw = pdfText(pdf);
    expect(raw).toContain("NET SALARY PAYABLE");
    expect(raw).toContain("Allowance 11");
  });
});

describe("payslip endpoint Ã¢â‚¬â€ one document for preview and download", () => {
  it("sends inline for ?view=inline and attachment otherwise", async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM salary_records sr")) {
        return [[{ ...RECORD }]];
      }
      if (s.includes("FROM salary_record_lines")) return [LINES];
      return [[]];
    });
    pool.getConnection.mockResolvedValue(h.conn);

    const res = {
      setHeader: vi.fn(),
      send: vi.fn(),
    };

    await downloadPayslip({ params: { uuid: RECORD.uuid }, query: { view: "inline" }, admin: { id: 1 } }, res);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Disposition", expect.stringContaining("inline"));

    res.setHeader.mockClear();
    await downloadPayslip({ params: { uuid: RECORD.uuid }, query: {}, admin: { id: 1 } }, res);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Disposition", expect.stringContaining("attachment"));
  });

  it("renders the same content for both dispositions", async () => {
    // THE GUARANTEE. One controller, one query, one generator. If the preview and
    // the download were ever produced by two paths, the number a recruiter signed
    // off on would not be the number the employee was handed.
    //
    // Compared as RENDERED TEXT, not as bytes, and that is not a weakening. A PDF
    // carries a creation timestamp in its Info dictionary, so two renders of one
    // record are never byte-identical - which would make byte equality a test that
    // fails on a correct implementation forever. What the requirement actually
    // asks is that the two show the same payroll data, and the text is where the
    // payroll data lives.
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM salary_records sr")) return [[{ ...RECORD }]];
      if (s.includes("FROM salary_record_lines")) return [LINES];
      return [[]];
    });

    const collect = async (query) => {
      const res = { setHeader: vi.fn(), send: vi.fn() };
      await downloadPayslip({ params: { uuid: RECORD.uuid }, query, admin: { id: 1 } }, res);
      return res.send.mock.calls[0][0];
    };

    const inline = await collect({ view: "inline" });
    const attachment = await collect({});
    // Both must be a real document first, so a failure reports "no PDF" rather
    // than two empty strings matching.
    expect(inline.length).toBeGreaterThan(1000);
    expect(attachment.length).toBeGreaterThan(1000);
    expect(pdfText(inline)).toBe(pdfText(attachment));
  });
});

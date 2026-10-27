import { describe, it, expect, vi } from "vitest";
import {
  escapeCsvCell,
  buildCsv,
  buildXlsx,
  sendCsv,
  sendXlsx,
  sendPdf,
  moneyCell,
  safeFilename,
  DEFAULT_COLUMN_WIDTHS,
} from "../src/utils/exportBuilders.js";

function mockRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: undefined,
    setHeader(k, v) {
      this.headers[k] = v;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe("escapeCsvCell", () => {
  it("leaves a plain value untouched", () => {
    expect(escapeCsvCell("Taxi")).toBe("Taxi");
    expect(escapeCsvCell(500)).toBe("500");
  });

  it("quotes a value containing a comma", () => {
    expect(escapeCsvCell("Ali, Khan")).toBe('"Ali, Khan"');
  });

  it("doubles an embedded quote", () => {
    // RFC 4180. Without doubling, Excel cannot parse the file and reports the
    // mangled value as a data problem rather than a malformed one.
    expect(escapeCsvCell('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("quotes a value containing a newline", () => {
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("renders null and undefined as empty", () => {
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
  });

  it("does not quote a value merely containing a quote-free hyphen", () => {
    expect(escapeCsvCell("2026-10-01")).toBe("2026-10-01");
  });
});

describe("buildCsv", () => {
  it("emits CRLF line endings per RFC 4180", () => {
    const csv = buildCsv(["a", "b"], [[1, 2]]);
    expect(csv).toBe("a,b\r\n1,2");
  });

  it("escapes data rows too", () => {
    const csv = buildCsv(["name"], [["Ali, Khan"]]);
    expect(csv).toBe("name\r\n\"Ali, Khan\"");
  });

  it("emits just the header when there are no rows", () => {
    expect(buildCsv(["a", "b"], [])).toBe("a,b");
  });
});

describe("sendCsv", () => {
  it("sets the download headers", () => {
    const res = sendCsv(mockRes(), { filename: "r.csv", headers: ["a"], rows: [[1]] });
    expect(res.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["Content-Disposition"]).toBe('attachment; filename="r.csv"');
  });

  it("prefixes a UTF-8 BOM so Excel reads Urdu correctly", () => {
    // Not optional for this product: without the BOM Excel assumes the system
    // codepage and mangles every Urdu string in the export.
    const res = sendCsv(mockRes(), { filename: "r.csv", headers: ["name"], rows: [["عاصم"]] });
    expect(res.body.charCodeAt(0)).toBe(0xfeff);
    expect(res.body).toContain("عاصم");
  });
});

describe("buildXlsx", () => {
  it("produces a real xlsx buffer", async () => {
    const buffer = await buildXlsx([
      { name: "Payroll", headers: ["Employee", "Net"], rows: [["Asim", 15625]] },
    ]);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    // A minimal xlsx is a ZIP archive: PK\x03\x04.
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it("supports multiple sheets", async () => {
    const buffer = await buildXlsx([
      { name: "A", headers: ["x"], rows: [[1]] },
      { name: "B", headers: ["y"], rows: [[2]] },
    ]);
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it("handles an empty row set without throwing", async () => {
    const buffer = await buildXlsx([{ name: "Empty", headers: ["a"], rows: [] }]);
    expect(Buffer.isBuffer(buffer)).toBe(true);
  });

  it("applies explicit column widths", async () => {
    const buffer = await buildXlsx([
      { name: "W", headers: ["a"], rows: [[1]], columnWidths: [40] },
    ]);
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it("returns a Buffer, not a stream or ArrayBuffer", async () => {
    const buffer = await buildXlsx([{ name: "S", headers: [], rows: [] }]);
    expect(typeof buffer.byteLength).toBe("number");
    expect(buffer.constructor.name).toBe("Buffer");
  });
});

describe("binary senders", () => {
  it("sendXlsx sets the OOXML content type and length", () => {
    const buffer = Buffer.from([1, 2, 3]);
    const res = sendXlsx(mockRes(), { filename: "r.xlsx", buffer });
    expect(res.headers["Content-Type"]).toContain("spreadsheetml");
    expect(res.headers["Content-Length"]).toBe("3");
    expect(res.body).toBe(buffer);
  });

  it("sendPdf sets the PDF content type", () => {
    const res = sendPdf(mockRes(), { filename: "r.pdf", buffer: Buffer.from([1]) });
    expect(res.headers["Content-Type"]).toBe("application/pdf");
  });

  it("strips characters that would break the Content-Disposition header", () => {
    // A quote in the filename would terminate the header value early.
    const res = sendCsv(mockRes(), { filename: 'ev"il\r\n.csv', headers: [], rows: [] });
    expect(res.headers["Content-Disposition"]).not.toContain("\r");
    expect(res.headers["Content-Disposition"]).not.toContain("\n");
  });
});

describe("safeFilename", () => {
  it.each(['a"b', "a\\b", "a\rb", "a\nb"])("neutralises %j", (name) => {
    const result = safeFilename(name);
    expect(result).not.toMatch(/["\\\r\n]/);
  });

  it("caps the length", () => {
    expect(safeFilename("x".repeat(500))).toHaveLength(120);
  });
});

describe("moneyCell", () => {
  it("coerces a DECIMAL string to a number so Excel treats the column as numeric", () => {
    // mysql2 returns DECIMAL(14,2) as a string. Left as text, a SUM over the
    // exported column silently returns 0.
    expect(moneyCell("15625.00")).toBe(15625);
    expect(typeof moneyCell("15625.00")).toBe("number");
  });

  it.each([["", null], [null, null], [undefined, null], ["abc", null], [NaN, null]])(
    "maps %j to %j",
    (input, expected) => {
      expect(moneyCell(input)).toBe(expected);
    }
  );

  it("keeps zero", () => {
    expect(moneyCell("0.00")).toBe(0);
  });
});

describe("DEFAULT_COLUMN_WIDTHS", () => {
  it("is a usable default set", () => {
    expect(Array.isArray(DEFAULT_COLUMN_WIDTHS)).toBe(true);
    expect(DEFAULT_COLUMN_WIDTHS.length).toBeGreaterThan(3);
  });
});
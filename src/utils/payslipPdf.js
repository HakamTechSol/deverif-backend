import PDFDocument from "pdfkit";

const PRIMARY = "#0d9488"; // teal-600
const DARK = "#134e4a"; // teal-900
const MUTED = "#64748b";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function money(value) {
  const n = Number(value ?? 0);
  if (Number.isNaN(n)) return "—";
  return `Rs. ${n.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function labelValueRow(doc, label, value, y, valueColor = "#0f172a") {
  doc.fillColor(MUTED).fontSize(9).text(label, 50, y, { lineBreak: false, continued: true });
  doc.fillColor(valueColor).fontSize(11).text(`  ${value}`, { lineBreak: true });
}

/**
 * Builds a printable payslip PDF (A4) for a salary record.
 * This is a manual ledger record — it does not perform any statutory
 * (tax/EOBI) calculation; figures shown are those entered by the org-admin.
 */
export async function generatePayslipPdf({ record, employeeName, organizationName }) {
  const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: "Payslip" } });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", resolve));

  const pageWidth = doc.page.width;
  const period = `${MONTHS[Number(record.month) - 1] ?? record.month} ${record.year}`;

  // Header band
  doc.rect(0, 0, pageWidth, 96).fill(DARK);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(22).text("Dverif", 50, 30);
  doc.font("Helvetica").fontSize(11).fillColor("#99f6e4").text("Salary Payslip", 50, 58);

  // Title
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(17).text("Salary Payslip", 50, 128);
  doc.moveTo(50, 152).lineTo(pageWidth - 50, 152).lineWidth(1.5).strokeColor(PRIMARY).stroke();

  // Employee / period
  let y = 172;
  labelValueRow(doc, "Employee", employeeName || "—", y);
  y = 194;
  labelValueRow(doc, "Organization", organizationName || "—", y);
  y = 216;
  labelValueRow(doc, "Period", period, y);
  y = 238;
  labelValueRow(doc, "Reference", record.uuid, y);
  y = 276;

  // Earnings table
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(12).text("Earnings & deductions", 50, y);
  y += 20;

  const row = (label, amount, isTotal = false) => {
    doc.fillColor(isTotal ? "#0f172a" : MUTED)
      .font(isTotal ? "Helvetica-Bold" : "Helvetica")
      .fontSize(isTotal ? 12 : 10)
      .text(label, 50, y);
    doc.fillColor(isTotal ? PRIMARY : "#0f172a")
      .font(isTotal ? "Helvetica-Bold" : "Helvetica")
      .fontSize(isTotal ? 12 : 10)
      .text(amount, pageWidth - 220, y, { width: 170, align: "right" });
    y += isTotal ? 26 : 20;
  };

  row("Basic salary", money(record.basic_salary));
  row("Allowances", money(record.allowances));
  row("Deductions", money(record.deductions));

  // Net total band
  doc.rect(50, y, pageWidth - 100, 36).fill(PRIMARY);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(13).text("Net salary", 68, y + 9);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(13).text(
    money(record.net_salary),
    pageWidth - 220,
    y + 9,
    { width: 170, align: "right" }
  );
  y += 56;

  if (record.notes) {
    labelValueRow(doc, "Notes", record.notes, y);
  }

  // Footer
  const footerY = doc.page.height - 80;
  doc.moveTo(50, footerY).lineTo(pageWidth - 50, footerY).lineWidth(1).strokeColor("#e2e8f0").stroke();
  doc.fillColor(MUTED).fontSize(8).text(
    "This payslip reflects manually entered figures and does not include statutory tax or contribution calculations.",
    50,
    footerY + 10,
    { align: "center", width: pageWidth - 100 }
  );

  doc.end();
  await done;
  return Buffer.concat(chunks);
}
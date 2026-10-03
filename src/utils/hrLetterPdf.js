import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLetterVerifyUrl } from "./letterQr.js";

/**
 * HR letter PDF.
 *
 * Follows the same structure as utils/payslipPdf.js and utils/certificatePdf.js —
 * pdfkit into a collected Buffer, brand colours and logo from assets/, Urdu text
 * auto-switching to the bundled Naskh face — so a letter is visually
 * indistinguishable from the payslips and certificates already in production.
 *
 * THE ONLY NEW IDEA HERE IS THE QR BLOCK. It states in plain words what the code
 * attests to (who, what kind of letter, which org, when issued) rather than
 * expecting the holder to know what a Dverif QR means. A QR that a bank employee
 * cannot interpret is decoration.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOGO = path.join(ROOT, "assets", "dverif-logo.png");
const ARABIC_FONT = path.join(ROOT, "assets", "NotoNaskhArabic-Regular.ttf");

const NAVY = "#123B73";
const BLUE = "#175CD3";
const INK = "#182230";
const MUTED = "#667085";
const LINE = "#D0D5DD";
const PALE = "#F5F9FF";
const GREEN = "#16875D";
const RED = "#B42318";

const PAGE_MARGIN = 56;
const rtlPattern = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

const LETTER_TYPE_LABEL = {
  offer: "Offer Letter",
  increment: "Salary Increment Letter",
  experience: "Experience Letter",
  employment_confirmation: "Employment Confirmation Letter",
  warning: "Warning Letter",
  appreciation: "Appreciation Letter",
  custom: "HR Letter",
};

function letterTypeLabel(type) {
  return LETTER_TYPE_LABEL[type] || "HR Letter";
}

function usableLogo() {
  return existsSync(LOGO) ? LOGO : null;
}

function formatDate(value, opts = { dateStyle: "medium" }) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-PK", { timeZone: "Asia/Karachi", ...opts });
}

/** Draw text, switching to the Arabic face when the string contains RTL. */
function displayText(doc, value, options = {}) {
  const text = value === null || value === undefined ? "" : String(value);
  if (!text) return;
  const rtl = rtlPattern.test(text);
  doc
    .font(rtl && existsSync(ARABIC_FONT) ? ARABIC_FONT : "Helvetica")
    .fillColor(options.color ?? INK)
    .fontSize(options.size ?? 11);
  if (rtl) doc.text(text, options.x, options.y, { width: options.width, align: "right" });
  else doc.text(text, options.x, options.y, { width: options.width, align: options.align ?? "left" });
}

/**
 * Render an issued letter.
 *
 * @param {object}  letter   the hr_letters row (needs uuid, letter_type, reference_no,
 *                           title, body_snapshot, status, issued_at, qr_token)
 * @param {object}  context  { employeeName, organizationName, verifyUrl }
 * @returns {Promise<Buffer>}
 */
export async function generateHrLetterPdf({ letter, employeeName, organizationName, verifyUrl }) {
  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    bufferPages: true,
    info: { Title: letterTypeLabel(letter.letter_type), Author: "Dverif" },
  });

  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve) => doc.on("end", resolve));

  const W = doc.page.width;
  const H = doc.page.height;
  const right = W - PAGE_MARGIN;
  const contentW = W - PAGE_MARGIN * 2;

  // ---- header -------------------------------------------------------------
  const logo = usableLogo();
  if (logo) {
    try {
      doc.image(logo, PAGE_MARGIN, PAGE_MARGIN, { fit: [110, 46] });
    } catch {
      /* a corrupt logo must not stop the letter being issued */
    }
  }
  displayText(doc, organizationName, {
    x: PAGE_MARGIN,
    y: PAGE_MARGIN + 52,
    width: contentW,
    align: "right",
    size: 10,
    color: MUTED,
  });

  doc
    .moveTo(PAGE_MARGIN, PAGE_MARGIN + 78)
    .lineTo(right, PAGE_MARGIN + 78)
    .strokeColor(LINE)
    .lineWidth(1)
    .stroke();

  // ---- title --------------------------------------------------------------
  let y = PAGE_MARGIN + 100;
  displayText(doc, letterTypeLabel(letter.letter_type), {
    x: PAGE_MARGIN,
    y,
    width: contentW,
    align: "center",
    size: 18,
    color: NAVY,
  });
  y += 30;

  if (letter.title && letter.title !== letterTypeLabel(letter.letter_type)) {
    displayText(doc, letter.title, {
      x: PAGE_MARGIN,
      y,
      width: contentW,
      align: "center",
      size: 12,
      color: MUTED,
    });
    y += 24;
  }

  // ---- meta strip ---------------------------------------------------------
  y += 6;
  doc.roundedRect(PAGE_MARGIN, y, contentW, 54, 6).fill(PALE);
  const metaY = y + 11;
  displayText(doc, "Reference No", { x: PAGE_MARGIN + 12, y: metaY, size: 8, color: MUTED });
  displayText(doc, letter.reference_no, {
    x: PAGE_MARGIN + 12,
    y: metaY + 13,
    size: 10,
    color: INK,
  });
  displayText(doc, "Issued To", { x: PAGE_MARGIN + 165, y: metaY, size: 8, color: MUTED });
  displayText(doc, employeeName, { x: PAGE_MARGIN + 165, y: metaY + 13, size: 10, color: INK });
  displayText(doc, "Issue Date", { x: PAGE_MARGIN + 345, y: metaY, size: 8, color: MUTED });
  displayText(doc, formatDate(letter.issued_at || new Date()), {
    x: PAGE_MARGIN + 345,
    y: metaY + 13,
    size: 10,
    color: INK,
  });
  y += 74;

  // ---- body ---------------------------------------------------------------
  // body_snapshot is the frozen, merged text — never re-rendered here. That is
  // what makes the PDF and the QR attestation describe the same document even
  // after the template is edited or deleted.
  displayText(doc, letter.body_snapshot, {
    x: PAGE_MARGIN,
    y,
    width: contentW,
    size: 11,
    lineGap: 4.5,
  });
  y = doc.y + 18;

  // ---- signature ----------------------------------------------------------
  doc
    .moveTo(PAGE_MARGIN + contentW - 170, y + 44)
    .lineTo(right, y + 44)
    .strokeColor(MUTED)
    .lineWidth(0.8)
    .stroke();
  displayText(doc, "Authorized Signatory", {
    x: PAGE_MARGIN + contentW - 170,
    y: y + 50,
    width: 170,
    align: "right",
    size: 9,
    color: MUTED,
  });
  y += 86;

  // ---- verification block -------------------------------------------------
  if (verifyUrl && letter.status === "issued") {
    if (y > H - PAGE_MARGIN - 190) {
      doc.addPage();
      y = PAGE_MARGIN;
    }

    let qrBuffer = null;
    try {
      qrBuffer = await QRCode.toBuffer(verifyUrl, {
        errorCorrectionLevel: "M",
        type: "png",
        width: 320,
        margin: 2,
        color: { dark: NAVY, light: "#FFFFFF" },
      });
    } catch {
      // A letter without a scannable QR is still a valid letter; the block below
      // degrades to the printed reference number instead of failing issuance.
      qrBuffer = null;
    }

    const boxH = qrBuffer ? 128 : 74;
    doc.roundedRect(PAGE_MARGIN, y, contentW, boxH, 6).fill(PALE);
    doc
      .roundedRect(PAGE_MARGIN, y, contentW, boxH, 6)
      .strokeColor(LINE)
      .lineWidth(0.8)
      .stroke();

    let textX = PAGE_MARGIN + 14;
    if (qrBuffer) {
      try {
        doc.image(qrBuffer, PAGE_MARGIN + 14, y + 10, { fit: [boxH - 20, boxH - 20] });
        textX = PAGE_MARGIN + 14 + (boxH - 20) + 16;
      } catch {
        textX = PAGE_MARGIN + 14;
      }
    }

    const textW = right - textX - 14;
    displayText(doc, "Digitally issued and verifiable on Dverif", {
      x: textX,
      y: y + 12,
      width: textW,
      size: 10,
      color: NAVY,
    });
    displayText(
      doc,
      "Scan the QR code, or visit the link below, to confirm this letter was issued by " +
        `${organizationName}. Confirmation shows the holder, the letter type and the date of issue — ` +
        "never the holder's national ID number.",
      { x: textX, y: y + 28, width: textW, size: 8, color: MUTED, lineGap: 2.5 }
    );
    displayText(doc, letter.reference_no, {
      x: textX,
      y: y + boxH - 26,
      width: textW,
      size: 8,
      color: INK,
    });
  }

  // ---- revoked banner -----------------------------------------------------
  if (letter.status === "revoked") {
    doc.roundedRect(PAGE_MARGIN, PAGE_MARGIN - 2, 200, 24, 4).fill(RED);
    displayText(doc, "REVOKED", {
      x: PAGE_MARGIN + 10,
      y: PAGE_MARGIN + 4,
      size: 11,
      color: "#FFFFFF",
    });
  }

  // ---- footer -------------------------------------------------------------
  displayText(doc, `Generated by Dverif · ${letter.reference_no}`, {
    x: PAGE_MARGIN,
    y: H - PAGE_MARGIN + 6,
    width: contentW,
    align: "center",
    size: 7.5,
    color: MUTED,
  });

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

export { GREEN, BLUE, NAVY };
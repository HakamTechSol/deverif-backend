// import PDFDocument from "pdfkit";
// import QRCode from "qrcode";
// import { existsSync } from "node:fs";
// import path from "node:path";
// import { fileURLToPath } from "node:url";
// import { buildLetterVerifyUrl } from "./letterQr.js";

// /**
//  * HR letter PDF.
//  *
//  * Follows the same structure as utils/payslipPdf.js and utils/certificatePdf.js —
//  * pdfkit into a collected Buffer, brand colours and logo from assets/, Urdu text
//  * auto-switching to the bundled Naskh face — so a letter is visually
//  * indistinguishable from the payslips and certificates already in production.
//  *
//  * THE ONLY NEW IDEA HERE IS THE QR BLOCK. It states in plain words what the code
//  * attests to (who, what kind of letter, which org, when issued) rather than
//  * expecting the holder to know what a Dverif QR means. A QR that a bank employee
//  * cannot interpret is decoration.
//  */

// const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// const LOGO = path.join(ROOT, "assets", "dverif-logo.png");
// const ARABIC_FONT = path.join(ROOT, "assets", "NotoNaskhArabic-Regular.ttf");

// const NAVY = "#123B73";
// const BLUE = "#175CD3";
// const INK = "#182230";
// const MUTED = "#667085";
// const LINE = "#D0D5DD";
// const PALE = "#F5F9FF";
// const GREEN = "#16875D";
// const RED = "#B42318";

// const PAGE_MARGIN = 56;
// const rtlPattern = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

// const LETTER_TYPE_LABEL = {
//   offer: "Offer Letter",
//   increment: "Salary Increment Letter",
//   experience: "Experience Letter",
//   employment_confirmation: "Employment Confirmation Letter",
//   warning: "Warning Letter",
//   appreciation: "Appreciation Letter",
//   custom: "HR Letter",
// };

// function letterTypeLabel(type) {
//   return LETTER_TYPE_LABEL[type] || "HR Letter";
// }

// function usableLogo(value) {
//   // Caller-supplied organization logo first, falling back to the platform mark.
//   if (value) {
//     try {
//       if (existsSync(value)) return value;
//     } catch {
//       /* malformed path must not stop the letter being issued */
//     }
//   }
//   return existsSync(LOGO) ? LOGO : null;
// }

// function formatDate(value, opts = { dateStyle: "medium" }) {
//   if (!value) return "";
//   const d = value instanceof Date ? value : new Date(value);
//   if (Number.isNaN(d.getTime())) return "";
//   return d.toLocaleString("en-PK", { timeZone: "Asia/Karachi", ...opts });
// }

// /** Draw text, switching to the Arabic face when the string contains RTL. */
// function displayText(doc, value, options = {}) {
//   const text = value === null || value === undefined ? "" : String(value);
//   if (!text) return;
//   const rtl = rtlPattern.test(text);
//   doc
//     .font(rtl && existsSync(ARABIC_FONT) ? ARABIC_FONT : "Helvetica")
//     .fillColor(options.color ?? INK)
//     .fontSize(options.size ?? 11);
//   if (rtl) doc.text(text, options.x, options.y, { width: options.width, align: "right" });
//   else doc.text(text, options.x, options.y, { width: options.width, align: options.align ?? "left" });
// }

// /**
//  * Diagonal REVOKED watermark across the centre of every page.
//  *
//  * Replaces a solid badge that used to sit over the header, where it covered the
//  * employer's logo and left the rest of the page looking like a valid letter. A
//  * faint diagonal cannot be cropped out without also cropping the page, and it
//  * leaves the header readable.
//  *
//  * Drawn LAST so it sits over the content, at low opacity so the text beneath
//  * stays legible. Rotation is applied around the page centre and undone
//  * afterwards, otherwise every later coordinate would be measured against a
//  * rotated origin.
//  */
// function drawRevokedWatermark(doc, W, H) {
//   const size = 76;
//   const text = "REVOKED";
//   const cx = W / 2;
//   const cy = H / 2;

//   for (const page of doc.bufferedPageRange().count
//     ? rangeOf(doc.bufferedPageRange())
//     : [doc.bufferedPageRange()]) {
//     doc.switchToPage(page);
//     doc.save();
//     doc.rotate(-30, { origin: [cx, cy] });
//     doc
//       .font("Helvetica-Bold")
//       .fontSize(size)
//       // fillOpacity, not a pale colour: a pale solid would hide the text
//       // underneath instead of showing through it.
//       .fillOpacity(0.13)
//       .fillColor(RED);
//     const w = doc.widthOfString(text);
//     const h = doc.heightOfString(text);
//     doc.text(text, cx - w / 2, cy - h / 2, { lineBreak: false });
//     doc.fillOpacity(1);
//     doc.restore();
//   }
// }

// function rangeOf({ start, count }) {
//   const out = [];
//   for (let i = 0; i < count; i += 1) out.push(start + i);
//   return out;
// }

// /**
//  * Render an issued letter.
//  *
//  * @param {object}  letter   the hr_letters row (needs uuid, letter_type, reference_no,
//  *                           title, body_snapshot, status, issued_at, qr_token)
//  * @param {object}  context  { employeeName, organizationName, organizationLogoPath, verifyUrl }
//  * @returns {Promise<Buffer>}
//  */
// export async function generateHrLetterPdf({
//   letter,
//   employeeName,
//   organizationName,
//   organizationLogoPath,
//   verifyUrl,
// }) {
//   const doc = new PDFDocument({
//     size: "A4",
//     margin: PAGE_MARGIN,
//     bufferPages: true,
//     info: { Title: letterTypeLabel(letter.letter_type), Author: "Dverif" },
//   });

//   const chunks = [];
//   doc.on("data", (chunk) => chunks.push(chunk));
//   const done = new Promise((resolve) => doc.on("end", resolve));

//   const W = doc.page.width;
//   const H = doc.page.height;
//   const right = W - PAGE_MARGIN;
//   const contentW = W - PAGE_MARGIN * 2;

//   // ---- header -------------------------------------------------------------
//   // The organization's own logo when it has one: a letterhead is what makes the
//   // document recognisably the employer's. Falls back to the Dverif mark so a
//   // letter is never issued unbranded just because a logo is missing.
//   const logo = usableLogo(organizationLogoPath);
//   if (logo) {
//     try {
//       doc.image(logo, PAGE_MARGIN, PAGE_MARGIN, { fit: [110, 46] });
//     } catch {
//       /* a corrupt logo must not stop the letter being issued */
//     }
//   }
//   displayText(doc, organizationName, {
//     x: PAGE_MARGIN,
//     y: PAGE_MARGIN + 52,
//     width: contentW,
//     align: "right",
//     size: 10,
//     color: MUTED,
//   });

//   doc
//     .moveTo(PAGE_MARGIN, PAGE_MARGIN + 78)
//     .lineTo(right, PAGE_MARGIN + 78)
//     .strokeColor(LINE)
//     .lineWidth(1)
//     .stroke();

//   // ---- title --------------------------------------------------------------
//   let y = PAGE_MARGIN + 100;
//   displayText(doc, letterTypeLabel(letter.letter_type), {
//     x: PAGE_MARGIN,
//     y,
//     width: contentW,
//     align: "center",
//     size: 18,
//     color: NAVY,
//   });
//   y += 30;

//   if (letter.title && letter.title !== letterTypeLabel(letter.letter_type)) {
//     displayText(doc, letter.title, {
//       x: PAGE_MARGIN,
//       y,
//       width: contentW,
//       align: "center",
//       size: 12,
//       color: MUTED,
//     });
//     y += 24;
//   }

//   // ---- meta strip ---------------------------------------------------------
//   y += 6;
//   doc.roundedRect(PAGE_MARGIN, y, contentW, 54, 6).fill(PALE);
//   const metaY = y + 11;
//   displayText(doc, "Reference No", { x: PAGE_MARGIN + 12, y: metaY, size: 8, color: MUTED });
//   displayText(doc, letter.reference_no, {
//     x: PAGE_MARGIN + 12,
//     y: metaY + 13,
//     size: 10,
//     color: INK,
//   });
//   displayText(doc, "Issued To", { x: PAGE_MARGIN + 165, y: metaY, size: 8, color: MUTED });
//   displayText(doc, employeeName, { x: PAGE_MARGIN + 165, y: metaY + 13, size: 10, color: INK });
//   displayText(doc, "Issue Date", { x: PAGE_MARGIN + 345, y: metaY, size: 8, color: MUTED });
//   displayText(doc, formatDate(letter.issued_at || new Date()), {
//     x: PAGE_MARGIN + 345,
//     y: metaY + 13,
//     size: 10,
//     color: INK,
//   });
//   y += 74;

//   // ---- body ---------------------------------------------------------------
//   // body_snapshot is the frozen, merged text — never re-rendered here. That is
//   // what makes the PDF and the QR attestation describe the same document even
//   // after the template is edited or deleted.
//   displayText(doc, letter.body_snapshot, {
//     x: PAGE_MARGIN,
//     y,
//     width: contentW,
//     size: 11,
//     lineGap: 4.5,
//   });
//   y = doc.y + 18;

//   // ---- signature ----------------------------------------------------------
//   doc
//     .moveTo(PAGE_MARGIN + contentW - 170, y + 44)
//     .lineTo(right, y + 44)
//     .strokeColor(MUTED)
//     .lineWidth(0.8)
//     .stroke();
//   displayText(doc, "Authorized Signatory", {
//     x: PAGE_MARGIN + contentW - 170,
//     y: y + 50,
//     width: 170,
//     align: "right",
//     size: 9,
//     color: MUTED,
//   });
//   y += 86;

//   // ---- verification block -------------------------------------------------
//   if (verifyUrl && letter.status === "issued") {
//     if (y > H - PAGE_MARGIN - 190) {
//       doc.addPage();
//       y = PAGE_MARGIN;
//     }

//     let qrBuffer = null;
//     try {
//       qrBuffer = await QRCode.toBuffer(verifyUrl, {
//         errorCorrectionLevel: "M",
//         type: "png",
//         width: 320,
//         margin: 2,
//         color: { dark: NAVY, light: "#FFFFFF" },
//       });
//     } catch {
//       // A letter without a scannable QR is still a valid letter; the block below
//       // degrades to the printed reference number instead of failing issuance.
//       qrBuffer = null;
//     }

//     const boxH = qrBuffer ? 128 : 74;
//     doc.roundedRect(PAGE_MARGIN, y, contentW, boxH, 6).fill(PALE);
//     doc
//       .roundedRect(PAGE_MARGIN, y, contentW, boxH, 6)
//       .strokeColor(LINE)
//       .lineWidth(0.8)
//       .stroke();

//     let textX = PAGE_MARGIN + 14;
//     if (qrBuffer) {
//       try {
//         doc.image(qrBuffer, PAGE_MARGIN + 14, y + 10, { fit: [boxH - 20, boxH - 20] });
//         textX = PAGE_MARGIN + 14 + (boxH - 20) + 16;
//       } catch {
//         textX = PAGE_MARGIN + 14;
//       }
//     }

//     const textW = right - textX - 14;
//     displayText(doc, "Digitally issued and verifiable on Dverif", {
//       x: textX,
//       y: y + 12,
//       width: textW,
//       size: 10,
//       color: NAVY,
//     });
//     displayText(
//       doc,
//       "Scan the QR code, or visit the link below, to confirm this letter was issued by " +
//         `${organizationName}. Confirmation shows the holder, the letter type and the date of issue — ` +
//         "never the holder's national ID number.",
//       { x: textX, y: y + 28, width: textW, size: 8, color: MUTED, lineGap: 2.5 }
//     );
//     displayText(doc, letter.reference_no, {
//       x: textX,
//       y: y + boxH - 26,
//       width: textW,
//       size: 8,
//       color: INK,
//     });
//   }

//   // ---- revoked watermark --------------------------------------------------
//   if (letter.status === "revoked") {
//     drawRevokedWatermark(doc, W, H);
//   }

//   // ---- footer -------------------------------------------------------------
//   displayText(doc, `Generated by Dverif · ${letter.reference_no}`, {
//     x: PAGE_MARGIN,
//     y: H - PAGE_MARGIN + 6,
//     width: contentW,
//     align: "center",
//     size: 7.5,
//     color: MUTED,
//   });

//   doc.end();
//   await done;
//   return Buffer.concat(chunks);
// }

// export { GREEN, BLUE, NAVY };


import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const HEADER_TOP = 36; // below the brand strip
const LOGO_BOX = { w: 160, h: 64 };
// Space reserved at the bottom of every page for the footer. Body content must
// never run into this zone; the footer itself is drawn inside it.
const FOOTER_ZONE = 40;
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

function usableLogo(value) {
  // Caller-supplied organization logo first, falling back to the platform mark.
  if (value) {
    try {
      if (existsSync(value)) return value;
    } catch {
      /* malformed path must not stop the letter being issued */
    }
  }
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
    .font(rtl && existsSync(ARABIC_FONT) ? ARABIC_FONT : options.font ?? "Helvetica")
    .fillColor(options.color ?? INK)
    .fontSize(options.size ?? 11);

  const textOptions = {
    width: options.width,
    // RTL text is always right-aligned; justify only applies to LTR.
    align: rtl ? "right" : options.align ?? "left",
  };
  if (options.lineGap !== undefined) textOptions.lineGap = options.lineGap;
  if (options.lineBreak !== undefined) textOptions.lineBreak = options.lineBreak;
  if (options.charSpacing !== undefined) textOptions.characterSpacing = options.charSpacing;
  if (options.height !== undefined) textOptions.height = options.height;
  if (options.ellipsis) textOptions.ellipsis = true;
  if (options.link) textOptions.link = options.link;

  doc.text(text, options.x, options.y, textOptions);
}

/**
 * Diagonal REVOKED watermark across the centre of every page.
 *
 * Replaces a solid badge that used to sit over the header, where it covered the
 * employer's logo and left the rest of the page looking like a valid letter. A
 * faint diagonal cannot be cropped out without also cropping the page, and it
 * leaves the header readable.
 *
 * Drawn LAST so it sits over the content, at low opacity so the text beneath
 * stays legible. Rotation is applied around the page centre and undone
 * afterwards, otherwise every later coordinate would be measured against a
 * rotated origin.
 */
function drawRevokedWatermark(doc, W, H) {
  const size = 76;
  const text = "REVOKED";
  const cx = W / 2;
  const cy = H / 2;
  const { start, count } = doc.bufferedPageRange();

  for (let i = start; i < start + count; i += 1) {
    doc.switchToPage(i);
    doc.save();
    doc.rotate(-30, { origin: [cx, cy] });
    doc
      .font("Helvetica-Bold")
      .fontSize(size)
      // fillOpacity, not a pale colour: a pale solid would hide the text
      // underneath instead of showing through it.
      .fillOpacity(0.13)
      .fillColor(RED);
    const w = doc.widthOfString(text);
    const h = doc.heightOfString(text);
    doc.text(text, cx - w / 2, cy - h / 2, { lineBreak: false });
    doc.fillOpacity(1);
    doc.restore();
  }
}

/** Brand strip across the very top of a page. */
function drawBrandStrip(doc, W) {
  doc.rect(0, 0, W, 6).fill(NAVY);
  doc.rect(0, 6, W, 2).fill(BLUE);
}

/**
 * Footer on every page.
 *
 * pdfkit starts a NEW PAGE whenever text is drawn below page.height minus the
 * bottom margin. The footer sits inside that bottom margin, so drawing it with
 * the normal margin silently created a second, otherwise-blank page holding only
 * the footer. Zeroing the bottom margin for the footer call (and disabling line
 * breaks) stops that.
 */
function drawFooters(doc, W, H, referenceNo) {
  const contentW = W - PAGE_MARGIN * 2;
  const { start, count } = doc.bufferedPageRange();

  for (let i = start; i < start + count; i += 1) {
    doc.switchToPage(i);
    const originalBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const lineY = H - 44;
    doc
      .moveTo(PAGE_MARGIN, lineY)
      .lineTo(W - PAGE_MARGIN, lineY)
      .strokeColor(LINE)
      .lineWidth(0.6)
      .stroke();

    const textY = lineY + 9;
    displayText(doc, "Generated by Dverif", {
      x: PAGE_MARGIN,
      y: textY,
      width: 180,
      align: "left",
      size: 7.5,
      color: MUTED,
      lineBreak: false,
    });
    displayText(doc, referenceNo, {
      x: PAGE_MARGIN + 180,
      y: textY,
      width: contentW - 360,
      align: "center",
      size: 7.5,
      color: MUTED,
      lineBreak: false,
    });
    displayText(doc, `Page ${i - start + 1} of ${count}`, {
      x: W - PAGE_MARGIN - 180,
      y: textY,
      width: 180,
      align: "right",
      size: 7.5,
      color: MUTED,
      lineBreak: false,
    });

    doc.page.margins.bottom = originalBottom;
  }
}

/**
 * Render an issued letter.
 *
 * @param {object}  letter   the hr_letters row (needs uuid, letter_type, reference_no,
 *                           title, body_snapshot, status, issued_at, qr_token)
 * @param {object}  context  { employeeName, organizationName, organizationLogoPath, verifyUrl }
 * @returns {Promise<Buffer>}
 */
export async function generateHrLetterPdf({
  letter,
  employeeName,
  organizationName,
  organizationLogoPath,
  verifyUrl,
}) {
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
  // Lowest y that signature / QR block may occupy.
  const contentBottom = H - PAGE_MARGIN - FOOTER_ZONE;

  // Brand strip on every page, including pages pdfkit adds for long bodies.
  drawBrandStrip(doc, W);
  doc.on("pageAdded", () => drawBrandStrip(doc, W));

  // ---- header / letterhead ------------------------------------------------
  // The organization's own logo when it has one: a letterhead is what makes the
  // document recognisably the employer's. Falls back to the Dverif mark so a
  // letter is never issued unbranded just because a logo is missing.
  const logo = usableLogo(organizationLogoPath);
  if (logo) {
    try {
      doc.image(logo, PAGE_MARGIN, HEADER_TOP, {
        fit: [LOGO_BOX.w, LOGO_BOX.h],
        align: "left",
        valign: "center",
      });
    } catch {
      /* a corrupt logo must not stop the letter being issued */
    }
  }

  const orgNameWidth = contentW - LOGO_BOX.w - 20;
  displayText(doc, organizationName, {
    x: right - orgNameWidth,
    y: HEADER_TOP + 16,
    width: orgNameWidth,
    align: "right",
    size: 14,
    font: "Helvetica-Bold",
    color: NAVY,
  });
  displayText(doc, "Official HR Correspondence", {
    x: right - orgNameWidth,
    y: doc.y + 3,
    width: orgNameWidth,
    align: "right",
    size: 8.5,
    color: MUTED,
  });

  const dividerY = HEADER_TOP + LOGO_BOX.h + 14;
  doc
    .moveTo(PAGE_MARGIN, dividerY)
    .lineTo(right, dividerY)
    .strokeColor(NAVY)
    .lineWidth(1.2)
    .stroke();

  // ---- title --------------------------------------------------------------
  let y = dividerY + 26;
  displayText(doc, letterTypeLabel(letter.letter_type).toUpperCase(), {
    x: PAGE_MARGIN,
    y,
    width: contentW,
    align: "center",
    size: 16,
    font: "Helvetica-Bold",
    color: NAVY,
    charSpacing: 1.5,
  });
  y += 26;

  // short accent rule under the title
  doc
    .moveTo(W / 2 - 24, y)
    .lineTo(W / 2 + 24, y)
    .strokeColor(BLUE)
    .lineWidth(2)
    .stroke();
  y += 14;

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
  y += 8;
  const metaH = 56;
  doc.roundedRect(PAGE_MARGIN, y, contentW, metaH, 6).fill(PALE);
  doc.rect(PAGE_MARGIN, y + 6, 3.5, metaH - 12).fill(NAVY);
  const metaY = y + 12;
  const col1 = PAGE_MARGIN + 18;
  const col2 = PAGE_MARGIN + 175;
  const col3 = PAGE_MARGIN + 370;

  const metaLabel = (label, x) =>
    displayText(doc, label.toUpperCase(), {
      x,
      y: metaY,
      size: 7,
      color: MUTED,
      charSpacing: 0.6,
      lineBreak: false,
    });
  const metaValue = (value, x, width) =>
    displayText(doc, value, {
      x,
      y: metaY + 14,
      width,
      size: 10,
      font: "Helvetica-Bold",
      color: INK,
      height: 13,
      ellipsis: true,
    });

  metaLabel("Reference No", col1);
  metaValue(letter.reference_no, col1, col2 - col1 - 12);
  metaLabel("Issued To", col2);
  metaValue(employeeName, col2, col3 - col2 - 12);
  metaLabel("Issue Date", col3);
  metaValue(formatDate(letter.issued_at || new Date()), col3, right - col3 - 12);
  y += metaH + 22;

  // ---- body ---------------------------------------------------------------
  // body_snapshot is the frozen, merged text — never re-rendered here. That is
  // what makes the PDF and the QR attestation describe the same document even
  // after the template is edited or deleted.
  displayText(doc, letter.body_snapshot, {
    x: PAGE_MARGIN,
    y,
    width: contentW,
    align: "justify",
    size: 11,
    lineGap: 5,
  });
  y = doc.y + 24;

  // ---- QR (generated up-front so the page-break check knows the real height) -
  const showVerification = Boolean(verifyUrl) && letter.status === "issued";
  let qrBuffer = null;
  if (showVerification) {
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
      // degrades to the printed link and reference number instead of failing issuance.
      qrBuffer = null;
    }
  }
  const boxH = qrBuffer ? 132 : 96;

  // ---- signature + verification: kept together on one page ----------------
  const signatureH = 96;
  const neededH = signatureH + (showVerification ? boxH : 0);
  if (y + neededH > contentBottom) {
    doc.addPage();
    y = PAGE_MARGIN;
  }

  // ---- signature ----------------------------------------------------------
  const sigX = right - 190;
  doc
    .moveTo(sigX, y + 44)
    .lineTo(right, y + 44)
    .strokeColor(MUTED)
    .lineWidth(0.8)
    .stroke();
  displayText(doc, "Authorized Signatory", {
    x: sigX,
    y: y + 51,
    width: 190,
    align: "right",
    size: 9,
    font: "Helvetica-Bold",
    color: INK,
  });
  displayText(doc, organizationName, {
    x: sigX,
    y: doc.y + 2,
    width: 190,
    align: "right",
    size: 8,
    color: MUTED,
  });
  y += signatureH;

  // ---- verification block -------------------------------------------------
  if (showVerification) {
    doc.roundedRect(PAGE_MARGIN, y, contentW, boxH, 6).fill(PALE);
    doc
      .roundedRect(PAGE_MARGIN, y, contentW, boxH, 6)
      .strokeColor(LINE)
      .lineWidth(0.8)
      .stroke();
    doc.rect(PAGE_MARGIN, y + 8, 3.5, boxH - 16).fill(GREEN);

    let textX = PAGE_MARGIN + 18;
    if (qrBuffer) {
      try {
        doc.image(qrBuffer, PAGE_MARGIN + 18, y + 12, { fit: [boxH - 24, boxH - 24] });
        textX = PAGE_MARGIN + 18 + (boxH - 24) + 16;
      } catch {
        textX = PAGE_MARGIN + 18;
      }
    }

    const textW = right - textX - 14;
    displayText(doc, "Digitally issued and verifiable on Dverif", {
      x: textX,
      y: y + 12,
      width: textW,
      size: 10,
      font: "Helvetica-Bold",
      color: NAVY,
    });
    displayText(
      doc,
      "Scan the QR code, or open the link below, to confirm this letter was issued by " +
        `${organizationName}. Confirmation shows the holder, the letter type and the date of issue — ` +
        "never the holder's national ID number.",
      { x: textX, y: y + 28, width: textW, size: 8, color: MUTED, lineGap: 2.5 }
    );
    displayText(doc, verifyUrl, {
      x: textX,
      y: doc.y + 6,
      width: textW,
      size: 7.5,
      color: BLUE,
      link: verifyUrl,
    });
    displayText(doc, `Ref: ${letter.reference_no}`, {
      x: textX,
      y: y + boxH - 20,
      width: textW,
      size: 8,
      font: "Helvetica-Bold",
      color: INK,
      lineBreak: false,
    });
  }

  // ---- footer on every page (must come before the watermark/end) ----------
  drawFooters(doc, W, H, letter.reference_no);

  // ---- revoked watermark --------------------------------------------------
  if (letter.status === "revoked") {
    drawRevokedWatermark(doc, W, H);
  }

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

export { GREEN, BLUE, NAVY };
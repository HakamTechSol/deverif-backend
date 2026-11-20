import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * HR letter PDF.
 *
 * LAYOUT FOLLOWS A REAL COMPANY LETTER, NOT A PLATFORM DOCUMENT.
 *
 *   [ organization logo, centred ]
 *   ----------------------------------------------
 *   Ref: HR/2026/0001                Dated: 01-November-2026
 *
 *   Employee Name
 *   Designation / Department
 *
 *   Sub: Offer Letter for the position of ...
 *
 *   body (template text, including its own sign-off)
 *   ----------------------------------------------
 *   HR/2026/0001          Page 1 of 1          Powered by Dverif
 *
 * THE DVERIF LOGO IS NEVER DRAWN. The letter belongs to the employer: its logo is
 * the letterhead, and the only trace of the platform is a small "Powered by
 * Dverif" line in the footer. When an organization has no usable logo the letterhead
 * falls back to the organization's NAME in text, never to the platform mark - a
 * letter that carries Dverif's logo reads as Dverif's letter, not the employer's.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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
const HEADER_TOP = 34;
const LOGO_MAX = { w: 190, h: 80 };
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

/**
 * The organization's own logo, or null.
 *
 * NO PLATFORM FALLBACK. A missing logo yields null and the letterhead prints the
 * organization's name instead. pdfkit only decodes PNG and JPEG, so a logo in any
 * other format throws at draw time and is handled there the same way.
 */
function usableLogo(value) {
  if (!value) return null;
  try {
    return existsSync(value) ? value : null;
  } catch {
    /* malformed path must not stop the letter being issued */
    return null;
  }
}

/** 01-November-2026, in Pakistan time, matching how letters are dated locally. */
function formatLetterDate(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Karachi",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}-${get("month")}-${get("year")}`;
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
  if (options.paragraphGap !== undefined) textOptions.paragraphGap = options.paragraphGap;
  if (options.lineBreak !== undefined) textOptions.lineBreak = options.lineBreak;
  if (options.charSpacing !== undefined) textOptions.characterSpacing = options.charSpacing;
  if (options.height !== undefined) textOptions.height = options.height;
  if (options.ellipsis) textOptions.ellipsis = true;
  if (options.underline) textOptions.underline = true;
  if (options.link) textOptions.link = options.link;

  doc.text(text, options.x, options.y, textOptions);
}

/**
 * Letterhead: the organization's logo centred at the top, a rule beneath it.
 * Returns the y where the letter's content may start.
 */
function drawLetterhead(doc, { logoPath, organizationName }) {
  const W = doc.page.width;
  const contentW = W - PAGE_MARGIN * 2;
  let y = HEADER_TOP;
  let drewLogo = false;

  if (logoPath) {
    try {
      const img = doc.openImage(logoPath);
      const scale = Math.min(LOGO_MAX.w / img.width, LOGO_MAX.h / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      doc.image(logoPath, (W - w) / 2, y, { width: w, height: h });
      y += h + 10;
      drewLogo = true;
    } catch {
      /* unreadable or unsupported logo: fall through to the name */
    }
  }

  if (!drewLogo && organizationName) {
    displayText(doc, organizationName, {
      x: PAGE_MARGIN,
      y: y + 6,
      width: contentW,
      align: "center",
      size: 20,
      font: "Helvetica-Bold",
      color: NAVY,
    });
    y = doc.y + 8;
  }

  doc
    .moveTo(PAGE_MARGIN, y)
    .lineTo(W - PAGE_MARGIN, y)
    .strokeColor(NAVY)
    .lineWidth(1.2)
    .stroke();
  return y + 22;
}

/**
 * Diagonal REVOKED watermark across the centre of every page.
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
      .fillOpacity(0.13)
      .fillColor(RED);
    const w = doc.widthOfString(text);
    const h = doc.heightOfString(text);
    doc.text(text, cx - w / 2, cy - h / 2, { lineBreak: false });
    doc.fillOpacity(1);
    doc.restore();
  }
}

/**
 * Footer on every page: reference left, page number centre, a small
 * "Powered by Dverif" on the right. That line is the platform's only mark.
 *
 * pdfkit starts a NEW PAGE whenever text is drawn below page.height minus the
 * bottom margin. The footer sits inside that bottom margin, so the margin is
 * zeroed for the footer call (and line breaks disabled) to stop it creating a
 * blank page holding only the footer.
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
    displayText(doc, referenceNo, {
      x: PAGE_MARGIN,
      y: textY,
      width: 180,
      align: "left",
      size: 7.5,
      color: MUTED,
      lineBreak: false,
    });
    displayText(doc, `Page ${i - start + 1} of ${count}`, {
      x: PAGE_MARGIN + 180,
      y: textY,
      width: contentW - 360,
      align: "center",
      size: 7.5,
      color: MUTED,
      lineBreak: false,
    });
    displayText(doc, "Powered by Dverif", {
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
 * Render a letter.
 *
 * @param {object}  letter   the hr_letters row (needs letter_type, reference_no, title,
 *                           body_snapshot, status, issued_at; designation/department
 *                           are used for the addressee block when present)
 * @param {object}  context  { employeeName, organizationName, organizationLogoPath, verifyUrl }
 * @returns {Promise<Buffer>}
 */
export async function generateHrLetterPdf({
  letter,
  employeeName,
  organizationName,
  organizationLogoPath,
  // eslint-disable-next-line no-unused-vars
  verifyUrl, // accepted for caller compatibility; no QR / link is printed on the letter
}) {
  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    bufferPages: true,
    info: { Title: letterTypeLabel(letter.letter_type), Author: organizationName || "HR" },
  });

  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve) => doc.on("end", resolve));

  const W = doc.page.width;
  const H = doc.page.height;
  const right = W - PAGE_MARGIN;
  const contentW = W - PAGE_MARGIN * 2;

  // ---- letterhead ---------------------------------------------------------
  let y = drawLetterhead(doc, {
    logoPath: usableLogo(organizationLogoPath),
    organizationName,
  });

  // ---- reference (left) and date (right) on one line -----------------------
  const issueDate = formatLetterDate(letter.issued_at || new Date());
  displayText(doc, `Ref: ${letter.reference_no ?? ""}`, {
    x: PAGE_MARGIN,
    y,
    width: contentW / 2,
    size: 10,
    font: "Helvetica-Bold",
    lineBreak: false,
  });
  displayText(doc, `Dated: ${issueDate}`, {
    x: PAGE_MARGIN + contentW / 2,
    y,
    width: contentW / 2,
    align: "right",
    size: 10,
    font: "Helvetica-Bold",
    lineBreak: false,
  });
  y += 30;

  // ---- addressee ----------------------------------------------------------
  displayText(doc, employeeName, {
    x: PAGE_MARGIN,
    y,
    width: contentW,
    size: 11,
    font: "Helvetica-Bold",
  });
  for (const line of [letter.designation, letter.department]) {
    if (!line) continue;
    displayText(doc, line, { x: PAGE_MARGIN, y: doc.y + 2, width: contentW, size: 10.5, color: MUTED });
  }
  y = doc.y + 18;

  // ---- subject ------------------------------------------------------------
  const subject = letter.title || letterTypeLabel(letter.letter_type);
  displayText(doc, `Sub: ${subject}`, {
    x: PAGE_MARGIN,
    y,
    width: contentW,
    size: 12,
    font: "Helvetica-Bold",
    underline: true,
  });
  y = doc.y + 14;

  // ---- body ---------------------------------------------------------------
  // body_snapshot is the frozen, merged text - never re-rendered here. That is
  // what makes the PDF and the QR attestation describe the same document even
  // after the template is edited or deleted.
  // Rendering-only tidy-up: 3+ consecutive newlines (an author pressing Enter
  // several times) collapse to ONE blank line, and stray edge whitespace goes.
  // The stored snapshot is untouched, so what was issued is still what is on file.
  const bodyText = String(letter.body_snapshot ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  displayText(doc, bodyText, {
    x: PAGE_MARGIN,
    y,
    width: contentW,
    align: "left",
    size: 11,
    lineGap: 4,
  });
  // No automatic signature block: the template owns its own sign-off ("Sincerely,
  // HR Department"), and a second "Regards / Authorized Signatory" duplicated it and
  // pushed an orphan block onto a second page.

  // ---- footer on every page (must come before the watermark/end) ----------
  drawFooters(doc, W, H, letter.reference_no ?? "");

  // ---- revoked watermark --------------------------------------------------
  if (letter.status === "revoked") {
    drawRevokedWatermark(doc, W, H);
  }

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

export { GREEN, BLUE, NAVY };
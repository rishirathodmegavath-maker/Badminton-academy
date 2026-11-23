import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { unit } from "../../academy/application/access";
import { reportAccess } from "./service";
import { invoiceAccess } from "../../fees/application/service";
import { plainMoney } from "../../fees/domain/money";
import { and, eq } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { DomainError } from "../../training/domain/rules";
import { denialAudited, recordAccess } from "../../audit/application/record";
import { buildReportSheet, sheetLines, type ReportSheet } from "../domain/report-sheet";
import { drawReportSheet } from "./report-pdf-layout";
export interface ReportRenderer {
  /**
   * `lines` is the plain-text content. When a `sheet` is given (monthly development reports) the document is drawn from
   * it with the branded layout; the sheet is the same model the on-screen preview uses.
   */
  render(academy: string, title: string, lines: string[], sheet?: ReportSheet): Promise<Uint8Array>;
}
// Uses portable built-in fonts. Unsupported scripts are rejected instead of silently dropping text.
export const pdfRenderer: ReportRenderer = {
  async render(academy, title, lines, sheet) {
    if (sheet) return drawReportSheet(sheet);
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    pdf.setTitle(title);
    pdf.setAuthor(academy);
    let page = pdf.addPage([595, 842]);
    let y = 720;
    const clean = (s: string) =>
      s.replace(/[\u2010-\u2015]/g, "-").replace(/\u2022/g, "-");
    const draw = (text: string, size = 11, strong = false) => {
      const active = strong ? bold : font;
      try {
        active.encodeText(clean(text));
      } catch {
        throw new DomainError(
          "PDF text contains characters unsupported by the current report font. Use Latin text for this pilot; multilingual font support is not configured.",
        );
      }
      if (y < 65) {
        page = pdf.addPage([595, 842]);
        y = 765;
      }
      page.drawText(clean(text), {
        x: 48,
        y,
        size,
        font: active,
        color: rgb(0.12, 0.2, 0.23),
      });
      y -= size + 8;
    };
    page.drawRectangle({
      x: 0,
      y: 760,
      width: 595,
      height: 82,
      color: rgb(0.06, 0.17, 0.22),
    });
    page.drawText("Sportozen", {
      x: 48,
      y: 798,
      size: 23,
      font: bold,
      color: rgb(1, 1, 1),
    });
    page.drawText("PRIVATE ACADEMY RECORD", {
      x: 48,
      y: 780,
      size: 8,
      font,
      color: rgb(0.75, 0.85, 0.75),
    });
    const wrap = (text: string, size: number) => {
      for (const paragraph of clean(text).split("\n")) {
        let line = "";
        for (const word of paragraph.split(/\s+/)) {
          if (font.widthOfTextAtSize(word, size) > 490) {
            if (line) {
              draw(line, size);
              line = "";
            }
            let segment = "";
            for (const char of word) {
              if (font.widthOfTextAtSize(segment + char, size) > 490) {
                draw(segment, size);
                segment = "";
              }
              segment += char;
            }
            line = segment;
            continue;
          }
          if (font.widthOfTextAtSize(`${line} ${word}`.trim(), size) > 490) {
            draw(line, size);
            line = word;
          } else line = `${line} ${word}`.trim();
        }
        draw(line, size);
      }
    };
    wrap(academy, 13);
    wrap(title, 17);
    y -= 10;
    for (const line of lines) wrap(line, 11);
    const pages = pdf.getPages();
    pages.forEach((p, i) => {
      p.drawText(
        `Private - authorised recipients only | ${i + 1} / ${pages.length}`,
        { x: 48, y: 32, size: 8, font, color: rgb(0.45, 0.5, 0.45) },
      );
    });
    return pdf.save();
  },
};
export async function reportPdf(a: Actor, id: string) {
  return denialAudited(
    a,
    { category: "REPORT", operation: "PDF", resourceId: id },
    () => reportPdfChecked(a, id),
  );
}
async function reportPdfChecked(a: Actor, id: string) {
  return unit(a, async (tx) => {
    const r = await reportAccess(a, id, tx);
    // Phase 7, fail-closed and in this transaction: no event, no document. Staff opening a withdrawn
    // report is HISTORICAL (the content families can no longer see).
    await recordAccess(tx, a, {
      category: "REPORT",
      operation: r.status === "WITHDRAWN" ? "HISTORICAL" : "PDF",
      resourceId: id,
      playerId: r.playerId,
      context: r.status === "WITHDRAWN" ? { withdrawn: true } : {},
    });
    // The same model the on-screen report is drawn from: the PDF and the preview carry identical facts.
    const sheet = buildReportSheet(r.data, {
      status: r.status,
      version: r.version,
      generatedOn: new Date().toISOString().slice(0, 10),
    });
    const lines = [
      ...(r.status === "WITHDRAWN"
        ? ["WITHDRAWN - no longer shared with families. Do not distribute."]
        : []),
      ...sheetLines(sheet),
    ];
    return {
      bytes: await pdfRenderer.render(r.data.academyName, r.data.title, lines, sheet),
      name: `report-${r.id}-v${r.version}.pdf`,
    };
  });
}
export async function receiptPdf(a: Actor, id: string) {
  return denialAudited(
    a,
    { category: "FINANCE", operation: "PDF", resourceId: id },
    () => receiptPdfChecked(a, id),
  );
}
async function receiptPdfChecked(a: Actor, id: string) {
  return unit(a, async (tx) => {
    const [p] = await tx
      .select()
      .from(t.payments)
      .where(and(eq(t.payments.academyId, a.academyId), eq(t.payments.id, id)));
    if (!p || p.status !== "VERIFIED")
      throw new DomainError("Verified receipt not found.", 404);
    const invoice = await invoiceAccess(a, p.invoiceId, tx);
    await recordAccess(tx, a, {
      category: "FINANCE",
      operation: "PDF",
      resourceId: id,
    });
    const refunds = await tx
      .select()
      .from(t.refunds)
      .where(
        and(
          eq(t.refunds.academyId, a.academyId),
          eq(t.refunds.paymentId, p.id),
        ),
      );
    return {
      bytes: await pdfRenderer.render(
        a.academyName,
        `Payment receipt ${p.data.receiptNumber}`,
        [
          `Invoice: ${invoice.data.number}`,
          `Amount verified: ${plainMoney(p.data.amount, p.data.currency)}`,
          `Payment method: ${p.data.method}`,
          `Reference: ${p.data.reference}`,
          `Verified by staff account: ${p.data.verifiedBy}`,
          `Verification note: ${p.data.reason}`,
          `Recorded refunds: ${plainMoney(refunds.reduce((sum, r) => sum + r.amount, 0), p.data.currency)}`,
          "Academy fees only. Sportozen subscription billing is separate.",
        ],
      ),
      name: `receipt-${p.id}.pdf`,
    };
  });
}

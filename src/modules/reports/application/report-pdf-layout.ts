import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { DomainError } from "../../training/domain/rules";
import {
  ATTENDANCE_TEXT,
  attendanceCaveat,
  dayLabel,
  type ReportSheet,
} from "../domain/report-sheet";
/**
 * Draws the monthly development report from the SAME `ReportSheet` the screen's preview is drawn from, so the PDF
 * and the preview carry identical facts. Built-in fonts only (no new dependency); text the font cannot encode is
 * rejected, exactly as the generic renderer does, rather than silently dropped.
 */
const PAGE_W = 595;
const PAGE_H = 842;
const M = 44; // side margin
const BODY_W = PAGE_W - M * 2;
const GREEN = rgb(0.09, 0.36, 0.23);
const NAVY = rgb(0.06, 0.17, 0.22);
const INK = rgb(0.12, 0.18, 0.2);
const MUTED = rgb(0.4, 0.46, 0.45);
const RULE = rgb(0.86, 0.9, 0.87);
const TINT = rgb(0.94, 0.97, 0.95);
const clean = (s: string) => s.replace(/[‐-―]/g, "-").replace(/•/g, "-");

export async function drawReportSheet(sheet: ReportSheet): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle(`${sheet.title} - ${sheet.player.name}`);
  pdf.setAuthor(sheet.academy);
  pdf.setSubject(`Monthly development report, ${sheet.periodLabel}`);
  let page: PDFPage = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H;

  const encodable = (text: string, f: PDFFont) => {
    try {
      f.encodeText(clean(text));
    } catch {
      throw new DomainError(
        "PDF text contains characters unsupported by the current report font. Use Latin text for this pilot; multilingual font support is not configured.",
      );
    }
  };
  const width = (text: string, size: number, f: PDFFont) => f.widthOfTextAtSize(clean(text), size);
  /** Word-wraps to `max` points, breaking an over-long word by character. */
  const wrapLines = (text: string, size: number, f: PDFFont, max: number) => {
    const out: string[] = [];
    for (const paragraph of clean(text).split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        let w = word;
        while (f.widthOfTextAtSize(w, size) > max) {
          let seg = "";
          for (const ch of w) {
            if (f.widthOfTextAtSize(seg + ch, size) > max) break;
            seg += ch;
          }
          if (line) {
            out.push(line);
            line = "";
          }
          out.push(seg);
          w = w.slice(seg.length);
        }
        const next = line ? `${line} ${w}` : w;
        if (f.widthOfTextAtSize(next, size) > max && line) {
          out.push(line);
          line = w;
        } else line = next;
      }
      out.push(line);
    }
    return out;
  };
  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: PAGE_H - 26, width: PAGE_W, height: 26, color: NAVY });
    page.drawText(clean(`${sheet.academy} - ${sheet.player.name} - ${sheet.periodLabel}`), {
      x: M,
      y: PAGE_H - 17,
      size: 8.5,
      font: bold,
      color: rgb(1, 1, 1),
    });
    y = PAGE_H - 54;
  };
  const ensure = (h: number) => {
    if (y - h < 58) newPage();
  };
  const para = (
    text: string,
    o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; max?: number; gap?: number } = {},
  ) => {
    const size = o.size ?? 10;
    const f = o.bold ? bold : font;
    encodable(text, f);
    const lead = size + 4;
    for (const line of wrapLines(text, size, f, o.max ?? BODY_W - ((o.x ?? M) - M))) {
      ensure(lead);
      y -= lead;
      page.drawText(line, { x: o.x ?? M, y, size, font: f, color: o.color ?? INK });
    }
    y -= o.gap ?? 4;
  };
  const heading = (text: string) => {
    ensure(48);
    y -= 20;
    page.drawRectangle({ x: M, y: y - 3, width: 4, height: 15, color: GREEN });
    encodable(text, bold);
    page.drawText(clean(text), { x: M + 11, y, size: 12.5, font: bold, color: NAVY });
    y -= 12;
  };

  // ── Header band
  page.drawRectangle({ x: 0, y: PAGE_H - 104, width: PAGE_W, height: 104, color: GREEN });
  page.drawRectangle({ x: 0, y: PAGE_H - 108, width: PAGE_W, height: 4, color: NAVY });
  encodable(sheet.academy, bold);
  page.drawText("Sportozen Academy", { x: M, y: PAGE_H - 46, size: 21, font: bold, color: rgb(1, 1, 1) });
  page.drawText("Badminton Academy", { x: M, y: PAGE_H - 64, size: 10.5, font, color: rgb(0.85, 0.94, 0.88) });
  if (sheet.academy && sheet.academy !== "Sportozen Academy")
    page.drawText(clean(sheet.academy), { x: M, y: PAGE_H - 82, size: 9, font, color: rgb(0.85, 0.94, 0.88) });
  const periodW = width(sheet.periodLabel, 17, bold);
  page.drawText(clean(sheet.periodLabel), { x: PAGE_W - M - periodW, y: PAGE_H - 48, size: 17, font: bold, color: rgb(1, 1, 1) });
  const sub = "Monthly Development Report";
  page.drawText(sub, { x: PAGE_W - M - width(sub, 9.5, font), y: PAGE_H - 66, size: 9.5, font, color: rgb(0.85, 0.94, 0.88) });
  y = PAGE_H - 108;

  if (sheet.status === "WITHDRAWN") {
    y -= 6;
    para("WITHDRAWN - no longer shared with families. Do not distribute.", { bold: true, size: 10, color: rgb(0.65, 0.12, 0.12), gap: 0 });
    y += 6;
  }

  // ── Player
  y -= 24;
  page.drawCircle({ x: M + 20, y: y - 12, size: 20, color: TINT, borderColor: GREEN, borderWidth: 1.2 });
  const ini = clean(sheet.player.initials || "?");
  page.drawText(ini, { x: M + 20 - width(ini, 13, bold) / 2, y: y - 17, size: 13, font: bold, color: GREEN });
  encodable(sheet.player.name, bold);
  page.drawText(clean(sheet.player.name), { x: M + 52, y: y - 6, size: 17, font: bold, color: NAVY });
  const meta = [sheet.player.group, sheet.title].filter(Boolean).join("  ·  ");
  encodable(meta, font);
  page.drawText(clean(meta), { x: M + 52, y: y - 23, size: 9.5, font, color: MUTED });
  y -= 54;

  // ── Stat tiles
  const att = sheet.stats.percent === null ? "-" : `${sheet.stats.percent}%`;
  const tiles: [string, string, string][] = [
    ["Sessions conducted", String(sheet.stats.sessions), "recorded in this period"],
    ["Sessions attended", String(sheet.stats.attended), `of ${sheet.stats.sessions}`],
    ["Attendance", att, sheet.stats.percent === null ? "not recorded" : "of recorded sessions"],
    ["Activities completed", String(sheet.stats.activities), `${sheet.stats.skillAreas} skill area${sheet.stats.skillAreas === 1 ? "" : "s"}`],
  ];
  const gap = 8;
  const tw = (BODY_W - gap * 3) / 4;
  ensure(70);
  tiles.forEach(([label, value, note], i) => {
    const x = M + i * (tw + gap);
    page.drawRectangle({ x, y: y - 58, width: tw, height: 58, color: TINT, borderColor: RULE, borderWidth: 0.8 });
    page.drawText(label, { x: x + 9, y: y - 16, size: 7.8, font, color: MUTED });
    page.drawText(value, { x: x + 9, y: y - 40, size: 20, font: bold, color: GREEN });
    page.drawText(note, { x: x + 9, y: y - 52, size: 7.3, font, color: MUTED });
  });
  y -= 64;
  const caveat = attendanceCaveat(sheet);
  if (caveat) para(caveat, { size: 8.5, color: MUTED });

  // ── What the player practised
  heading("What the player practised");
  if (!sheet.practised.length)
    para("No training activity was recorded for this player in this period.", { color: MUTED });
  for (const g of sheet.practised) {
    ensure(34);
    para(g.label, { bold: true, size: 10.5, color: GREEN, gap: 1 });
    para(
      g.activities.map((a) => (a.times > 1 ? `${a.title} (x${a.times})` : a.title)).join(", "),
      { x: M + 10, size: 9.5, gap: 5 },
    );
  }

  // ── Progress compared with the period before (numbers only; what the records lack is listed, never hidden)
  const g = sheet.progress;
  if (g) {
    heading("Progress compared with the period before");
    const colX = [M + 4, M + 150, M + 330];
    const cell = (text: string, x: number, size: number, f: PDFFont, color: ReturnType<typeof rgb>, maxW: number, row: number) => {
      encodable(text, f);
      const lines = wrapLines(text, size, f, maxW);
      lines.forEach((ln, i) => page.drawText(ln, { x, y: row - i * (size + 2), size, font: f, color }));
      return lines.length;
    };
    const tableRow = (cells: [string, string, string], head = false) => {
      const size = head ? 8.5 : 9.5;
      const f = head ? bold : font;
      const maxW = [140, 170, PAGE_W - M - colX[2]];
      const need = Math.max(...cells.map((c, i) => wrapLines(c, size, f, maxW[i]).length)) * (size + 2) + 8;
      ensure(need + 4);
      y -= size + 6;
      if (head) page.drawRectangle({ x: M, y: y - 5, width: BODY_W, height: size + 10, color: TINT });
      const heights = cells.map((c, i) => cell(c, colX[i], size, i === 0 || head ? bold : font, head ? MUTED : INK, maxW[i], y));
      const extra = (Math.max(...heights) - 1) * (size + 2);
      y -= extra;
      page.drawLine({ start: { x: M, y: y - 5 }, end: { x: PAGE_W - M, y: y - 5 }, thickness: 0.5, color: RULE });
    };
    tableRow(["Measure", g.periodLabel, g.previousLabel], true);
    tableRow(["Attendance", g.attendance.now, g.attendance.before ?? "No sessions recorded"]);
    for (const r of g.practice) tableRow([`Practice: ${r.label.toLowerCase()}`, `${r.now} min`, r.before === null ? "-" : `${r.before} min`]);
    if (g.practice.length) tableRow(["Practice time in total", `${g.practiceTotal.now} min`, g.practiceTotal.before === null ? "-" : `${g.practiceTotal.before} min`]);
    y -= 8;
    if (g.attendance.change) para(`Attendance rate: ${g.attendance.change}.`, { size: 9, color: MUTED, gap: 2 });
    if (g.observationCounts.length)
      para(`Reviewed coaching observations this period: ${g.observationCounts.map((c) => `${c.label} ${c.count}`).join(", ")}.`, { size: 9, color: MUTED, gap: 2 });
    if (g.notRecorded.length) {
      ensure(34);
      para("Not recorded in this period", { bold: true, size: 9.5, color: GREEN, gap: 1 });
      for (const n of g.notRecorded) para(`- ${n}`, { x: M + 10, size: 9, color: MUTED, gap: 2 });
    }
    para("Figures come from the academy's records. They are counts and differences only.", { size: 8.5, color: MUTED, gap: 2 });
  }

  // ── Coach feedback
  heading("Coach feedback");
  const f = sheet.feedback;
  const block = (label: string, text: string) => {
    ensure(34);
    para(label, { bold: true, size: 10, color: GREEN, gap: 1 });
    para(text, { x: M + 10, gap: 6 });
  };
  block("Monthly summary", f.summary || "No coach summary recorded.");
  if (f.strengths) block("Strengths shown", f.strengths);
  if (f.improvements) block("Areas to improve", f.improvements);
  if (f.priorities.length) {
    ensure(34);
    para("Next month's development priorities", { bold: true, size: 10, color: GREEN, gap: 1 });
    f.priorities.forEach((p, i) => para(`${i + 1}. ${p}`, { x: M + 10, gap: 2 }));
    y -= 4;
  }
  if (f.closingNote) block("Coach's closing note", f.closingNote);
  if (sheet.observations.length) {
    ensure(34);
    para("Reviewed coaching observations", { bold: true, size: 10, color: GREEN, gap: 1 });
    for (const o of sheet.observations) para(`${dayLabel(o.date)}${o.category ? ` (${o.category})` : ""}: ${o.text}`, { x: M + 10, size: 9.5, gap: 3 });
    y -= 3;
  }

  // ── Recorded sessions
  heading("Recorded sessions");
  for (const s of sheet.sessions) {
    ensure(18);
    y -= 14;
    const status = ATTENDANCE_TEXT[s.attendance];
    const line = `${dayLabel(s.date)}   ${s.title}`;
    encodable(line, font);
    page.drawText(clean(line), { x: M + 4, y, size: 9.5, font, color: INK });
    page.drawText(status, { x: PAGE_W - M - width(status, 9.5, bold), y, size: 9.5, font: bold, color: s.attendance === "PRESENT" ? GREEN : MUTED });
    page.drawLine({ start: { x: M, y: y - 5 }, end: { x: PAGE_W - M, y: y - 5 }, thickness: 0.5, color: RULE });
  }

  // ── Approval + footer on every page
  y -= 16;
  para(sheet.reviewer ? `Reviewed and approved by ${sheet.reviewer}${sheet.approvedOn ? ` on ${dayLabel(sheet.approvedOn)}` : ""}.` : "Not yet approved.", {
    size: 9,
    color: MUTED,
  });
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 44 }, end: { x: PAGE_W - M, y: 44 }, thickness: 0.6, color: RULE });
    p.drawText(clean(`Sportozen Academy  ·  Generated ${dayLabel(sheet.generatedOn)}  ·  ${sheet.statusLabel}  ·  Revision ${sheet.revision}`), {
      x: M,
      y: 30,
      size: 8,
      font,
      color: MUTED,
    });
    const right = `Private - authorised recipients only  |  ${i + 1} / ${pages.length}`;
    p.drawText(right, { x: PAGE_W - M - width(right, 8, font), y: 30, size: 8, font, color: MUTED });
  });
  return pdf.save();
}

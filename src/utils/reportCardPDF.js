'use strict';

/**
 * Server-side PDF report card generator using pdfkit.
 * Matches the HTML ReportCardPrintPage layout as closely as possible
 * while using only the 14 built-in PDF core fonts (WinAnsiEncoding).
 *
 * Note: pdfkit built-in fonts (Helvetica, Times-Roman, Courier) do NOT
 * support Unicode symbols (checkmarks etc.) — we use plain ASCII text.
 */

const PDFDocument = require('pdfkit');

// ── Pakistani grading scale ───────────────────────────────────────────────
const GRADE_SCALE = [
  { grade: 'A1', min: 90, max: 100, label: 'Distinction', rgb: [21,  128, 61]  },
  { grade: 'A',  min: 80, max: 89,  label: 'Excellent',   rgb: [29,  78,  216] },
  { grade: 'B',  min: 70, max: 79,  label: 'Very Good',   rgb: [124, 58,  237] },
  { grade: 'C',  min: 60, max: 69,  label: 'Good',        rgb: [8,   145, 178] },
  { grade: 'D',  min: 50, max: 59,  label: 'Pass',        rgb: [217, 119, 6]   },
  { grade: 'F',  min: 0,  max: 49,  label: 'Fail',        rgb: [220, 38,  38]  },
];

function gradeRgb(grade) {
  return (GRADE_SCALE.find(s => s.grade === grade) || { rgb: [100, 116, 139] }).rgb;
}

function ordinal(n) {
  if (!n) return '-';
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function fmtMonth(d) {
  if (!d) return '-';
  try { return new Date(d).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
  catch { return '-'; }
}

function fmtDate(d) {
  try { return new Date(d).toLocaleDateString('en-US', { day: '2-digit', month: 'long', year: 'numeric' }); }
  catch { return '-'; }
}

// ── Draw one report card on the current PDF page ──────────────────────────
function drawReportCard(doc, { summary, subjects, settings }) {
  if (!summary) return;

  // A4 dimensions (points)
  const PW = 595.28;
  const ML = 28;                    // margin
  const CW = PW - ML * 2;          // content width  (539.28)
  const CH = 841.89 - ML * 2;      // content height (785.89) — full page

  const pct      = parseFloat(summary.percentage || 0);
  const isPassed = summary.result_status === 'pass';
  const SC       = isPassed ? [21, 128, 61] : [220, 38, 38];   // status colour
  const BC       = pct >= 80 ? [21, 128, 61] : pct >= 60 ? [217, 119, 6] : [220, 38, 38]; // bar colour
  const GC       = gradeRgb(summary.grade);

  const schoolName  = (settings?.school_name    || 'School Management System').toUpperCase();
  const schoolAddr  = settings?.school_address  || '';
  const schoolPhone = settings?.school_phone    || '';
  const schoolEmail = settings?.school_email    || '';

  // ── Double border (full content height so it always encloses everything) ─
  doc.rect(ML, ML, CW, CH).lineWidth(2.5).stroke('#1e293b');
  doc.rect(ML + 5, ML + 5, CW - 10, CH - 10).lineWidth(0.8).stroke('#1e293b');

  const IP = 10;                    // inner padding
  const IX = ML + 5 + IP;          // inner x
  const IW = CW - 10 - IP * 2;     // inner width (509.28)

  let y = ML + 5 + IP;

  // ── HEADER ────────────────────────────────────────────────────────────────
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#0f172a')
     .text(schoolName, IX, y, { width: IW, align: 'center', characterSpacing: 0.5 });
  y += 17;

  if (schoolAddr) {
    doc.fontSize(7.5).font('Helvetica').fillColor('#475569')
       .text(schoolAddr, IX, y, { width: IW, align: 'center' });
    y += 10;
  }

  const contact = [schoolPhone && `Tel: ${schoolPhone}`, schoolEmail].filter(Boolean).join('   |   ');
  if (contact) {
    doc.fontSize(7).font('Helvetica').fillColor('#64748b')
       .text(contact, IX, y, { width: IW, align: 'center' });
    y += 10;
  }

  // Title bar
  const tBarW = 200, tBarH = 14;
  doc.rect(IX + (IW - tBarW) / 2, y, tBarW, tBarH).fill('#1e293b');
  doc.fontSize(7).font('Helvetica-Bold').fillColor('#ffffff')
     .text('RESULT CARD / REPORT OF PROGRESS', IX, y + 4, { width: IW, align: 'center', characterSpacing: 0.8 });
  y += tBarH + 4;

  // PASS / FAIL stamp — anchored top-right of inner content
  const stW = 58, stH = 18;
  const stX = IX + IW - stW, stY = ML + 5 + IP;
  doc.rect(stX, stY, stW, stH).lineWidth(1.5).stroke(SC);
  doc.fontSize(8).font('Helvetica-Bold').fillColor(SC)
     .text(isPassed ? 'PASS' : 'FAIL', stX, stY + 5, { width: stW, align: 'center' });

  // Separator
  doc.moveTo(IX, y).lineTo(IX + IW, y).lineWidth(1.5).stroke('#1e293b');
  y += 5;

  // ── STUDENT INFO BAND ─────────────────────────────────────────────────────
  const infoH = 52;
  doc.rect(IX, y, IW, infoH).fill('#f8fafc');
  doc.rect(IX, y, IW, infoH).lineWidth(0.5).stroke('#e2e8f0');

  const c1 = 72, c2 = 108, c3 = 72;
  const c4 = IW - c1 - c2 - c3 - 8;
  const midX = IX + c1 + c2 + 8;

  const infoRows = [
    ['Student Name',   (summary.full_name   || '-').slice(0, 35), 'Exam',          (summary.exam_name || '-').slice(0, 35)],
    ["Father's Name",  (summary.father_name || '-').slice(0, 35), 'Class',
      [summary.class_name || summary.grade || '-', summary.section ? `- ${summary.section}` : ''].filter(Boolean).join(' ')],
    ['Roll Number',    summary.roll_number  || '-',               'Academic Year', summary.academic_year || '-'],
    ['Exam Period',    `${fmtMonth(summary.start_date)} - ${fmtMonth(summary.end_date)}`,
      'Class Position',
      summary.position && summary.total_students
        ? `${ordinal(summary.position)} of ${summary.total_students}`
        : '-'],
  ];

  infoRows.forEach((row, i) => {
    const ry = y + 4 + i * 11.5;
    doc.fontSize(7).font('Helvetica').fillColor('#64748b').text(`${row[0]}:`, IX + 4, ry, { width: c1 - 4 });
    doc.fontSize(7).font('Helvetica-Bold').fillColor('#0f172a').text(row[1], IX + c1, ry, { width: c2 - 4, ellipsis: true });
    doc.fontSize(7).font('Helvetica').fillColor('#64748b').text(`${row[2]}:`, midX, ry, { width: c3 - 2 });
    doc.fontSize(7).font('Helvetica-Bold').fillColor(i === 3 ? [29, 78, 216] : '#0f172a')
       .text(row[3], midX + c3, ry, { width: c4 - 4, ellipsis: true });
  });
  y += infoH + 5;

  // ── SUBJECT TABLE ─────────────────────────────────────────────────────────
  const cols = [
    { label: 'Subject',  w: Math.round(IW * 0.24), align: 'left'   },
    { label: 'Max',      w: Math.round(IW * 0.08), align: 'center' },
    { label: 'Pass',     w: Math.round(IW * 0.07), align: 'center' },
    { label: 'Obtained', w: Math.round(IW * 0.09), align: 'center' },
    { label: '%',        w: Math.round(IW * 0.08), align: 'center' },
    { label: 'Grade',    w: Math.round(IW * 0.08), align: 'center' },
    { label: 'Remarks',  w: Math.round(IW * 0.22), align: 'left'   },
    { label: 'Result',   w: 0,                      align: 'center' },
  ];
  cols[7].w = IW - cols.slice(0, 7).reduce((s, c) => s + c.w, 0);

  const rH = 13, hH = 13;

  // Header row
  doc.rect(IX, y, IW, hH).fill('#1e293b');
  let cx = IX;
  cols.forEach(col => {
    doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#f1f5f9')
       .text(col.label.toUpperCase(), cx + 2, y + 4, { width: col.w - 4, align: col.align });
    cx += col.w;
  });
  y += hH;

  // Subject rows
  subjects.forEach((s, i) => {
    const bg  = s.subject_status === 'fail' ? '#fff1f2' : (i % 2 === 0 ? '#ffffff' : '#f8fafc');
    const sRgb = gradeRgb(s.subject_grade);
    const rClr = s.subject_status === 'fail' ? [220, 38, 38] : s.is_absent ? [100, 116, 139] : [21, 128, 61];

    doc.rect(IX, y, IW, rH).fill(bg);

    const cells = [
      { text: (s.subject_name || '-') + (s.subject_code ? ` (${s.subject_code})` : ''), font: 'Helvetica-Bold', color: '#1e293b' },
      { text: String(s.total_marks   ?? '-'), font: 'Helvetica',      color: '#1e293b' },
      { text: String(s.passing_marks ?? '-'), font: 'Helvetica',      color: '#1e293b' },
      { text: s.is_absent ? 'ABS'  : String(s.obtained_marks ?? '-'), font: 'Helvetica-Bold', color: '#0f172a' },
      { text: s.is_absent ? '-'    : `${s.subject_percentage ?? '-'}%`, font: 'Helvetica',   color: '#1e293b' },
      { text: s.subject_grade      || '-', font: 'Helvetica-Bold', color: sRgb  },
      { text: (s.remarks           || '').slice(0, 40), font: 'Helvetica', color: '#475569'  },
      { text: s.is_absent ? 'ABSENT' : (s.subject_status === 'pass' ? 'PASS' : 'FAIL'), font: 'Helvetica-Bold', color: rClr },
    ];

    cx = IX;
    cells.forEach((cell, ci) => {
      doc.fontSize(7).font(cell.font).fillColor(cell.color)
         .text(cell.text, cx + 2, y + 3, { width: cols[ci].w - 4, align: cols[ci].align, ellipsis: true });
      cx += cols[ci].w;
    });
    doc.moveTo(IX, y + rH).lineTo(IX + IW, y + rH).lineWidth(0.25).stroke('#e2e8f0');
    y += rH;
  });

  // Grand total row
  const passedN = subjects.filter(s => s.subject_status === 'pass').length;
  const failedN = subjects.filter(s => s.subject_status === 'fail').length;
  const totH    = 15;
  doc.rect(IX, y, IW, totH).fill('#f1f5f9');
  doc.moveTo(IX, y).lineTo(IX + IW, y).lineWidth(1).stroke('#94a3b8');

  const totCells = [
    { text: 'GRAND TOTAL',                                font: 'Helvetica-Bold', color: '#0f172a' },
    { text: String(summary.total_marks    ?? '-'),        font: 'Helvetica-Bold', color: '#0f172a' },
    { text: '-',                                          font: 'Helvetica',      color: '#64748b' },
    { text: String(summary.obtained_marks ?? '-'),        font: 'Helvetica-Bold', color: '#0f172a' },
    { text: `${pct}%`,                                   font: 'Helvetica-Bold', color: '#0f172a' },
    { text: summary.grade || '-',                         font: 'Helvetica-Bold', color: GC        },
    { text: `${passedN} passed / ${failedN} failed`,      font: 'Helvetica',      color: '#475569' },
    { text: isPassed ? 'PASS' : 'FAIL',                   font: 'Helvetica-Bold', color: SC        },
  ];
  cx = IX;
  totCells.forEach((cell, ci) => {
    doc.fontSize(7.5).font(cell.font).fillColor(cell.color)
       .text(cell.text, cx + 2, y + 4, { width: cols[ci].w - 4, align: cols[ci].align });
    cx += cols[ci].w;
  });
  y += totH + 6;

  // ── SUMMARY CARDS ─────────────────────────────────────────────────────────
  const sCards = [
    { label: 'Total Marks',    value: `${summary.obtained_marks}/${summary.total_marks}`, color: '#0f172a' },
    { label: 'Percentage',     value: `${pct}%`,                                          color: BC        },
    { label: 'Grade',          value: summary.grade || '-',                                color: GC        },
    { label: 'Class Position', value: summary.position ? ordinal(summary.position) : '-', color: [29, 78, 216] },
    { label: 'Result',         value: isPassed ? 'PASS' : 'FAIL',                         color: SC        },
  ];
  const scW = Math.floor(IW / sCards.length);
  const scH = 30;

  sCards.forEach((sc, i) => {
    const sx = IX + i * scW;
    doc.rect(sx, y, scW, scH).lineWidth(0.4).stroke('#e2e8f0');
    doc.fontSize(6).font('Helvetica').fillColor('#64748b')
       .text(sc.label.toUpperCase(), sx + 2, y + 4, { width: scW - 4, align: 'center' });
    doc.fontSize(10).font('Helvetica-Bold').fillColor(sc.color)
       .text(sc.value, sx + 2, y + 13, { width: scW - 4, align: 'center' });
  });
  y += scH + 6;

  // ── PROGRESS BAR ──────────────────────────────────────────────────────────
  doc.fontSize(7).font('Helvetica').fillColor('#64748b').text('Overall Performance', IX, y, { width: IW / 2 });
  doc.fontSize(7).font('Helvetica-Bold').fillColor(BC).text(`${pct}%`, IX, y, { width: IW, align: 'right' });
  y += 10;
  doc.rect(IX, y, IW, 6).fill('#e2e8f0');
  if (pct > 0) doc.rect(IX, y, IW * Math.min(pct, 100) / 100, 6).fill(BC);
  y += 6 + 5;

  // ── GRADE SCALE TABLE ─────────────────────────────────────────────────────
  const gsBoxH = 34;
  doc.rect(IX, y, IW, gsBoxH).fill('#f8fafc');
  doc.rect(IX, y, IW, gsBoxH).lineWidth(0.5).stroke('#e2e8f0');
  doc.fontSize(6).font('Helvetica-Bold').fillColor('#475569')
     .text('GRADING SCALE  (PAKISTANI EDUCATION SYSTEM)', IX + 4, y + 3, { characterSpacing: 0.3 });
  y += 12;

  const gsW = Math.floor(IW / GRADE_SCALE.length);
  GRADE_SCALE.forEach((gs, i) => {
    const gx = IX + i * gsW;
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(gs.rgb)
       .text(gs.grade, gx + 2, y + 1, { width: gsW - 4, align: 'center' });
    doc.fontSize(5.5).font('Helvetica').fillColor(gs.rgb)
       .text(`${gs.min}-${gs.max}%`, gx + 2, y + 9, { width: gsW - 4, align: 'center' });
    doc.fontSize(5.5).fillColor(gs.rgb)
       .text(gs.label, gx + 2, y + 16, { width: gsW - 4, align: 'center' });
  });
  y += 22 + 6;

  // ── TEACHER REMARKS ───────────────────────────────────────────────────────
  const remarkSubs = subjects.filter(s => s.remarks);
  if (remarkSubs.length > 0) {
    doc.moveTo(IX, y).lineTo(IX + IW, y).lineWidth(0.5).stroke('#cbd5e1');
    y += 4;
    doc.fontSize(7).font('Helvetica-Bold').fillColor('#475569').text("TEACHER'S REMARKS:", IX, y);
    y += 10;
    remarkSubs.forEach(s => {
      doc.fontSize(7).font('Helvetica-Bold').fillColor('#334155')
         .text(`${s.subject_name}: `, IX, y, { continued: true });
      doc.font('Helvetica').fillColor('#334155').text(s.remarks || '');
      y += 10;
    });
    y += 3;
  }

  // ── SIGNATURE ROW ─────────────────────────────────────────────────────────
  doc.moveTo(IX, y).lineTo(IX + IW, y).lineWidth(0.5).stroke('#e2e8f0');
  y += 10;

  const sigW = Math.floor(IW / 3);
  [
    { label: 'Class Teacher',     note: null,                  align: 'left'   },
    { label: 'Parent / Guardian', note: 'Signature with date', align: 'center' },
    { label: 'Principal',         note: null,                  align: 'right'  },
  ].forEach(({ label, note, align }, i) => {
    const sx = IX + i * sigW;
    const lineY = y + 18;
    // Position signature line within each third
    const x1 = align === 'left'   ? sx          : align === 'right' ? sx + sigW * 0.3 : sx + sigW * 0.1;
    const x2 = align === 'left'   ? sx + sigW * 0.7 : align === 'right' ? sx + sigW    : sx + sigW * 0.9;
    doc.moveTo(x1, lineY).lineTo(x2, lineY).lineWidth(0.8).stroke('#64748b');
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#1e293b')
       .text(label.toUpperCase(), sx, lineY + 3, { width: sigW, align });
    if (note) {
      doc.fontSize(6.5).font('Helvetica').fillColor('#94a3b8')
         .text(note, sx, lineY + 11, { width: sigW, align });
    }
  });
  y += 32;

  // ── FOOTER ────────────────────────────────────────────────────────────────
  doc.moveTo(IX, y).lineTo(IX + IW, y).lineWidth(0.25).stroke('#f1f5f9');
  y += 3;
  doc.fontSize(6.5).font('Helvetica').fillColor('#94a3b8')
     .text(`Issued: ${fmtDate(new Date())}`, IX, y, { width: IW / 2 });
  doc.fontSize(6.5).fillColor('#94a3b8')
     .text('This is a computer-generated result card.', IX, y, { width: IW, align: 'right' });
}

// ── Public: create a pdfkit Document stream with one student per page ─────
function createReportCardPDF(cards) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });

  cards.forEach((card, i) => {
    doc.addPage({ size: 'A4', margin: 0 });
    drawReportCard(doc, card);
  });

  doc.end();
  return doc; // Readable stream — pipe to res
}

module.exports = { createReportCardPDF };

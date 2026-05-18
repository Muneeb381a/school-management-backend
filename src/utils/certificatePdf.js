'use strict';

const PDFDocument = require('pdfkit');

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '-';
  try { return new Date(d).toLocaleDateString('en-PK', { day: '2-digit', month: 'long', year: 'numeric' }); }
  catch { return '-'; }
}

function fmtYear(d) {
  if (!d) return '-';
  try { return new Date(d).getFullYear().toString(); }
  catch { return '-'; }
}

// ── Shared: draw school letterhead ────────────────────────────────────────────
function drawLetterhead(doc, settings, subtitle) {
  const PW = 595.28;
  const ML = 40;
  const CW = PW - ML * 2;
  const NAVY = [15, 40, 100];
  const GOLD = [180, 140, 30];

  // Top border bar
  doc.rect(0, 0, PW, 8).fill(NAVY);

  // School name
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16)
     .text(settings.school_name || 'School Management System', ML, 24, { align: 'center', width: CW });

  // School address / phone
  const meta = [settings.school_address, settings.school_phone, settings.school_email]
    .filter(Boolean).join('   •   ');
  if (meta) {
    doc.fillColor([80, 80, 80]).font('Helvetica').fontSize(8.5)
       .text(meta, ML, 44, { align: 'center', width: CW });
  }

  // Subtitle (document title)
  doc.moveDown(0.3);
  const titleY = meta ? 58 : 50;
  doc.rect(ML, titleY, CW, 22).fill(NAVY);
  doc.fillColor([255, 255, 255]).font('Helvetica-Bold').fontSize(10)
     .text(subtitle.toUpperCase(), ML, titleY + 5, { align: 'center', width: CW });

  // Bottom gold line
  doc.rect(ML, titleY + 22, CW, 2).fill(GOLD);

  return titleY + 28; // return Y position after letterhead
}

// ── Shared: draw a two-column info row ────────────────────────────────────────
function infoRow(doc, x, y, width, label, value, opts = {}) {
  const lw = opts.labelWidth || width * 0.38;
  const vw = width - lw - 8;
  doc.fillColor([90, 90, 90]).font('Helvetica').fontSize(9).text(label + ':', x, y, { width: lw });
  doc.fillColor([20, 20, 20]).font('Helvetica-Bold').fontSize(9)
     .text(value || '-', x + lw + 8, y, { width: vw, ellipsis: true });
  return y + 16;
}

// ── Shared: section heading ───────────────────────────────────────────────────
function sectionHead(doc, x, y, width, text) {
  const NAVY = [15, 40, 100];
  doc.rect(x, y, width, 16).fill([235, 240, 255]);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9)
     .text(text.toUpperCase(), x + 6, y + 3, { width: width - 12 });
  return y + 20;
}

// ── Transfer Certificate PDF ──────────────────────────────────────────────────
function streamTcPdf(res, { student, settings, certNo, issuedAt }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="TC-${student.admission_number || student.id}.pdf"`);
  doc.pipe(res);

  const ML  = 40;
  const PW  = 595.28;
  const CW  = PW - ML * 2;
  const NAVY = [15, 40, 100];

  let y = drawLetterhead(doc, settings, 'Transfer Certificate');
  y += 6;

  // Cert no + date block (top right)
  doc.fillColor([90, 90, 90]).font('Helvetica').fontSize(8)
     .text(`Cert No: ${certNo}`, ML, y, { align: 'right', width: CW })
     .text(`Date Issued: ${fmtDate(issuedAt)}`, ML, y + 10, { align: 'right', width: CW });
  y += 26;

  // ── Student particulars ───────────────────────────────────────────────────
  y = sectionHead(doc, ML, y, CW, 'Student Particulars');
  const half = (CW - 10) / 2;

  // Two-column layout
  let lyL = y, lyR = y;
  lyL = infoRow(doc, ML,            lyL, half, 'Name of Student',  student.full_name);
  lyL = infoRow(doc, ML,            lyL, half, 'Father\'s Name',   student.father_name);
  lyL = infoRow(doc, ML,            lyL, half, 'Mother\'s Name',   student.mother_name);
  lyL = infoRow(doc, ML,            lyL, half, 'Date of Birth',    fmtDate(student.date_of_birth));
  lyL = infoRow(doc, ML,            lyL, half, 'CNIC / B-Form',    student.cnic);

  lyR = infoRow(doc, ML + half + 10, lyR, half, 'Admission No',    student.admission_number);
  lyR = infoRow(doc, ML + half + 10, lyR, half, 'Roll Number',     student.roll_number);
  lyR = infoRow(doc, ML + half + 10, lyR, half, 'Date of Admission', fmtDate(student.admission_date));
  lyR = infoRow(doc, ML + half + 10, lyR, half, 'Address',         student.address);
  lyR = infoRow(doc, ML + half + 10, lyR, half, 'Phone',           student.phone || student.father_phone);

  y = Math.max(lyL, lyR) + 6;

  // ── Academic record ───────────────────────────────────────────────────────
  y = sectionHead(doc, ML, y, CW, 'Academic Record');
  y = infoRow(doc, ML, y, CW, 'Last Class Attended',        [student.class_name, student.section].filter(Boolean).join(' – ') || '-');
  y = infoRow(doc, ML, y, CW, 'Academic Year',              student.academic_year || fmtYear(new Date()));
  y = infoRow(doc, ML, y, CW, 'Medium of Instruction',      settings.medium_of_instruction || 'English');
  y = infoRow(doc, ML, y, CW, 'Result in Last Examination', student.last_result || 'Pass');
  y = infoRow(doc, ML, y, CW, 'Total School Days',          student.total_days   || '-');
  y = infoRow(doc, ML, y, CW, 'Days Present',               student.days_present || '-');
  y += 4;

  // ── Leaving details ───────────────────────────────────────────────────────
  y = sectionHead(doc, ML, y, CW, 'Leaving Details');
  y = infoRow(doc, ML, y, CW, 'Date of Leaving',    fmtDate(student.leaving_date || issuedAt));
  y = infoRow(doc, ML, y, CW, 'Reason for Leaving', student.leaving_reason || 'On parent\'s request');
  y = infoRow(doc, ML, y, CW, 'Character',          student.character_assessment || 'Good');
  y += 4;

  // ── Fee clearance ─────────────────────────────────────────────────────────
  y = sectionHead(doc, ML, y, CW, 'Fee Clearance');
  const feeStatus = student.outstanding_fee && parseFloat(student.outstanding_fee) > 0
    ? `Outstanding Balance: PKR ${parseFloat(student.outstanding_fee).toFixed(2)}`
    : 'All dues cleared';
  y = infoRow(doc, ML, y, CW, 'Fee Status', feeStatus);
  y += 12;

  // ── Certification text ────────────────────────────────────────────────────
  doc.rect(ML, y, CW, 1).fill([200, 200, 200]);
  y += 8;
  doc.fillColor([50, 50, 50]).font('Helvetica').fontSize(8.5)
     .text(
       'This Transfer Certificate is issued on the request of the parent/guardian. ' +
       'The school certifies that the above information is true and correct to the best of its knowledge.',
       ML, y, { width: CW, align: 'justify' }
     );
  y += 30;

  // ── Signatures ────────────────────────────────────────────────────────────
  const sigW = CW / 3;
  const sigs = ['Class Teacher', 'Principal', 'School Stamp'];
  sigs.forEach((label, i) => {
    const sx = ML + i * sigW;
    doc.rect(sx + 10, y + 30, sigW - 20, 1).fill([150, 150, 150]);
    doc.fillColor([80, 80, 80]).font('Helvetica').fontSize(8)
       .text(label, sx, y + 34, { width: sigW, align: 'center' });
  });

  // Bottom page border
  doc.rect(0, 841.89 - 8, PW, 8).fill(NAVY);

  doc.end();
}

// ── Admission Confirmation Letter PDF ─────────────────────────────────────────
function streamAdmissionLetterPdf(res, { student, settings, certNo, issuedAt }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Admission-${student.admission_number || student.id}.pdf"`);
  doc.pipe(res);

  const ML   = 40;
  const PW   = 595.28;
  const CW   = PW - ML * 2;
  const NAVY = [15, 40, 100];

  let y = drawLetterhead(doc, settings, 'Admission Confirmation Letter');
  y += 10;

  // Ref + date
  doc.fillColor([90, 90, 90]).font('Helvetica').fontSize(8.5)
     .text(`Ref: ${certNo}`, ML, y)
     .text(`Date: ${fmtDate(issuedAt)}`, ML, y, { align: 'right', width: CW });
  y += 20;

  // Addressee
  doc.fillColor([20, 20, 20]).font('Helvetica-Bold').fontSize(9.5)
     .text('To,', ML, y);
  y += 14;
  doc.font('Helvetica').fontSize(9.5)
     .text(student.father_name || 'Parent / Guardian', ML, y)
     .text(student.address     || '', ML, y + 13);
  y += 34;

  // Subject line
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10)
     .text(`Subject: Admission Confirmation – ${student.full_name}`, ML, y);
  doc.rect(ML, y + 14, CW, 1).fill([200, 200, 200]);
  y += 22;

  // Salutation
  doc.fillColor([20, 20, 20]).font('Helvetica').fontSize(9.5)
     .text(`Dear ${student.father_name ? `Mr./Ms. ${student.father_name}` : 'Parent/Guardian'},`, ML, y);
  y += 18;

  // Opening paragraph
  doc.fontSize(9.5)
     .text(
       `We are pleased to confirm the admission of your ward `,
       ML, y, { continued: true }
     )
     .font('Helvetica-Bold').text(student.full_name || 'the student', { continued: true })
     .font('Helvetica').text(
       ` to ${settings.school_name || 'our school'}. ` +
       `The details of admission are as follows:`,
       { width: CW }
     );
  y += 36;

  // ── Admission details ─────────────────────────────────────────────────────
  y = sectionHead(doc, ML, y, CW, 'Admission Details');
  y = infoRow(doc, ML, y, CW, 'Admission Number',   student.admission_number);
  y = infoRow(doc, ML, y, CW, 'Student Name',       student.full_name);
  y = infoRow(doc, ML, y, CW, 'Father\'s Name',     student.father_name);
  y = infoRow(doc, ML, y, CW, 'Date of Birth',      fmtDate(student.date_of_birth));
  y = infoRow(doc, ML, y, CW, 'Class Admitted',     [student.class_name, student.section].filter(Boolean).join(' – ') || '-');
  y = infoRow(doc, ML, y, CW, 'Academic Session',   student.academic_year || fmtYear(new Date()));
  y = infoRow(doc, ML, y, CW, 'Date of Admission',  fmtDate(student.admission_date || issuedAt));
  y += 6;

  // ── Important instructions ────────────────────────────────────────────────
  y = sectionHead(doc, ML, y, CW, 'Important Instructions');
  const instructions = [
    'Please bring this letter on the first day of school along with original documents.',
    'Fee must be paid by the due date each month to avoid late charges.',
    'Students must wear the school uniform from the first day.',
    'Any change in contact information should be reported to the school office immediately.',
  ];
  instructions.forEach(inst => {
    doc.fillColor([40, 40, 40]).font('Helvetica').fontSize(8.5)
       .text(`•  ${inst}`, ML + 6, y, { width: CW - 12 });
    y += 14;
  });
  y += 6;

  // Closing paragraph
  doc.fillColor([20, 20, 20]).font('Helvetica').fontSize(9.5)
     .text(
       `We warmly welcome ${student.full_name || 'your child'} to the ${settings.school_name || 'school'} family ` +
       `and look forward to a rewarding academic journey ahead.`,
       ML, y, { width: CW }
     );
  y += 36;

  // ── Signatures ────────────────────────────────────────────────────────────
  const sigW = CW / 2;
  [['Prepared by', 'Admission Office'], ['Authorised by', settings.principal_name || 'Principal']].forEach(([role, name], i) => {
    const sx = ML + i * sigW;
    doc.fillColor([80, 80, 80]).font('Helvetica').fontSize(8)
       .text(name, sx, y + 4, { width: sigW - 10, align: i === 0 ? 'left' : 'right' });
    doc.rect(sx + (i === 1 ? 10 : 0), y + 30, sigW - 20, 1).fill([150, 150, 150]);
    doc.fillColor([80, 80, 80]).font('Helvetica').fontSize(7.5)
       .text(role, sx, y + 34, { width: sigW, align: i === 0 ? 'left' : 'right' });
  });

  // Bottom page border
  doc.rect(0, 841.89 - 8, PW, 8).fill(NAVY);

  doc.end();
}

module.exports = { streamTcPdf, streamAdmissionLetterPdf };

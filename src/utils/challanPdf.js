'use strict';

const PDFDocument = require('pdfkit');

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n) {
  return parseFloat(n || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '-';
  try { return new Date(d).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return '-'; }
}

function fmtMonth(d) {
  if (!d) return '-';
  try { return new Date(d).toLocaleDateString('en-PK', { month: 'long', year: 'numeric' }); }
  catch { return '-'; }
}

// ── Draw one challan copy (fits in a given Y-band on the page) ───────────────
// copyLabel: 'Bank Copy' | 'School Copy' | 'Student Copy'
// top: Y-coordinate where this copy starts
// copyHeight: pixels allocated to this copy
function drawCopy(doc, { invoice, items, settings }, copyLabel, top, copyHeight) {
  const PW = 595.28;
  const ML = 20;
  const CW = PW - ML * 2;

  const GREEN  = [0, 102, 51];
  const DARK   = [30, 30, 30];
  const GREY   = [90, 90, 90];
  const LGREY  = [220, 220, 220];
  const WHITE  = [255, 255, 255];
  const RED    = [180, 0, 0];

  const currency = settings.currency || 'PKR';
  const net      = parseFloat(invoice.net_amount || 0);
  const balance  = parseFloat(invoice.balance    || 0);
  const isPaid   = invoice.status === 'paid';

  // ── Outer border ──────────────────────────────────────────────────────────
  doc.save()
     .rect(ML, top, CW, copyHeight - 4)
     .lineWidth(1)
     .strokeColor(LGREY)
     .stroke();

  // ── Header band ───────────────────────────────────────────────────────────
  const headerH = 48;
  doc.rect(ML, top, CW, headerH).fill(GREEN);

  // School name (left)
  doc.fillColor(WHITE)
     .font('Helvetica-Bold').fontSize(11)
     .text(settings.school_name || 'School', ML + 8, top + 8, { width: CW * 0.55 });

  doc.fillColor([200, 255, 200])
     .font('Helvetica').fontSize(8)
     .text(settings.school_address || '', ML + 8, top + 22, { width: CW * 0.55 });

  doc.fillColor([200, 255, 200])
     .fontSize(7.5)
     .text(
       [settings.school_phone, settings.school_email].filter(Boolean).join('  |  '),
       ML + 8, top + 34, { width: CW * 0.55 }
     );

  // Copy label badge (right)
  const badgeW = 88;
  const badgeX = ML + CW - badgeW - 6;
  doc.roundedRect(badgeX, top + 10, badgeW, 22, 4).fill([255, 255, 255, 0.2]);
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(9)
     .text(copyLabel, badgeX, top + 16, { width: badgeW, align: 'center' });

  // "FEE CHALLAN" title (center-right band)
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(13)
     .text('FEE CHALLAN', ML + CW * 0.55, top + 14, { width: CW * 0.3, align: 'center' });

  // ── Info row ──────────────────────────────────────────────────────────────
  const infoY  = top + headerH + 5;
  const colW   = CW / 4;

  const infoItems = [
    { label: 'Invoice No',      value: invoice.invoice_no       || '-' },
    { label: 'Student',         value: invoice.student_name     || '-' },
    { label: 'Father',          value: invoice.father_name      || '-' },
    { label: 'Roll No',         value: invoice.roll_number      || '-' },
    { label: 'Class',           value: [invoice.class_name, invoice.section].filter(Boolean).join(' - ') || '-' },
    { label: 'Month',           value: fmtMonth(invoice.billing_month) },
    { label: 'Issue Date',      value: fmtDate(invoice.issued_at) },
    { label: 'Due Date',        value: fmtDate(invoice.due_date) },
  ];

  infoItems.forEach((item, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x   = ML + col * colW + 6;
    const y   = infoY + row * 22;

    doc.fillColor(GREY).font('Helvetica').fontSize(7).text(item.label, x, y);
    doc.fillColor(DARK).font('Helvetica-Bold').fontSize(8).text(item.value, x, y + 8, { width: colW - 8, ellipsis: true });
  });

  // Separator line
  const sepY = infoY + 2 * 22 + 6;
  doc.moveTo(ML, sepY).lineTo(ML + CW, sepY).strokeColor(LGREY).lineWidth(0.5).stroke();

  // ── Fee items table ───────────────────────────────────────────────────────
  const tableTop  = sepY + 4;
  const rowH      = 14;
  const descW     = CW * 0.65;
  const amtW      = CW * 0.35;

  // Table header
  doc.rect(ML, tableTop, CW, rowH).fill([240, 245, 240]);
  doc.fillColor(DARK).font('Helvetica-Bold').fontSize(7.5)
     .text('Description', ML + 6, tableTop + 3, { width: descW - 6 })
     .text(`Amount (${currency})`, ML + descW, tableTop + 3, { width: amtW - 6, align: 'right' });

  let rowY = tableTop + rowH;
  (items || []).filter(it => !it.is_waived).forEach((item, idx) => {
    if (idx % 2 === 1) doc.rect(ML, rowY, CW, rowH).fill([250, 253, 250]);
    const desc = item.description || item.head_name || 'Fee';
    doc.fillColor(DARK).font('Helvetica').fontSize(7.5)
       .text(desc, ML + 6, rowY + 3, { width: descW - 6, ellipsis: true })
       .text(fmt(item.amount), ML + descW, rowY + 3, { width: amtW - 6, align: 'right' });
    rowY += rowH;
  });

  // Separator before totals
  doc.moveTo(ML, rowY).lineTo(ML + CW, rowY).strokeColor(LGREY).lineWidth(0.5).stroke();
  rowY += 3;

  // Fine / discount rows if non-zero
  if (parseFloat(invoice.fine_amount || 0) > 0) {
    doc.fillColor(RED).font('Helvetica').fontSize(7.5)
       .text('Fine / Late Fee', ML + 6, rowY + 2, { width: descW - 6 })
       .text(fmt(invoice.fine_amount), ML + descW, rowY + 2, { width: amtW - 6, align: 'right' });
    rowY += rowH;
  }
  if (parseFloat(invoice.discount_amount || 0) > 0) {
    doc.fillColor([0, 120, 0]).font('Helvetica').fontSize(7.5)
       .text('Discount', ML + 6, rowY + 2, { width: descW - 6 })
       .text('- ' + fmt(invoice.discount_amount), ML + descW, rowY + 2, { width: amtW - 6, align: 'right' });
    rowY += rowH;
  }
  if (parseFloat(invoice.paid_amount || 0) > 0 && !isPaid) {
    doc.fillColor(GREY).font('Helvetica').fontSize(7.5)
       .text('Already Paid', ML + 6, rowY + 2, { width: descW - 6 })
       .text('- ' + fmt(invoice.paid_amount), ML + descW, rowY + 2, { width: amtW - 6, align: 'right' });
    rowY += rowH;
  }

  // Net payable highlight row
  rowY += 2;
  doc.rect(ML, rowY, CW, 18).fill(GREEN);
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(9)
     .text('NET PAYABLE', ML + 6, rowY + 4, { width: descW - 6 })
     .text(`${currency} ${fmt(isPaid ? 0 : balance)}`, ML + descW, rowY + 4, { width: amtW - 6, align: 'right' });
  rowY += 18;

  // ── Bank info ─────────────────────────────────────────────────────────────
  if (settings.bank_name) {
    rowY += 5;
    doc.moveTo(ML, rowY).lineTo(ML + CW, rowY).strokeColor(LGREY).lineWidth(0.5).stroke();
    rowY += 4;

    const bankLine = [
      settings.bank_name,
      settings.bank_account_title && `A/C: ${settings.bank_account_title}`,
      settings.bank_account_no    && `#${settings.bank_account_no}`,
      settings.bank_iban          && `IBAN: ${settings.bank_iban}`,
      settings.bank_branch        && `Branch: ${settings.bank_branch}`,
    ].filter(Boolean).join('   |   ');

    doc.fillColor(GREY).font('Helvetica').fontSize(7).text('Bank Details: ', ML + 6, rowY, { continued: true })
       .fillColor(DARK).font('Helvetica-Bold').text(bankLine, { width: CW - 12 });
    rowY += 12;
  }

  // ── Status stamp ──────────────────────────────────────────────────────────
  if (isPaid) {
    doc.save()
       .translate(ML + CW - 80, top + copyHeight - 70)
       .rotate(-30)
       .fontSize(22)
       .fillColor([0, 150, 0])
       .fillOpacity(0.25)
       .font('Helvetica-Bold')
       .text('PAID', 0, 0)
       .restore();
  } else if (new Date(invoice.due_date) < new Date()) {
    doc.save()
       .translate(ML + CW - 80, top + copyHeight - 70)
       .rotate(-30)
       .fontSize(22)
       .fillColor([180, 0, 0])
       .fillOpacity(0.25)
       .font('Helvetica-Bold')
       .text('OVERDUE', 0, 0)
       .restore();
  }

  // Dashed cut line at bottom
  const cutY = top + copyHeight - 2;
  doc.moveTo(ML, cutY).lineTo(ML + CW, cutY)
     .dash(4, { space: 3 }).strokeColor([180, 180, 180]).lineWidth(0.7).stroke().undash();
}

// ── Public: stream a 3-copy challan PDF to the response ─────────────────────
function streamChallanPdf(res, data) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="challan-${data.invoice.invoice_no}.pdf"`
  );
  doc.pipe(res);

  // A4 = 841.89 points tall. Three equal copies with small padding.
  const PH        = 841.89;
  const copyH     = Math.floor(PH / 3);
  const copies    = ['Bank Copy', 'School Copy', 'Student Copy'];

  copies.forEach((label, i) => {
    drawCopy(doc, data, label, i * copyH, copyH);
  });

  doc.end();
}

module.exports = { streamChallanPdf };

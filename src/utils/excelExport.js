/**
 * Excel export helper built on ExcelJS.
 *
 * Usage:
 *   const { buildWorkbook, sendWorkbook } = require('../utils/excelExport');
 *   const wb = await buildWorkbook({ title, sheetName, columns, rows });
 *   await sendWorkbook(res, wb, 'students_export.xlsx');
 */

const ExcelJS = require('exceljs');

// Brand colours
const HEADER_BG   = '1E40AF'; // indigo-800
const HEADER_FONT = 'FFFFFF';
const TITLE_BG    = '1E3A8A'; // indigo-900
const ALT_ROW_BG  = 'EFF6FF'; // indigo-50

/**
 * Build an ExcelJS Workbook.
 *
 * @param {{
 *   title:     string,
 *   sheetName: string,
 *   columns:   Array<{ header: string, key: string, width?: number, numFmt?: string }>,
 *   rows:      object[],
 *   subtitle?: string,
 * }} opts
 * @returns {Promise<ExcelJS.Workbook>}
 */
async function buildWorkbook({ title, sheetName, columns, rows, subtitle }) {
  const wb    = new ExcelJS.Workbook();
  wb.creator   = 'School Management System';
  wb.created   = new Date();

  const sheet = wb.addWorksheet(sheetName, {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true },
  });

  // ── Title row ─────────────────────────────────────────────
  sheet.mergeCells(1, 1, 1, columns.length);
  const titleCell    = sheet.getCell('A1');
  titleCell.value    = title;
  titleCell.font     = { bold: true, size: 14, color: { argb: HEADER_FONT } };
  titleCell.fill     = { type: 'pattern', pattern: 'solid', fgColor: { argb: TITLE_BG } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 28;

  // ── Subtitle / generated date ─────────────────────────────
  sheet.mergeCells(2, 1, 2, columns.length);
  const subCell    = sheet.getCell('A2');
  subCell.value    = subtitle || `Generated: ${new Date().toLocaleString('en-PK')}`;
  subCell.font     = { size: 10, color: { argb: '94A3B8' } };
  subCell.fill     = { type: 'pattern', pattern: 'solid', fgColor: { argb: TITLE_BG } };
  subCell.alignment = { horizontal: 'center' };
  sheet.getRow(2).height = 18;

  // ── Column header row ─────────────────────────────────────
  const headerRow = sheet.addRow(columns.map(c => c.header));
  headerRow.height = 22;
  headerRow.eachCell(cell => {
    cell.font      = { bold: true, size: 11, color: { argb: HEADER_FONT } };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border    = { bottom: { style: 'thin', color: { argb: HEADER_FONT } } };
  });

  // ── Set column widths ─────────────────────────────────────
  columns.forEach((col, idx) => {
    const wsCol     = sheet.getColumn(idx + 1);
    wsCol.width     = col.width || 16;
    wsCol.key       = col.key;
    if (col.numFmt) wsCol.numFmt = col.numFmt;
  });

  // ── Data rows ─────────────────────────────────────────────
  rows.forEach((row, ri) => {
    const values   = columns.map(c => {
      const v = row[c.key];
      return v === null || v === undefined ? '' : v;
    });
    const dataRow  = sheet.addRow(values);
    const isAlt    = ri % 2 === 1;

    dataRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
      if (isAlt) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ALT_ROW_BG } };
      }
      cell.border = {
        bottom: { style: 'hair', color: { argb: 'CBD5E1' } },
      };
      // Right-align numeric columns
      const colDef = columns[colNum - 1];
      if (colDef?.numFmt || typeof row[colDef?.key] === 'number') {
        cell.alignment = { horizontal: 'right' };
      }
    });
  });

  // ── Freeze panes below header row ─────────────────────────
  sheet.views = [{ state: 'frozen', ySplit: 3 }]; // freeze title+subtitle+header

  // ── Auto-filter on header row ─────────────────────────────
  if (rows.length > 0) {
    sheet.autoFilter = {
      from: { row: 3, column: 1 },
      to:   { row: 3, column: columns.length },
    };
  }

  return wb;
}

/**
 * Stream the workbook to the HTTP response.
 * @param {import('express').Response} res
 * @param {ExcelJS.Workbook} workbook
 * @param {string} filename
 */
async function sendWorkbook(res, workbook, filename) {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  await workbook.xlsx.write(res);
  res.end();
}

module.exports = { buildWorkbook, sendWorkbook };

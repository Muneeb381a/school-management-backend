// Unit tests for utility functions — no DB required
const { calcStatus, calcNet, invoiceNo, receiptNo } = require('../src/services/feeService');

describe('feeService — calcNet', () => {
  it('returns total + fine - discount', () => {
    expect(calcNet(1000, 50, 100)).toBe(950);
  });
  it('handles zero fine and discount', () => {
    expect(calcNet(500, 0, 0)).toBe(500);
  });
});

describe('feeService — calcStatus', () => {
  const future = new Date(Date.now() + 86400000 * 10).toISOString().slice(0, 10);
  const past   = new Date(Date.now() - 86400000 * 10).toISOString().slice(0, 10);

  it('paid when paidAmount >= net', () => {
    expect(calcStatus(1000, 0, 0, 1000, future)).toBe('paid');
  });
  it('partial when some paid but not full', () => {
    expect(calcStatus(1000, 0, 0, 500, future)).toBe('partial');
  });
  it('overdue when nothing paid and past due', () => {
    expect(calcStatus(1000, 0, 0, 0, past)).toBe('overdue');
  });
  it('unpaid when nothing paid and future due', () => {
    expect(calcStatus(1000, 0, 0, 0, future)).toBe('unpaid');
  });
});

describe('feeService — invoiceNo', () => {
  it('formats correctly', () => {
    expect(invoiceNo('2025-03', 42)).toBe('INV-202503-00042');
  });
});

describe('feeService — receiptNo', () => {
  it('starts with REC-', () => {
    expect(receiptNo(1)).toMatch(/^REC-\d{6}-\d{5}$/);
  });
});

/**
 * Generates a cryptographically random temporary password.
 *
 * Guarantees:
 *  - 12 characters
 *  - At least 1 uppercase, 1 lowercase, 1 digit, 1 special character
 *  - No ambiguous characters (0, O, 1, l, I) that look alike
 *  - Shuffled so required-character positions are not predictable
 *
 * Replaces the old deterministic pattern (Stu@{id}, Tch@{id})
 * which was guessable from any public student/teacher ID.
 */

const crypto = require('crypto');

const UPPER  = 'ABCDEFGHJKLMNPQRSTUVWXYZ';  // removed I, O
const LOWER  = 'abcdefghjkmnpqrstuvwxyz';   // removed i, l, o
const DIGITS = '23456789';                   // removed 0, 1
const SPEC   = '@#!$';
const ALL    = UPPER + LOWER + DIGITS + SPEC;

function genTempPassword() {
  // 12 random bytes — one per output character
  const bytes = crypto.randomBytes(16);

  // Guarantee at least one character from each required class
  const required = [
    UPPER [bytes[0] % UPPER.length],
    LOWER [bytes[1] % LOWER.length],
    DIGITS[bytes[2] % DIGITS.length],
    SPEC  [bytes[3] % SPEC.length],
  ];

  // Fill remaining 8 positions from the full alphabet
  const rest = [];
  for (let i = 4; i < 12; i++) {
    rest.push(ALL[bytes[i] % ALL.length]);
  }

  // Fisher-Yates shuffle using the last 4 random bytes as entropy
  const chars = [...required, ...rest];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[12 + (i % 4)] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}

module.exports = { genTempPassword };

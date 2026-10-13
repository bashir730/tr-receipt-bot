'use strict';

// ---------------------------------------------------------------
// Normalization utilities for Turkish bank receipts.
// Handles Persian/Arabic/Latin digits, Turkish amount formats
// (1.234,56 and 1,234.56), dates (dd.mm.yyyy), times and IBANs.
// ---------------------------------------------------------------

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function toEnglishDigits(str) {
  return String(str === null || str === undefined ? '' : str)
    .replace(/[۰-۹]/g, d => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, d => String(AR_DIGITS.indexOf(d)));
}

// Fold Turkish letters for case-insensitive keyword matching.
// ş/Ş -> s, ı/İ/I -> i, ğ -> g, ö -> o, ü -> u, ç -> c, â -> a
function foldTr(str) {
  return String(str || '')
    .replace(/[İI]/g, 'i')
    .replace(/[ıI]/g, 'i')
    .replace(/ş/g, 's').replace(/Ş/g, 's')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'g')
    .replace(/ç/g, 'c').replace(/Ç/g, 'c')
    .replace(/ö/g, 'o').replace(/Ö/g, 'o')
    .replace(/ü/g, 'u').replace(/Ü/g, 'u')
    .replace(/â/g, 'a').replace(/Â/g, 'a')
    .toLowerCase();
}

// Parse an amount in Turkish (1.234,56) or English (1,234.56) format.
// Returns a canonical string like "1234.56" (decimals kept only if non-zero),
// or "" when nothing could be parsed.
function parseAmountSmart(raw) {
  let s = toEnglishDigits(String(raw === null || raw === undefined ? '' : raw))
    .replace(/\s/g, '')
    .replace(/[^\d.,]/g, '')
    .trim();
  if (!s) return '';

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart = '';
  let decPart = '';

  if (lastDot >= 0 && lastComma >= 0) {
    if (lastComma > lastDot) {
      // 1.234,56  -> dot = thousands, comma = decimal
      intPart = s.slice(0, lastComma).replace(/\./g, '');
      decPart = s.slice(lastComma + 1);
    } else {
      // 1,234.56  -> comma = thousands, dot = decimal
      intPart = s.slice(0, lastDot).replace(/,/g, '');
      decPart = s.slice(lastDot + 1);
    }
  } else if (lastDot >= 0) {
    const tail = s.slice(lastDot + 1);
    if (tail.length === 3) {
      // 1.000 -> thousands separator (Turkish style)
      intPart = s.replace(/\./g, '');
    } else {
      intPart = s.slice(0, lastDot);
      decPart = tail;
    }
  } else if (lastComma >= 0) {
    const tail = s.slice(lastComma + 1);
    if (tail.length === 1 || tail.length === 2) {
      // 1234,5 / 1234,56 -> decimal comma
      intPart = s.slice(0, lastComma).replace(/\./g, '');
      decPart = tail;
    } else {
      // 1,234 or 80,000 -> thousands separator
      intPart = s.replace(/,/g, '');
    }
  } else {
    intPart = s;
  }

  intPart = String(intPart || '').replace(/^0+(?=\d)/, '');
  if (!intPart) intPart = '0';
  if (decPart) decPart = (decPart + '00').slice(0, 2);
  if (decPart && decPart !== '00') return intPart + '.' + decPart;
  return intPart;
}

// dd.mm.yyyy | yyyy-mm-dd | dd/mm/yy -> YYYYMMDD, else "".
function normalizeDate(raw) {
  const s = toEnglishDigits(String(raw || '')).trim();
  if (!s) return '';
  const m = s.match(/(\d{1,4})[\/\.\-\s](\d{1,2})[\/\.\-\s](\d{1,4})/);
  if (m) {
    let [, a, b, c] = m;
    if (a.length <= 2 && c.length >= 2) {
      const day = a.padStart(2, '0');
      const month = b.padStart(2, '0');
      let year = c;
      if (year.length === 2) year = '20' + year;
      return year + month + day;
    }
    if (a.length === 4) {
      return a + b.padStart(2, '0') + c.padStart(2, '0');
    }
  }
  return s.replace(/[^\d]/g, '');
}

// HH:MM(:SS) -> "HH:MM(:SS)", tolerant of OCR noise.
function normalizeTime(raw) {
  const s = toEnglishDigits(String(raw || '')).replace(/[^\d:]/g, '');
  const m = s.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (!m) return '';
  const h = m[1].padStart(2, '0');
  const mi = m[2].padStart(2, '0');
  if (m[3]) return h + ':' + mi + ':' + m[3].padStart(2, '0');
  return h + ':' + mi;
}

// IBAN: uppercase, strip non-alphanumerics, fix O/I/L/S->digits inside the
// numeric part (Turkish IBANs are TR + 24 digits).
function normalizeIban(raw) {
  let s = toEnglishDigits(String(raw || '')).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length > 4) {
    const cc = s.slice(0, 2);
    const rest = s.slice(2)
      .replace(/O/g, '0')
      .replace(/[IJL|]/g, '1')
      .replace(/S/g, '5')
      .replace(/Z/g, '2')
      .replace(/B/g, '8')
      .replace(/G/g, '6')
      .replace(/Q/g, '0')
      .replace(/D/g, '0');
    s = cc + rest;
  }
  return s;
}

// Turkish IBAN must be TR + 24 digits (26 chars total) with a valid mod-97 checksum.
function isValidTrIban(iban) {
  const ib = normalizeIban(iban);
  if (!/^TR\d{24}$/.test(ib)) return false;
  // Standard IBAN checksum: move first 4 chars to the end, letters -> 10..35, mod 97 must be 1.
  const rearranged = ib.slice(4) + ib.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' && ch <= 'Z' ? (ch.charCodeAt(0) - 55) : Number(ch);
    remainder = (remainder * (v >= 10 ? 100 : 10) + v) % 97;
  }
  return remainder === 1;
}

// Transaction id: uppercase alphanumerics, fix common OCR letter/digit
// confusion ONLY when the value otherwise looks numeric, min length check.
function normalizeTxnId(raw, minLen) {
  let s = toEnglishDigits(String(raw || '')).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  // If it is digits + typical OCR-confusion letters only, fold to digits.
  if (/^[0-9OILSBGQDZ|]+$/.test(s)) {
    s = s
      .replace(/O/g, '0')
      .replace(/[IL|]/g, '1')
      .replace(/S/g, '5')
      .replace(/B/g, '8')
      .replace(/G/g, '6')
      .replace(/Q/g, '0')
      .replace(/D/g, '0')
      .replace(/Z/g, '2');
  }
  if (s.length < (minLen || 6)) return '';
  return s;
}

function normalizeName(raw) {
  return foldTr(String(raw || ''))
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  toEnglishDigits,
  foldTr,
  parseAmountSmart,
  normalizeDate,
  normalizeTime,
  normalizeIban,
  isValidTrIban,
  normalizeTxnId,
  normalizeName
};

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  toEnglishDigits,
  foldTr,
  parseAmountSmart,
  normalizeDate,
  normalizeTime,
  normalizeIban,
  isValidTrIban,
  normalizeTxnId,
  normalizeName
} = require('../src/utils/normalize');

test('toEnglishDigits converts Persian and Arabic digits', () => {
  assert.equal(toEnglishDigits('۱۲۳۴٥'), '12345');
  assert.equal(toEnglishDigits('٩٨٧'), '987');
  assert.equal(toEnglishDigits('abc 456'), 'abc 456');
});

test('foldTr folds Turkish letters for case-insensitive matching', () => {
  assert.equal(foldTr('ZİRAAT Bankası'), 'ziraat bankasi');
  assert.equal(foldTr('İŞLEM NO'), 'islem no');
  assert.equal(foldTr('Havale/EFT'), 'havale/eft');
});

test('parseAmountSmart handles Turkish and English formats', () => {
  assert.equal(parseAmountSmart('1.500,00 TL'), '1500');
  assert.equal(parseAmountSmart('1,500.00 TRY'), '1500');
  assert.equal(parseAmountSmart('1.234,56'), '1234.56');
  assert.equal(parseAmountSmart('1,234.56'), '1234.56');
  assert.equal(parseAmountSmart('80.000'), '80000');
  assert.equal(parseAmountSmart('5,000'), '5000');
  assert.equal(parseAmountSmart('750,00'), '750');
  assert.equal(parseAmountSmart('4991,5'), '4991.50');
  assert.equal(parseAmountSmart('12.34'), '12.34');
  assert.equal(parseAmountSmart(''), '');
  assert.equal(parseAmountSmart('TL'), '');
  // Persian / Arabic digits
  assert.equal(parseAmountSmart('۱۵۰۰'), '1500');
  assert.equal(parseAmountSmart('١٢٣٤'), '1234');
});

test('normalizeDate handles dd.mm.yyyy / yyyy-mm-dd / two-digit years', () => {
  assert.equal(normalizeDate('13.10.2026'), '20261013');
  assert.equal(normalizeDate('13/10/26'), '20261013');
  assert.equal(normalizeDate('2026-10-13'), '20261013');
  assert.equal(normalizeDate(''), '');
});

test('normalizeTime handles noisy OCR time strings', () => {
  assert.equal(normalizeTime('14:32'), '14:32');
  assert.equal(normalizeTime('9:5'), '09:05');
  assert.equal(normalizeTime('14:32:07'), '14:32:07');
  assert.equal(normalizeTime('Saat 14:32'), '14:32');
});

test('normalizeIban fixes OCR letter/digit confusion', () => {
  assert.equal(
    normalizeIban('TR33 OO06 1O05 1978 6457 8413 26'),
    'TR330006100519786457841326'
  );
});

test('isValidTrIban validates checksum', () => {
  // registry example IBAN
  assert.equal(isValidTrIban('TR33 0006 1005 1978 6457 8413 26'), true);
  // same IBAN with one digit changed -> invalid checksum
  assert.equal(isValidTrIban('TR33 0006 1005 1978 6457 8413 27'), false);
  // too short
  assert.equal(isValidTrIban('TR330006'), false);
  // wrong country
  assert.equal(isValidTrIban('DE89370400440532013000'), false);
});

test('normalizeTxnId normalizes and rejects short ids', () => {
  assert.equal(normalizeTxnId('1234567890', 6), '1234567890');
  assert.equal(normalizeTxnId('OO12345', 6), '0012345'); // OCR O/0 confusion in numeric ids
  assert.equal(normalizeTxnId('12345', 6), '');   // too short
  assert.equal(normalizeTxnId('ABC12345', 6), 'ABC12345'); // letters kept when not confusion-only
  assert.equal(normalizeTxnId('0000000', 6), '0000000');
});

test('extractTxnId pulls the id out of a labelled receipt line', () => {
  const { extractTxnId } = require('../src/parsers/common');
  assert.equal(extractTxnId('İşlem No: 1234567890', 6), '1234567890');
  assert.equal(extractTxnId('İşlem Takip No : 987654321\nTutar 5 TL', 6), '987654321');
});

test('normalizeName strips and folds names', () => {
  assert.equal(normalizeName('AHMET YILMAZ'), 'ahmet yilmaz');
  assert.equal(normalizeName('  Şule   Öztürk '), 'sule ozturk');
});

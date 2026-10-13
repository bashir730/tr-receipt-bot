'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseReceipt, detectBank, looksLikeChatScreenshot } = require('../src/parsers');
const { makeTrIban } = require('./helpers');

const SENDER_IBAN = makeTrIban('00010010197864578413'); // Ziraat-looking BBAN
const RECEIVER_IBAN = makeTrIban('00123456789012345678');

const ZIRAAT_TEXT = [
  'Ziraat Bankası',
  'Dekont - Havale/EFT',
  'Gönderen: AHMET YILMAZ',
  'IBAN: ' + SENDER_IBAN,
  'Alıcı: MEHMET KAYA',
  'IBAN: ' + RECEIVER_IBAN,
  'Tutar: 1.500,00 TL',
  'Tarih: 13.10.2026 Saat: 14:32',
  'İşlem No: 1234567890',
  'Referans No: 778899001'
].join('\n');

const AKBANK_TEXT = [
  'AkBank Direkt',
  'İşlem Takip No: 987654321',
  'Referans No: 112233445',
  'Tutar: 2.500,00 TRY',
  'İşlem Tarihi: 13/10/2026',
  'Saat: 09:15',
  'Gönderen: ALI DEMIR',
  'IBAN: ' + SENDER_IBAN,
  'Alıcı: AYSE KAYA',
  'IBAN: ' + RECEIVER_IBAN
].join('\n');

const ENPARA_TEXT = [
  'en para',
  'İşlem No: 55667788',
  'Tutar: 750,00 TL',
  'Tarih: 13.10.2026 Saat: 20:05',
  'Gönderen IBAN: ' + SENDER_IBAN,
  'Alıcı IBAN: ' + RECEIVER_IBAN
].join('\n');

test('ziraat receipt is detected and parsed fully', () => {
  const r = parseReceipt(ZIRAAT_TEXT);
  assert.ok(r, 'should parse');
  assert.equal(r.bank, 'ziraat');
  assert.equal(r.txnId, '1234567890');
  assert.equal(r.amount, '1500');
  assert.equal(r.currency, 'TRY');
  assert.equal(r.date, '20261013');
  assert.equal(r.time, '14:32');
  assert.equal(r.senderIban, SENDER_IBAN);
  assert.equal(r.receiverIban, RECEIVER_IBAN);
  assert.equal(r.senderName, 'ahmet yilmaz');
  assert.equal(r.receiverName, 'mehmet kaya');
});

test('akbank receipt is detected and parsed', () => {
  const r = parseReceipt(AKBANK_TEXT);
  assert.ok(r);
  assert.equal(r.bank, 'akbank');
  assert.equal(r.txnId, '987654321');
  assert.equal(r.amount, '2500');
  assert.equal(r.currency, 'TRY');
  assert.equal(r.date, '20261013');
  assert.equal(r.time, '09:15');
});

test('enpara receipt is detected and parsed', () => {
  const r = parseReceipt(ENPARA_TEXT);
  assert.ok(r);
  assert.equal(r.bank, 'enpara');
  assert.equal(r.txnId, '55667788');
  assert.equal(r.amount, '750');
  assert.equal(r.date, '20261013');
  assert.equal(r.time, '20:05');
});

test('detectBank returns the right slug', () => {
  assert.equal(detectBank(ZIRAAT_TEXT), 'ziraat');
  assert.equal(detectBank(AKBANK_TEXT), 'akbank');
  assert.equal(detectBank(ENPARA_TEXT), 'enpara');
  assert.equal(detectBank('random note about dinner plans'), null);
});

test('non-receipt text returns null', () => {
  assert.equal(parseReceipt('merhaba nasilsin bugun hava guzel'), null);
  assert.equal(parseReceipt(''), null);
});

test('chat screenshots are rejected', () => {
  const screenshot = [
    'WhatsApp',
    'Ali: bugun bulusalim mi',
    'Ayse: sesli mesaj',
    'online'
  ].join('\n');
  assert.equal(looksLikeChatScreenshot(screenshot), true);
  assert.equal(parseReceipt(screenshot), null);
});

test('unknown Turkish bank with receipt indicators parses as other-tr', () => {
  const text = [
    'QNB Bank',
    'Havale/EFT dekont',
    'Tutar: 320,00 TL',
    'Tarih: 01.11.2026',
    'İşlem No: 887766554',
    'Alıcı IBAN: ' + RECEIVER_IBAN
  ].join('\n');
  const r = parseReceipt(text);
  assert.ok(r);
  assert.equal(r.bank, 'other-tr');
  assert.equal(r.txnId, '887766554');
});

test('receipt without txn id still extracts amount/date/ibans', () => {
  const text = [
    'Ziraat Bankası',
    'Tutar: 100,00 TL',
    'Tarih: 13.10.2026 Saat: 10:00',
    'IBAN: ' + SENDER_IBAN,
    'IBAN: ' + RECEIVER_IBAN
  ].join('\n');
  const r = parseReceipt(text);
  assert.ok(r);
  assert.equal(r.bank, 'ziraat');
  assert.equal(r.txnId, '');
  assert.equal(r.amount, '100');
});

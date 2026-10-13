'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkReceipt } = require('../src/fraud/fraudEngine');
const { makeTrIban } = require('./helpers');

const SENDER_IBAN = makeTrIban('00010010197864578413');
const RECEIVER_IBAN = makeTrIban('00123456789012345678');

function baseReceipt(overrides = {}) {
  return {
    bank: 'ziraat',
    txnId: '123456789',
    amount: '1500',
    currency: 'TRY',
    date: '20261013',
    time: '14:32',
    senderIban: SENDER_IBAN,
    receiverIban: RECEIVER_IBAN,
    senderName: 'ahmet yilmaz',
    receiverName: 'mehmet kaya',
    rawText: 'Ziraat Bankasi Tutar 1.500,00 TL Islem No 123456789',
    ...overrides
  };
}

test('complete consistent receipt -> ok', () => {
  const r = checkReceipt(baseReceipt(), 'islem tamamlandi');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.issues, []);
});

test('invalid IBAN checksum -> review', () => {
  const r = checkReceipt(baseReceipt({ senderIban: 'TR000000000000000000000001' }), '');
  assert.equal(r.status, 'review');
  assert.ok(r.issues.some(i => i.startsWith('iban_checksum_invalid')));
});

test('failed-transfer markers -> review', () => {
  const r = checkReceipt(baseReceipt(), 'İşlem Başarısız');
  assert.equal(r.status, 'review');
  assert.ok(r.issues.some(i => i.startsWith('negative_marker')));
});

test('degenerate all-zero txn id -> review', () => {
  const r = checkReceipt(baseReceipt({ txnId: '0000000' }), '');
  assert.equal(r.status, 'review');
  assert.ok(r.issues.some(i => i.startsWith('txn_id_degenerate')));
});

test('missing amount or date -> review', () => {
  assert.equal(checkReceipt(baseReceipt({ amount: '' }), '').status, 'review');
  assert.equal(checkReceipt(baseReceipt({ date: '' }), '').status, 'review');
});

test('no txn id and no IBANs -> review (insufficient identifiers)', () => {
  const r = checkReceipt(baseReceipt({ txnId: '', senderIban: '', receiverIban: '' }), '');
  assert.equal(r.status, 'review');
  assert.ok(r.issues.includes('insufficient_identifiers'));
});

test('no txn id but both IBANs present -> ok', () => {
  const r = checkReceipt(baseReceipt({ txnId: '' }), '');
  assert.equal(r.status, 'ok');
});

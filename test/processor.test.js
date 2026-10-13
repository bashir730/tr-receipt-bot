'use strict';

// Acceptance tests from the spec, run against the real processor with
// injected OCR (deterministic; no network, no real WhatsApp).

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { ReceiptStore } = require('../src/db/database');
const { ReceiptProcessor } = require('../src/processor');
const { isReceiptCandidate } = require('../src/whatsapp/messageFilter');
const {
  makeTrIban, renderText, resize, makeMsg, makeTextMsg, makeVoiceMsg,
  makeStickerMsg, makeVideoMsg, getImageBytes, makeOcr, tempDbPath
} = require('./helpers');

const GROUP_A = '120363012345678901@g.us';
const GROUP_B = '120363098765432109@g.us';

const SENDER_IBAN = makeTrIban('00010010197864578413');
const RECEIVER_IBAN = makeTrIban('00123456789012345678');

const ZIRAAT_A = [
  'Ziraat Bankası',
  'Dekont - Havale/EFT',
  'Gönderen: AHMET YILMAZ',
  'IBAN: ' + SENDER_IBAN,
  'Alıcı: MEHMET KAYA',
  'IBAN: ' + RECEIVER_IBAN,
  'Tutar: 1.500,00 TL',
  'Tarih: 13.10.2026 Saat: 14:32',
  'İşlem No: 1234567890'
].join('\n');

// different receipt: same bank, different txn id, same amount
const ZIRAAT_B = ZIRAAT_A.replace('İşlem No: 1234567890', 'İşlem No: 2233445566');

// same transaction id, but a different image (e.g. partial screenshot)
const ZIRAAT_C = ZIRAAT_A.replace('Tarih: 13.10.2026 Saat: 14:32', 'Tarih: 13.10.2026 Saat: 15:44');

const AKBANK_A = [
  'AkBank Direkt',
  'İşlem Takip No: 987654321',
  'Tutar: 2.500,00 TRY',
  'İşlem Tarihi: 13/10/2026',
  'Saat: 09:15',
  'Gönderen IBAN: ' + SENDER_IBAN,
  'Alıcı IBAN: ' + RECEIVER_IBAN
].join('\n');

const NOT_A_RECEIPT = 'bugun marketten ekmek ve süt aldim, fatura odemesi icin bankaya gidilecek';

const FAILED_RECEIPT = [
  'Ziraat Bankası',
  'İşlem No: 998877665',
  'Tutar: 1.500,00 TL',
  'Tarih: 13.10.2026 Saat: 14:32',
  'İşlem Başarısız / İptal edildi',
  'IBAN: ' + SENDER_IBAN,
  'IBAN: ' + RECEIVER_IBAN
].join('\n');

const BAD_IBAN_RECEIPT = [
  'Ziraat Bankası',
  'İşlem No: 112233445',
  'Tutar: 1.000,00 TL',
  'Tarih: 13.10.2026 Saat: 11:00',
  'IBAN: TR000000000000000000000001',
  'IBAN: ' + RECEIVER_IBAN
].join('\n');

const NO_TXN_RECEIPT = [
  'Ziraat Bankası',
  'Tutar: 100,00 TL',
  'Tarih: 13.10.2026 Saat: 10:00',
  'IBAN: ' + SENDER_IBAN,
  'IBAN: ' + RECEIVER_IBAN
].join('\n');

let dbPath;
let samples;
const openStores = [];

beforeEach(async () => {
  dbPath = tempDbPath('receipts.db');
  samples = [];
});

function newProcessor(overrides = {}) {
  const store = overrides.store || new ReceiptStore(dbPath);
  openStores.push(store);
  const ocr = makeOcr(samples);
  return {
    store,
    processor: new ReceiptProcessor({ store, getImageBytes, ocr })
  };
}

// Close every store before the process exits so better-sqlite3 native
// statements are finalized inside a live environment (prevents teardown crash).
after(() => {
  for (const s of openStores) {
    try { s.close(); } catch {}
  }
});

// ---------- acceptance: group isolation & reactions ----------

test('new receipt in group A -> only ✅', async () => {
  const img = await renderText(ZIRAAT_A);
  samples.push({ ...(await withPhash(img)), text: ZIRAAT_A });
  const { processor, store } = newProcessor();

  const res = await processor.process(makeMsg(GROUP_A, img));
  assert.equal(res.status, 'new');
  assert.equal(res.reaction, '✅');
  assert.equal(store.countReceipts(GROUP_A), 1);
});

test('same receipt again in group A -> only ❌', async () => {
  const img = await renderText(ZIRAAT_A);
  samples.push({ ...(await withPhash(img)), text: ZIRAAT_A });
  const { processor, store } = newProcessor();

  await processor.process(makeMsg(GROUP_A, img));
  const res = await processor.process(makeMsg(GROUP_A, img));
  assert.equal(res.status, 'duplicate');
  assert.equal(res.reaction, '❌');
  assert.equal(store.countReceipts(GROUP_A), 1);
});

test('same receipt in group B is independent -> ✅ there, ❌ on repeat', async () => {
  const img = await renderText(ZIRAAT_A);
  samples.push({ ...(await withPhash(img)), text: ZIRAAT_A });
  const { processor, store } = newProcessor();

  const inA = await processor.process(makeMsg(GROUP_A, img));
  assert.equal(inA.reaction, '✅');

  const inB = await processor.process(makeMsg(GROUP_B, img));
  assert.equal(inB.status, 'new');
  assert.equal(inB.reaction, '✅');

  const inB2 = await processor.process(makeMsg(GROUP_B, img));
  assert.equal(inB2.status, 'duplicate');
  assert.equal(inB2.reaction, '❌');

  assert.equal(store.countReceipts(GROUP_A), 1);
  assert.equal(store.countReceipts(GROUP_B), 1);
});

test('two different receipts with the same amount are NOT duplicates', async () => {
  const img1 = await renderText(ZIRAAT_A);
  const img2 = await renderText(ZIRAAT_B); // same amount, different txn id
  samples.push({ ...(await withPhash(img1)), text: ZIRAAT_A });
  samples.push({ ...(await withPhash(img2)), text: ZIRAAT_B });
  const { processor, store } = newProcessor();

  const r1 = await processor.process(makeMsg(GROUP_A, img1));
  const r2 = await processor.process(makeMsg(GROUP_A, img2));
  assert.equal(r1.reaction, '✅');
  assert.equal(r2.status, 'new');
  assert.equal(r2.reaction, '✅');
  assert.equal(store.countReceipts(GROUP_A), 2);
});

test('same transaction id on a different image -> ❌', async () => {
  const img1 = await renderText(ZIRAAT_A);
  const img2 = await renderText(ZIRAAT_C); // same İşlem No, cropped/different screenshot
  samples.push({ ...(await withPhash(img1)), text: ZIRAAT_A });
  samples.push({ ...(await withPhash(img2)), text: ZIRAAT_C });
  const { processor } = newProcessor();

  const r1 = await processor.process(makeMsg(GROUP_A, img1));
  const r2 = await processor.process(makeMsg(GROUP_A, img2));
  assert.equal(r1.reaction, '✅');
  assert.equal(r2.status, 'duplicate');
  assert.equal(r2.reaction, '❌');
  assert.equal(r2.reason, 'txn_id');
});

test('resized / re-compressed copy of the same receipt -> ❌', async () => {
  const img = await renderText(ZIRAAT_A);
  const imgRecompressed = await resize(img, 260); // same content, JPEG, smaller
  samples.push({ ...(await withPhash(img)), text: ZIRAAT_A });
  const { processor, store } = newProcessor();

  const r1 = await processor.process(makeMsg(GROUP_A, img));
  const r2 = await processor.process(makeMsg(GROUP_A, imgRecompressed));
  assert.equal(r1.reaction, '✅');
  assert.equal(r2.status, 'duplicate');
  assert.equal(r2.reaction, '❌');
  assert.equal(store.countReceipts(GROUP_A), 1);
});

// ---------- acceptance: things that must produce NO reaction ----------

test('text, voice, sticker, video messages are ignored', async () => {
  const img = await renderText(ZIRAAT_A);
  samples.push({ ...(await withPhash(img)), text: ZIRAAT_A });
  const { processor } = newProcessor();

  for (const msg of [
    makeTextMsg(GROUP_A, 'selam'),
    makeVoiceMsg(GROUP_A),
    makeStickerMsg(GROUP_A),
    makeVideoMsg(GROUP_A)
  ]) {
    const res = await processor.process(msg);
    assert.equal(res.reaction, null);
    assert.equal(res.status, 'ignored');
  }
});

test('image message filter accepts only group images', async () => {
  const img = await renderText(ZIRAAT_A);
  assert.equal(isReceiptCandidate(makeMsg(GROUP_A, img)), true);
  assert.equal(isReceiptCandidate(makeMsg('+905551112233@s.whatsapp.net', img)), false); // private chat
  assert.equal(isReceiptCandidate(makeTextMsg(GROUP_A, 'selam')), false);
  assert.equal(isReceiptCandidate(makeVoiceMsg(GROUP_A)), false);
});

test('unclear image (OCR unreadable) -> no reaction, nothing registered', async () => {
  const img = await renderText('@@@ ### @@@'); // unknown to the OCR map -> ''
  const { processor, store } = newProcessor();

  const res = await processor.process(makeMsg(GROUP_A, img));
  assert.equal(res.reaction, null);
  assert.equal(store.countReceipts(GROUP_A), 0);
});

test('image that is not a bank receipt -> no reaction', async () => {
  const img = await renderText(NOT_A_RECEIPT);
  samples.push({ ...(await withPhash(img)), text: NOT_A_RECEIPT });
  const { processor, store } = newProcessor();

  const res = await processor.process(makeMsg(GROUP_A, img));
  assert.equal(res.reaction, null);
  assert.equal(store.countReceipts(GROUP_A), 0);
});

test('failed/cancelled transfer receipt -> review, no reaction', async () => {
  const img = await renderText(FAILED_RECEIPT);
  samples.push({ ...(await withPhash(img)), text: FAILED_RECEIPT });
  const { processor, store } = newProcessor();

  const res = await processor.process(makeMsg(GROUP_A, img));
  assert.equal(res.reaction, null);
  assert.equal(res.status, 'review');
  assert.equal(store.countReceipts(GROUP_A), 0);
  assert.ok(store.countReviews(GROUP_A) >= 1, 'review is logged internally');
});

test('receipt with invalid IBAN checksum -> review, no reaction', async () => {
  const img = await renderText(BAD_IBAN_RECEIPT);
  samples.push({ ...(await withPhash(img)), text: BAD_IBAN_RECEIPT });
  const { processor, store } = newProcessor();

  const res = await processor.process(makeMsg(GROUP_A, img));
  assert.equal(res.reaction, null);
  assert.equal(res.status, 'review');
  assert.equal(store.countReceipts(GROUP_A), 0);
});

test('receipt without txn id but full info: first ✅, exact combination repeat ❌', async () => {
  const img1 = await renderText(NO_TXN_RECEIPT);
  const img2 = await renderText(NO_TXN_RECEIPT, { width: 480 }); // same data, different screenshot
  samples.push({ ...(await withPhash(img1)), text: NO_TXN_RECEIPT });
  samples.push({ ...(await withPhash(img2)), text: NO_TXN_RECEIPT });
  const { processor, store } = newProcessor();

  const r1 = await processor.process(makeMsg(GROUP_A, img1));
  assert.equal(r1.status, 'new');
  assert.equal(r1.reaction, '✅');

  const r2 = await processor.process(makeMsg(GROUP_A, img2));
  assert.equal(r2.status, 'duplicate');
  assert.equal(r2.reaction, '❌');
  assert.equal(store.countReceipts(GROUP_A), 1);
});

test('akbank receipt works end to end too', async () => {
  const img = await renderText(AKBANK_A);
  samples.push({ ...(await withPhash(img)), text: AKBANK_A });
  const { processor } = newProcessor();

  const r1 = await processor.process(makeMsg(GROUP_A, img));
  const r2 = await processor.process(makeMsg(GROUP_A, img));
  assert.equal(r1.reaction, '✅');
  assert.equal(r2.reaction, '❌');
});

// ---------- acceptance: concurrency & persistence ----------

test('the same receipt sent twice simultaneously -> exactly ONE registration', async () => {
  const img = await renderText(ZIRAAT_A);
  samples.push({ ...(await withPhash(img)), text: ZIRAAT_A });
  const { processor, store } = newProcessor();

  const [r1, r2] = await Promise.all([
    processor.process(makeMsg(GROUP_A, img)),
    processor.process(makeMsg(GROUP_A, img))
  ]);

  const reactions = [r1.reaction, r2.reaction].sort();
  assert.deepEqual(reactions, ['✅', '❌']);
  assert.equal(store.countReceipts(GROUP_A), 1, 'exactly one row');
});

test('records survive a restart (new store on the same db file)', async () => {
  const img = await renderText(ZIRAAT_A);
  samples.push({ ...(await withPhash(img)), text: ZIRAAT_A });

  const first = newProcessor();
  const r1 = await first.processor.process(makeMsg(GROUP_A, img));
  assert.equal(r1.reaction, '✅');
  first.store.close();

  // simulate restart: fresh store + processor on the same file
  const second = newProcessor();
  const r2 = await second.processor.process(makeMsg(GROUP_A, img));
  assert.equal(r2.status, 'duplicate');
  assert.equal(r2.reaction, '❌');
  assert.equal(second.store.countReceipts(GROUP_A), 1);
  second.store.close();
});

// ---------- helper used above ----------

const { computeHash } = require('../src/utils/perceptualHash');
async function withPhash(buffer) {
  return { phash: await computeHash(buffer) };
}

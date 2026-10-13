'use strict';

// ---------------------------------------------------------------
// Parser router. Tries known Turkish bank parsers (extensible list),
// then a generic Turkish-receipt fallback (bank = 'other-tr').
// Returns null when the OCR text does not look like a bank receipt
// at all — those images must be ignored without any reaction.
// ---------------------------------------------------------------

const ziraat = require('./ziraat');
const akbank = require('./akbank');
const enpara = require('./enpara');
const common = require('./common');
const { isValidTrIban } = require('../utils/normalize');

// Register new banks by adding their module here.
const BANK_PARSERS = [ziraat, akbank, enpara];

// Text that clearly indicates a Turkish bank receipt / dekont.
const RECEIPT_INDICATORS = [
  'dekont', 'havale', 'eft', 'iban', 'islem no', 'referans no',
  'islem takip no', 'tutar', 'hesap hareketleri', 'fatura odemesi',
  'transfer', 'gonderen', 'alici', 'sube', 'iban:'
];

// Words that indicate a chat screenshot / non-receipt image even when
// OCR produces text. Adapted from the reference project's screenshot filter.
const CHAT_SCREENSHOT_MARKERS = [
  'whatsapp', 'cevrimici', 'bugun', 'dun', 'yaziyor...', 'online',
  'sesli mesaj', 'grup adi', 'mesajlar', 'katilimcilar'
];

function looksLikeChatScreenshot(text) {
  const folded = common.foldTr(text);
  const hits = CHAT_SCREENSHOT_MARKERS.filter(m => folded.includes(m)).length;
  // needs several markers together to avoid false positives on real receipts
  return hits >= 2;
}

function hasReceiptIndicators(text) {
  const folded = common.foldTr(text);
  return RECEIPT_INDICATORS.some(m => folded.includes(m));
}

// Generic fallback parser for other Turkish banks (Guaranteed only by
// generic fields, bank slug 'other-tr').
function parseGenericTr(text, opts = {}) {
  const minTxn = (opts.minTxnIdLen || 6);
  const txnId = common.extractTxnId(text, minTxn);
  const amount = common.extractAmount(text);
  const currency = common.extractCurrency(text);
  const { date, time } = common.extractDateTime(text);
  const { senderName, receiverName } = common.extractPartyNames(text);
  const { senderIban, receiverIban } = common.extractPartyIbans(text);

  return {
    bank: 'other-tr',
    bankDisplay: 'Diğer (TR)',
    txnId, amount, currency, date, time,
    senderIban: isValidTrIban(senderIban) ? senderIban : (senderIban || ''),
    receiverIban: isValidTrIban(receiverIban) ? receiverIban : (receiverIban || ''),
    senderName, receiverName,
    rawText: String(text || '')
  };
}

function parseReceipt(text, opts = {}) {
  if (!text || !String(text).trim()) return null;

  for (const parser of BANK_PARSERS) {
    if (parser.matches(text)) {
      const receipt = parser.parse(text, opts);
      if (receipt) return receipt;
    }
  }

  if (looksLikeChatScreenshot(text)) return null;
  if (!hasReceiptIndicators(text)) return null;

  const generic = parseGenericTr(text, opts);
  // generic needs at least *some* meaningful content to be worth reviewing
  if (!generic.txnId && !generic.amount && !generic.receiverIban) return null;
  return generic;
}

function detectBank(text) {
  const folded = common.foldTr(text || '');
  for (const parser of BANK_PARSERS) {
    if (parser.matches(folded)) return parser.name;
  }
  if (hasReceiptIndicators(folded)) return 'other-tr';
  return null;
}

module.exports = {
  parseReceipt,
  detectBank,
  looksLikeChatScreenshot,
  hasReceiptIndicators,
  BANK_PARSERS
};

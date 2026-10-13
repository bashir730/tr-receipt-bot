'use strict';

// ---------------------------------------------------------------
// Enpara (QNB Finansbank) receipt parser.
// Typical markers: "en para", "Enpara", "İşlem No", "Tutar", IBAN.
// ---------------------------------------------------------------

const common = require('./common');
const { isValidTrIban } = require('../utils/normalize');

const NAME = 'enpara';
const DISPLAY = 'Enpara';

function matches(text) {
  return /en\s*para|enpara|qnb finans/i.test(common.foldTr(text));
}

function parse(text, opts = {}) {
  if (!matches(text)) return null;

  const minTxn = (opts.minTxnIdLen || 6);
  const txnId = common.extractTxnId(text, minTxn);
  const amount = common.extractAmount(text);
  const currency = common.extractCurrency(text);
  const { date, time } = common.extractDateTime(text);
  const { senderName, receiverName } = common.extractPartyNames(text);
  const { senderIban, receiverIban } = common.extractPartyIbans(text);

  return {
    bank: NAME,
    bankDisplay: DISPLAY,
    txnId, amount, currency, date, time,
    senderIban: isValidTrIban(senderIban) ? senderIban : (senderIban || ''),
    receiverIban: isValidTrIban(receiverIban) ? receiverIban : (receiverIban || ''),
    senderName, receiverName,
    rawText: String(text || '')
  };
}

module.exports = { name: NAME, display: DISPLAY, matches, parse };

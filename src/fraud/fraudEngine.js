'use strict';

// ---------------------------------------------------------------
// Anti-fraud checks. Fraud indicators move a receipt from "new" to
// "needs review" — they NEVER produce a ✅ and never a ❌ by themselves.
//
// IMPORTANT: without an independent bank reference (API/statement),
// this module CANNOT prove a receipt is genuine or forged. It only
// detects structural inconsistencies. Statuses are strictly:
//   'ok' | 'review'
// ---------------------------------------------------------------

const { isValidTrIban, normalizeIban, foldTr } = require('../utils/normalize');

// Words on receipts that indicate a failed / cancelled / rejected transfer.
const NEGATIVE_MARKERS = [
  'islem basarisiz', 'basarisiz', 'iptal edildi', 'iptal',
  'unsuccessful', 'failed', 'cancelled', 'reddedildi', 'geri alindi'
];

// A transaction id made of a single repeated digit is almost certainly
// OCR noise or tampering.
function isDegenerateTxnId(txnId) {
  if (!txnId) return false;
  if (/^(\d)\1{5,}$/.test(txnId)) return true;   // '000000'
  if (/^0+$/.test(txnId)) return true;
  return false;
}

/**
 * @param {object} receipt  parsed receipt fields
 * @param {string} ocrText  raw OCR text (for failed-marker scan)
 * @returns {{status:'ok'|'review', issues:string[]}}
 */
function checkReceipt(receipt, ocrText) {
  const issues = [];

  // 1. Invalid IBAN structure (checksum) — only for IBANs that were found
  //    at all; an absent IBAN is not an issue by itself.
  for (const iban of [receipt.senderIban, receipt.receiverIban]) {
    if (iban && !isValidTrIban(iban)) {
      issues.push('iban_checksum_invalid:' + normalizeIban(iban));
    }
  }

  // 2. Degenerate / suspicious transaction id
  if (receipt.txnId && isDegenerateTxnId(receipt.txnId)) {
    issues.push('txn_id_degenerate:' + receipt.txnId);
  }

  // 3. Failed / cancelled markers in the receipt text
  const folded = foldTr(ocrText);
  for (const marker of NEGATIVE_MARKERS) {
    if (folded.includes(marker)) {
      issues.push('negative_marker:' + marker);
      break;
    }
  }

  // 4. Amount missing or zero while the receipt claims a transfer
  if (!receipt.amount || parseFloat(receipt.amount) <= 0) {
    issues.push('amount_missing_or_zero');
  }

  // 5. Date missing — cannot anchor the transaction
  if (!receipt.date) {
    issues.push('date_missing');
  }

  // 6. Neither a transaction id nor both IBANs — too little to be definite
  const hasTxn = !!receipt.txnId && !isDegenerateTxnId(receipt.txnId);
  const hasBothIbans = !!(receipt.senderIban && receipt.receiverIban);
  if (!hasTxn && !hasBothIbans) {
    issues.push('insufficient_identifiers');
  }

  return { status: issues.length === 0 ? 'ok' : 'review', issues };
}

module.exports = { checkReceipt, isDegenerateTxnId, NEGATIVE_MARKERS };

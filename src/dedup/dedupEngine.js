'use strict';

// ---------------------------------------------------------------
// Duplicate detection engine — evaluation order:
//   1. exact image SHA-256 within the group
//   2. normalized transaction id within (group, bank)
//   3. perceptual hash (resized / recompressed / cropped copies) —
//      similar images are SUSPICIOUS; they only become 'duplicate'
//      when the OCR-extracted data also matches, otherwise 'review'
//   4. combination match (no txn id): amount+date+time+IBANs all equal
//      -> duplicate; weaker overlaps -> review (never auto-confirmed)
//
// Final registration is done by the atomic store transaction — see
// src/db/database.js. This module performs the pre-insert evaluation.
// ---------------------------------------------------------------

const config = require('../config');
const { hammingDistance } = require('../utils/perceptualHash');

function evaluate(store, groupJid, receipt, hashes) {
  // 1. exact same image bytes
  const bySha = store.findBySha(groupJid, hashes.sha256);
  if (bySha) {
    return { status: 'duplicate', reason: 'image_sha256', row: bySha };
  }

  // 2. same transaction id for the same bank in the same group
  if (receipt.txnId) {
    const byTxn = store.findByTxn(groupJid, receipt.bank, receipt.txnId);
    if (byTxn) {
      return { status: 'duplicate', reason: 'txn_id', row: byTxn };
    }
  }

  // 3. perceptual similarity
  if (hashes.phash) {
    const candidates = store.listPhashes(groupJid);
    for (const row of candidates) {
      const dist = hammingDistance(hashes.phash, row.image_phash);
      if (dist > config.PHASH_HAMMING_MAX) continue;

      // similar image: is the extracted data the same too?
      const sameTxn = !!(receipt.txnId && row.txn_id === receipt.txnId);
      const sameAmount = !!(receipt.amount && row.amount === receipt.amount);
      const sameDate = !!(receipt.date && row.txn_date === receipt.date);
      const sameTime = !!(receipt.time && row.txn_time === receipt.time);
      const sameIbans = !!(receipt.senderIban && row.sender_iban === receipt.senderIban &&
                           receipt.receiverIban && row.receiver_iban === receipt.receiverIban);

      if (sameTxn || (sameAmount && sameDate && (sameTime || sameIbans))) {
        return { status: 'duplicate', reason: 'perceptual_and_data', row };
      }
      // similar image but different data -> possible tampering, needs review
      return { status: 'review', reason: 'similar_image_different_data', row };
    }
  }

  // 4. no transaction id: exact combination match -> duplicate;
  //    partial overlaps only -> review
  if (!receipt.txnId && receipt.amount && receipt.date) {
    const combo = store.findCombo(
      groupJid, receipt.amount, receipt.date, receipt.time || null,
      receipt.senderIban || null, receipt.receiverIban || null
    );
    if (combo) {
      return { status: 'duplicate', reason: 'combination_exact', row: combo };
    }
  }

  return { status: 'new' };
}

module.exports = { evaluate };

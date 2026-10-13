'use strict';

// ---------------------------------------------------------------
// SQLite storage. One shared table keyed by group_jid with compound
// UNIQUE constraints — never one table per group.
//
// better-sqlite3 is synchronous: every transaction is atomic with
// respect to the Node event loop, so a check-then-insert transaction
// cannot interleave with another one, even for two images arriving
// at the same time.
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS receipts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_jid     TEXT NOT NULL,
  image_sha256  TEXT NOT NULL,
  image_phash   TEXT,
  bank          TEXT NOT NULL,
  txn_id        TEXT NOT NULL,
  amount        TEXT,
  currency      TEXT,
  txn_date      TEXT,
  txn_time      TEXT,
  sender_iban   TEXT,
  receiver_iban TEXT,
  sender_name   TEXT,
  receiver_name TEXT,
  raw_text      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (group_jid, image_sha256)
);

-- One transaction id per bank per group: the second insert with the same
-- (group, bank, txn) is rejected by SQLite itself — the final atomic guard.
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_group_bank_txn
  ON receipts (group_jid, bank, txn_id);

CREATE INDEX IF NOT EXISTS idx_receipts_group_amount
  ON receipts (group_jid, amount);

CREATE INDEX IF NOT EXISTS idx_receipts_group_date
  ON receipts (group_jid, txn_date);

CREATE INDEX IF NOT EXISTS idx_receipts_group_phash
  ON receipts (group_jid, image_phash);

-- Audit log for "needs review" items. No uniqueness: review items are never
-- treated as registered receipts and never block a later, valid registration.
CREATE TABLE IF NOT EXISTS review_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  group_jid    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  details      TEXT,
  image_sha256 TEXT,
  image_phash  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

class ReceiptStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(SCHEMA);

    this.stmtBySha = this.db.prepare(
      'SELECT * FROM receipts WHERE group_jid = ? AND image_sha256 = ?'
    );
    this.stmtByTxn = this.db.prepare(
      'SELECT * FROM receipts WHERE group_jid = ? AND bank = ? AND txn_id = ?'
    );
    this.stmtCombo = this.db.prepare(
      `SELECT * FROM receipts
        WHERE group_jid = ? AND amount = ? AND txn_date = ? AND txn_time = ?
          AND sender_iban IS ? AND receiver_iban IS ?`
    );
    this.stmtAllPhashes = this.db.prepare(
      'SELECT id, image_phash, bank, amount, txn_date, txn_time, sender_iban, receiver_iban, txn_id FROM receipts WHERE group_jid = ? AND image_phash IS NOT NULL'
    );
    this.stmtInsert = this.db.prepare(
      `INSERT INTO receipts
        (group_jid, image_sha256, image_phash, bank, txn_id, amount, currency,
         txn_date, txn_time, sender_iban, receiver_iban, sender_name, receiver_name, raw_text)
       VALUES (@group_jid, @image_sha256, @image_phash, @bank, @txn_id, @amount, @currency,
         @txn_date, @txn_time, @sender_iban, @receiver_iban, @sender_name, @receiver_name, @raw_text)`
    );
    this.stmtReview = this.db.prepare(
      'INSERT INTO review_log (group_jid, reason, details, image_sha256, image_phash) VALUES (?, ?, ?, ?, ?)'
    );
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  findBySha(groupJid, sha) {
    return this.stmtBySha.get(groupJid, sha) || null;
  }

  findByTxn(groupJid, bank, txnId) {
    return this.stmtByTxn.get(groupJid, bank, txnId) || null;
  }

  findCombo(groupJid, amount, date, time, senderIban, receiverIban) {
    return this.stmtCombo.get(groupJid, amount, date, time, senderIban, receiverIban) || null;
  }

  listPhashes(groupJid) {
    return this.stmtAllPhashes.all(groupJid);
  }

  logReview(groupJid, reason, details, sha, phash) {
    this.stmtReview.run(groupJid, reason, details || '', sha || null, phash || null);
  }

  countAll() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n;
  }

  countReceipts(groupJid) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE group_jid = ?').get(groupJid).n;
  }

  countReviews(groupJid) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM review_log WHERE group_jid = ?').get(groupJid).n;
  }

  // Atomic check-and-register. Returns:
  //   { status: 'new', row }        — inserted (this call registered the receipt)
  //   { status: 'duplicate', row }  — an existing row proves duplication
  // The INSERT is the source of truth: UNIQUE constraints make double
  // registration impossible even under concurrent inserts.
  registerReceipt(groupJid, receipt, hashes) {
    const run = this.db.transaction(() => {
      const existingSha = this.findBySha(groupJid, hashes.sha256);
      if (existingSha) return { status: 'duplicate', row: existingSha, reason: 'image_sha256' };

      if (receipt.txnId) {
        const existingTxn = this.findByTxn(groupJid, receipt.bank, receipt.txnId);
        if (existingTxn) return { status: 'duplicate', row: existingTxn, reason: 'txn_id' };
      }

      const row = {
        group_jid: groupJid,
        image_sha256: hashes.sha256,
        image_phash: hashes.phash || null,
        bank: receipt.bank,
        txn_id: receipt.txnId,
        amount: receipt.amount || null,
        currency: receipt.currency || null,
        txn_date: receipt.date || null,
        txn_time: receipt.time || null,
        sender_iban: receipt.senderIban || null,
        receiver_iban: receipt.receiverIban || null,
        sender_name: receipt.senderName || null,
        receiver_name: receipt.receiverName || null,
        raw_text: receipt.rawText || null
      };
      this.stmtInsert.run(row);
      return { status: 'new', row };
    });

    try {
      return run();
    } catch (err) {
      // UNIQUE constraint violation from a concurrent insert -> duplicate.
      if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return {
          status: 'duplicate',
          row: this.findBySha(groupJid, hashes.sha256) ||
               (receipt.txnId ? this.findByTxn(groupJid, receipt.bank, receipt.txnId) : null),
          reason: 'unique_constraint'
        };
      }
      throw err;
    }
  }
}

module.exports = { ReceiptStore, SCHEMA };

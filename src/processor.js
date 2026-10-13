'use strict';

// ---------------------------------------------------------------
// Receipt processor — the pipeline orchestrator.
//
// Input: a Baileys message (already filtered as a group image),
// injected byte-provider and OCR function (for testability).
// Output: { status, reaction } where reaction is '✅' | '❌' | null.
//
// The bot NEVER sends text messages. The only outputs are reactions:
//   ✅ registered as a new receipt
//   ❌ proven duplicate
//   no reaction for anything unclear (ignored / needs review)
//
// Concurrency: a keyed mutex serializes processing of the exact same
// image in the same group, so a double-send resolves deterministically;
// the SQLite UNIQUE constraints remain the final atomic guard.
// ---------------------------------------------------------------

const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');
const { ReceiptStore } = require('./db/database');
const { computeHash } = require('./utils/perceptualHash');
const { parseReceipt } = require('./parsers');
const { checkReceipt } = require('./fraud/fraudEngine');
const dedup = require('./dedup/dedupEngine');
const { isReceiptCandidate, isAllowedGroup } = require('./whatsapp/messageFilter');

class ReceiptProcessor {
  constructor(opts = {}) {
    this.store = opts.store || new ReceiptStore(config.dbPath);
    this.getImageBytes = opts.getImageBytes; // async (msg) => Buffer
    this.ocr = opts.ocr;                     // async (buffer) => string
    if (typeof this.getImageBytes !== 'function' || typeof this.ocr !== 'function') {
      throw new Error('ReceiptProcessor requires getImageBytes and ocr functions');
    }
    this.inFlight = new Map(); // key: groupJid + ':' + sha256 -> Promise chain
  }

  // Keyed mutex: serializes work per (group, image). Different images run in parallel.
  _withLock(key, fn) {
    const prev = this.inFlight.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    this.inFlight.set(key, run);
    run.finally(() => {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    }).catch(() => {});
    return run;
  }

  async hashImage(buffer) {
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    let phash = '';
    try {
      phash = await computeHash(buffer);
    } catch (err) {
      logger.warn({ err: err.message }, 'perceptual hash failed (continuing without it)');
    }
    return { sha256, phash };
  }

  // Main entry point. Never throws — errors become a silent 'ignored'.
  async process(msg) {
    try {
      if (!isReceiptCandidate(msg)) {
        return { status: 'ignored', reaction: null };
      }
      const groupJid = msg.key.remoteJid;
      if (!isAllowedGroup(groupJid)) {
        return { status: 'ignored', reaction: null };
      }

      const buffer = await this.getImageBytes(msg);
      if (!buffer || buffer.length === 0) {
        return { status: 'ignored', reaction: null, reason: 'download_failed' };
      }

      const hashes = await this.hashImage(buffer);

      // Exact-image fast path: duplicate detection without paying for OCR.
      if (this.store.findBySha(groupJid, hashes.sha256)) {
        logger.info({ groupJid }, 'duplicate receipt (image sha256) — no OCR needed');
        return { status: 'duplicate', reaction: config.REACTION_DUPLICATE, reason: 'image_sha256' };
      }

      // Serialize identical images in the same group (double-send race).
      return await this._withLock(groupJid + ':' + hashes.sha256, async () => {
        // Re-check after acquiring the lock — another copy may have finished.
        const pre = this.store.findBySha(groupJid, hashes.sha256);
        if (pre) {
          return { status: 'duplicate', reaction: config.REACTION_DUPLICATE, reason: 'image_sha256' };
        }

        const ocrText = await this.ocr(buffer);
        if (!ocrText || ocrText.trim().length < config.MIN_OCR_TEXT_LEN) {
          this.store.logReview(groupJid, 'ocr_unreadable', 'OCR produced no usable text', hashes.sha256, hashes.phash);
          logger.info({ groupJid }, 'OCR unreadable — no reaction');
          return { status: 'ignored', reaction: null, reason: 'ocr_unreadable' };
        }

        const receipt = parseReceipt(ocrText);
        if (!receipt) {
          if (config.verboseIgnored) this.store.logReview(groupJid, 'not_a_receipt', '', hashes.sha256, hashes.phash);
          logger.info({ groupJid }, 'image is not a bank receipt — no reaction');
          return { status: 'ignored', reaction: null, reason: 'not_a_receipt' };
        }

        const fraud = checkReceipt(receipt, ocrText);
        if (fraud.status === 'review') {
          this.store.logReview(groupJid, 'fraud_review', fraud.issues.join('; '), hashes.sha256, hashes.phash);
          logger.warn({ groupJid, issues: fraud.issues }, 'receipt needs review — no reaction');
          return { status: 'review', reaction: null, reason: 'fraud:' + fraud.issues.join(',') };
        }

        const verdict = dedup.evaluate(this.store, groupJid, receipt, hashes);
        if (verdict.status === 'duplicate') {
          logger.info({ groupJid, reason: verdict.reason }, 'duplicate receipt');
          return { status: 'duplicate', reaction: config.REACTION_DUPLICATE, reason: verdict.reason };
        }
        if (verdict.status === 'review') {
          this.store.logReview(groupJid, 'dedup_review', verdict.reason, hashes.sha256, hashes.phash);
          logger.warn({ groupJid, reason: verdict.reason }, 'suspicious receipt — no reaction');
          return { status: 'review', reaction: null, reason: verdict.reason };
        }

        // Atomic check-and-register (final race guard via UNIQUE constraints).
        const registered = this.store.registerReceipt(groupJid, receipt, hashes);
        if (registered.status === 'duplicate') {
          return { status: 'duplicate', reaction: config.REACTION_DUPLICATE, reason: registered.reason };
        }

        logger.info({ groupJid, bank: receipt.bank, txnId: receipt.txnId }, 'new receipt registered');
        return { status: 'new', reaction: config.REACTION_NEW };
      });
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'processor error — no reaction');
      return { status: 'ignored', reaction: null, reason: 'error:' + err.message };
    }
  }

  close() {
    this.store.close();
  }

  // Total registered receipts across all groups (for the status endpoint).
  safeCountAll() {
    try { return this.store.countAll(); } catch { return -1; }
  }
}

module.exports = { ReceiptProcessor };

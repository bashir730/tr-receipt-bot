'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

module.exports = {
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'receipts.db'),
  sessionDir: process.env.SESSION_DIR || path.join(__dirname, '..', 'session'),
  ocrLang: process.env.OCR_LANG || 'tur+eng',
  logLevel: process.env.LOG_LEVEL || 'info',
  allowedGroups: (process.env.ALLOWED_GROUPS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  verboseIgnored: String(process.env.VERBOSE_IGNORED || '').toLowerCase() === 'true',

  REACTION_NEW: '✅',
  REACTION_DUPLICATE: '❌',

  // Max Hamming distance (of 128 bits) for two images to be "similar"
  PHASH_HAMMING_MAX: 8,

  MIN_OCR_TEXT_LEN: 12,
  MIN_TXN_ID_LEN: 6
};

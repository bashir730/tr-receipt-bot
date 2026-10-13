'use strict';

// ---------------------------------------------------------------
// Perceptual image hashing for receipts.
// Combines a 64-bit average hash (aHash) and a 64-bit difference
// hash (dHash) into one 128-bit hex string (32 chars).
//
// Why combined: receipts are mostly white background + black text,
// so a plain aHash matches ANY receipt. Requiring BOTH the
// brightness layout AND the horizontal gradient pattern keeps the
// false-positive rate low, while exact resized / recompressed copies
// of the same receipt still match.
//
// A perceptual match alone is only SUSPICIOUS — the dedup engine
// decides 'duplicate' only when OCR-extracted data also matches.
// ---------------------------------------------------------------

const { Jimp } = require('jimp');

async function computeHash(buffer) {
  const img = await Jimp.read(buffer);
  img.resize({ w: 9, h: 8 });
  img.greyscale();

  const { data } = img.bitmap;
  // 8 rows x 9 cols grayscale (channel 0 after greyscale)
  const gray = [];
  for (let y = 0; y < 8; y++) {
    const row = [];
    for (let x = 0; x < 9; x++) {
      row.push(data[(y * 9 + x) * 4]);
    }
    gray.push(row);
  }

  // --- aHash: 64 bits, threshold = mean of the 8x8 left block ---
  let sum = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) sum += gray[y][x];
  const mean = sum / 64;

  let hex = '';
  for (let row = 0; row < 8; row++) {
    let b = 0;
    for (let bit = 0; bit < 8; bit++) {
      if (gray[row][bit] >= mean) b |= (1 << (7 - bit));
    }
    hex += b.toString(16).padStart(2, '0');
  }

  // --- dHash: 64 bits, compare horizontally adjacent pixels ---
  for (let row = 0; row < 8; row++) {
    let b = 0;
    for (let bit = 0; bit < 8; bit++) {
      // left pixel darker than right -> 1
      if (gray[row][bit] < gray[row][bit + 1]) b |= (1 << (7 - bit));
    }
    hex += b.toString(16).padStart(2, '0');
  }

  return hex; // 32 hex chars = 128 bits
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { dist += x & 1; x >>= 1; }
  }
  return dist;
}

module.exports = { computeHash, hammingDistance };

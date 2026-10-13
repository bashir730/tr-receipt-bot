'use strict';

// Test helpers: fake Baileys messages, rendered pseudo-receipt images,
// injectable OCR, valid TR IBAN generation.

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Jimp } = require('jimp');
const { computeHash, hammingDistance } = require('../src/utils/perceptualHash');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Generate a valid Turkish IBAN for arbitrary 20 account digits.
function makeTrIban(bban20) {
  const bban = String(bban20).replace(/\D/g, '').padStart(22, '0');
  const rearranged = bban + '2927' + '00'; // 'TR00' in numeric form: T=29, R=27
  let remainder = 0;
  for (const ch of rearranged) {
    remainder = (remainder * 10 + Number(ch)) % 97;
  }
  const check = String(98 - remainder).padStart(2, '0');
  return 'TR' + check + bban;
}

// Deterministic small PRNG from a string, so the same text always
// renders the same pseudo-receipt and different texts differ.
function seededRng(seedStr) {
  let h = 2166136261;
  for (const ch of String(seedStr)) {
    h ^= ch.charCodeAt(0);
    h = (h * 16777619) >>> 0;
  }
  return () => {
    h = (h * 1103515245 + 12345) >>> 0;
    return h / 4294967296;
  };
}

// Render a deterministic pseudo-receipt image (white bg + black bars).
// Tests inject their own OCR text per image, so visual realism is not
// needed — only: same text -> same picture, different text -> clearly
// different picture.
async function renderText(text, opts = {}) {
  const width = opts.width || 420;
  const height = 320;
  const img = new Jimp({ width, height, color: 0xffffffff });
  const data = img.bitmap.data;
  const rand = seededRng(text);

  for (let i = 0; i < 14; i++) {
    const y0 = 18 + i * 20;
    const x0 = 20 + Math.floor(rand() * 70);
    const len = 40 + Math.floor(rand() * Math.max(40, width - 130));
    const shade = i % 3 === 0 ? 0 : 55;
    for (let y = y0; y < Math.min(y0 + 10, height); y++) {
      for (let x = x0; x < Math.min(x0 + len, width); x++) {
        const idx = (y * width + x) * 4;
        data[idx] = shade;
        data[idx + 1] = shade;
        data[idx + 2] = shade;
      }
    }
  }
  return img.getBuffer('image/png');
}

// Resize / re-encode an image (simulates re-compressed screenshot copies).
async function resize(buffer, width) {
  const img = await Jimp.read(buffer);
  img.resize({ w: width });
  return img.getBuffer('image/jpeg');
}

// Fake Baileys image message carrying raw bytes.
let msgCounter = 0;
function makeMsg(jid, bytes) {
  msgCounter += 1;
  return {
    key: { remoteJid: jid, id: 'MSG' + msgCounter, fromMe: false },
    message: { imageMessage: { mimetype: 'image/png', fileLength: bytes.length } },
    _bytes: bytes
  };
}

function makeTextMsg(jid, text) {
  return { key: { remoteJid: jid, id: 'T' + Date.now() + Math.random(), fromMe: false }, message: { conversation: text } };
}

function makeVoiceMsg(jid) {
  return { key: { remoteJid: jid, id: 'V' + Date.now() + Math.random(), fromMe: false }, message: { audioMessage: { mimetype: 'audio/ogg' } } };
}

function makeStickerMsg(jid) {
  return { key: { remoteJid: jid, id: 'S' + Date.now() + Math.random(), fromMe: false }, message: { stickerMessage: { mimetype: 'image/webp' } } };
}

function makeVideoMsg(jid) {
  return { key: { remoteJid: jid, id: 'D' + Date.now() + Math.random(), fromMe: false }, message: { videoMessage: { mimetype: 'video/mp4' } } };
}

const getImageBytes = async (msg) => msg._bytes;

// Fake OCR that maps an image to a text by perceptual closeness to a set of
// known sample images (mirrors real OCR: same content -> same text).
function makeOcr(samples) {
  // samples: [{ phash, text }]
  return async (buffer) => {
    const ph = await computeHash(buffer);
    for (const s of samples) {
      if (hammingDistance(ph, s.phash) <= 8) return s.text;
    }
    return '';
  };
}

const { computeHash: ch } = require('../src/utils/perceptualHash');
async function withPhash(buffer) {
  return { phash: await ch(buffer) };
}

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trrb-'));
  return path.join(dir, name || 'receipts.db');
}

module.exports = {
  sha256,
  makeTrIban,
  renderText,
  resize,
  makeMsg,
  makeTextMsg,
  makeVoiceMsg,
  makeStickerMsg,
  makeVideoMsg,
  getImageBytes,
  makeOcr,
  withPhash,
  tempDbPath
};

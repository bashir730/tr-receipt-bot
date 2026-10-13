'use strict';

// ---------------------------------------------------------------
// Local OCR engine — Tesseract (tesseract.js WASM), Turkish language.
// No external AI API, no paid service. Language data is downloaded
// once and cached in ./langdata.
//
// Preprocessing mirrors the approach used in the reference project
// (ghost-manual, src/bot/cases.js): grayscale + resize, then OCR
// with psm 6, retried with psm 3 when the result is too short.
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');
const config = require('../config');
const logger = require('../logger');

const LANGDATA_DIR = path.join(__dirname, '..', '..', 'langdata');

let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      fs.mkdirSync(LANGDATA_DIR, { recursive: true });
      const { createWorker } = require('tesseract.js');
      const worker = await createWorker(config.ocrLang, 1, {
        cachePath: LANGDATA_DIR,
        logger: () => {}
      });
      return worker;
    })();
  }
  return workerPromise;
}

async function terminateWorker() {
  if (workerPromise) {
    const w = await workerPromise;
    await w.terminate();
    workerPromise = null;
  }
}

// Grayscale + normalize size for better OCR on receipts.
async function preprocess(buffer) {
  const img = await Jimp.read(buffer);
  const w = img.bitmap.width;
  if (w > 1400) {
    img.resize({ w: 1000 });
  } else if (w < 500) {
    const factor = Math.min(2, 800 / Math.max(1, w));
    img.resize({ w: Math.round(w * factor) });
  }
  img.greyscale();
  if (typeof img.contrast === 'function') img.contrast(0.2);
  return img.getBuffer('image/png');
}

// Repairs common OCR output noise that breaks parsing.
function cleanOcrText(text) {
  return String(text || '')
    .replace(/-\s*\n\s*/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[|]/g, 'l')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n');
}

async function ocrImage(buffer) {
  try {
    const pre = await preprocess(buffer);
    const worker = await getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    let data = await worker.recognize(pre);
    let text = cleanOcrText(data.data ? data.data.text : data.text);

    if (!text || text.trim().length < config.MIN_OCR_TEXT_LEN) {
      // retry with automatic page segmentation
      await worker.setParameters({ tessedit_pageseg_mode: '3' });
      data = await worker.recognize(pre);
      const alt = cleanOcrText(data.data ? data.data.text : data.text);
      if (alt && alt.trim().length > text.trim().length) text = alt;
    }
    return text;
  } catch (err) {
    logger.error({ err: err.message }, 'OCR failed');
    return '';
  }
}

module.exports = { ocrImage, terminateWorker, cleanOcrText };

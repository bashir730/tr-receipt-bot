'use strict';

// ---------------------------------------------------------------
// Shared extraction helpers for Turkish receipt parsers.
// All matching is done on folded (diacritics-stripped, lowercased)
// text so OCR noise in Turkish characters does not break parsing.
// ---------------------------------------------------------------

const {
  foldTr,
  parseAmountSmart,
  normalizeDate,
  normalizeTime,
  normalizeIban,
  normalizeTxnId,
  normalizeName,
  toEnglishDigits
} = require('../utils/normalize');

function toLines(text) {
  return String(text || '')
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean);
}

// Strip leading separators/punctuation but keep the value itself
function stripLeadingJunk(s) {
  return String(s || '').replace(/^[\s:;.,\-–—|·•]+/u, '').trim();
}

// Find the value that follows a label. Checks the same line first,
// then the next non-empty line. Returns raw string or ''.
function valueAfterLabel(lines, labelsIn) {
  const labels = Array.isArray(labelsIn) ? labelsIn : [labelsIn];
  for (let i = 0; i < lines.length; i++) {
    const folded = foldTr(lines[i]);
    for (const label of labels) {
      const idx = folded.indexOf(label);
      if (idx === -1) continue;
      const remainder = stripLeadingJunk(lines[i].slice(idx + label.length));
      if (remainder) return remainder;
      if (i + 1 < lines.length) {
        const next = stripLeadingJunk(lines[i + 1]);
        if (next) return next;
      }
    }
  }
  return '';
}

// Extract all IBAN-like strings (normalized). Duplicates removed, order kept.
//
// We match on a whitespace-stripped copy so IBANs broken across lines or with
// OCR-inserted spaces still glue together, and take EXACTLY 24 chars after
// 'TR' so trailing words ('IBAN', 'Tutar', ...) are never swallowed into the
// match (a greedy run would corrupt the IBAN and drop it).
function extractIbans(text) {
  const found = [];
  const raw = toEnglishDigits(String(text || '')).toUpperCase().replace(/\s+/g, '');
  const matches = raw.match(/TR[0-9OILSBGQDZ]{24}/g) || [];
  for (const m of matches) {
    const ib = normalizeIban(m);
    if (/^TR[0-9]{24}$/.test(ib) && !found.includes(ib)) found.push(ib);
  }
  return found;
}

// Extract amount: prefers the value after Tutar/Miktar label,
// falls back to the largest amount-like number in the text.
function extractAmount(text) {
  const lines = toLines(text);
  const raw = valueAfterLabel(lines, ['tutar', 'miktar', 'islem tutari', 'gonderilen tutar', 'toplam']);
  let amount = parseAmountSmart(raw);

  if (!amount) {
    const candidates = [];
    const re = /\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+,\d{2}|\d+(?:\.\d{1,2})?/g;
    const s = toEnglishDigits(String(text || '')).replace(/[\u0600-\u06FF]/g, '');
    let m;
    while ((m = re.exec(s)) !== null) {
      const v = parseAmountSmart(m[0]);
      if (v && parseFloat(v) > 0) candidates.push(v);
    }
    let best = '';
    for (const c of candidates) {
      if (!best || parseFloat(c) > parseFloat(best)) best = c;
    }
    amount = best;
  }
  if (!amount || amount === '0') return '';
  return amount;
}

function extractCurrency(text) {
  const s = foldTr(text);
  if (/\btry\b|\btl\b|lira/.test(s)) return 'TRY';
  if (/\busd\b|dolar/.test(s)) return 'USD';
  if (/\beur\b|euro/.test(s)) return 'EUR';
  return '';
}

// Date + time: prefer labelled fields, fall back to any date / time pattern.
function extractDateTime(text) {
  const lines = toLines(text);
  let date = normalizeDate(valueAfterLabel(lines, ['tarih', 'islem tarihi', 'islem zamani']));
  if (!date) {
    const m = toEnglishDigits(String(text || '')).match(/\b\d{1,4}[\/\.\-]\d{1,2}[\/\.\-]\d{1,4}\b/);
    if (m) date = normalizeDate(m[0]);
  }
  let time = normalizeTime(valueAfterLabel(lines, ['saat', 'islem saati', 'zaman']));
  if (!time) {
    const m = toEnglishDigits(String(text || '')).match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/);
    if (m) time = normalizeTime(m[0]);
  }
  return { date, time };
}

// Transaction id: try each label, normalize, require min length.
function extractTxnId(text, minLen) {
  const lines = toLines(text);
  const raw = valueAfterLabel(lines, [
    'islem takip no', 'islem no', 'islem numarasi', 'referans no',
    'referans numarasi', 'islem kodu', 'dekont no', 'islem id',
    'transaction id', 'reference no', 'islem ref no'
  ]);
  return normalizeTxnId(raw, minLen);
}

// Sender / receiver names after Gonderen / Alici labels.
function extractPartyNames(text) {
  const lines = toLines(text);
  const senderName = normalizeName(valueAfterLabel(lines, ['gonderen', 'gonderen hesap', 'gonderen ad soyad', 'from']));
  const receiverName = normalizeName(valueAfterLabel(lines, ['alici', 'alici hesap', 'alici ad soyad', 'to']));
  return { senderName, receiverName };
}

// Sender / receiver IBANs: prefer IBANs appearing after Gonderen/Alici
// labels on the same line; fall back to order of appearance.
function extractPartyIbans(text) {
  const lines = toLines(text);
  const all = extractIbans(text);
  let senderIban = '';
  let receiverIban = '';

  for (const line of lines) {
    const folded = foldTr(line);
    const ib = extractIbans(line)[0];
    if (!ib) continue;
    if (folded.startsWith('iban') || folded.startsWith('iban:')) continue; // standalone IBAN label
    if (/gonder/.test(folded)) senderIban = senderIban || ib;
    if (/alici|alic\b|al\u0131c/.test(folded) || folded.includes('alici')) receiverIban = receiverIban || ib;
  }
  if (all.length >= 2) {
    if (!senderIban) senderIban = all[0];
    if (!receiverIban) receiverIban = all[1];
  } else if (all.length === 1) {
    if (!receiverIban) receiverIban = all[0];
  }
  return { senderIban, receiverIban };
}

module.exports = {
  toLines,
  valueAfterLabel,
  extractIbans,
  extractAmount,
  extractCurrency,
  extractDateTime,
  extractTxnId,
  extractPartyNames,
  extractPartyIbans,
  foldTr,
  stripLeadingJunk
};

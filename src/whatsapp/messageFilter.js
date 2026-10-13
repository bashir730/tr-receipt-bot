'use strict';

// ---------------------------------------------------------------
// WhatsApp message filter.
// Only images sent in groups are candidates. Everything else
// (text, voice, video, stickers, documents, statuses, own messages)
// is ignored completely — no reaction, no reply, no log spam.
// ---------------------------------------------------------------

const config = require('../config');

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function isAllowedGroup(jid) {
  if (!isGroupJid(jid)) return false;
  if (config.allowedGroups.length === 0) return true;
  return config.allowedGroups.includes(jid);
}

function isOwnMessage(msg) {
  return !!(msg && msg.key && msg.key.fromMe);
}

// Returns the image payload when the message is a plain image message
// (imageMessage either directly or inside ephemeralMessage/viewOnceMessage).
// Returns null for anything else.
function extractImageMessage(msg) {
  const m = msg && msg.message;
  if (!m) return null;

  let content = m;
  // Unwrap ephemeral / view-once containers once
  if (content.ephemeralMessage) content = content.ephemeralMessage;
  if (content.viewOnceMessage) content = content.viewOnceMessage;
  if (content.ephemeralMessage) content = content.ephemeralMessage;

  const img = content.imageMessage;
  if (!img) return null;
  const mime = String(img.mimetype || '');
  if (mime && !mime.startsWith('image/')) return null;
  if (mime === 'image/gif') return null; // animated gifs are not receipts
  return img;
}

function isReceiptCandidate(msg) {
  if (!msg || isOwnMessage(msg)) return false;
  if (!isAllowedGroup(msg.key.remoteJid)) return false;
  return extractImageMessage(msg) !== null;
}

module.exports = { isGroupJid, isAllowedGroup, isOwnMessage, extractImageMessage, isReceiptCandidate };

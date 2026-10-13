#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------
// tr-receipt-bot — entry point.
// WhatsApp bot that reacts ✅ / ❌ to Turkish bank receipts sent in
// groups. It sends NOTHING else — no text replies, no warnings.
//
// Usage:
//   node index.js --qr               (print QR in terminal)
//   node index.js --pair 905xxxxxxxxx (pairing code)
//   node index.js                    (pairing code via prompt if new session)
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');

const config = require('./src/config');
const logger = require('./src/logger');
const { ReceiptProcessor } = require('./src/processor');
const { ocrImage } = require('./src/ocr/ocrEngine');
const { startCloudServer } = require('./src/cloudServer');

// ---- CLI args ----
const args = process.argv.slice(2);
const useQr = args.includes('--qr');
const pairIdx = args.indexOf('--pair');
const pairNumber = pairIdx !== -1 ? args[pairIdx + 1] : null;

// ---- session ----
fs.mkdirSync(config.sessionDir, { recursive: true });

const getImageBytes = async (msg) => {
  return downloadMediaMessage(msg, 'buffer', {}, { logger });
};

let processor;
let sock;
let qrShown = false;
let waConnected = false;
let waRegistered = false;

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);

  const { version } = await fetchLatestWaWebVersion().catch(() => ({ version: [2, 3000, 0] }));

  sock = makeWASocket({
    version,
    auth: state,
    logger: logger.child({ module: 'baileys' }),
    printQRInTerminal: false,
    browser: ['tr-receipt-bot', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on('creds.update', () => {
    try { saveCreds(); } catch {}
    try { waRegistered = !!sock.authState?.creds?.registered; } catch { waRegistered = false; }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (useQr || !pairNumber) {
        qrShown = true;
        console.log('\nBağlanmak için telefonunuzdan bu QR kodunu okutun:\n');
        qrcode.generate(qr, { small: true });
      }
      if (pairNumber && !state.c.registered) {
        try {
          const code = await sock.requestPairingCode(pairNumber);
          console.log('\nEşleştirme kodu: ' + code);
        } catch (err) {
          logger.error({ err: err.message }, 'pairing code failed');
        }
      }
    }

    if (connection === 'open') {
      qrShown = false;
      waConnected = true;
      console.log('✔ WhatsApp bağlandı. Gruplara gönderilen banka dekontları dinleniyor...');
      console.log('  Yanıtlar: ✅ yeni fış / ❌ tekrar (başka hiçbir mesaj gönderilmez).');
    }

    if (connection === 'close') {
      waConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ code, shouldReconnect }, 'connection closed');
      if (shouldReconnect) {
        setTimeout(connect, 3000);
      } else {
        console.log('Oturum kapatıldı (logged out). session klasörünü silip yeniden başlatın.');
        process.exit(1);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      if (!msg.key || msg.key.fromMe) continue;
      if (!msg.key.remoteJid || !msg.key.remoteJid.endsWith('@g.us')) continue;
      if (!config.allowedGroups.length || config.allowedGroups.includes(msg.key.remoteJid)) {
        try {
          const result = await processor.process(msg);
          if (result.reaction && msg.key && msg.key.id) {
            await sock.sendMessage(msg.key.remoteJid, {
              react: { text: result.reaction, key: msg.key }
            });
          }
        } catch (err) {
          logger.error({ err: err.message }, 'message handling failed — staying silent');
        }
      }
    }
  });
}

async function main() {
  processor = new ReceiptProcessor({ getImageBytes, ocr: ocrImage });
  await connect();

  // Cloud mode (Render etc.): PORT is provided by the platform.
  const port = process.env.PORT;
  if (port) {
    startCloudServer({
      port: Number(port),
      getSocket: () => sock,
      getStatus: () => ({
        whatsapp: waConnected ? 'connected' : 'waiting',
        registered: waRegistered,
        receipts: processor.safeCountAll()
      })
    });
  }

  const shutdown = () => {
    try { processor.close(); } catch {}
    try { sock?.end(new Error('shutdown')); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

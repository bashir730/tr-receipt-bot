'use strict';

// ---------------------------------------------------------------
// Cloud / container mode helper.
// On hosts like Render there is no interactive terminal, so the QR
// code in logs is hard to use. Instead we expose a tiny HTTP server:
//
//   GET  /                     health / status (no secret needed)
//   GET  /pairing?secret=...   get (or generate) the WhatsApp pairing
//                              code for PAIR_PHONE, to be typed into
//                              WhatsApp on the phone (Settings ->
//                              Linked devices -> Link a device ->
//                              "Link with phone number").
//
// The pairing endpoint only works when PAIRING_SECRET is set; it
// returns 403 otherwise. No other routes exist and the bot still
// sends nothing to any WhatsApp chat.
// ---------------------------------------------------------------

const http = require('http');
const QRCode = require('qrcode');
const logger = require('./logger');

function startCloudServer({ port, getSocket, getStatus, getQR }) {
  let lastPairingCode = null;
  let lastPairingAt = 0;
  let pairingBusy = false;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (url.pathname === '/') {
      return json(200, Object.assign({ ok: true }, getStatus()));
    }

    if (url.pathname === '/pairing') {
      const secret = process.env.PAIRING_SECRET || '';
      if (!secret) return json(403, { error: 'pairing disabled (PAIRING_SECRET not set)' });
      if (url.searchParams.get('secret') !== secret) return json(403, { error: 'bad secret' });

      const st = getStatus();
      if (st.registered) return json(200, { status: 'already-paired' });

      // Serve a recent code (valid for a short while) without regenerating.
      if (lastPairingCode && Date.now() - lastPairingAt < 2 * 60 * 1000 && !pairingBusy) {
        return json(200, { status: 'ok', pairingCode: lastPairingCode });
      }
      const phone = (process.env.PAIR_PHONE || '').replace(/[^0-9]/g, '');
      if (!phone) return json(409, { error: 'PAIR_PHONE not configured' });

      const sock = getSocket();
      if (!sock || pairingBusy) return json(503, { error: 'whatsapp not ready yet, retry in ~30s' });

      pairingBusy = true;
      try {
        const code = await sock.requestPairingCode(phone);
        lastPairingCode = code;
        lastPairingAt = Date.now();
        return json(200, { status: 'ok', pairingCode: code });
      } catch (err) {
        return json(500, { error: 'pairing failed: ' + err.message });
      } finally {
        pairingBusy = false;
      }
    }

    if (url.pathname === '/qr') {
      const secret = process.env.PAIRING_SECRET || '';
      if (!secret) return json(403, { error: 'QR disabled (PAIRING_SECRET not set)' });
      if (url.searchParams.get('secret') !== secret) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<meta name="viewport" content="width=device-width"><p>Secret incorrect. Add ?secret=PAIRING_SECRET to the URL.</p>');
        return;
      }
      const st = getStatus();
      if (st.registered) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<meta name="viewport" content="width=device-width"><h2>&#10004; WhatsApp connected</h2><pre>' + JSON.stringify(st, null, 2) + '</pre>');
        return;
      }
      const qr = getQR && getQR();
      if (!qr) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'refresh': '10' });
        res.end('<meta name="viewport" content="width=device-width"><p>Waiting for WhatsApp QR... this page reloads every 10s.</p>');
        return;
      }
      const dataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
      const html = '<!doctype html><html><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width">'
        + '<meta http-equiv="refresh" content="20">'
        + '<title>tr-receipt-bot</title><style>body{font-family:sans-serif;text-align:center;background:#111;color:#eee;padding:20px}'
        + 'img{max-width:400px;width:100%;background:#fff;padding:12px;border-radius:12px}'
        + 'p{font-size:18px}code{background:#333;padding:2px 6px;border-radius:6px}</style></head><body>'
        + '<h2>WhatsApp QR</h2>'
        + '<p>WhatsApp &#8594; Settings &#8594; <b>Linked devices</b> &#8594; <b>Link a device</b></p>'
        + '<img src="' + dataUrl + '" alt="QR">'
        + '<p style="color:#8f8">page auto-refreshes while QR is fresh</p>'
        + '<p><small>' + JSON.stringify(st) + '</small></p>'
        + '</body></html>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(port, () => logger.info({ port }, 'cloud server listening'));
  return server;
}

module.exports = { startCloudServer };

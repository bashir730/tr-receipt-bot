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
const logger = require('./logger');

function startCloudServer({ port, getSocket, getStatus }) {
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

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(port, () => logger.info({ port }, 'cloud server listening'));
  return server;
}

module.exports = { startCloudServer };

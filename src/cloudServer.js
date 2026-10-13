'use strict';
// Cloud (Render) helper: binds $PORT, exposes health, QR page and pairing code.
// Guards: /qr and /pairing require ?secret= equal to env PAIRING_SECRET.

const http = require('http');
const fs = require('fs');
const QRCode = require('qrcode');

function startCloudServer(port) {
  const status = () => ({
    ok: true,
    connected: !!(global.sockConnected || global.primaryConnected),
    registered: !!(global.sock && global.sock.authState && global.sock.authState.creds && global.sock.authState.creds.registered),
    bot: 'ghost-manual'
  });

  const checkSecret = (req, url) => {
    const secret = process.env.PAIRING_SECRET || '';
    if (!secret) return false;
    return url.searchParams.get('secret') === secret;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (url.pathname === '/') return json(200, status());

    if (url.pathname === '/qr') {
      if (!checkSecret(req, url)) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<meta name="viewport" content="width=device-width"><p>Secret incorrect or PAIRING_SECRET not set. Add ?secret=YOUR_SECRET</p>');
      }
      const st = status();
      if (st.registered) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<meta name="viewport" content="width=device-width"><h2>&#10004; WhatsApp connected</h2><pre>' + JSON.stringify(st, null, 2) + '</pre>');
      }
      const qr = global.latestQR;
      if (!qr) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'refresh': '10' });
        return res.end('<meta name="viewport" content="width=device-width"><p>Waiting for WhatsApp QR... auto-reloads every 10s</p>');
      }
      let dataUrl = '';
      try { dataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 }); } catch (e) {}
      const html = '<!doctype html><html><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width">'
        + '<meta http-equiv="refresh" content="20"><title>ghost-manual</title>'
        + '<style>body{font-family:sans-serif;text-align:center;background:#111;color:#eee;padding:20px}'
        + 'img{max-width:400px;width:100%;background:#fff;padding:12px;border-radius:12px}</style></head><body>'
        + '<h2>WhatsApp QR</h2>'
        + '<p>WhatsApp &#8594; Settings &#8594; <b>Linked devices</b> &#8594; <b>Link a device</b></p>'
        + (dataUrl ? '<img src="' + dataUrl + '" alt="QR">' : '<p>QR expired, reloading...</p>')
        + '<p><small>' + JSON.stringify(st) + '</small></p></body></html>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname === '/pairing') {
      if (!checkSecret(req, url)) return json(403, { error: 'bad secret' });
      const code = global.lastPairingCode;
      if (!code) return json(503, { ...status(), error: 'pairing code not generated yet, retry in a few seconds' });
      return json(200, { ...status(), pairingCode: code, phone: process.env.PAIR_PHONE || '' });
    }

    json(404, { error: 'not found' });
  });

  server.listen(port, () => console.log('[CLOUD] server listening on port ' + port));
  return server;
}

module.exports = { startCloudServer };

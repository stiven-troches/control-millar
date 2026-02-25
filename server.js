const http = require('http');
const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// Estados de módulos
const states  = {};
const lastMec = {};
for (let i = 1; i <= 27; i++) {
  const id = 'M' + String(i).padStart(2, '0');
  states[id]  = 'green';
  lastMec[id] = '';
}

// Servidor HTTP — sirve panel.html
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/panel.html') {
    const filePath = path.join(__dirname, 'panel.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('panel.html no encontrado'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// WebSocket
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  // Enviar estado actual al nuevo cliente
  ws.send(JSON.stringify({ type: 'init', states, lastMec }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'change' && states[msg.id] !== undefined) {
      states[msg.id] = msg.state;
      if (msg.mecanico) lastMec[msg.id] = msg.mecanico;
      // Reenviar a todos los demás
      const out = JSON.stringify({ type: 'change', id: msg.id, state: msg.state, mecanico: msg.mecanico || '' });
      wss.clients.forEach(c => {
        if (c !== ws && c.readyState === WebSocket.OPEN) c.send(out);
      });
    }
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`Confecciones Millar corriendo en puerto ${PORT}`);
});

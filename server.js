const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ── Estado compartido en memoria ──────────────────────────────────
const MODULES = ['M01','M02','M03','M04','M05','M06','M07','M08','M09','M10',
                 'M11','M12','M13','M14','M15','M16','M17','M18','M19','M20',
                 'M21','M22','M23','M24','M25','M26','M27'];

const states  = {};
const lastMec = {};
MODULES.forEach(id => { states[id] = 'green'; lastMec[id] = ''; });

// ── Servidor HTTP (sirve el index.html) ───────────────────────────
const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// ── WebSocket ─────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  // Enviar estado actual al nuevo cliente
  ws.send(JSON.stringify({
    type: 'init',
    states: { ...states },
    lastMec: { ...lastMec }
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'change' && states[msg.id] !== undefined) {
        states[msg.id] = msg.state;
        if (msg.mecanico) lastMec[msg.id] = msg.mecanico;
        // Retransmitir a todos los demás clientes
        const broadcast = JSON.stringify({
          type: 'change',
          id: msg.id,
          state: msg.state,
          mecanico: msg.mecanico || ''
        });
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === 1) {
            client.send(broadcast);
          }
        });
      }
    } catch (e) {
      console.error('Error procesando mensaje:', e);
    }
  });

  ws.on('close', () => {});
  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});

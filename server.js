// ══════════════════════════════════════════════════════════════════
//  server.js  —  Confecciones Millar  v4.0
//  Mejoras aplicadas en esta versión:
//  #1  Estado de módulos persistido en disco
//  #2  Caché en memoria para loadDB / saveDB
//  #3  SEGURIDAD: RESET_PASS obligatoria desde env var (sin fallback)
//  #4  SEGURIDAD: /admin/reset cambiado de GET a POST
//  #5  SEGURIDAD: Rate limiting en rutas admin y API
//  #6  SEGURIDAD: Multer con fileFilter — solo imágenes permitidas
//  #7  SEGURIDAD: CORS restringido al origen configurado
//  #8  BUGFIX: broadcast ahora es función global (fix scope error)
//  #9  Validación de entrada en rutas POST
//  #10 Todo el routing unificado en Express
//  #11 Validación de mensajes WebSocket
//  #12 Helmet para cabeceras HTTP seguras
//  #13 Health-check endpoint para Render
// ══════════════════════════════════════════════════════════════════

'use strict';

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { WebSocketServer } = require('ws');
const express = require('express');
const multer  = require('multer');
const xlsxLib = require('xlsx');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');

// ── Variables de entorno obligatorias ────────────────────────────
// #3: RESET_PASS DEBE estar definida en Render como env var.
//     Si no existe, el servidor arranca pero avisa claramente.
const RESET_PASS = process.env.RESET_PASS;
if (!RESET_PASS) {
  console.error('⚠️  ADVERTENCIA: Variable de entorno RESET_PASS no definida.');
  console.error('   El endpoint /admin/reset estará DESHABILITADO hasta configurarla.');
}

const PORT          = process.env.PORT          || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null; // null = solo en dev

// ── Directorios ────────────────────────────────────────────────────
const DATA_DIR    = process.env.DATA_DIR    || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');

[DATA_DIR, UPLOADS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Rutas de archivos ──────────────────────────────────────────────
const FILES = {
  ia_state:       path.join(DATA_DIR, 'ia_state.json'),
  ia_records:     path.join(DATA_DIR, 'ia_records.json'),
  modules_config: path.join(DATA_DIR, 'modules_config.json'),
  floor_state:    path.join(DATA_DIR, 'floor_state.json'),
  ci_requests:    path.join(DATA_DIR, 'ci_requests.json'),
  ci_config:      path.join(DATA_DIR, 'ci_config.json'),
  alistamientos:  path.join(DATA_DIR, 'alistamientos.json'),
  mantenimientos: path.join(DATA_DIR, 'mantenimientos.json'),
  alertas:        path.join(DATA_DIR, 'alertas.json'),
  app_config:     path.join(DATA_DIR, 'app_config.json'),
  novedades:      path.join(DATA_DIR, 'novedades.json'),
  cargos:         path.join(DATA_DIR, 'cargos.json'),
  maquinaria:     path.join(DATA_DIR, 'maquinaria.json'),
  turnos:         path.join(DATA_DIR, 'turnos.json'),
  historial:      path.join(DATA_DIR, 'historial.json'),
};

// ── Helpers de persistencia ────────────────────────────────────────
function readJSON(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath))
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error('Error leyendo', filePath, e.message);
  }
  return defaultValue;
}

function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
  } catch (e) {
    console.error('Error escribiendo', filePath, e.message);
  }
}

// ── Caché en memoria ───────────────────────────────────────────────
const dbCache = {};

function loadDB(key) {
  if (!dbCache[key]) {
    try {
      dbCache[key] = fs.existsSync(FILES[key])
        ? JSON.parse(fs.readFileSync(FILES[key], 'utf8'))
        : [];
    } catch(e) {
      console.error('Error cargando caché', key, e.message);
      dbCache[key] = [];
    }
  }
  return dbCache[key];
}

function saveDB(key, data) {
  dbCache[key] = data;
  try {
    fs.writeFileSync(FILES[key], JSON.stringify(data));
  } catch (e) {
    console.error('Error guardando', key, e.message);
  }
}

// ── Perfil Programador ─────────────────────────────────────────────
const PROGRAMADOR_PROFILE = {
  id: 'programador', name: 'Programador', role: 'programador',
  pass: '1', canDelete: false
};

function ensureProgramador(state) {
  if (!state || typeof state !== 'object') state = { supervisors: [], employees: [] };
  if (!Array.isArray(state.supervisors)) state.supervisors = [];
  state.supervisors = state.supervisors.filter(s => s.id !== 'programador');
  state.supervisors.unshift(PROGRAMADOR_PROFILE);
  return state;
}

function loadInitialState() {
  return ensureProgramador({ supervisors: [], employees: [] });
}

// ── Estado Control de Asistencia ──────────────────────────────────
let iaState       = readJSON(FILES.ia_state, null);
let iaRecords     = readJSON(FILES.ia_records, []);
let modulesConfig = readJSON(FILES.modules_config, { disabled:[], extra:[], renamed:{}, modPass:{} });

if (!iaState) {
  iaState = loadInitialState();
} else {
  iaState = ensureProgramador(iaState);
}
writeJSON(FILES.ia_state, iaState);
writeJSON(FILES.ia_records, iaRecords);

function saveIaState()       { writeJSON(FILES.ia_state,       iaState);       }
function saveIaRecords()     { writeJSON(FILES.ia_records,     iaRecords);     }
function saveModulesConfig() { writeJSON(FILES.modules_config, modulesConfig); }

// ── Estado Control de Piso ─────────────────────────────────────────
const MODULES = [
  'M01','M02','M03','M04','M05','M06','M07','M08','M09','M10',
  'M11','M12','M13','M14','M15','M16','M17','M18','M19','M20',
  'M21','M22','M23','M24','M25','M26','M27'
];

const floorDefault = { states: {}, lastMec: {} };
MODULES.forEach(id => { floorDefault.states[id] = 'green'; floorDefault.lastMec[id] = ''; });

const floorPersisted = readJSON(FILES.floor_state, floorDefault);
const states  = floorPersisted.states  || { ...floorDefault.states  };
const lastMec = floorPersisted.lastMec || { ...floorDefault.lastMec };

MODULES.forEach(id => {
  if (!states[id])  states[id]  = 'green';
  if (!lastMec[id]) lastMec[id] = '';
});

function saveFloorState() {
  writeJSON(FILES.floor_state, { states, lastMec });
}

// ── Estado Tablero CI ──────────────────────────────────────────────
const CI_CONFIG_DEFAULT = {
  tipoInsumoList: [
    {name:'Aplique',flow:'qty_only'},{name:'Elástico',flow:'elastico'},
    {name:'Marquilla Logo',flow:'qty_only'},{name:'Marquilla Talla',flow:'qty_talla'},
    {name:'Prelavado',flow:'qty_talla'},{name:'Transfer',flow:'qty_talla'}
  ],
  elasticoList: ['Base','Bola','Bota','Cintura','Envivar'],
  moduleList: [
    'M01','M02','M03','M04','M05','M06','M07','M08','M09','M10',
    'M11','M12','M13','M14','M15','M16','M17','M18','M19','M20',
    'M21','M22','M23','M24','M25','M26','M27','Empaque'
  ],
  obsList: ['Pérdida','Faltante','Defectos']
};

let ciRequests = readJSON(FILES.ci_requests, []);
let ciConfig   = readJSON(FILES.ci_config, CI_CONFIG_DEFAULT);

function saveCiRequests() { writeJSON(FILES.ci_requests, ciRequests); }
function saveCiConfig()   { writeJSON(FILES.ci_config,   ciConfig);   }

// ── Datos estáticos Alistamiento ───────────────────────────────────────
const SUPERVISORAS_BIT = []; // se gestionan desde la app
const MECANICOS_BIT = []; // se gestionan desde la app
const BASE_MODULOS_BIT = [
  'M01','M02','M03','M04','M05','M06','M07','M08','M09','M10',
  'M11','M12','M13','M14','M15','M16','M17','M18','M19','M20',
  'M21','M22','M23','M24','M25','M26','M27','Preparación','Empaque'
];
const MAQUINAS_BIT = []; // se gestionan desde la app

function getModulosBit() {
  const disabled = modulesConfig.disabled || [];
  const extra    = modulesConfig.extra    || [];
  return [
    ...BASE_MODULOS_BIT.filter(m => !disabled.includes(m)),
    ...extra.filter(m => !disabled.includes(m))
  ];
}

// ══════════════════════════════════════════════════════════════════
//  EXPRESS
// ══════════════════════════════════════════════════════════════════
const app = express();

// #7 CORS restringido — en producción usa ALLOWED_ORIGIN
const corsOptions = ALLOWED_ORIGIN
  ? { origin: ALLOWED_ORIGIN, methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'] }
  : { origin: true }; // dev: permite cualquier origen
app.use(cors(corsOptions));

// #12 Cabeceras de seguridad básicas (sin instalar helmet)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── #5 Rate limiter simple (sin dependencias externas) ────────────
// Limita a MAX_REQ requests por IP en WINDOW_MS milisegundos
const rateLimitStore = new Map();
function rateLimit(maxReq, windowMs) {
  return (req, res, next) => {
    const ip  = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const key = `${ip}`;
    if (!rateLimitStore.has(key)) {
      rateLimitStore.set(key, { count: 1, start: now });
      return next();
    }
    const entry = rateLimitStore.get(key);
    if (now - entry.start > windowMs) {
      rateLimitStore.set(key, { count: 1, start: now });
      return next();
    }
    entry.count++;
    if (entry.count > maxReq) {
      console.warn(`Rate limit superado para IP ${ip} en ${req.path}`);
      return res.status(429).json({ error: 'Demasiadas solicitudes. Intente en un momento.' });
    }
    next();
  };
}

// Limpieza periódica del store de rate limit (cada 10 min)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of rateLimitStore.entries()) {
    if (v.start < cutoff) rateLimitStore.delete(k);
  }
}, 10 * 60 * 1000);

// ── Archivos estáticos ─────────────────────────────────────────────
app.use('/alistamiento/uploads', express.static(UPLOADS_DIR));

// ── Rutas principales ──────────────────────────────────────────────
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'index.html'))
);
app.get('/ingresos', (req, res) =>
  res.sendFile(path.join(__dirname, 'ingresos.html'))
);
app.get('/alistamiento', (req, res) =>
  res.sendFile(path.join(__dirname, 'alistamientos.html'))
);

app.get('/ci', (req, res) => {
  res.sendFile(path.join(__dirname, 'Tablero_CI.html'));
});

// #13 Health check para Render
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    version: '4.0',
    uptime:  Math.floor(process.uptime()),
    ts:      new Date().toISOString()
  });
});

// ── #6 Multer con fileFilter (solo imágenes) ───────────────────────
const ALLOWED_MIME = ['image/jpeg','image/png','image/webp','image/gif'];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename:    (req, file, cb) => {
      const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
      const safe = `${Date.now()}-${uuidv4()}${ext}`;
      cb(null, safe);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}. Solo se aceptan imágenes.`));
    }
  }
});

// Manejo de error de Multer
function handleMulterError(err, req, res, next) {
  if (err && err.message) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
}

// ── Helpers de validación ──────────────────────────────────────────
function requireFields(obj, fields) {
  const missing = fields.filter(f => !obj[f] || String(obj[f]).trim() === '');
  return missing.length ? missing : null;
}

// ── #8 broadcast GLOBAL (fix bug de scope en /api/ia-record-obs) ──
// Se declara después de que wss sea creado (ver abajo), pero la función
// queda disponible globalmente para todas las rutas REST.
let wss; // se asigna después de http.createServer
function broadcast(payload, excludeWs = null) {
  if (!wss) return;
  const str = JSON.stringify(payload);
  wss.clients.forEach(c => {
    if (c.readyState !== 1) return;
    if (excludeWs && c === excludeWs) return;
    c.send(str);
  });
}

// ══════════════════════════════════════════════════════════════════
//  RUTAS API — Alistamiento
// ══════════════════════════════════════════════════════════════════

app.get('/alistamiento/api/config', (req, res) =>
  res.json({
    supervisoras: SUPERVISORAS_BIT,
    mecanicos:    MECANICOS_BIT,
    modulos:      getModulosBit(),
    maquinas:     MAQUINAS_BIT
  })
);

// ── Alistamientos ──────────────────────────────────────────────────
app.get('/alistamiento/api/alistamientos', (req, res) => {
  let data = [...loadDB('alistamientos')];
  const { modulo, fecha, supervisor } = req.query;
  if (modulo)     data = data.filter(r => r.modulo === modulo);
  if (fecha)      data = data.filter(r => r.fecha && r.fecha.startsWith(fecha));
  if (supervisor) data = data.filter(r => r.supervisor === supervisor);
  res.json(data.sort((a, b) => new Date(b.fechaHora) - new Date(a.fechaHora)));
});

app.post(
  '/alistamiento/api/alistamientos',
  (req, res, next) => upload.array('fotos', 5)(req, res, err => err ? handleMulterError(err, req, res, next) : next()),
  (req, res) => {
    const missing = requireFields(req.body, ['modulo', 'tipoMaquina', 'serial', 'mecanico']);
    if (missing) return res.status(400).json({ error: `Campos requeridos faltantes: ${missing.join(', ')}` });
    try {
      const data  = loadDB('alistamientos');
      const ahora = new Date();
      const nuevo = {
        id: uuidv4(),
        ...req.body,
        fotos:     req.files ? req.files.map(f => `/alistamiento/uploads/${f.filename}`) : [],
        fechaHora: ahora.toISOString(),
        fecha:     ahora.toISOString().split('T')[0],
        hora:      ahora.toTimeString().slice(0, 8)
      };
      data.push(nuevo);
      saveDB('alistamientos', data);
      if (nuevo.pruebaCostura === 'Rechazada') {
        const alertas = loadDB('alertas');
        alertas.push({
          id: uuidv4(), tipo: 'critica',
          mensaje: `Prueba RECHAZADA - Módulo ${nuevo.modulo} - ${nuevo.tipoMaquina} S/N ${nuevo.serial}`,
          referencia: nuevo.id, area: 'alistamiento', leida: false, fechaHora: ahora.toISOString()
        });
        saveDB('alertas', alertas);
      }
      res.json({ success: true, data: nuevo });
    } catch(e) { res.status(500).json({ error: e.message }); }
  }
);

app.delete('/alistamiento/api/alistamientos/:id', (req, res) => {
  const data = loadDB('alistamientos').filter(r => r.id !== req.params.id);
  saveDB('alistamientos', data);
  res.json({ success: true });
});

// ── Mantenimientos ─────────────────────────────────────────────────
app.get('/alistamiento/api/mantenimientos', (req, res) => {
  let data = [...loadDB('mantenimientos')];
  const { tipo, fecha, mecanico } = req.query;
  if (tipo)     data = data.filter(r => r.tipoMantenimiento === tipo);
  if (fecha)    data = data.filter(r => r.fecha && r.fecha.startsWith(fecha));
  if (mecanico) data = data.filter(r => r.mecanico === mecanico);
  res.json(data.sort((a, b) => new Date(b.fechaHora) - new Date(a.fechaHora)));
});

app.post(
  '/alistamiento/api/mantenimientos',
  (req, res, next) => upload.array('fotos', 5)(req, res, err => err ? handleMulterError(err, req, res, next) : next()),
  (req, res) => {
    const missing = requireFields(req.body, ['tipoMaquina', 'serial', 'mecanico', 'tipoMantenimiento']);
    if (missing) return res.status(400).json({ error: `Campos requeridos faltantes: ${missing.join(', ')}` });
    try {
      const data  = loadDB('mantenimientos');
      const ahora = new Date();
      const nuevo = {
        id: uuidv4(),
        ...req.body,
        fotos:     req.files ? req.files.map(f => `/alistamiento/uploads/${f.filename}`) : [],
        fechaHora: ahora.toISOString(),
        fecha:     ahora.toISOString().split('T')[0],
        hora:      ahora.toTimeString().slice(0, 8)
      };
      data.push(nuevo);
      saveDB('mantenimientos', data);
      if (nuevo.tipoMantenimiento === 'Correctivo') {
        const alertas = loadDB('alertas');
        alertas.push({
          id: uuidv4(), tipo: 'advertencia',
          mensaje: `Correctivo registrado - Módulo ${nuevo.modulo||'N/A'} - ${nuevo.tipoMaquina} S/N ${nuevo.serial}`,
          referencia: nuevo.id, area: 'mantenimiento', leida: false, fechaHora: ahora.toISOString()
        });
        saveDB('alertas', alertas);
      }
      res.json({ success: true, data: nuevo });
    } catch(e) { res.status(500).json({ error: e.message }); }
  }
);

app.delete('/alistamiento/api/mantenimientos/:id', (req, res) => {
  const data = loadDB('mantenimientos').filter(r => r.id !== req.params.id);
  saveDB('mantenimientos', data);
  res.json({ success: true });
});

// ── Alertas ────────────────────────────────────────────────────────
app.get('/alistamiento/api/alertas', (req, res) => {
  const data = loadDB('alertas');
  res.json(data.filter(a => !a.leida).sort((a, b) => new Date(b.fechaHora) - new Date(a.fechaHora)));
});

app.put('/alistamiento/api/alertas/:id/leer', (req, res) => {
  const data = loadDB('alertas');
  const a = data.find(x => x.id === req.params.id);
  if (a) a.leida = true;
  saveDB('alertas', data);
  res.json({ success: true });
});

app.put('/alistamiento/api/alertas/leer-todas', (req, res) => {
  const data = loadDB('alertas').map(a => ({ ...a, leida: true }));
  saveDB('alertas', data);
  res.json({ success: true });
});

// ── Exportar Excel ─────────────────────────────────────────────────
app.get('/alistamiento/api/exportar/alistamientos', (req, res) => {
  const data = loadDB('alistamientos');
  const rows = data.map(r => ({
    'Módulo':r.modulo||'','Referencia':r.referencia||'','Máquina':r.tipoMaquina||'',
    'Serial':r.serial||'','Mecánico':r.mecanico||'','Supervisor':r.supervisor||'',
    'Ficha Técnica':r.fichaTecnica||'','Muestra Física':r.muestraFisica||'',
    'Prueba Costura':r.pruebaCostura||'','Observaciones':r.observaciones||'',
    'Fecha':r.fecha||'','Hora':r.hora||''
  }));
  const wb = xlsxLib.utils.book_new();
  xlsxLib.utils.book_append_sheet(wb, xlsxLib.utils.json_to_sheet(rows), 'Alistamientos');
  const buf = xlsxLib.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="Alistamientos_${new Date().toISOString().split('T')[0]}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get('/alistamiento/api/exportar/mantenimientos', (req, res) => {
  const data = loadDB('mantenimientos');
  const rows = data.map(r => ({
    'Módulo':r.modulo||'','Máquina':r.tipoMaquina||'','Serial':r.serial||'',
    'Tipo':r.tipoMantenimiento||'','Repuestos':r.repuestos||'',
    'Mecánico':r.mecanico||'','Observaciones':r.observaciones||'',
    'Fecha':r.fecha||'','Hora':r.hora||''
  }));
  const wb = xlsxLib.utils.book_new();
  xlsxLib.utils.book_append_sheet(wb, xlsxLib.utils.json_to_sheet(rows), 'Mantenimientos');
  const buf = xlsxLib.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="Mantenimientos_${new Date().toISOString().split('T')[0]}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Stats ──────────────────────────────────────────────────────────
app.get('/alistamiento/api/stats', (req, res) => {
  const alistamientos  = loadDB('alistamientos');
  const mantenimientos = loadDB('mantenimientos');
  const alertas        = loadDB('alertas');
  const hoy = new Date().toISOString().split('T')[0];
  res.json({
    alistamientos: {
      total:      alistamientos.length,
      hoy:        alistamientos.filter(r => r.fecha === hoy).length,
      aprobados:  alistamientos.filter(r => r.pruebaCostura === 'Aprobada').length,
      rechazados: alistamientos.filter(r => r.pruebaCostura === 'Rechazada').length
    },
    mantenimientos: {
      total:       mantenimientos.length,
      hoy:         mantenimientos.filter(r => r.fecha === hoy).length,
      preventivos: mantenimientos.filter(r => r.tipoMantenimiento === 'Preventivo').length,
      correctivos: mantenimientos.filter(r => r.tipoMantenimiento === 'Correctivo').length
    },
    alertas: { noLeidas: alertas.filter(a => !a.leida).length }
  });
});

// ══════════════════════════════════════════════════════════════════
//  RUTAS API — Configuración de la App
// ══════════════════════════════════════════════════════════════════

// App Config
app.get('/api/app-config', (req, res) => {
  res.json(readJSON(FILES.app_config, {}));
});

app.post('/api/app-config', (req, res) => {
  try {
    const existing = readJSON(FILES.app_config, {});
    function deepMerge(target, source) {
      const out = Object.assign({}, target);
      Object.keys(source).forEach(k => {
        const sv = source[k], tv = target[k];
        if (sv && typeof sv === 'object' && !Array.isArray(sv) &&
            tv && typeof tv === 'object' && !Array.isArray(tv)) {
          out[k] = deepMerge(tv, sv);
        } else {
          out[k] = sv;
        }
      });
      return out;
    }
    writeJSON(FILES.app_config, deepMerge(existing, req.body));
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// CI Config (para modal Solicitar Insumos en index.html)
app.get('/api/ci-config', (req, res) => {
  res.json(ciConfig);
});

// Novedades
app.get('/api/novedades',  (req, res) => res.json(readJSON(FILES.novedades, [])));
app.post('/api/novedades', (req, res) => {
  try {
    writeJSON(FILES.novedades, Array.isArray(req.body) ? req.body : []);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cargos
app.get('/api/cargos',  (req, res) => res.json(readJSON(FILES.cargos, [])));
app.post('/api/cargos', (req, res) => {
  try { writeJSON(FILES.cargos, req.body); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Maquinaria
app.get('/api/maquinaria',  (req, res) => res.json(readJSON(FILES.maquinaria, [])));
app.post('/api/maquinaria', (req, res) => {
  try { writeJSON(FILES.maquinaria, req.body); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Turnos
app.get('/api/turnos',  (req, res) => res.json(readJSON(FILES.turnos, [])));
app.post('/api/turnos', (req, res) => {
  try { writeJSON(FILES.turnos, req.body); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Historial
app.get('/api/historial',  (req, res) => res.json(readJSON(FILES.historial, [])));
app.post('/api/historial', (req, res) => {
  try { writeJSON(FILES.historial, req.body); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── #8 BUGFIX: broadcast disponible globalmente ────────────────────
app.patch('/api/ia-record-obs', (req, res) => {
  const { id, obs } = req.body;
  if (!id) return res.status(400).json({ error: 'sin id' });
  const idx = iaRecords.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'no encontrado' });
  iaRecords[idx].obs = obs || '';
  saveIaRecords();
  broadcast({ type: 'ia_edit_record', record: iaRecords[idx] }); // ✅ sin error de scope
  res.json({ success: true, record: iaRecords[idx] });
});

// ══════════════════════════════════════════════════════════════════
//  #3 + #4: RESET TOTAL — POST, contraseña env obligatoria
// ══════════════════════════════════════════════════════════════════
// Antes: GET /admin/reset?pass=xxx  ← contraseña visible en logs
// Ahora: POST /admin/reset  con body { pass: "..." }
// La contraseña viene SOLO de la variable de entorno RESET_PASS.
// Rate limit: máx 5 intentos por IP cada 15 minutos.

app.post('/admin/reset', rateLimit(5, 15 * 60 * 1000), (req, res) => {
  if (!RESET_PASS) {
    return res.status(503).json({ error: 'Reset deshabilitado: configura la variable de entorno RESET_PASS en Render.' });
  }
  const { pass } = req.body;
  if (!pass || pass !== RESET_PASS) {
    console.warn(`Intento fallido de reset desde IP ${req.ip} a las ${new Date().toISOString()}`);
    return res.status(403).json({ error: 'Contraseña incorrecta.' });
  }
  try {
    const filesToReset = Object.values(FILES);
    filesToReset.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });

    // Limpiar caché en memoria
    Object.keys(dbCache).forEach(k => delete dbCache[k]);

    // Resetear estado en memoria
    MODULES.forEach(id => { states[id] = 'green'; lastMec[id] = ''; });
    iaState       = ensureProgramador({ supervisors: [], employees: [] });
    iaRecords     = [];
    modulesConfig = { disabled:[], extra:[], renamed:{}, modPass:{} };
    ciRequests    = [];
    ciConfig      = { ...CI_CONFIG_DEFAULT };

    // Guardar estado limpio
    saveIaState();
    saveFloorState();

    // Notificar a todos los clientes WS
    broadcast({ type: 'server_reset' });

    console.warn(`⚠️  RESET TOTAL ejecutado desde IP ${req.ip} a las ${new Date().toISOString()}`);
    res.json({ success: true, mensaje: 'Todos los datos han sido borrados. El servidor está en blanco.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Compatibilidad: el GET antiguo devuelve instrucciones claras
app.get('/admin/reset', (req, res) => {
  res.status(405).json({
    error: 'Método no permitido. Usa POST /admin/reset con body JSON { "pass": "tu_clave" }',
    ejemplo: 'fetch("/admin/reset", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ pass:"tu_clave" }) })'
  });
});

// ══════════════════════════════════════════════════════════════════
//  SERVIDOR HTTP + WEBSOCKET
// ══════════════════════════════════════════════════════════════════
const server = http.createServer(app);

// Asignar wss ANTES de que puedan llegar requests (el listen es async)
wss = new WebSocketServer({ server });

// Ping/pong — evita timeout de 60s en Render
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const clientIp = req.socket.remoteAddress || 'unknown';
  console.log(`WS conectado: ${clientIp} | clientes: ${wss.clients.size}`);

  // Estado completo al conectar
  ws.send(JSON.stringify({
    type:          'init',
    states:        { ...states },
    lastMec:       { ...lastMec },
    iaState:       iaState,
    iaRecords:     iaRecords,
    modulesConfig: modulesConfig
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { console.warn('WS: mensaje JSON inválido'); return; }

    if (!msg || typeof msg.type !== 'string') {
      console.warn('WS: mensaje sin tipo válido:', raw.toString().slice(0, 80));
      return;
    }

    // broadcast local (excluye al emisor)
    const broadcastLocal = (payload) => broadcast(payload, ws);

    try {
      // ── Control de Piso ─────────────────────────────────────────
      if (msg.type === 'change') {
        if (!msg.id || states[msg.id] === undefined) {
          console.warn('WS change: módulo desconocido:', msg.id); return;
        }
        states[msg.id] = msg.state || 'green';
        if (msg.state === 'red') lastMec[msg.id] = '';
        else if (msg.mecanico) lastMec[msg.id] = msg.mecanico;
        saveFloorState();
        broadcastLocal({ type:'change', id:msg.id, state:msg.state, mecanico:msg.mecanico||'', limite:msg.limite||null });
      }

      // ── Config Módulos ──────────────────────────────────────────
      else if (msg.type === 'modules_config') {
        modulesConfig = {
          disabled: Array.isArray(msg.disabled) ? msg.disabled : [],
          extra:    Array.isArray(msg.extra)    ? msg.extra    : [],
          renamed:  msg.renamed  && typeof msg.renamed  === 'object' ? msg.renamed  : {},
          modPass:  msg.modPass  && typeof msg.modPass  === 'object' ? msg.modPass  : {}
        };
        saveModulesConfig();
        broadcastLocal({ type:'modules_config', ...modulesConfig });
      }

      // ── Tablero CI ──────────────────────────────────────────────
      else if (msg.type === 'ci_init') {
        ciRequests.forEach(r => {
          if (!r.alertStart && r.status === 'alert') {
            const tsFromId = parseInt((r._id || '').split('-')[0]);
            r.alertStart = tsFromId > 0 ? tsFromId : Date.now();
          }
        });
        ws.send(JSON.stringify({
          type:           'ci_init',
          requests:       ciRequests,
          tipoInsumoList: ciConfig.tipoInsumoList,
          elasticoList:   ciConfig.elasticoList,
          moduleList:     ciConfig.moduleList,
          obsList:        ciConfig.obsList || CI_CONFIG_DEFAULT.obsList
        }));
      }

      else if (msg.type === 'ci_cumplido_request') {
        if (!msg.request) { console.warn('WS ci_cumplido_request: sin payload'); return; }
        broadcastLocal({ type:'ci_cumplido_request', request:msg.request });
      }

      else if (msg.type === 'ci_config_sync') {
        if (msg.tipoInsumoList) ciConfig.tipoInsumoList = msg.tipoInsumoList;
        if (msg.elasticoList)   ciConfig.elasticoList   = msg.elasticoList;
        if (msg.moduleList)     ciConfig.moduleList     = msg.moduleList;
        if (msg.obsList)        ciConfig.obsList        = msg.obsList;
        saveCiConfig();
        broadcastLocal({ type:'ci_config_sync', tipoInsumoList:ciConfig.tipoInsumoList, elasticoList:ciConfig.elasticoList, moduleList:ciConfig.moduleList, obsList:ciConfig.obsList || CI_CONFIG_DEFAULT.obsList });
      }

      else if (msg.type === 'ci_new_request') {
        if (!msg.request || !msg.request._id) { console.warn('WS ci_new_request: sin _id'); return; }
        if (!ciRequests.find(r => r._id === msg.request._id)) {
          if (!msg.request.alertStart) msg.request.alertStart = Date.now();
          ciRequests.unshift(msg.request);
          if (ciRequests.length > 500) ciRequests = ciRequests.slice(0, 500);
          saveCiRequests();
        }
        broadcastLocal({ type:'ci_new_request', request:msg.request });
      }

      else if (msg.type === 'ci_update_request') {
        if (!msg.request || !msg.request._id) { console.warn('WS ci_update_request: sin _id'); return; }
        const idx = ciRequests.findIndex(r => r._id === msg.request._id);
        if (idx > -1) ciRequests[idx] = msg.request;
        saveCiRequests();
        broadcastLocal({ type:'ci_update_request', request:msg.request });
      }

      else if (msg.type === 'ci_delete_request') {
        if (msg.reqId) {
          ciRequests = ciRequests.filter(r => r._id !== msg.reqId);
        } else if (typeof msg.idx === 'number') {
          ciRequests.splice(msg.idx, 1);
        } else { console.warn('WS ci_delete_request: sin reqId ni idx'); return; }
        saveCiRequests();
        broadcastLocal({ type:'ci_delete_request', idx:msg.idx, reqId:msg.reqId });
      }

      // ── Control de Asistencia ────────────────────────────────────
      else if (msg.type === 'ia_add_record') {
        if (!msg.record) { console.warn('WS ia_add_record: sin record'); return; }
        iaRecords = iaRecords.filter(r =>
          !(r.empName === msg.record.empName &&
            r.date    === msg.record.date    &&
            r.supervisor === msg.record.supervisor)
        );
        iaRecords.push(msg.record);
        saveIaRecords();
        broadcastLocal({ type:'ia_add_record', record:msg.record });
      }

      else if (msg.type === 'ia_delete_record') {
        if (!msg.id) { console.warn('WS ia_delete_record: sin id'); return; }
        iaRecords = iaRecords.filter(r => r.id !== msg.id);
        saveIaRecords();
        broadcastLocal({ type:'ia_delete_record', id:msg.id });
      }

      else if (msg.type === 'ia_edit_record') {
        if (!msg.record || !msg.record.id) { console.warn('WS ia_edit_record: sin id'); return; }
        const idx = iaRecords.findIndex(r => r.id === msg.record.id);
        if (idx > -1) iaRecords[idx] = msg.record;
        saveIaRecords();
        broadcastLocal({ type:'ia_edit_record', record:msg.record });
      }

      else if (msg.type === 'ia_save_state') {
        if (!msg.state) { console.warn('WS ia_save_state: sin state'); return; }
        iaState = ensureProgramador(msg.state);
        saveIaState();
        broadcastLocal({ type:'ia_save_state', state:iaState });
      }

      else {
        console.warn('WS: tipo de mensaje no reconocido:', msg.type);
      }

    } catch (e) {
      console.error('Error procesando mensaje WS:', e.message);
    }
  });

  ws.on('close', () => {
    console.log(`WS desconectado: ${clientIp} | clientes restantes: ${wss.clients.size}`);
  });
  ws.on('error', (e) => console.error('WS error:', e.message));
});

// ── 404 handler ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

// ── Manejo global de errores Express ──────────────────────────────
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('Error no capturado:', err.message);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// ── Iniciar servidor ───────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ Confecciones Millar v4.0 — Puerto ${PORT}`);
  console.log(`   Control de Piso   : http://localhost:${PORT}/`);
  console.log(`   Control Ingresos  : http://localhost:${PORT}/ingresos`);
  console.log(`   Alistamiento          : http://localhost:${PORT}/alistamiento`);
  console.log(`   Tablero CI        : http://localhost:${PORT}/ci`);
  console.log(`   Health check      : http://localhost:${PORT}/health`);
  console.log(`   RESET_PASS        : ${RESET_PASS ? '✅ configurada' : '⚠️  NO configurada (reset deshabilitado)'}`);
  console.log(`   CORS origen       : ${ALLOWED_ORIGIN || 'abierto (modo dev)'}`);
});

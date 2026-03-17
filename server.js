// ══════════════════════════════════════════════════════════════════
//  server.js  —  Confecciones Millar  v3.0
//  Mejoras aplicadas:
//  #1  Estado de módulos persistido en disco
//  #2  Caché en memoria para loadDB / saveDB (evita I/O por request)
//  #4  Datos de empleados cargados desde data/initial_state.json
//  #5  Validación de entrada en rutas POST
//  #6  Todo el routing unificado en Express (sin handler http manual)
//  #7  Validación de mensajes WebSocket
// ══════════════════════════════════════════════════════════════════

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { WebSocketServer } = require('ws');
const express = require('express');
const multer  = require('multer');
const xlsxLib = require('xlsx');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;

// ── Directorios ───────────────────────────────────────────────────
const DATA_DIR    = process.env.DATA_DIR    || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');

[DATA_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Rutas de archivos ─────────────────────────────────────────────
const FILES = {
  ia_state:      path.join(DATA_DIR, 'ia_state.json'),
  ia_records:    path.join(DATA_DIR, 'ia_records.json'),
  modules_config:path.join(DATA_DIR, 'modules_config.json'),
  floor_state:   path.join(DATA_DIR, 'floor_state.json'),   // #1 nuevo
  ci_requests:   path.join(DATA_DIR, 'ci_requests.json'),
  ci_config:     path.join(DATA_DIR, 'ci_config.json'),
  alistamientos: path.join(DATA_DIR, 'alistamientos.json'),
  mantenimientos:path.join(DATA_DIR, 'mantenimientos.json'),
  alertas:       path.join(DATA_DIR, 'alertas.json'),
  app_config:    path.join(DATA_DIR, 'app_config.json'),
  novedades:     path.join(DATA_DIR, 'novedades.json'),
  cargos:        path.join(DATA_DIR, 'cargos.json'),
  maquinaria:    path.join(DATA_DIR, 'maquinaria.json'),
  turnos:        path.join(DATA_DIR, 'turnos.json'),
  historial:     path.join(DATA_DIR, 'historial.json'),
};

// ── Helpers de persistencia ───────────────────────────────────────
function readJSON(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) { console.error('Error leyendo', filePath, e.message); }
  return defaultValue;
}
function writeJSON(filePath, data) {
  try { fs.writeFileSync(filePath, JSON.stringify(data), 'utf8'); }
  catch (e) { console.error('Error escribiendo', filePath, e.message); }
}

// ── #2 Caché en memoria para Bitácora ────────────────────────────
// En lugar de leer disco en cada request, mantenemos los datos en RAM
// y solo escribimos cuando hay cambios.
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
  try { fs.writeFileSync(FILES[key], JSON.stringify(data)); }
  catch (e) { console.error('Error guardando', key, e.message); }
}

// ── Perfil Programador — SIEMPRE debe existir, nunca se puede borrar ──
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

// Estado inicial vacío — los empleados y supervisores se crean desde la app
// y quedan persistidos en data/ia_state.json en el servidor.
function loadInitialState() {
  return ensureProgramador({ supervisors: [], employees: [] });
}

// ── Estado Control de Asistencia ─────────────────────────────────
let iaState   = readJSON(FILES.ia_state, null);
let iaRecords = readJSON(FILES.ia_records, []);
let modulesConfig = readJSON(FILES.modules_config, { disabled:[], extra:[], renamed:{}, modPass:{} });

if (!iaState) {
  iaState = loadInitialState();
} else {
  iaState = ensureProgramador(iaState);
}
writeJSON(FILES.ia_state, iaState);
writeJSON(FILES.ia_records, iaRecords);

function saveIaState()      { writeJSON(FILES.ia_state,      iaState);       }
function saveIaRecords()    { writeJSON(FILES.ia_records,    iaRecords);     }
function saveModulesConfig(){ writeJSON(FILES.modules_config, modulesConfig); }

// ── #1 Estado Control de Piso — persistido en disco ───────────────
const MODULES = ['M01','M02','M03','M04','M05','M06','M07','M08','M09','M10',
                 'M11','M12','M13','M14','M15','M16','M17','M18','M19','M20',
                 'M21','M22','M23','M24','M25','M26','M27'];

const floorDefault = { states: {}, lastMec: {} };
MODULES.forEach(id => { floorDefault.states[id] = 'green'; floorDefault.lastMec[id] = ''; });

const floorPersisted = readJSON(FILES.floor_state, floorDefault);
const states  = floorPersisted.states  || { ...floorDefault.states  };
const lastMec = floorPersisted.lastMec || { ...floorDefault.lastMec };
// Asegurar que todos los módulos existan (por si se agregaron nuevos)
MODULES.forEach(id => {
  if (!states[id])  states[id]  = 'green';
  if (!lastMec[id]) lastMec[id] = '';
});

function saveFloorState() {
  writeJSON(FILES.floor_state, { states, lastMec });
}

// ── Estado Tablero CI ─────────────────────────────────────────────
let ciRequests = readJSON(FILES.ci_requests, []);
let ciConfig   = readJSON(FILES.ci_config, {
  tipoInsumoList: [
    {name:'Aplique',flow:'qty_only'},{name:'Elástico',flow:'elastico'},
    {name:'Marquilla Logo',flow:'qty_only'},{name:'Marquilla Talla',flow:'qty_talla'},
    {name:'Prelavado',flow:'qty_talla'},{name:'Transfer',flow:'qty_talla'}
  ],
  elasticoList: ['Base','Bola','Bota','Cintura','Envivar'],
  moduleList:   ['M01','M02','M03','M04','M05','M06','M07','M08','M09','M10',
                 'M11','M12','M13','M14','M15','M16','M17','M18','M19','M20',
                 'M21','M22','M23','M24','M25','M26','M27','Empaque'],
  obsList:      ['Pérdida','Faltante','Defectos']
});

function saveCiRequests() { writeJSON(FILES.ci_requests, ciRequests); }
function saveCiConfig()   { writeJSON(FILES.ci_config,   ciConfig);   }

// ── Datos estáticos Bitácora ──────────────────────────────────────
const SUPERVISORAS_BIT = [
  { id:1, nombre:'María Pineda',    modulos:['01','02','03','04','05','06','07','08','09'], rol:'Titular' },
  { id:2, nombre:'Yurani Zapata',   modulos:['10','15','16','17','18','19','20','21'],      rol:'Titular' },
  { id:3, nombre:'Maritza Urrego',  modulos:['Preparación'],                               rol:'Titular' },
  { id:4, nombre:'Mery Tabares',    modulos:['22','23','24','25','26','27'],                rol:'Titular' },
  { id:5, nombre:'Ruby Vilora',     modulos:['Empaque'],                                   rol:'Titular' },
  { id:6, nombre:'Oswaldo Acevedo', modulos:[],                                            rol:'Apoyo'   }
];
const MECANICOS_BIT = [
  'ANDRES RIOS','CESAR CIFUENTES','DAIRON ZAPATA','ELKIN LOPEZ',
  'JUAN C GONZALEZ','OSCAR ZEA','RICARDO SERNA','WALTER PEREZ','YON CANO'
];
const BASE_MODULOS_BIT = [
  'M01','M02','M03','M04','M05','M06','M07','M08','M09','M10',
  'M11','M12','M13','M14','M15','M16','M17','M18','M19','M20',
  'M21','M22','M23','M24','M25','M26','M27','Preparación','Empaque'
];
const MAQUINAS_BIT = [
  'Plana','Fileteadora Sencilla','Fileteadora de Seguridad','Fileteadora Refuerzo',
  'Fileteadora Elástico','Fil Robotina','Recubridora','Cuchilla Izquierda',
  'Cuchilla Derecha','Rec Multiagujas','Simbra','Cerradora Codo',
  'Multiagujas','Botonadora','Ojaladora'
];

function getModulosBit() {
  const disabled = modulesConfig.disabled || [];
  const extra    = modulesConfig.extra    || [];
  return [
    ...BASE_MODULOS_BIT.filter(m => !disabled.includes(m)),
    ...extra.filter(m => !disabled.includes(m))
  ];
}

// ── #6 Express como único router ─────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Archivos estáticos de uploads
app.use('/alistamiento/uploads', express.static(UPLOADS_DIR));

// Servir index.html para la raíz y cualquier ruta no capturada por Express
// (esto reemplaza el handler http manual)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Módulo Control de Ingresos — archivo independiente
app.get('/ingresos', (req, res) => res.sendFile(path.join(__dirname, 'ingresos.html')));

// #8 Advertir si Tablero_CI.html no existe
const CI_PATH = path.join(__dirname, 'Tablero_CI.html');
if (!fs.existsSync(CI_PATH)) {
  console.warn('⚠️  Tablero_CI.html no encontrado — la ruta /ci devolverá 404');
}
app.get('/ci', (req, res) => {
  if (!fs.existsSync(CI_PATH)) return res.status(404).send('Tablero CI no encontrado');
  res.sendFile(CI_PATH);
});

// ── Multer ────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ── #5 Helpers de validación ──────────────────────────────────────
function requireFields(obj, fields) {
  const missing = fields.filter(f => !obj[f] || String(obj[f]).trim() === '');
  return missing.length ? missing : null;
}

// ── Rutas Bitácora ────────────────────────────────────────────────
app.get('/alistamiento', (req, res) =>
  res.sendFile(path.join(__dirname, 'alistamientos.html'))
);

app.get('/alistamiento/api/config', (req, res) =>
  res.json({ supervisoras: SUPERVISORAS_BIT, mecanicos: MECANICOS_BIT, modulos: getModulosBit(), maquinas: MAQUINAS_BIT })
);

// ALISTAMIENTOS
app.get('/alistamiento/api/alistamientos', (req, res) => {
  let data = [...loadDB('alistamientos')];
  const { modulo, fecha, supervisor } = req.query;
  if (modulo)     data = data.filter(r => r.modulo === modulo);
  if (fecha)      data = data.filter(r => r.fecha && r.fecha.startsWith(fecha));
  if (supervisor) data = data.filter(r => r.supervisor === supervisor);
  res.json(data.sort((a,b) => new Date(b.fechaHora) - new Date(a.fechaHora)));
});

app.post('/alistamiento/api/alistamientos', upload.array('fotos', 5), (req, res) => {
  // #5 Validación
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
        id: uuidv4(), tipo:'critica',
        mensaje: `Prueba RECHAZADA - Módulo ${nuevo.modulo} - ${nuevo.tipoMaquina} S/N ${nuevo.serial}`,
        referencia: nuevo.id, area:'alistamiento', leida:false, fechaHora: ahora.toISOString()
      });
      saveDB('alertas', alertas);
    }
    res.json({ success: true, data: nuevo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/alistamiento/api/alistamientos/:id', (req, res) => {
  const data = loadDB('alistamientos').filter(r => r.id !== req.params.id);
  saveDB('alistamientos', data);
  res.json({ success: true });
});

// MANTENIMIENTOS
app.get('/alistamiento/api/mantenimientos', (req, res) => {
  let data = [...loadDB('mantenimientos')];
  const { tipo, fecha, mecanico } = req.query;
  if (tipo)     data = data.filter(r => r.tipoMantenimiento === tipo);
  if (fecha)    data = data.filter(r => r.fecha && r.fecha.startsWith(fecha));
  if (mecanico) data = data.filter(r => r.mecanico === mecanico);
  res.json(data.sort((a,b) => new Date(b.fechaHora) - new Date(a.fechaHora)));
});

app.post('/alistamiento/api/mantenimientos', upload.array('fotos', 5), (req, res) => {
  // #5 Validación
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
        id: uuidv4(), tipo:'advertencia',
        mensaje: `Correctivo registrado - Módulo ${nuevo.modulo||'N/A'} - ${nuevo.tipoMaquina} S/N ${nuevo.serial}`,
        referencia: nuevo.id, area:'mantenimiento', leida:false, fechaHora: ahora.toISOString()
      });
      saveDB('alertas', alertas);
    }
    res.json({ success: true, data: nuevo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/alistamiento/api/mantenimientos/:id', (req, res) => {
  const data = loadDB('mantenimientos').filter(r => r.id !== req.params.id);
  saveDB('mantenimientos', data);
  res.json({ success: true });
});

// ALERTAS
app.get('/alistamiento/api/alertas', (req, res) => {
  const data = loadDB('alertas');
  res.json(data.filter(a => !a.leida).sort((a,b) => new Date(b.fechaHora) - new Date(a.fechaHora)));
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

// EXPORTAR EXCEL
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
  const buf = xlsxLib.write(wb, { type:'buffer', bookType:'xlsx' });
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
  const buf = xlsxLib.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="Mantenimientos_${new Date().toISOString().split('T')[0]}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});


// ══════════════════════════════════════════════════════════════════
//  RUTAS API — Configuración de la App (antes en localStorage)
//  Todos los datos se guardan en el servidor para sincronización
//  entre dispositivos.
// ══════════════════════════════════════════════════════════════════

// ── App Config (perfiles/usuarios extra, áreas, módulos UI) ───────
app.get('/api/app-config', (req, res) => {
  const data = readJSON(FILES.app_config, {});
  res.json(data);
});
app.post('/api/app-config', (req, res) => {
  try {
    const existing = readJSON(FILES.app_config, {});
    // Deep merge: para cada clave del body, si ambos son objetos no-array se mergean
    // si alguno es array o primitivo, el nuevo valor reemplaza
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
    const merged = deepMerge(existing, req.body);
    writeJSON(FILES.app_config, merged);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Novedades ─────────────────────────────────────────────────────
app.get('/api/novedades', (req, res) => {
  res.json(readJSON(FILES.novedades, []));
});
app.post('/api/novedades', (req, res) => {
  try {
    const data = Array.isArray(req.body) ? req.body : [];
    writeJSON(FILES.novedades, data);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Cargos ────────────────────────────────────────────────────────
app.get('/api/cargos', (req, res) => {
  res.json(readJSON(FILES.cargos, []));
});
app.post('/api/cargos', (req, res) => {
  try {
    writeJSON(FILES.cargos, req.body);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Maquinaria ────────────────────────────────────────────────────
app.get('/api/maquinaria', (req, res) => {
  res.json(readJSON(FILES.maquinaria, []));
});
app.post('/api/maquinaria', (req, res) => {
  try {
    writeJSON(FILES.maquinaria, req.body);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Turnos ────────────────────────────────────────────────────────
app.get('/api/turnos', (req, res) => {
  res.json(readJSON(FILES.turnos, []));
});
app.post('/api/turnos', (req, res) => {
  try {
    writeJSON(FILES.turnos, req.body);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Historial mecánicos ───────────────────────────────────────────
app.patch('/api/ia-record-obs', (req, res) => {
  const { id, obs } = req.body;
  if (!id) return res.status(400).json({ error: 'sin id' });
  const idx = iaRecords.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'no encontrado' });
  iaRecords[idx].obs = obs || '';
  saveIaRecords();
  broadcast({ type: 'ia_edit_record', record: iaRecords[idx] });
  res.json({ success: true, record: iaRecords[idx] });
});

app.get('/api/historial', (req, res) => {
  res.json(readJSON(FILES.historial, []));
});
app.post('/api/historial', (req, res) => {
  try {
    writeJSON(FILES.historial, req.body);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── RESET TOTAL ───────────────────────────────────────────────────
// Borra todos los datos y deja el servidor en blanco.
// Protegido con contraseña: GET /admin/reset?pass=TU_CLAVE
// También puedes definir la clave en Render como variable de entorno RESET_PASS
const RESET_PASS = process.env.RESET_PASS || 'millar2024';

app.get('/admin/reset', (req, res) => {
  if (req.query.pass !== RESET_PASS) {
    return res.status(403).json({ error: 'Contraseña incorrecta' });
  }
  try {
    // Borrar archivos de datos del disco
    const filesToReset = [
      FILES.ia_state, FILES.ia_records, FILES.modules_config,
      FILES.floor_state, FILES.ci_requests, FILES.ci_config,
      FILES.alistamientos, FILES.mantenimientos, FILES.alertas,
      FILES.app_config, FILES.novedades, FILES.cargos, FILES.maquinaria, FILES.turnos, FILES.historial
    ];
    filesToReset.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });

    // Limpiar caché en memoria
    Object.keys(dbCache).forEach(k => delete dbCache[k]);

    // Resetear estado en memoria
    MODULES.forEach(id => { states[id] = 'green'; lastMec[id] = ''; });
    iaState       = ensureProgramador({ supervisors: [], employees: [] });
    iaRecords     = [];
    modulesConfig = { disabled:[], extra:[], renamed:{}, modPass:{} };
    ciRequests    = [];
    ciConfig = {
      tipoInsumoList: [
        {name:'Aplique',flow:'qty_only'},{name:'Elástico',flow:'elastico'},
        {name:'Marquilla Logo',flow:'qty_only'},{name:'Marquilla Talla',flow:'qty_talla'},
        {name:'Prelavado',flow:'qty_talla'},{name:'Transfer',flow:'qty_talla'}
      ],
      elasticoList: ['Base','Bola','Bota','Cintura','Envivar'],
      moduleList:   ['M01','M02','M03','M04','M05','M06','M07','M08','M09','M10',
                     'M11','M12','M13','M14','M15','M16','M17','M18','M19','M20',
                     'M21','M22','M23','M24','M25','M26','M27','Empaque'],
      obsList:      ['Pérdida','Faltante','Defectos']
    };

    console.log('⚠️  RESET TOTAL ejecutado');
    res.json({ success: true, mensaje: 'Todos los datos han sido borrados. El servidor está en blanco.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// STATS
app.get('/alistamiento/api/stats', (req, res) => {
  const alistamientos  = loadDB('alistamientos');
  const mantenimientos = loadDB('mantenimientos');
  const alertas        = loadDB('alertas');
  const hoy = new Date().toISOString().split('T')[0];
  res.json({
    alistamientos:  {
      total:     alistamientos.length,
      hoy:       alistamientos.filter(r => r.fecha === hoy).length,
      aprobados: alistamientos.filter(r => r.pruebaCostura === 'Aprobada').length,
      rechazados:alistamientos.filter(r => r.pruebaCostura === 'Rechazada').length
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

// ── #6 Servidor HTTP unificado en Express ─────────────────────────
const server = http.createServer(app);

// ── WebSocket ─────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// Ping/pong — evita timeout de 60s en Render
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

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
    // #7 Validación de mensajes WebSocket
    let msg;
    try { msg = JSON.parse(raw); }
    catch { console.warn('WS: mensaje JSON inválido'); return; }

    if (!msg || typeof msg.type !== 'string') {
      console.warn('WS: mensaje sin tipo válido:', raw.toString().slice(0, 80));
      return;
    }

    const broadcast = (payload, excludeSelf = true) => {
      const str = JSON.stringify(payload);
      wss.clients.forEach(c => {
        if (c.readyState !== 1) return;
        if (excludeSelf && c === ws) return;
        c.send(str);
      });
    };

    try {
      // ── Control de Piso ──────────────────────────────────────
      if (msg.type === 'change') {
        if (!msg.id || states[msg.id] === undefined) {
          console.warn('WS change: módulo desconocido:', msg.id); return;
        }
        states[msg.id] = msg.state || 'green';
        if (msg.state === 'red') lastMec[msg.id] = '';
        else if (msg.mecanico)   lastMec[msg.id] = msg.mecanico;
        saveFloorState(); // #1
        broadcast({ type:'change', id:msg.id, state:msg.state, mecanico:msg.mecanico||'', limite:msg.limite||null });
      }

      // ── Config de Módulos ─────────────────────────────────────
      else if (msg.type === 'modules_config') {
        modulesConfig = {
          disabled: Array.isArray(msg.disabled) ? msg.disabled : [],
          extra:    Array.isArray(msg.extra)    ? msg.extra    : [],
          renamed:  msg.renamed && typeof msg.renamed === 'object' ? msg.renamed : {},
          modPass:  msg.modPass && typeof msg.modPass === 'object' ? msg.modPass : {}
        };
        saveModulesConfig();
        broadcast({ type:'modules_config', ...modulesConfig });
      }

      // ── Tablero CI: inicializar ───────────────────────────────
      else if (msg.type === 'ci_init') {
        ciRequests.forEach(r => {
          if (!r.alertStart && r.status === 'alert') {
            const tsFromId = parseInt((r._id || '').split('-')[0]);
            r.alertStart = tsFromId > 0 ? tsFromId : Date.now();
          }
        });
        ws.send(JSON.stringify({
          type: 'ci_init',
          requests:       ciRequests,
          tipoInsumoList: ciConfig.tipoInsumoList,
          elasticoList:   ciConfig.elasticoList,
          moduleList:     ciConfig.moduleList,
          obsList:        ciConfig.obsList || ['Pérdida','Faltante','Defectos']
        }));
      }

      else if (msg.type === 'ci_cumplido_request') {
        if (!msg.request) { console.warn('WS ci_cumplido_request: sin payload'); return; }
        broadcast({ type:'ci_cumplido_request', request:msg.request });
      }

      else if (msg.type === 'ci_config_sync') {
        if (msg.tipoInsumoList) ciConfig.tipoInsumoList = msg.tipoInsumoList;
        if (msg.elasticoList)   ciConfig.elasticoList   = msg.elasticoList;
        if (msg.moduleList)     ciConfig.moduleList     = msg.moduleList;
        if (msg.obsList)        ciConfig.obsList        = msg.obsList;
        saveCiConfig();
        broadcast({ type:'ci_config_sync', tipoInsumoList:ciConfig.tipoInsumoList, elasticoList:ciConfig.elasticoList, moduleList:ciConfig.moduleList, obsList:ciConfig.obsList || ['Pérdida','Faltante','Defectos'] });
      }

      else if (msg.type === 'ci_new_request') {
        if (!msg.request || !msg.request._id) { console.warn('WS ci_new_request: sin _id'); return; }
        if (!ciRequests.find(r => r._id === msg.request._id)) {
          if (!msg.request.alertStart) msg.request.alertStart = Date.now();
          ciRequests.unshift(msg.request);
          if (ciRequests.length > 500) ciRequests = ciRequests.slice(0, 500);
          saveCiRequests();
        }
        broadcast({ type:'ci_new_request', request:msg.request });
      }

      else if (msg.type === 'ci_update_request') {
        if (!msg.request || !msg.request._id) { console.warn('WS ci_update_request: sin _id'); return; }
        const idx = ciRequests.findIndex(r => r._id === msg.request._id);
        if (idx > -1) ciRequests[idx] = msg.request;
        saveCiRequests();
        broadcast({ type:'ci_update_request', request:msg.request });
      }

      else if (msg.type === 'ci_delete_request') {
        if (msg.reqId) {
          ciRequests = ciRequests.filter(r => r._id !== msg.reqId);
        } else if (typeof msg.idx === 'number') {
          ciRequests.splice(msg.idx, 1);
        } else { console.warn('WS ci_delete_request: sin reqId ni idx'); return; }
        saveCiRequests();
        broadcast({ type:'ci_delete_request', idx:msg.idx, reqId:msg.reqId });
      }

      // ── Control de Asistencia ─────────────────────────────────
      else if (msg.type === 'ia_add_record') {
        if (!msg.record) { console.warn('WS ia_add_record: sin record'); return; }
        iaRecords = iaRecords.filter(r =>
          !(r.empName === msg.record.empName &&
            r.date === msg.record.date &&
            r.supervisor === msg.record.supervisor)
        );
        iaRecords.push(msg.record);
        saveIaRecords();
        broadcast({ type:'ia_add_record', record:msg.record });
      }

      else if (msg.type === 'ia_delete_record') {
        if (!msg.id) { console.warn('WS ia_delete_record: sin id'); return; }
        iaRecords = iaRecords.filter(r => r.id !== msg.id);
        saveIaRecords();
        broadcast({ type:'ia_delete_record', id:msg.id });
      }

      else if (msg.type === 'ia_edit_record') {
        if (!msg.record || !msg.record.id) { console.warn('WS ia_edit_record: sin id'); return; }
        const idx = iaRecords.findIndex(r => r.id === msg.record.id);
        if (idx > -1) iaRecords[idx] = msg.record;
        saveIaRecords();
        broadcast({ type:'ia_edit_record', record:msg.record });
      }

      else if (msg.type === 'ia_save_state') {
        if (!msg.state) { console.warn('WS ia_save_state: sin state'); return; }
        iaState = ensureProgramador(msg.state);
        saveIaState();
        broadcast({ type:'ia_save_state', state:iaState });
      }

      else {
        console.warn('WS: tipo de mensaje no reconocido:', msg.type);
      }

    } catch (e) {
      console.error('Error procesando mensaje WS:', e.message);
    }
  });

  ws.on('close', () => {});
  ws.on('error', (e) => console.error('WS error:', e.message));
});

server.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  console.log(`   Control de Piso : http://localhost:${PORT}/`);
  console.log(`   Bitácora        : http://localhost:${PORT}/alistamiento`);
  console.log(`   Tablero CI      : http://localhost:${PORT}/ci`);
});

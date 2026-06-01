const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('./database.db');

// ========== 1. CREAR TABLAS ==========
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password TEXT,
    is_admin INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    date TEXT,
    home TEXT,
    away TEXT,
    stage TEXT,
    match_datetime TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    match_id TEXT,
    vote TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, match_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS results (
    match_id TEXT PRIMARY KEY,
    result TEXT
  )`);
});

// Crear usuario admin por defecto si no existe (admin / admin123)
const crearAdminPorDefecto = async () => {
  db.get("SELECT id FROM users WHERE name = ?", ["admin"], async (err, row) => {
    if (!row) {
      const hash = await bcrypt.hash("admin123", 10);
      db.run("INSERT INTO users (name, password, is_admin) VALUES (?, ?, ?)",
        ["admin", hash, 1]);
      console.log("✅ Usuario admin creado: admin / admin123");
    }
  });
};

// ========== 2. CARGAR PARTIDOS DESDE OPENFOOTBALL (solo una vez) ==========
async function cargarPartidosDesdeAPI() {
  return new Promise((resolve, reject) => {
    db.get("SELECT COUNT(*) as count FROM matches", async (err, row) => {
      if (err) return reject(err);
      if (row.count > 0) {
        console.log("✅ Los partidos ya existen en la BD.");
        return resolve();
      }
      console.log("🌐 Descargando calendario del Mundial 2026...");
      try {
        const respuesta = await fetch('https://cdn.jsdelivr.net/gh/openfootball/worldcup.json@master/2026/worldcup.json');
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
        const datos = await respuesta.json();
        const insert = db.prepare(`INSERT INTO matches (id, date, home, away, stage, match_datetime) VALUES (?, ?, ?, ?, ?, ?)`);
        for (const partido of datos.matches) {
          const idPartido = `wc_${partido.date}_${partido.team1}_${partido.team2}`.replace(/\s/g, '_');
          const fechaHora = `${partido.date}T${partido.time?.split(' ')[0] || '12:00'}:00`;
          const fechaISO = new Date(fechaHora).toISOString();
          insert.run(idPartido, partido.date, partido.team1, partido.team2, partido.round || partido.group || "Fase de grupos", fechaISO);
        }
        insert.finalize();
        console.log(`✅ Se cargaron ${datos.matches.length} partidos.`);
        resolve();
      } catch (error) {
        console.error("❌ Error cargando partidos:", error);
        reject(error);
      }
    });
  });
}

// ========== 3. ACTUALIZAR RESULTADOS (API-Football, cada 30 min) ==========
const API_FOOTBALL_KEY = '9dd5c5fc800b524e41ec228fbcd61d1b'; // 👈 Reemplázala con tu clave de RapidAPI
const API_FOOTBALL_HOST = 'v3.football.api-sports.io';
const WORLD_CUP_LEAGUE_ID = 1;
const WORLD_CUP_SEASON = 2026;

async function actualizarResultadosAutomaticos() {
  console.log("🔄 Actualizando resultados desde API-Football...");
  try {
    const url = `https://${API_FOOTBALL_HOST}/fixtures?league=${WORLD_CUP_LEAGUE_ID}&season=${WORLD_CUP_SEASON}&status=FT`;
    const response = await fetch(url, {
      headers: { 'x-apisports-key': API_FOOTBALL_KEY }
    });
    const data = await response.json();
    if (!data.response) return;
    let actualizados = 0;
    for (const partido of data.response) {
      if (partido.fixture.status.short === 'FT') {
        let resultado = null;
        if (partido.goals.home > partido.goals.away) resultado = 'home';
        else if (partido.goals.home < partido.goals.away) resultado = 'away';
        else if (partido.goals.home === partido.goals.away) resultado = 'draw';
        if (resultado) {
          const matchId = partido.fixture.id.toString();
          db.run(`INSERT OR REPLACE INTO results (match_id, result) VALUES (?, ?)`, [matchId, resultado]);
          actualizados++;
        }
      }
    }
    console.log(`✅ Resultados actualizados: ${actualizados} partidos finalizados.`);
  } catch (error) {
    console.error("❌ Error actualizando resultados:", error);
  }
}

// ========== 4. MIDDLEWARE DE AUTENTICACIÓN ==========
const sesiones = {}; // { token: { userId, isAdmin } }

function authMiddleware(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  const sesion = sesiones[token];
  if (!sesion) return res.status(401).json({ error: 'Sesión inválida' });
  req.userId = sesion.userId;
  req.isAdmin = sesion.isAdmin;
  next();
}

// ========== 5. RUTAS DE AUTENTICACIÓN ==========
app.post('/api/register', async (req, res) => {
  const { name, password, isAdmin } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Faltan datos' });
  db.get("SELECT id FROM users WHERE name = ?", [name], async (err, row) => {
    if (row) return res.status(400).json({ error: 'El nombre ya existe' });
    const hash = await bcrypt.hash(password, 10);
    db.run("INSERT INTO users (name, password, is_admin) VALUES (?, ?, ?)",
      [name, hash, isAdmin ? 1 : 0], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, name, isAdmin: !!isAdmin });
      });
  });
});

app.post('/api/login', (req, res) => {
  const { name, password } = req.body;
  db.get("SELECT id, name, password, is_admin FROM users WHERE name = ?", [name], async (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Credenciales inválidas' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Credenciales inválidas' });
    const token = Math.random().toString(36).substring(2) + Date.now() + Math.random();
    sesiones[token] = { userId: user.id, isAdmin: user.is_admin === 1 };
    res.json({ token, userId: user.id, name: user.name, isAdmin: user.is_admin === 1 });
  });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization;
  delete sesiones[token];
  res.json({ success: true });
});

// ========== 6. RUTAS PROTEGIDAS ==========
app.get('/api/matches', authMiddleware, (req, res) => {
  db.all('SELECT * FROM matches ORDER BY match_datetime', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/matches/datetime', authMiddleware, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Solo admin' });
  const { matchId, datetime } = req.body;
  db.run("UPDATE matches SET match_datetime = ? WHERE id = ?", [datetime, matchId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.post('/api/vote', authMiddleware, (req, res) => {
  const { matchId, vote } = req.body;
  if (!matchId || !vote) return res.status(400).json({ error: 'Faltan datos' });
  db.get("SELECT match_datetime FROM matches WHERE id = ?", [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Partido no existe' });
    const deadline = new Date(match.match_datetime);
    if (new Date() > deadline) {
      return res.status(403).json({ error: 'Votación cerrada por fecha/hora' });
    }
    db.get("SELECT id FROM votes WHERE user_id = ? AND match_id = ?", [req.userId, matchId], (err, existing) => {
      if (existing) return res.status(403).json({ error: 'Ya votaste en este partido' });
      db.run("INSERT INTO votes (user_id, match_id, vote) VALUES (?, ?, ?)", [req.userId, matchId, vote], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    });
  });
});

app.get('/api/votes', authMiddleware, (req, res) => {
  db.all("SELECT match_id, vote FROM votes WHERE user_id = ?", [req.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const votesMap = {};
    rows.forEach(row => { votesMap[row.match_id] = row.vote; });
    res.json(votesMap);
  });
});

app.get('/api/results', authMiddleware, (req, res) => {
  db.all('SELECT match_id, result FROM results', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const map = {};
    rows.forEach(r => { map[r.match_id] = r.result; });
    res.json(map);
  });
});

app.post('/api/results', authMiddleware, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Solo admin' });
  const { matchId, result } = req.body;
  if (!matchId) return res.status(400).json({ error: 'Faltan datos' });
  if (result === null) {
    db.run("DELETE FROM results WHERE match_id = ?", [matchId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  } else {
    db.run("INSERT OR REPLACE INTO results (match_id, result) VALUES (?, ?)", [matchId, result], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  }
});

app.get('/api/leaderboard', authMiddleware, (req, res) => {
  db.all(`
    SELECT u.id, u.name, 
           SUM(CASE WHEN v.vote = r.result THEN 1 ELSE 0 END) as points
    FROM users u
    LEFT JOIN votes v ON u.id = v.user_id
    LEFT JOIN results r ON v.match_id = r.match_id
    GROUP BY u.id
    ORDER BY points DESC, u.name
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/users', authMiddleware, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Solo admin' });
  db.all('SELECT id, name, is_admin FROM users', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.delete('/api/users/:id', authMiddleware, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Solo admin' });
  const userId = req.params.id;
  db.run("DELETE FROM votes WHERE user_id = ?", [userId]);
  db.run("DELETE FROM users WHERE id = ?", [userId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== 7. INICIAR SERVIDOR ==========
crearAdminPorDefecto();
cargarPartidosDesdeAPI()
  .then(() => {
    actualizarResultadosAutomaticos();
    setInterval(actualizarResultadosAutomaticos, 30 * 60 * 1000);
  })
  .catch(console.error);

app.listen(PORT, () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
});
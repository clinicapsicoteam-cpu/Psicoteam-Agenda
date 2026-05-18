const http   = require('http')
const fs     = require('fs')
const path   = require('path')
const { Pool } = require('pg')

const PORT      = process.env.PORT || 3000
const SEED_FILE = path.join(__dirname, 'data.json')

// ─── POSTGRES ────────────────────────────────────────────────────────────────
// Railway injeta DATABASE_URL automaticamente quando você adiciona o plugin PostgreSQL
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null

// Fallback: arquivo local (desenvolvimento sem banco)
const LOCAL_FILE = path.join('/tmp', 'clinica_data.json')

// ─── SETUP DO BANCO ───────────────────────────────────────────────────────────
async function setupDB() {
  if (!pool) return
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS psicoteam_data (
        id      TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    console.log('✅ Tabela PostgreSQL pronta')

    // Se a tabela estiver vazia, carrega o seed
    const r = await pool.query("SELECT id FROM psicoteam_data WHERE id = 'main'")
    if (r.rowCount === 0) {
      const seed = loadSeed()
      if (seed) {
        await pool.query(
          "INSERT INTO psicoteam_data (id, payload) VALUES ('main', $1)",
          [JSON.stringify(seed)]
        )
        console.log('✅ Seed carregado no PostgreSQL')
      }
    } else {
      console.log('✅ Dados existentes encontrados no PostgreSQL')
    }
  } catch(e) {
    console.error('❌ Erro ao configurar PostgreSQL:', e.message)
  }
}

// ─── READ / WRITE ─────────────────────────────────────────────────────────────
function loadSeed() {
  // Verifica se o seed em /tmp é mais novo (evita re-reset)
  if (fs.existsSync(LOCAL_FILE)) {
    try {
      const local  = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'))
      const seed   = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'))
      const localV = local._version || 0
      const seedV  = seed._version  || 0
      if (localV >= seedV) return local
    } catch(e) {}
  }
  try { return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) } catch(e) { return null }
}

async function readData() {
  // 1. Tenta PostgreSQL
  if (pool) {
    try {
      const r = await pool.query("SELECT payload FROM psicoteam_data WHERE id = 'main'")
      if (r.rowCount > 0) return r.rows[0].payload
    } catch(e) {
      console.warn('⚠️ Leitura PostgreSQL falhou:', e.message)
    }
  }
  // 2. Fallback: arquivo local
  return loadSeed() || { agendas:[], pacientes:[], currentAgendaId:1, nextPatId:1, nextAgendaId:1 }
}

async function writeData(obj) {
  const str = JSON.stringify(obj)

  // 1. Salva no PostgreSQL
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO psicoteam_data (id, payload, updated_at)
         VALUES ('main', $1, NOW())
         ON CONFLICT (id) DO UPDATE SET payload = $1, updated_at = NOW()`,
        [str]
      )
    } catch(e) {
      console.warn('⚠️ Escrita PostgreSQL falhou:', e.message)
    }
  }

  // 2. Sempre salva localmente também (backup duplo)
  try { fs.writeFileSync(LOCAL_FILE, str, 'utf8') } catch(e) {}
  try { fs.writeFileSync(SEED_FILE,  str, 'utf8') } catch(e) {}
}

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────
function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end',  () => { try { resolve(JSON.parse(raw)) } catch(e) { reject(e) } })
    req.on('error', reject)
  })
}

function jsonRes(res, status, obj) {
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(JSON.stringify(obj))
}

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // index.html
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'))
      res.writeHead(200, {
        'Content-Type':  'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      })
      res.end(html)
    } catch(e) { res.writeHead(500); res.end('Erro: ' + e.message) }
    return
  }

  // Imagens
  if (req.method === 'GET' && /\.(png|jpg|jpeg|ico|svg|gif)$/i.test(url)) {
    const name  = decodeURIComponent(path.basename(url))
    const files = fs.readdirSync(__dirname)
    const found = files.find(f =>
      f.toLowerCase() === name.toLowerCase() || f.toLowerCase().endsWith('.png')
    )
    if (found) {
      try {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(fs.readFileSync(path.join(__dirname, found)))
        return
      } catch(e) {}
    }
    res.writeHead(404); res.end('not found')
    return
  }

  // GET /api/data
  if (req.method === 'GET' && url === '/api/data') {
    try {
      const d = await readData()
      jsonRes(res, 200, { ok: true, data: d })
    } catch(e) {
      jsonRes(res, 500, { ok: false, error: e.message })
    }
    return
  }

  // POST /api/data
  if (req.method === 'POST' && url === '/api/data') {
    try {
      const payload = await bodyJson(req)
      await writeData(payload)
      jsonRes(res, 200, { ok: true })
    } catch(e) {
      jsonRes(res, 400, { ok: false, error: e.message })
    }
    return
  }

  // GET /api/status  (diagnóstico)
  if (req.method === 'GET' && url === '/api/status') {
    const dbOk = pool ? await pool.query('SELECT 1').then(()=>true).catch(()=>false) : false
    const d = await readData()
    jsonRes(res, 200, {
      db:         dbOk ? 'PostgreSQL ✅' : pool ? 'PostgreSQL ❌' : 'Sem banco (arquivo)',
      agendas:    d.agendas?.length    || 0,
      pacientes:  d.pacientes?.length  || 0,
      versao:     d._version           || '—',
      timestamp:  new Date().toISOString()
    })
    return
  }

  jsonRes(res, 404, { ok: false, error: 'not found' })
})

// ─── START ────────────────────────────────────────────────────────────────────
setupDB().then(() => {
  server.listen(PORT, async () => {
    const d = await readData()
    const db = pool ? 'PostgreSQL' : 'arquivo local'
    console.log(`✅ PsicoTEAM porta ${PORT} | ${db} | ${d.agendas?.length||0} agendas | ${d.pacientes?.length||0} pacientes`)
  })
})

const http   = require('http')
const fs     = require('fs')
const path   = require('path')
const { Pool } = require('pg')

const PORT      = process.env.PORT || 3000
const SEED_FILE = path.join(__dirname, 'data.json')

// ─── POSTGRES ─────────────────────────────────────────────────────────────────
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null

// ─── SETUP ────────────────────────────────────────────────────────────────────
async function setupDB() {
  if (!pool) return
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS psicoteam_data (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`)

    // Check if data already exists in DB
    const r = await pool.query("SELECT payload FROM psicoteam_data WHERE id='main'")
    
    if (r.rowCount === 0) {
      // DB is empty — load seed ONLY if it has real data (agendas > 0)
      const seed = loadSeedFile()
      if (seed && (seed.agendas?.length || 0) > 0) {
        await pool.query(
          "INSERT INTO psicoteam_data(id,payload) VALUES('main',$1)",
          [JSON.stringify(seed)]
        )
        console.log(`✅ Seed carregado: ${seed.agendas?.length} agendas, ${seed.pacientes?.length} pacientes`)
      }
    } else {
      const existing = r.rows[0].payload
      console.log(`✅ Banco existente: ${existing.agendas?.length||0} agendas, ${existing.pacientes?.length||0} pacientes`)
    }
  } catch(e) {
    console.error('❌ setupDB error:', e.message)
  }
}

function loadSeedFile() {
  try { return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) } catch(e) { return null }
}

// ─── READ / WRITE ──────────────────────────────────────────────────────────────
async function readData() {
  // 1. Try PostgreSQL first (source of truth)
  if (pool) {
    try {
      const r = await pool.query("SELECT payload FROM psicoteam_data WHERE id='main'")
      if (r.rowCount > 0) return r.rows[0].payload
    } catch(e) { console.warn('Read PG error:', e.message) }
  }
  // 2. Fallback: seed file
  return loadSeedFile() || { agendas:[], pacientes:[], currentAgendaId:1, nextPatId:1, nextAgendaId:1 }
}

async function writeData(obj) {
  // 1. Save to PostgreSQL (primary)
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO psicoteam_data(id,payload,updated_at) VALUES('main',$1,NOW())
         ON CONFLICT(id) DO UPDATE SET payload=$1, updated_at=NOW()`,
        [JSON.stringify(obj)]
      )
    } catch(e) { console.warn('Write PG error:', e.message) }
  }
  // 2. Also update seed file as local backup
  try { fs.writeFileSync(SEED_FILE, JSON.stringify(obj, null, 2), 'utf8') } catch(e) {}
}

// ─── HTTP ──────────────────────────────────────────────────────────────────────
function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => { try { resolve(JSON.parse(raw)) } catch(e) { reject(e) } })
    req.on('error', reject)
  })
}

function jsonRes(res, status, obj) {
  res.writeHead(status, {
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type'
  })
  res.end(JSON.stringify(obj))
}

// ─── SERVER ────────────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]

  if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return }

  // Serve index.html
  if (req.method==='GET' && (url==='/' || url==='/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname,'index.html'))
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache,no-store,must-revalidate'})
      res.end(html)
    } catch(e) { res.writeHead(500); res.end('Error: '+e.message) }
    return
  }

  // Serve images
  if (req.method==='GET' && /\.(png|jpg|jpeg|ico|svg|gif)$/i.test(url)) {
    const name  = decodeURIComponent(path.basename(url))
    const files = fs.readdirSync(__dirname)
    const found = files.find(f=>f.toLowerCase()===name.toLowerCase()||f.toLowerCase().endsWith('.png'))
    if (found) {
      try { res.writeHead(200,{'Content-Type':'image/png'}); res.end(fs.readFileSync(path.join(__dirname,found))); return } catch(e) {}
    }
    res.writeHead(404); res.end('not found')
    return
  }

  // GET /api/data
  if (req.method==='GET' && url==='/api/data') {
    try { jsonRes(res,200,{ok:true,data:await readData()}) }
    catch(e) { jsonRes(res,500,{ok:false,error:e.message}) }
    return
  }

  // POST /api/data
  if (req.method==='POST' && url==='/api/data') {
    try {
      const payload = await bodyJson(req)
      // SAFETY: never save if agendas would drop to 0
      const current = await readData()
      if ((payload.agendas?.length||0) === 0 && (current.agendas?.length||0) > 0) {
        console.warn('⚠️ Blocked save: would erase', current.agendas.length, 'agendas')
        jsonRes(res,200,{ok:true,warning:'blocked empty save'})
        return
      }
      await writeData(payload)
      jsonRes(res,200,{ok:true})
    } catch(e) { jsonRes(res,400,{ok:false,error:e.message}) }
    return
  }

  // GET /api/status
  if (req.method==='GET' && url==='/api/status') {
    const dbOk = pool ? await pool.query('SELECT 1').then(()=>true).catch(()=>false) : false
    const d = await readData()
    jsonRes(res,200,{
      db: dbOk?'PostgreSQL ✅':pool?'PostgreSQL ❌':'Sem banco',
      agendas: d.agendas?.length||0,
      pacientes: d.pacientes?.length||0,
      versao: d._version||'—',
      timestamp: new Date().toISOString()
    })
    return
  }

  // GET /api/debug — show raw DB payload summary
  if (req.method==='GET' && url==='/api/debug') {
    try {
      if (!pool) { jsonRes(res,200,{error:'no pool'}); return }
      const r = await pool.query("SELECT payload->'agendas' as agendas, payload->'pacientes' as pacientes, payload->'nextPatId' as nextPatId, updated_at FROM psicoteam_data WHERE id='main'")
      if (r.rowCount===0) { jsonRes(res,200,{error:'no data in DB'}); return }
      const row = r.rows[0]
      const ags = JSON.parse(row.agendas||'[]')
      const pacs = JSON.parse(row.pacientes||'[]')
      jsonRes(res,200,{
        db_agendas: ags.length,
        db_pacientes: pacs.length,
        db_nextPatId: row.nextpatid,
        db_updated: row.updated_at,
        first_paciente: pacs[0]?.nome||null,
        last_paciente: pacs[pacs.length-1]?.nome||null
      })
    } catch(e) { jsonRes(res,500,{error:e.message}) }
    return
  }

  jsonRes(res,404,{ok:false,error:'not found'})

}).listen(PORT, () => {
  setupDB().then(async () => {
    const d = await readData()
    console.log(`✅ PsicoTEAM porta ${PORT} | ${pool?'PostgreSQL':'arquivo'} | ${d.agendas?.length||0} agendas | ${d.pacientes?.length||0} pacientes`)
  })
})

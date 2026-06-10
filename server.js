const http   = require('http')
const fs     = require('fs')
const path   = require('path')
const { Pool } = require('pg')

const PORT      = process.env.PORT || 3000
const SEED_FILE = path.join(__dirname, 'data.json')

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null

async function setupDB() {
  if (!pool) return
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS psicoteam_data (
      id TEXT PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    )`)

    const seed = loadSeedFile()
    if (!seed) return

    const r = await pool.query("SELECT payload->>'_version' as ver, payload->>'_forceUpdate' as force FROM psicoteam_data WHERE id='main'")

    if (r.rowCount === 0) {
      // Empty DB — load seed
      await pool.query("INSERT INTO psicoteam_data(id,payload) VALUES('main',$1)", [JSON.stringify(seed)])
      console.log(`✅ Seed inicial: ${seed.agendas?.length} agendas, ${seed.pacientes?.length} pacientes`)
    } else {
      const dbVer    = parseInt(r.rows[0].ver || '0')
      const seedVer  = seed._version || 0
      const forceUpd = seed._forceUpdate === true

      if (forceUpd && seedVer > dbVer) {
        // Force overwrite DB with new seed data
        await pool.query(
          "UPDATE psicoteam_data SET payload=$1, updated_at=NOW() WHERE id='main'",
          [JSON.stringify(seed)]
        )
        console.log(`✅ DB atualizado forçado (seed v${seedVer} > db v${dbVer})`)
        // Remove forceUpdate flag from seed file
        delete seed._forceUpdate
        try { fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2)) } catch(e) {}
      } else {
        const dbData = await readData()
        console.log(`✅ DB existente: ${dbData.agendas?.length||0} agendas, ${dbData.pacientes?.length||0} pacientes (v${dbVer})`)
      }
    }
  } catch(e) {
    console.error('❌ setupDB error:', e.message)
  }
}

function loadSeedFile() {
  try { return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) } catch(e) { return null }
}

async function readData() {
  if (pool) {
    try {
      const r = await pool.query("SELECT payload FROM psicoteam_data WHERE id='main'")
      if (r.rowCount > 0) return r.rows[0].payload
    } catch(e) { console.warn('Read PG error:', e.message) }
  }
  return loadSeedFile() || { agendas:[], pacientes:[], currentAgendaId:1, nextPatId:1, nextAgendaId:1 }
}

async function writeData(obj) {
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO psicoteam_data(id,payload,updated_at) VALUES('main',$1,NOW())
         ON CONFLICT(id) DO UPDATE SET payload=$1, updated_at=NOW()`,
        [JSON.stringify(obj)]
      )
    } catch(e) { console.warn('Write PG error:', e.message) }
  }
  try { fs.writeFileSync(SEED_FILE, JSON.stringify(obj, null, 2), 'utf8') } catch(e) {}
}

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

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]
  if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return }

  if (req.method==='GET' && (url==='/' || url==='/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname,'index.html'))
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache,no-store,must-revalidate'})
      res.end(html)
    } catch(e) { res.writeHead(500); res.end('Error: '+e.message) }
    return
  }

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

  if (req.method==='GET' && url==='/api/data') {
    try { jsonRes(res,200,{ok:true,data:await readData()}) }
    catch(e) { jsonRes(res,500,{ok:false,error:e.message}) }
    return
  }

  if (req.method==='POST' && url==='/api/data') {
    try {
      const payload = await bodyJson(req)
      // Safety: never erase agendas
      const current = await readData()
      if ((payload.agendas?.length||0) === 0 && (current.agendas?.length||0) > 0) {
        jsonRes(res,200,{ok:true,warning:'blocked empty save'})
        return
      }
      await writeData(payload)
      jsonRes(res,200,{ok:true})
    } catch(e) { jsonRes(res,400,{ok:false,error:e.message}) }
    return
  }

  if (req.method==='GET' && url==='/api/status') {
    const dbOk = pool ? await pool.query('SELECT 1').then(()=>true).catch(()=>false) : false
    const data = await readData()
    // Count slots with patients
    let slots = 0
    ;(data.agendas||[]).forEach(ag => {
      Object.values(ag.slots||{}).forEach(dias => {
        dias.forEach(v => { if(v && v!=='bloqueado' && !v.startsWith('almoco:') && !v.startsWith('reuniao:')) slots++ })
      })
    })
    jsonRes(res,200,{
      db: dbOk?'PostgreSQL ✅':pool?'PostgreSQL ❌':'Sem banco',
      agendas: data.agendas?.length||0,
      pacientes: data.pacientes?.length||0,
      sessoes_agenda: slots,
      versao: data._version||'—',
      timestamp: new Date().toISOString()
    })
    return
  }

  if (req.method==='GET' && url==='/api/debug') {
    try {
      if (!pool) { jsonRes(res,200,{error:'no pool'}); return }
      const r = await pool.query("SELECT payload->'_version' as ver, payload->'_forceUpdate' as fu, updated_at FROM psicoteam_data WHERE id='main'")
      if (r.rowCount===0) { jsonRes(res,200,{error:'no data in DB'}); return }
      const data = await readData()
      let slots = 0
      ;(data.agendas||[]).forEach(ag => {
        Object.values(ag.slots||{}).forEach(dias => {
          dias.forEach(v => { if(v && v!=='bloqueado' && !v.startsWith('almoco:')) slots++ })
        })
      })
      jsonRes(res,200,{
        db_version: r.rows[0].ver,
        db_forceUpdate: r.rows[0].fu,
        db_updated: r.rows[0].updated_at,
        db_agendas: data.agendas?.length||0,
        db_pacientes: data.pacientes?.length||0,
        db_sessoes: slots
      })
    } catch(e) { jsonRes(res,500,{error:e.message}) }
    return
  }

  jsonRes(res,404,{ok:false,error:'not found'})

}).listen(PORT, () => {
  setupDB().then(async () => {
    const data = await readData()
    let slots = 0
    ;(data.agendas||[]).forEach(ag => {
      Object.values(ag.slots||{}).forEach(dias => {
        dias.forEach(v => { if(v && v!=='bloqueado' && !v.startsWith('almoco:')) slots++ })
      })
    })
    console.log(`✅ PsicoTEAM porta ${PORT} | ${data.agendas?.length||0} agendas | ${data.pacientes?.length||0} pacientes | ${slots} sessões`)
  })
})

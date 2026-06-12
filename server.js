const http = require('http')
const fs   = require('fs')
const path = require('path')
const { Pool } = require('pg')

const PORT      = process.env.PORT || 3000
const SEED_FILE = path.join(__dirname, 'data.json')

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 20,                    // pool de 20 conexões simultâneas
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000
    })
  : null

// ─── SETUP ────────────────────────────────────────────────────────────────────
async function setupDB() {
  if (!pool) return
  try {
    // Tabela principal de dados (estado global: pacientes, execuções, config)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS psicoteam_data (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`)

    // Tabela de slots — cada linha é UM slot de UMA agenda num dia específico
    // Permite updates atômicos sem conflito entre usuários
    await pool.query(`
      CREATE TABLE IF NOT EXISTS psicoteam_slots (
        agenda_id   INTEGER NOT NULL,
        slot        TEXT    NOT NULL,
        dia         INTEGER NOT NULL,
        valor       TEXT    NOT NULL DEFAULT '',
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (agenda_id, slot, dia)
      )`)

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_slots_agenda ON psicoteam_slots(agenda_id)`)

    // Carrega seed se DB vazio
    const r = await pool.query("SELECT payload->>'_version' as ver FROM psicoteam_data WHERE id='main'")
    const seed = loadSeedFile()
    if (!seed) return

    if (r.rowCount === 0) {
      await pool.query("INSERT INTO psicoteam_data(id,payload) VALUES('main',$1)", [JSON.stringify(seed)])
      console.log(`✅ Seed: ${seed.agendas?.length} agendas, ${seed.pacientes?.length} pacientes`)
    } else {
      const dbVer   = parseInt(r.rows[0].ver || '0')
      const seedVer = parseInt(seed._version || '0')
      if (seedVer > dbVer) {
        await pool.query("UPDATE psicoteam_data SET payload=$1, updated_at=NOW() WHERE id='main'", [JSON.stringify(seed)])
        console.log(`✅ Seed atualizado v${seedVer}`)
      } else {
        console.log(`✅ DB preservado v${dbVer}`)
      }
    }
  } catch(e) {
    console.error('❌ setupDB:', e.message)
  }
}

function loadSeedFile() {
  try { return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) } catch(e) { return null }
}

// ─── READ ─────────────────────────────────────────────────────────────────────
async function readData() {
  if (!pool) return loadSeedFile() || {}
  try {
    // Lê dados principais
    const r = await pool.query("SELECT payload FROM psicoteam_data WHERE id='main'")
    if (r.rowCount === 0) return loadSeedFile() || {}
    const data = r.rows[0].payload

    // Sobrepõe slots da tabela psicoteam_slots (fonte de verdade para agendamentos)
    const slots = await pool.query("SELECT agenda_id, slot, dia, valor FROM psicoteam_slots")
    if (slots.rowCount > 0) {
      // Inicializa slots das agendas se necessário
      ;(data.agendas || []).forEach(ag => {
        if (!ag.slots) ag.slots = {}
      })
      slots.rows.forEach(row => {
        const ag = (data.agendas || []).find(a => a.id === row.agenda_id)
        if (!ag) return
        if (!ag.slots[row.slot]) ag.slots[row.slot] = ['','','','','','bloqueado']
        ag.slots[row.slot][row.dia] = row.valor
      })
    }
    return data
  } catch(e) {
    console.warn('readData error:', e.message)
    return loadSeedFile() || {}
  }
}

// ─── WRITE FULL STATE ─────────────────────────────────────────────────────────
async function writeData(obj) {
  if (!pool) {
    try { fs.writeFileSync(SEED_FILE, JSON.stringify(obj, null, 2)) } catch(e) {}
    return
  }
  try {
    // Salva dados principais (sem slots — eles ficam na tabela dedicada)
    const dataWithoutSlots = JSON.parse(JSON.stringify(obj))
    ;(dataWithoutSlots.agendas || []).forEach(ag => { ag.slots = {} })

    // Mantém versão atual
    const cur = await pool.query("SELECT payload->>'_version' as ver FROM psicoteam_data WHERE id='main'")
    const curVer = parseInt(cur.rows[0]?.ver || '0')
    if (!dataWithoutSlots._version || parseInt(dataWithoutSlots._version) < curVer) {
      dataWithoutSlots._version = curVer
    }

    await pool.query(
      `INSERT INTO psicoteam_data(id,payload,updated_at) VALUES('main',$1,NOW())
       ON CONFLICT(id) DO UPDATE SET payload=$1, updated_at=NOW()`,
      [JSON.stringify(dataWithoutSlots)]
    )

    // Salva todos os slots na tabela dedicada (bulk upsert)
    const slotRows = []
    ;(obj.agendas || []).forEach(ag => {
      Object.entries(ag.slots || {}).forEach(([slot, dias]) => {
        dias.forEach((valor, dia) => {
          if (dia >= 6) return
          slotRows.push([ag.id, slot, dia, valor || ''])
        })
      })
    })

    if (slotRows.length > 0) {
      // Bulk upsert em lotes de 100
      for (let i = 0; i < slotRows.length; i += 100) {
        const batch = slotRows.slice(i, i + 100)
        const vals  = batch.map((_, j) => `($${j*4+1},$${j*4+2},$${j*4+3},$${j*4+4},NOW())`).join(',')
        const flat  = batch.flat()
        await pool.query(
          `INSERT INTO psicoteam_slots(agenda_id,slot,dia,valor,updated_at) VALUES ${vals}
           ON CONFLICT(agenda_id,slot,dia) DO UPDATE SET valor=EXCLUDED.valor, updated_at=NOW()`,
          flat
        )
      }
    }

    try { fs.writeFileSync(SEED_FILE, JSON.stringify(obj, null, 2)) } catch(e) {}
  } catch(e) {
    console.warn('writeData error:', e.message)
  }
}

// ─── WRITE SINGLE SLOT (atômico — sem conflito) ───────────────────────────────
async function writeSlot(agendaId, slot, dia, valor) {
  if (!pool) return
  try {
    await pool.query(
      `INSERT INTO psicoteam_slots(agenda_id,slot,dia,valor,updated_at) VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT(agenda_id,slot,dia) DO UPDATE SET valor=$4, updated_at=NOW()`,
      [agendaId, slot, dia, valor || '']
    )
  } catch(e) {
    console.warn('writeSlot error:', e.message)
  }
}

// ─── HTTP ──────────────────────────────────────────────────────────────────────
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
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type'
  })
  res.end(JSON.stringify(obj))
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // index.html
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'))
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache,no-store,must-revalidate'})
      res.end(html)
    } catch(e) { res.writeHead(500); res.end('Error: ' + e.message) }
    return
  }

  // Imagens
  if (req.method === 'GET' && /\.(png|jpg|jpeg|ico|svg|gif)$/i.test(url)) {
    const name  = decodeURIComponent(path.basename(url))
    const files = fs.readdirSync(__dirname)
    const found = files.find(f => f.toLowerCase() === name.toLowerCase() || f.toLowerCase().endsWith('.png'))
    if (found) {
      try { res.writeHead(200, {'Content-Type':'image/png'}); res.end(fs.readFileSync(path.join(__dirname, found))); return } catch(e) {}
    }
    res.writeHead(404); res.end('not found')
    return
  }

  // GET /api/data — lê estado completo com slots
  if (req.method === 'GET' && url === '/api/data') {
    try { jsonRes(res, 200, {ok:true, data: await readData()}) }
    catch(e) { jsonRes(res, 500, {ok:false, error:e.message}) }
    return
  }

  // POST /api/data — salva estado completo
  if (req.method === 'POST' && url === '/api/data') {
    try {
      const payload = await bodyJson(req)
      const current = await readData()
      if ((payload.agendas?.length||0) === 0 && (current.agendas?.length||0) > 0) {
        jsonRes(res, 200, {ok:true, warning:'blocked empty agendas'})
        return
      }
      await writeData(payload)
      jsonRes(res, 200, {ok:true})
    } catch(e) { jsonRes(res, 400, {ok:false, error:e.message}) }
    return
  }

  // POST /api/slot — salva UM slot atomicamente (sem conflito entre usuários!)
  if (req.method === 'POST' && url === '/api/slot') {
    try {
      const {agendaId, slot, dia, valor} = await bodyJson(req)
      if (agendaId === undefined || !slot || dia === undefined) {
        jsonRes(res, 400, {ok:false, error:'agendaId, slot, dia obrigatórios'}); return
      }
      await writeSlot(parseInt(agendaId), slot, parseInt(dia), valor)
      jsonRes(res, 200, {ok:true})
    } catch(e) { jsonRes(res, 400, {ok:false, error:e.message}) }
    return
  }

  // GET /api/status
  if (req.method === 'GET' && url === '/api/status') {
    const dbOk = pool ? await pool.query('SELECT 1').then(()=>true).catch(()=>false) : false
    const data = await readData()
    let slots = 0
    ;(data.agendas||[]).forEach(ag => {
      Object.values(ag.slots||{}).forEach(dias => {
        dias.forEach(v => { if(v && v!=='bloqueado' && !v.startsWith('almoco:') && !v.startsWith('reuniao:')) slots++ })
      })
    })
    jsonRes(res, 200, {
      db: dbOk ? 'PostgreSQL ✅' : pool ? 'PostgreSQL ❌' : 'Sem banco',
      agendas: data.agendas?.length||0,
      pacientes: data.pacientes?.length||0,
      sessoes: slots,
      versao: data._version||'—',
      timestamp: new Date().toISOString()
    })
    return
  }

  // GET /api/load-slots — carrega slots_seed.json no PostgreSQL (uso único)
  if (req.method === 'GET' && url === '/api/load-slots') {
    try {
      const slotsFile = path.join(__dirname, 'slots_seed.json')
      if (!fs.existsSync(slotsFile)) {
        jsonRes(res, 404, {error: 'slots_seed.json não encontrado'}); return
      }
      const slotsData = JSON.parse(fs.readFileSync(slotsFile, 'utf8'))
      if (!pool) { jsonRes(res, 400, {error: 'PostgreSQL não conectado'}); return }

      let inserted = 0
      for (const [agIdStr, agSlots] of Object.entries(slotsData)) {
        const agId = parseInt(agIdStr)
        const rows = []
        for (const [slot, dias] of Object.entries(agSlots)) {
          dias.forEach((valor, dia) => {
            if (dia < 6) rows.push([agId, slot, dia, valor || ''])
          })
        }
        if (rows.length > 0) {
          for (let i = 0; i < rows.length; i += 100) {
            const batch = rows.slice(i, i + 100)
            const vals  = batch.map((_, j) => `($${j*4+1},$${j*4+2},$${j*4+3},$${j*4+4},NOW())`).join(',')
            await pool.query(
              `INSERT INTO psicoteam_slots(agenda_id,slot,dia,valor,updated_at) VALUES ${vals}
               ON CONFLICT(agenda_id,slot,dia) DO UPDATE SET valor=EXCLUDED.valor, updated_at=NOW()`,
              batch.flat()
            )
            inserted += batch.length
          }
        }
      }

      // Count result
      const r = await pool.query("SELECT COUNT(*) as c FROM psicoteam_slots WHERE valor != '' AND valor != 'bloqueado'")
      jsonRes(res, 200, {
        ok: true,
        inserted,
        db_sessoes: parseInt(r.rows[0].c),
        message: 'Slots carregados com sucesso!'
      })
    } catch(e) {
      jsonRes(res, 500, {error: e.message})
    }
    return
  }

  // GET /api/debug
  if (req.method === 'GET' && url === '/api/debug') {
    try {
      if (!pool) { jsonRes(res, 200, {error:'no pool'}); return }
      const r  = await pool.query("SELECT payload->>'_version' as ver, payload->>'_forceUpdate' as fu, updated_at FROM psicoteam_data WHERE id='main'")
      const rs = await pool.query("SELECT COUNT(*) as total FROM psicoteam_slots WHERE valor != '' AND valor != 'bloqueado'")
      const data = await readData()
      jsonRes(res, 200, {
        db_version:     r.rows[0]?.ver,
        db_forceUpdate: r.rows[0]?.fu,
        db_updated:     r.rows[0]?.updated_at,
        db_agendas:     data.agendas?.length||0,
        db_pacientes:   data.pacientes?.length||0,
        db_sessoes:     parseInt(rs.rows[0]?.total||0)
      })
    } catch(e) { jsonRes(res, 500, {error:e.message}) }
    return
  }

  jsonRes(res, 404, {ok:false, error:'not found'})

}).listen(PORT, () => {
  setupDB().then(async () => {
    const data = await readData()
    const sr   = pool ? await pool.query("SELECT COUNT(*) as c FROM psicoteam_slots WHERE valor != '' AND valor != 'bloqueado'").catch(()=>({rows:[{c:0}]})) : {rows:[{c:0}]}
    console.log(`✅ PsicoTEAM porta ${PORT} | ${data.agendas?.length||0} agendas | ${data.pacientes?.length||0} pacientes | ${sr.rows[0].c} slots`)
  })
})
const http = require('http')
const fs   = require('fs')
const path = require('path')
const { Pool } = require('pg')

const PORT      = process.env.PORT || 3000
const SEED_FILE = path.join(__dirname, 'data.json')

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 20,                    // pool de 20 conexões simultâneas
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000
    })
  : null

// ─── SETUP ────────────────────────────────────────────────────────────────────
async function setupDB() {
  if (!pool) return
  try {
    // Tabela principal de dados (estado global: pacientes, execuções, config)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS psicoteam_data (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`)

    // Tabela de slots — cada linha é UM slot de UMA agenda num dia específico
    // Permite updates atômicos sem conflito entre usuários
    await pool.query(`
      CREATE TABLE IF NOT EXISTS psicoteam_slots (
        agenda_id   INTEGER NOT NULL,
        slot        TEXT    NOT NULL,
        dia         INTEGER NOT NULL,
        valor       TEXT    NOT NULL DEFAULT '',
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (agenda_id, slot, dia)
      )`)

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_slots_agenda ON psicoteam_slots(agenda_id)`)

    // Carrega seed se DB vazio
    const r = await pool.query("SELECT payload->>'_version' as ver FROM psicoteam_data WHERE id='main'")
    const seed = loadSeedFile()
    if (!seed) return

    if (r.rowCount === 0) {
      await pool.query("INSERT INTO psicoteam_data(id,payload) VALUES('main',$1)", [JSON.stringify(seed)])
      console.log(`✅ Seed: ${seed.agendas?.length} agendas, ${seed.pacientes?.length} pacientes`)
    } else {
      const dbVer   = parseInt(r.rows[0].ver || '0')
      const seedVer = parseInt(seed._version || '0')
      if (seedVer > dbVer) {
        await pool.query("UPDATE psicoteam_data SET payload=$1, updated_at=NOW() WHERE id='main'", [JSON.stringify(seed)])
        console.log(`✅ Seed atualizado v${seedVer}`)
      } else {
        console.log(`✅ DB preservado v${dbVer}`)
      }
    }
  } catch(e) {
    console.error('❌ setupDB:', e.message)
  }
}

function loadSeedFile() {
  try { return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) } catch(e) { return null }
}

// ─── READ ─────────────────────────────────────────────────────────────────────
async function readData() {
  if (!pool) return loadSeedFile() || {}
  try {
    // Lê dados principais
    const r = await pool.query("SELECT payload FROM psicoteam_data WHERE id='main'")
    if (r.rowCount === 0) return loadSeedFile() || {}
    const data = r.rows[0].payload

    // Sobrepõe slots da tabela psicoteam_slots (fonte de verdade para agendamentos)
    const slots = await pool.query("SELECT agenda_id, slot, dia, valor FROM psicoteam_slots")
    if (slots.rowCount > 0) {
      // Inicializa slots das agendas se necessário
      ;(data.agendas || []).forEach(ag => {
        if (!ag.slots) ag.slots = {}
      })
      slots.rows.forEach(row => {
        const ag = (data.agendas || []).find(a => a.id === row.agenda_id)
        if (!ag) return
        if (!ag.slots[row.slot]) ag.slots[row.slot] = ['','','','','','bloqueado']
        ag.slots[row.slot][row.dia] = row.valor
      })
    }
    return data
  } catch(e) {
    console.warn('readData error:', e.message)
    return loadSeedFile() || {}
  }
}

// ─── WRITE FULL STATE ─────────────────────────────────────────────────────────
async function writeData(obj) {
  if (!pool) {
    try { fs.writeFileSync(SEED_FILE, JSON.stringify(obj, null, 2)) } catch(e) {}
    return
  }
  try {
    // Salva dados principais (sem slots — eles ficam na tabela dedicada)
    const dataWithoutSlots = JSON.parse(JSON.stringify(obj))
    ;(dataWithoutSlots.agendas || []).forEach(ag => { ag.slots = {} })

    // Mantém versão atual
    const cur = await pool.query("SELECT payload->>'_version' as ver FROM psicoteam_data WHERE id='main'")
    const curVer = parseInt(cur.rows[0]?.ver || '0')
    if (!dataWithoutSlots._version || parseInt(dataWithoutSlots._version) < curVer) {
      dataWithoutSlots._version = curVer
    }

    await pool.query(
      `INSERT INTO psicoteam_data(id,payload,updated_at) VALUES('main',$1,NOW())
       ON CONFLICT(id) DO UPDATE SET payload=$1, updated_at=NOW()`,
      [JSON.stringify(dataWithoutSlots)]
    )

    // Salva todos os slots na tabela dedicada (bulk upsert)
    const slotRows = []
    ;(obj.agendas || []).forEach(ag => {
      Object.entries(ag.slots || {}).forEach(([slot, dias]) => {
        dias.forEach((valor, dia) => {
          if (dia >= 6) return
          slotRows.push([ag.id, slot, dia, valor || ''])
        })
      })
    })

    if (slotRows.length > 0) {
      // Bulk upsert em lotes de 100
      for (let i = 0; i < slotRows.length; i += 100) {
        const batch = slotRows.slice(i, i + 100)
        const vals  = batch.map((_, j) => `($${j*4+1},$${j*4+2},$${j*4+3},$${j*4+4},NOW())`).join(',')
        const flat  = batch.flat()
        await pool.query(
          `INSERT INTO psicoteam_slots(agenda_id,slot,dia,valor,updated_at) VALUES ${vals}
           ON CONFLICT(agenda_id,slot,dia) DO UPDATE SET valor=EXCLUDED.valor, updated_at=NOW()`,
          flat
        )
      }
    }

    try { fs.writeFileSync(SEED_FILE, JSON.stringify(obj, null, 2)) } catch(e) {}
  } catch(e) {
    console.warn('writeData error:', e.message)
  }
}

// ─── WRITE SINGLE SLOT (atômico — sem conflito) ───────────────────────────────
async function writeSlot(agendaId, slot, dia, valor) {
  if (!pool) return
  try {
    await pool.query(
      `INSERT INTO psicoteam_slots(agenda_id,slot,dia,valor,updated_at) VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT(agenda_id,slot,dia) DO UPDATE SET valor=$4, updated_at=NOW()`,
      [agendaId, slot, dia, valor || '']
    )
  } catch(e) {
    console.warn('writeSlot error:', e.message)
  }
}

// ─── HTTP ──────────────────────────────────────────────────────────────────────
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
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type'
  })
  res.end(JSON.stringify(obj))
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // index.html
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'))
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache,no-store,must-revalidate'})
      res.end(html)
    } catch(e) { res.writeHead(500); res.end('Error: ' + e.message) }
    return
  }

  // Imagens
  if (req.method === 'GET' && /\.(png|jpg|jpeg|ico|svg|gif)$/i.test(url)) {
    const name  = decodeURIComponent(path.basename(url))
    const files = fs.readdirSync(__dirname)
    const found = files.find(f => f.toLowerCase() === name.toLowerCase() || f.toLowerCase().endsWith('.png'))
    if (found) {
      try { res.writeHead(200, {'Content-Type':'image/png'}); res.end(fs.readFileSync(path.join(__dirname, found))); return } catch(e) {}
    }
    res.writeHead(404); res.end('not found')
    return
  }

  // GET /api/data — lê estado completo com slots
  if (req.method === 'GET' && url === '/api/data') {
    try { jsonRes(res, 200, {ok:true, data: await readData()}) }
    catch(e) { jsonRes(res, 500, {ok:false, error:e.message}) }
    return
  }

  // POST /api/data — salva estado completo
  if (req.method === 'POST' && url === '/api/data') {
    try {
      const payload = await bodyJson(req)
      const current = await readData()
      if ((payload.agendas?.length||0) === 0 && (current.agendas?.length||0) > 0) {
        jsonRes(res, 200, {ok:true, warning:'blocked empty agendas'})
        return
      }
      await writeData(payload)
      jsonRes(res, 200, {ok:true})
    } catch(e) { jsonRes(res, 400, {ok:false, error:e.message}) }
    return
  }

  // POST /api/slot — salva UM slot atomicamente (sem conflito entre usuários!)
  if (req.method === 'POST' && url === '/api/slot') {
    try {
      const {agendaId, slot, dia, valor} = await bodyJson(req)
      if (agendaId === undefined || !slot || dia === undefined) {
        jsonRes(res, 400, {ok:false, error:'agendaId, slot, dia obrigatórios'}); return
      }
      await writeSlot(parseInt(agendaId), slot, parseInt(dia), valor)
      jsonRes(res, 200, {ok:true})
    } catch(e) { jsonRes(res, 400, {ok:false, error:e.message}) }
    return
  }

  // GET /api/status
  if (req.method === 'GET' && url === '/api/status') {
    const dbOk = pool ? await pool.query('SELECT 1').then(()=>true).catch(()=>false) : false
    const data = await readData()
    let slots = 0
    ;(data.agendas||[]).forEach(ag => {
      Object.values(ag.slots||{}).forEach(dias => {
        dias.forEach(v => { if(v && v!=='bloqueado' && !v.startsWith('almoco:') && !v.startsWith('reuniao:')) slots++ })
      })
    })
    jsonRes(res, 200, {
      db: dbOk ? 'PostgreSQL ✅' : pool ? 'PostgreSQL ❌' : 'Sem banco',
      agendas: data.agendas?.length||0,
      pacientes: data.pacientes?.length||0,
      sessoes: slots,
      versao: data._version||'—',
      timestamp: new Date().toISOString()
    })
    return
  }

  // GET /api/load-slots — carrega slots_seed.json no PostgreSQL (uso único)
  if (req.method === 'GET' && url === '/api/load-slots') {
    try {
      const slotsFile = path.join(__dirname, 'slots_seed.json')
      if (!fs.existsSync(slotsFile)) {
        jsonRes(res, 404, {error: 'slots_seed.json não encontrado'}); return
      }
      const slotsData = JSON.parse(fs.readFileSync(slotsFile, 'utf8'))
      if (!pool) { jsonRes(res, 400, {error: 'PostgreSQL não conectado'}); return }

      let inserted = 0
      for (const [agIdStr, agSlots] of Object.entries(slotsData)) {
        const agId = parseInt(agIdStr)
        const rows = []
        for (const [slot, dias] of Object.entries(agSlots)) {
          dias.forEach((valor, dia) => {
            if (dia < 6) rows.push([agId, slot, dia, valor || ''])
          })
        }
        if (rows.length > 0) {
          for (let i = 0; i < rows.length; i += 100) {
            const batch = rows.slice(i, i + 100)
            const vals  = batch.map((_, j) => `($${j*4+1},$${j*4+2},$${j*4+3},$${j*4+4},NOW())`).join(',')
            await pool.query(
              `INSERT INTO psicoteam_slots(agenda_id,slot,dia,valor,updated_at) VALUES ${vals}
               ON CONFLICT(agenda_id,slot,dia) DO UPDATE SET valor=EXCLUDED.valor, updated_at=NOW()`,
              batch.flat()
            )
            inserted += batch.length
          }
        }
      }

      // Count result
      const r = await pool.query("SELECT COUNT(*) as c FROM psicoteam_slots WHERE valor != '' AND valor != 'bloqueado'")
      jsonRes(res, 200, {
        ok: true,
        inserted,
        db_sessoes: parseInt(r.rows[0].c),
        message: 'Slots carregados com sucesso!'
      })
    } catch(e) {
      jsonRes(res, 500, {error: e.message})
    }
    return
  }

  // GET /api/debug
  if (req.method === 'GET' && url === '/api/debug') {
    try {
      if (!pool) { jsonRes(res, 200, {error:'no pool'}); return }
      const r  = await pool.query("SELECT payload->>'_version' as ver, payload->>'_forceUpdate' as fu, updated_at FROM psicoteam_data WHERE id='main'")
      const rs = await pool.query("SELECT COUNT(*) as total FROM psicoteam_slots WHERE valor != '' AND valor != 'bloqueado'")
      const data = await readData()
      jsonRes(res, 200, {
        db_version:     r.rows[0]?.ver,
        db_forceUpdate: r.rows[0]?.fu,
        db_updated:     r.rows[0]?.updated_at,
        db_agendas:     data.agendas?.length||0,
        db_pacientes:   data.pacientes?.length||0,
        db_sessoes:     parseInt(rs.rows[0]?.total||0)
      })
    } catch(e) { jsonRes(res, 500, {error:e.message}) }
    return
  }

  jsonRes(res, 404, {ok:false, error:'not found'})

}).listen(PORT, () => {
  setupDB().then(async () => {
    const data = await readData()
    const sr   = pool ? await pool.query("SELECT COUNT(*) as c FROM psicoteam_slots WHERE valor != '' AND valor != 'bloqueado'").catch(()=>({rows:[{c:0}]})) : {rows:[{c:0}]}
    console.log(`✅ PsicoTEAM porta ${PORT} | ${data.agendas?.length||0} agendas | ${data.pacientes?.length||0} pacientes | ${sr.rows[0].c} slots`)
  })
})
 = require('http')
const fs   = require('fs')
const path = require('path')
const { Pool } = require('pg')

const PORT      = process.env.PORT || 3000
const SEED_FILE = path.join(__dirname, 'data.json')

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 20,                    // pool de 20 conexões simultâneas
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000
    })
  : null

// ─── SETUP ────────────────────────────────────────────────────────────────────
async function setupDB() {
  if (!pool) return
  try {
    // Tabela principal de dados (estado global: pacientes, execuções, config)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS psicoteam_data (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`)

    // Tabela de slots — cada linha é UM slot de UMA agenda num dia específico
    // Permite updates atômicos sem conflito entre usuários
    await pool.query(`
      CREATE TABLE IF NOT EXISTS psicoteam_slots (
        agenda_id   INTEGER NOT NULL,
        slot        TEXT    NOT NULL,
        dia         INTEGER NOT NULL,
        valor       TEXT    NOT NULL DEFAULT '',
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (agenda_id, slot, dia)
      )`)

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_slots_agenda ON psicoteam_slots(agenda_id)`)

    // Carrega seed se DB vazio
    const r = await pool.query("SELECT payload->>'_version' as ver FROM psicoteam_data WHERE id='main'")
    const seed = loadSeedFile()
    if (!seed) return

    if (r.rowCount === 0) {
      await pool.query("INSERT INTO psicoteam_data(id,payload) VALUES('main',$1)", [JSON.stringify(seed)])
      console.log(`✅ Seed: ${seed.agendas?.length} agendas, ${seed.pacientes?.length} pacientes`)
    } else {
      const dbVer   = parseInt(r.rows[0].ver || '0')
      const seedVer = parseInt(seed._version || '0')
      if (seedVer > dbVer) {
        await pool.query("UPDATE psicoteam_data SET payload=$1, updated_at=NOW() WHERE id='main'", [JSON.stringify(seed)])
        console.log(`✅ Seed atualizado v${seedVer}`)
      } else {
        console.log(`✅ DB preservado v${dbVer}`)
      }
    }
  } catch(e) {
    console.error('❌ setupDB:', e.message)
  }
}

function loadSeedFile() {
  try { return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) } catch(e) { return null }
}

// ─── READ ─────────────────────────────────────────────────────────────────────
async function readData() {
  if (!pool) return loadSeedFile() || {}
  try {
    // Lê dados principais
    const r = await pool.query("SELECT payload FROM psicoteam_data WHERE id='main'")
    if (r.rowCount === 0) return loadSeedFile() || {}
    const data = r.rows[0].payload

    // Sobrepõe slots da tabela psicoteam_slots (fonte de verdade para agendamentos)
    const slots = await pool.query("SELECT agenda_id, slot, dia, valor FROM psicoteam_slots")
    if (slots.rowCount > 0) {
      // Inicializa slots das agendas se necessário
      ;(data.agendas || []).forEach(ag => {
        if (!ag.slots) ag.slots = {}
      })
      slots.rows.forEach(row => {
        const ag = (data.agendas || []).find(a => a.id === row.agenda_id)
        if (!ag) return
        if (!ag.slots[row.slot]) ag.slots[row.slot] = ['','','','','','bloqueado']
        ag.slots[row.slot][row.dia] = row.valor
      })
    }
    return data
  } catch(e) {
    console.warn('readData error:', e.message)
    return loadSeedFile() || {}
  }
}

// ─── WRITE FULL STATE ─────────────────────────────────────────────────────────
async function writeData(obj) {
  if (!pool) {
    try { fs.writeFileSync(SEED_FILE, JSON.stringify(obj, null, 2)) } catch(e) {}
    return
  }
  try {
    // Salva dados principais (sem slots — eles ficam na tabela dedicada)
    const dataWithoutSlots = JSON.parse(JSON.stringify(obj))
    ;(dataWithoutSlots.agendas || []).forEach(ag => { ag.slots = {} })

    // Mantém versão atual
    const cur = await pool.query("SELECT payload->>'_version' as ver FROM psicoteam_data WHERE id='main'")
    const curVer = parseInt(cur.rows[0]?.ver || '0')
    if (!dataWithoutSlots._version || parseInt(dataWithoutSlots._version) < curVer) {
      dataWithoutSlots._version = curVer
    }

    await pool.query(
      `INSERT INTO psicoteam_data(id,payload,updated_at) VALUES('main',$1,NOW())
       ON CONFLICT(id) DO UPDATE SET payload=$1, updated_at=NOW()`,
      [JSON.stringify(dataWithoutSlots)]
    )

    // Salva todos os slots na tabela dedicada (bulk upsert)
    const slotRows = []
    ;(obj.agendas || []).forEach(ag => {
      Object.entries(ag.slots || {}).forEach(([slot, dias]) => {
        dias.forEach((valor, dia) => {
          if (dia >= 6) return
          slotRows.push([ag.id, slot, dia, valor || ''])
        })
      })
    })

    if (slotRows.length > 0) {
      // Bulk upsert em lotes de 100
      for (let i = 0; i < slotRows.length; i += 100) {
        const batch = slotRows.slice(i, i + 100)
        const vals  = batch.map((_, j) => `($${j*4+1},$${j*4+2},$${j*4+3},$${j*4+4},NOW())`).join(',')
        const flat  = batch.flat()
        await pool.query(
          `INSERT INTO psicoteam_slots(agenda_id,slot,dia,valor,updated_at) VALUES ${vals}
           ON CONFLICT(agenda_id,slot,dia) DO UPDATE SET valor=EXCLUDED.valor, updated_at=NOW()`,
          flat
        )
      }
    }

    try { fs.writeFileSync(SEED_FILE, JSON.stringify(obj, null, 2)) } catch(e) {}
  } catch(e) {
    console.warn('writeData error:', e.message)
  }
}

// ─── WRITE SINGLE SLOT (atômico — sem conflito) ───────────────────────────────
async function writeSlot(agendaId, slot, dia, valor) {
  if (!pool) return
  try {
    await pool.query(
      `INSERT INTO psicoteam_slots(agenda_id,slot,dia,valor,updated_at) VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT(agenda_id,slot,dia) DO UPDATE SET valor=$4, updated_at=NOW()`,
      [agendaId, slot, dia, valor || '']
    )
  } catch(e) {
    console.warn('writeSlot error:', e.message)
  }
}

// ─── HTTP ──────────────────────────────────────────────────────────────────────
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
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type'
  })
  res.end(JSON.stringify(obj))
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // index.html
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'))
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache,no-store,must-revalidate'})
      res.end(html)
    } catch(e) { res.writeHead(500); res.end('Error: ' + e.message) }
    return
  }

  // Imagens
  if (req.method === 'GET' && /\.(png|jpg|jpeg|ico|svg|gif)$/i.test(url)) {
    const name  = decodeURIComponent(path.basename(url))
    const files = fs.readdirSync(__dirname)
    const found = files.find(f => f.toLowerCase() === name.toLowerCase() || f.toLowerCase().endsWith('.png'))
    if (found) {
      try { res.writeHead(200, {'Content-Type':'image/png'}); res.end(fs.readFileSync(path.join(__dirname, found))); return } catch(e) {}
    }
    res.writeHead(404); res.end('not found')
    return
  }

  // GET /api/data — lê estado completo com slots
  if (req.method === 'GET' && url === '/api/data') {
    try { jsonRes(res, 200, {ok:true, data: await readData()}) }
    catch(e) { jsonRes(res, 500, {ok:false, error:e.message}) }
    return
  }

  // POST /api/data — salva estado completo
  if (req.method === 'POST' && url === '/api/data') {
    try {
      const payload = await bodyJson(req)
      const current = await readData()
      if ((payload.agendas?.length||0) === 0 && (current.agendas?.length||0) > 0) {
        jsonRes(res, 200, {ok:true, warning:'blocked empty agendas'})
        return
      }
      await writeData(payload)
      jsonRes(res, 200, {ok:true})
    } catch(e) { jsonRes(res, 400, {ok:false, error:e.message}) }
    return
  }

  // POST /api/slot — salva UM slot atomicamente (sem conflito entre usuários!)
  if (req.method === 'POST' && url === '/api/slot') {
    try {
      const {agendaId, slot, dia, valor} = await bodyJson(req)
      if (agendaId === undefined || !slot || dia === undefined) {
        jsonRes(res, 400, {ok:false, error:'agendaId, slot, dia obrigatórios'}); return
      }
      await writeSlot(parseInt(agendaId), slot, parseInt(dia), valor)
      jsonRes(res, 200, {ok:true})
    } catch(e) { jsonRes(res, 400, {ok:false, error:e.message}) }
    return
  }

  // GET /api/status
  if (req.method === 'GET' && url === '/api/status') {
    const dbOk = pool ? await pool.query('SELECT 1').then(()=>true).catch(()=>false) : false
    const data = await readData()
    let slots = 0
    ;(data.agendas||[]).forEach(ag => {
      Object.values(ag.slots||{}).forEach(dias => {
        dias.forEach(v => { if(v && v!=='bloqueado' && !v.startsWith('almoco:') && !v.startsWith('reuniao:')) slots++ })
      })
    })
    jsonRes(res, 200, {
      db: dbOk ? 'PostgreSQL ✅' : pool ? 'PostgreSQL ❌' : 'Sem banco',
      agendas: data.agendas?.length||0,
      pacientes: data.pacientes?.length||0,
      sessoes: slots,
      versao: data._version||'—',
      timestamp: new Date().toISOString()
    })
    return
  }

  // GET /api/debug
  if (req.method === 'GET' && url === '/api/debug') {
    try {
      if (!pool) { jsonRes(res, 200, {error:'no pool'}); return }
      const r  = await pool.query("SELECT payload->>'_version' as ver, payload->>'_forceUpdate' as fu, updated_at FROM psicoteam_data WHERE id='main'")
      const rs = await pool.query("SELECT COUNT(*) as total FROM psicoteam_slots WHERE valor != '' AND valor != 'bloqueado'")
      const data = await readData()
      jsonRes(res, 200, {
        db_version:     r.rows[0]?.ver,
        db_forceUpdate: r.rows[0]?.fu,
        db_updated:     r.rows[0]?.updated_at,
        db_agendas:     data.agendas?.length||0,
        db_pacientes:   data.pacientes?.length||0,
        db_sessoes:     parseInt(rs.rows[0]?.total||0)
      })
    } catch(e) { jsonRes(res, 500, {error:e.message}) }
    return
  }

  jsonRes(res, 404, {ok:false, error:'not found'})

}).listen(PORT, () => {
  setupDB().then(async () => {
    const data = await readData()
    const sr   = pool ? await pool.query("SELECT COUNT(*) as c FROM psicoteam_slots WHERE valor != '' AND valor != 'bloqueado'").catch(()=>({rows:[{c:0}]})) : {rows:[{c:0}]}
    console.log(`✅ PsicoTEAM porta ${PORT} | ${data.agendas?.length||0} agendas | ${data.pacientes?.length||0} pacientes | ${sr.rows[0].c} slots`)
  })
})

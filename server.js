const http = require('http')
const fs   = require('fs')
const path = require('path')

const PORT = process.env.PORT || 3000
const DATA_FILE = path.join(__dirname, 'data.json')

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  } catch(e) {
    return { agendas:[], pacientes:[], currentAgendaId:1, nextPatId:1, nextAgendaId:1 }
  }
}

function writeData(obj) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8') } catch(e) { console.error('write error:',e) }
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => { try { resolve(JSON.parse(raw)) } catch(e) { reject(e) } })
    req.on('error', reject)
  })
}

function json(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type' })
  res.end(body)
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    } catch(e) { res.writeHead(500); res.end('Error loading index.html: ' + e.message) }
    return
  }

  if (req.method === 'GET' && /\.(png|jpg|jpeg|ico|svg|gif)$/i.test(url)) {
    const name = decodeURIComponent(path.basename(url))
    const candidates = fs.readdirSync(__dirname).filter(f => f.toLowerCase() === name.toLowerCase() || f.toLowerCase().endsWith('.png'))
    for (const c of candidates) {
      const full = path.join(__dirname, c)
      if (fs.existsSync(full)) {
        const img = fs.readFileSync(full)
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(img)
        return
      }
    }
    res.writeHead(404); res.end('not found')
    return
  }

  if (req.method === 'GET' && url === '/api/data') {
    json(res, 200, { ok:true, data: readData() })
    return
  }

  if (req.method === 'POST' && url === '/api/data') {
    try {
      const payload = await bodyJson(req)
      writeData(payload)
      json(res, 200, { ok:true })
    } catch(e) {
      json(res, 400, { ok:false, error: e.message })
    }
    return
  }

  json(res, 404, { ok:false, error:'not found' })

}).listen(PORT, () => {
  console.log(`✅ PsicoTEAM rodando na porta ${PORT}`)
  const d = readData()
  console.log(`📊 ${d.agendas?.length||0} agendas | ${d.pacientes?.length||0} pacientes`)
})

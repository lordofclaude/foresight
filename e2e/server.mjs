import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')
const fixturesRoot = join(here, 'fixtures')
const host = '127.0.0.1'
const port = Number(process.env.FORESIGHT_E2E_PORT || 4188)

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
}

function send(res, status, body, contentType) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

async function fixture(name) {
  return readFile(join(fixturesRoot, name))
}

function safeFile(root, pathname) {
  const requested = resolve(root, normalize(pathname).replace(/^[/\\]+/, ''))
  return requested === root || requested.startsWith(root + '\\') || requested.startsWith(root + '/')
    ? requested
    : null
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${host}:${port}`)
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed')

    if (url.pathname === '/health') {
      return send(res, 200, JSON.stringify({ ok: true, service: 'foresight-e2e-relay' }), types['.json'])
    }
    if (url.pathname === '/api/news') {
      return send(res, 200, await fixture('news.json'), types['.json'])
    }
    if (url.pathname === '/api/scores/stream') {
      return send(res, 200, await fixture('live-score.sse'), 'text/event-stream; charset=utf-8')
    }
    if (url.pathname === '/api/odds/stream') {
      return send(res, 200, await fixture('live-odds.sse'), 'text/event-stream; charset=utf-8')
    }

    const fixturePrefix = '/__e2e__/fixtures/'
    const root = url.pathname.startsWith(fixturePrefix) ? fixturesRoot : appRoot
    const relative = url.pathname.startsWith(fixturePrefix)
      ? url.pathname.slice(fixturePrefix.length)
      : (url.pathname === '/' ? 'index.html' : url.pathname)
    let file = safeFile(root, relative)
    if (!file) return send(res, 403, 'forbidden')
    const info = await stat(file)
    if (info.isDirectory()) file = join(file, 'index.html')
    let body = await readFile(file)

    // Auth tests may target a different Clerk development instance. Only a
    // pk_test_* value is ever substituted; secrets are never sent to the page.
    if (file.endsWith('index.html') && /^pk_test_/.test(process.env.CLERK_PUBLISHABLE_KEY || '')) {
      body = Buffer.from(body.toString('utf8').replace(
        /const CLERK_PK = "pk_test_[^"]+"/,
        `const CLERK_PK = ${JSON.stringify(process.env.CLERK_PUBLISHABLE_KEY)}`,
      ))
    }
    if (req.method === 'HEAD') body = ''
    return send(res, 200, body, types[extname(file).toLowerCase()] || 'application/octet-stream')
  } catch (error) {
    if (error && error.code === 'ENOENT') return send(res, 404, 'not found')
    return send(res, 500, 'e2e server error')
  }
})

server.listen(port, host, () => {
  process.stdout.write(`Foresight E2E server: http://${host}:${port}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}

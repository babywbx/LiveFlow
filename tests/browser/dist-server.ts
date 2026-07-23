import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'

export interface DistServer {
  readonly origin: string
  close(): Promise<void>
}

export async function startDistServer(html: string): Promise<DistServer> {
  const distRoot = resolve(process.cwd(), 'dist')
  const server = createServer((request, response) => {
    void respond(request.url ?? '/', response)
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Browser test server did not bind a TCP port.')
  }

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close(): Promise<void> {
      return closeServer(server)
    },
  }

  async function respond(
    requestPath: string,
    response: ServerResponse<IncomingMessage>,
  ): Promise<void> {
    const requestUrl = new URL(requestPath, 'http://127.0.0.1')
    if (requestUrl.pathname === '/') {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(html)
      return
    }

    const absolutePath = resolve(distRoot, `.${decodeURIComponent(requestUrl.pathname)}`)
    if (!absolutePath.startsWith(`${distRoot}${sep}`) || extname(absolutePath) !== '.js') {
      response.statusCode = 404
      response.end('not found')
      return
    }

    try {
      response.setHeader('content-type', 'text/javascript; charset=utf-8')
      response.end(await readFile(absolutePath))
    } catch {
      response.statusCode = 404
      response.end('not found')
    }
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose()
      } else {
        reject(error)
      }
    })
  })
}

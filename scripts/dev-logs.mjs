import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactLogLine } from './log-redaction.mjs'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sessionId = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
const logsRoot = path.join(rootDirectory, '.logs')
const sessionDirectory = path.join(logsRoot, sessionId)
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const ansiPattern = /\u001B\[[0-?]*[ -/]*[@-~]/g

await mkdir(sessionDirectory, { recursive: true })
await writeFile(path.join(logsRoot, 'latest.txt'), `${sessionId}\n`, 'utf8')
await writeFile(path.join(sessionDirectory, 'meta.json'), JSON.stringify({
  sessionId,
  startedAt: new Date().toISOString(),
  cwd: rootDirectory,
  node: process.version,
}, null, 2), 'utf8')

const combinedLog = createWriteStream(path.join(sessionDirectory, 'combined.log'), { flags: 'a' })
const childRecords = []
let shuttingDown = false
let finalExitCode = 0

function attachLogStream(sourceName, streamName, readable, output, destination) {
  let buffered = ''

  const writeLine = (line) => {
    const record = `[${new Date().toISOString()}] [${sourceName}] [${streamName}] ${line}\n`
    destination.write(record)
    combinedLog.write(record)
  }

  readable.on('data', (chunk) => {
    buffered += chunk.toString('utf8').replace(ansiPattern, '').replace(/\r/g, '')
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      const redacted = redactLogLine(line)
      output.write(`${redacted}\n`)
      writeLine(redacted)
    }
  })

  readable.on('end', () => {
    if (buffered) {
      const redacted = redactLogLine(buffered)
      output.write(`${redacted}\n`)
      writeLine(redacted)
    }
  })
}

function killProcessTree(child, signal) {
  if (!child.pid || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // 이미 종료된 프로세스는 무시한다.
  }
}

function startProcess(name, scriptName) {
  const logStream = createWriteStream(path.join(sessionDirectory, `${name}.log`), { flags: 'a' })
  const child = spawn(npmCommand, ['run', scriptName], {
    cwd: rootDirectory,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      LOCAL_DEBUG_LOG_ENABLED: '1',
      LOCAL_DEBUG_LOG_DIR: sessionDirectory,
    },
    stdio: ['inherit', 'pipe', 'pipe'],
  })

  attachLogStream(name, 'stdout', child.stdout, process.stdout, logStream)
  attachLogStream(name, 'stderr', child.stderr, process.stderr, logStream)

  const exited = new Promise((resolve) => {
    child.once('error', (error) => {
      finalExitCode = 1
      process.stderr.write(`[dev:logs] ${name} 시작 실패: ${error.message}\n`)
    })
    child.once('exit', (code, signal) => {
      if (!shuttingDown && code !== 0) finalExitCode = code ?? 1
      process.stdout.write(`[dev:logs] ${name} 종료 (code=${code ?? 'null'}, signal=${signal ?? 'none'})\n`)
      logStream.end()
      resolve()
      if (!shuttingDown) shutdown('SIGTERM')
    })
  })

  const record = { child, exited }
  childRecords.push(record)
  return record
}

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  for (const { child } of childRecords) killProcessTree(child, signal)

  const forceTimer = setTimeout(() => {
    for (const { child } of childRecords) killProcessTree(child, 'SIGKILL')
  }, 5_000)
  forceTimer.unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

process.stdout.write(`[dev:logs] 로그 디렉터리: ${sessionDirectory}\n`)
startProcess('backend', 'dev:server')
startProcess('frontend', 'dev:client')

await Promise.all(childRecords.map(({ exited }) => exited))
combinedLog.end()
process.exitCode = finalExitCode

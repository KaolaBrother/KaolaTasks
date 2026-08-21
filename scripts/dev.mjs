import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const env = {
  ...process.env,
  PORT: process.env.PORT ?? '31415',
  VITE_DEV_TARGET: process.env.VITE_DEV_TARGET ?? 'http://127.0.0.1:5173',
}

function spawnInherit(command, args) {
  return spawn(command, args, { cwd: repoRoot, env, stdio: 'inherit' })
}

const vite = spawnInherit('pnpm', [
  '--filter',
  '@kaola/web',
  'exec',
  'vite',
  '--host',
  '127.0.0.1',
  '--port',
  '5173',
  '--strictPort',
])
const server = spawnInherit('pnpm', ['--filter', '@kaola/server', 'dev'])

function shutdown(signal) {
  vite.kill(signal)
  server.kill(signal)
}

process.on('SIGINT', () => {
  shutdown('SIGINT')
})
process.on('SIGTERM', () => {
  shutdown('SIGTERM')
})

vite.on('exit', (code) => {
  if (server.exitCode == null) server.kill('SIGTERM')
  if (code) process.exitCode = code
})
server.on('exit', (code) => {
  if (vite.exitCode == null) vite.kill('SIGTERM')
  if (code) process.exitCode = code
})

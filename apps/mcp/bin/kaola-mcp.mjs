#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const main = join(here, '..', 'src', 'main.ts')
const child = spawn(
  process.execPath,
  ['--experimental-strip-types', main, ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
)
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

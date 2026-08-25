import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

type ScryptFn = (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>

const scryptAsync = promisify(scrypt) as unknown as ScryptFn
const N = 16384
const r = 8
const p = 1
const keyLen = 32
const saltLen = 16
const maxmem = 64 * 1024 * 1024

export async function hashPassword(password: string): Promise<string> {
  if (password === '') {
    throw new Error('password must not be empty')
  }
  const salt = randomBytes(saltLen)
  const key = await scryptAsync(password, salt, keyLen, { N, r, p, maxmem })
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    if (typeof encoded !== 'string' || encoded === '') return false
    const parts = encoded.split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const cost = Number(parts[1])
    const blockSize = Number(parts[2])
    const parallel = Number(parts[3])
    const saltHex = parts[4]
    const keyHex = parts[5]
    if (
      !Number.isInteger(cost) ||
      !Number.isInteger(blockSize) ||
      !Number.isInteger(parallel) ||
      cost < 2 ||
      blockSize < 1 ||
      parallel < 1 ||
      saltHex === '' ||
      keyHex === '' ||
      saltHex.length % 2 !== 0 ||
      keyHex.length % 2 !== 0
    ) {
      return false
    }
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(keyHex, 'hex')
    if (salt.length === 0 || expected.length === 0) return false
    const actual = await scryptAsync(password, salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallel,
      maxmem,
    })
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

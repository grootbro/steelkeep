import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from './config'

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message) }
}

export function seal(value: unknown, key = config.key()): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64')
}

export function unseal<T>(value: string, key = config.key()): T {
  const blob = Buffer.from(value, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0,12))
  decipher.setAuthTag(blob.subarray(12,28))
  return JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8')) as T
}

export function tokenMatches(value: string, expected = config.token()): boolean {
  const a = Buffer.from(value), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a,b)
}

export function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value)) throw new AppError('INVALID_IDENTIFIER', 'Use a database name containing letters, digits and underscores.')
  return value
}

export function allowedHost(host: string): void {
  if (!config.allowedHosts().includes(host)) throw new AppError('ENDPOINT_NOT_ALLOWED', 'This endpoint is not in the installation allowlist.', 403)
}

// Never persist arbitrary driver/CLI errors: they can contain DSNs, queries and passwords.
export function safeFailure(error: unknown): {code: string; message: string} {
  return error instanceof AppError ? {code:error.code,message:error.message} : {code:'OPERATION_FAILED',message:'The operation failed. Check the connection, permissions and worker availability.'}
}

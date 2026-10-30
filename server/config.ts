import { readFileSync } from 'node:fs'

export function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing configuration: ${name}`)
  return value
}

export const config = {
  databaseUrl: () => {
    // Explicit secret-file mode takes precedence inside the self-hosted stack.
    const file=process.env.STEELKEEP_DATABASE_PASSWORD_FILE
    if(!file)return env('DATABASE_URL')
    const url=new URL('postgresql://steelkeep@'+env('STEELKEEP_DATABASE_HOST')+':5432/steelkeep')
    url.password=readFileSync(file,'utf8').trim()
    return url.toString()
  },
  key: () => {
    const key = readFileSync(env('STEELKEEP_KEY_FILE'))
    if (key.length !== 32) throw new Error('Steelkeep encryption key must contain 32 bytes')
    return key
  },
  token: () => readFileSync(env('STEELKEEP_TOKEN_FILE'), 'utf8').trim(),
  allowedHosts: () => env('STEELKEEP_ALLOWED_HOSTS').split(',').map(s => s.trim()),
  allowedOrigins: () => env('STEELKEEP_ALLOWED_ORIGINS').split(',').map(s => s.trim())
}

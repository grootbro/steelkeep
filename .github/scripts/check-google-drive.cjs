const assert = require('node:assert/strict')
const { randomBytes, randomUUID, createCipheriv } = require('node:crypto')
const { readFileSync, lstatSync } = require('node:fs')
const { mkdir, writeFile } = require('node:fs/promises')
const { spawn } = require('node:child_process')
const { createServer } = require('node:net')
const { Client } = require('pg')
const { chromium } = require('playwright')

const base = 'http://127.0.0.1:4310'
const directory = 'output/playwright/google-drive-ui'
const sourceFolder = 'syntheticSourceFolder12345', archiveFolder = 'syntheticArchiveFolder12345'
const currentStorage = randomUUID(), previousStorage = randomUUID(), sourceConnection = randomUUID()
const purposes = ['account', 'source', 'storage', 'restore', 'recovery']
const grants = purposes.map(purpose => ({ id: randomUUID(), purpose, scopes: purpose === 'account' ? ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'] : ['https://www.googleapis.com/auth/' + (['source', 'recovery'].includes(purpose) ? 'drive.readonly' : 'drive.file')], status: 'active', revision: 1, createdAt: '2026-11-23T00:00:00.000Z', claimedAt: '2026-11-23T00:00:00.000Z', revokedAt: null }))
const results = [], checks = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function guard() {
  assert.ok(process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true', 'This UI proof requires an isolated Linux GitHub Actions runner.')
  assert.ok(process.env.STEELKEEP_GOOGLE_DRIVE_ACCEPTANCE === 'synthetic-ci' && process.env.STEELKEEP_UI_ACCEPTANCE === 'github-google-drive', 'Explicit disposable Drive UI markers are required.')
  const url = new URL(process.env.DATABASE_URL || '')
  assert.ok(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && url.port === '5432' && url.pathname === '/steelkeep_drive_ci' && url.username === 'steelkeep_drive_ci' && url.password === 'synthetic-drive-ci-only' && !url.search && !url.hash, 'Only the exact disposable Google Drive CI database is permitted.')
  assert.ok(process.env.STEELKEEP_KEY_FILE === '/tmp/steelkeep-drive-ci/key' && process.env.STEELKEEP_TOKEN_FILE === '/tmp/steelkeep-drive-ci/token', 'Use only the fixture key files.')
  for (const file of [process.env.STEELKEEP_KEY_FILE, process.env.STEELKEEP_TOKEN_FILE]) {
    const stat = lstatSync(file)
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && !(stat.mode & 0o077), 'Fixture secret files must be private regular files.')
  }
  assert.equal(readFileSync(process.env.STEELKEEP_KEY_FILE).length, 32)
  assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).name, 'steelkeep')
}

function sealedEmpty() {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', readFileSync(process.env.STEELKEEP_KEY_FILE), nonce)
  const ciphertext = Buffer.concat([cipher.update('{}', 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64')
}

async function seed() {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const row = (await db.query(`SELECT current_database() AS database, current_user AS actor,
      (SELECT max(version) FROM steelkeep_migrations) AS schema,
      (SELECT count(*)::int FROM connections) AS connections,
      (SELECT count(*)::int FROM owner_account) AS owners,
      (SELECT count(*)::int FROM runs) AS runs,
      (SELECT count(*)::int FROM artifacts) AS artifacts`)).rows[0]
    assert.deepEqual(row, { database: 'steelkeep_drive_ci', actor: 'steelkeep_drive_ci', schema: 13, connections: 0, owners: 0, runs: 0, artifacts: 0 }, 'Run only after the isolated integration fixture has cleaned its own records.')
    const rows = [
      { id: sourceConnection, name: 'Synthetic work documents', kind: 'google_drive', folder: sourceFolder, purpose: 'source' },
      { id: currentStorage, name: 'Synthetic Drive archive storage', kind: 'google_drive_storage', folder: archiveFolder, purpose: 'storage' },
      { id: previousStorage, name: 'Synthetic earlier-installation archives', kind: 'google_drive_storage', folder: 'syntheticEarlierFolder12345', purpose: 'recovery' }
    ]
    for (const row of rows) {
      const grant = grants.find(grant => grant.purpose === row.purpose)
      const config = { database: row.folder, folderId: row.folder, folderName: row.name, accountId: 'syntheticDriveAccount12345', grantId: grant.id, grantRevision: 1, grantPurpose: row.purpose, readOnly: row.purpose === 'recovery', readOnlyRecovery: row.purpose === 'recovery', restoreTarget: false }
      await db.query("INSERT INTO connections(id,name,kind,config,secret,check_status,checked_at) VALUES($1,$2,$3,$4::jsonb,$5,'available',now())", [row.id, row.name, row.kind, JSON.stringify(config), sealedEmpty()])
    }
    checks.push('real-postgresql-empty-fixture-and-synthetic-drive-metadata')
  } finally { await db.end() }
}

async function freePort() {
  await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', () => reject(new Error('The UI fixture port is already occupied; no existing server will be used.')))
    probe.listen(4310, '127.0.0.1', () => probe.close(resolve))
  })
}

async function startServer() {
  await freePort()
  const child = spawn('bun', ['server/serve.ts'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '4310', STEELKEEP_PUBLIC_HOSTS: '127.0.0.1', STEELKEEP_ALLOWED_ORIGINS: base, STEELKEEP_SECURE_COOKIE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-65536) })
  const exited = new Promise(resolve => child.once('exit', resolve))
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([exited, delay(4000)])
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([exited, delay(2000)]) }
    }
    await writeFile(`${directory}/server.log`, output)
  }
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('The fixture web child exited before readiness; see server.log.')
      try { const response = await fetch(base + '/api/v1/health', { signal: AbortSignal.timeout(500) }); if (response.status === 200) return stop } catch {}
      await delay(250)
    }
    throw new Error('The fixture web child did not become ready within 20 seconds.')
  } catch (error) { await stop(); throw error }
}

async function installSyntheticGoogle(context) {
  const observed = { connections: [], claims: [], imports: [], catalog: [], authorizations: [], googleNavigation: [], keyDownloads: 0, unexpectedWrites: [], ownerAccess: true, rejectStorageOnce: false }
  const archive = { fileId: 'syntheticArchiveFile12345', name: 'Synthetic database snapshot', size: '4096', sha256: 'a'.repeat(64), engine: 'postgres', recoveryId: 'syntheticRecoveryFile12345', portable: true }
  await context.route('https://accounts.google.com/**', async route => {
    observed.googleNavigation.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body><h1>Synthetic Google approval boundary</h1></body></html>' })
  })
  await context.route(/^https:\/\/(www\.googleapis\.com|oauth2\.googleapis\.com)\//, route => route.abort())
  await context.route(base + '/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method()
    const fulfill = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
    if (path === '/api/v1/me' && method === 'GET') { await delay(250); return route.continue() }
    if (path === '/api/v1/google-drive/status') return fulfill({ configured: true, redirectUri: base + '/api/v1/google-drive/oauth/callback', sourceScope: 'https://www.googleapis.com/auth/drive.readonly', restoreScope: 'https://www.googleapis.com/auth/drive.file', ownerAccess: observed.ownerAccess })
    if (path === '/api/v1/google-drive/grants') return fulfill(grants)
    if (path === '/api/v1/google-drive/oauth/claim' && method === 'POST') { observed.claims.push(request.postDataJSON()); return fulfill(grants[0]) }
    if (path === '/api/v1/google-drive/oauth/start' && method === 'POST') {
      observed.authorizations.push(request.postDataJSON())
      const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      authorization.search = new URLSearchParams({ client_id: 'synthetic-ci-client.apps.googleusercontent.com', redirect_uri: base + '/api/v1/google-drive/oauth/callback', state: 'synthetic-approval-state', response_type: 'code' }).toString()
      return fulfill({ authorizationUrl: authorization.href, expiresAt: new Date(Date.now() + 300000).toISOString() })
    }
    if (path === '/api/v1/google-drive/recovery-key') { observed.keyDownloads++; return fulfill({ error: { code: 'UI_PROOF_REFUSED', message: 'This UI proof never downloads a recovery key.' } }, 403) }
    if (/^\/api\/v1\/google-drive\/storage\/[^/]+\/archives$/.test(path)) {
      observed.catalog.push({ path, pageToken: url.searchParams.get('pageToken') })
      return fulfill(url.searchParams.has('pageToken') ? { items: [{ ...archive, fileId: 'syntheticOtherArchive12345', name: 'Synthetic second-page snapshot' }], nextPageToken: null, notice: 'Synthetic catalog; native archive handling is qualified separately.' } : { items: [archive], nextPageToken: 'next+synthetic/page=', notice: 'Synthetic catalog; native archive handling is qualified separately.' })
    }
    if (path === '/api/v1/google-drive/archives/import' && method === 'POST') {
      observed.imports.push(request.postDataJSON())
      return observed.imports.length === 1 ? fulfill({ error: { code: 'GOOGLE_DRIVE_UNAVAILABLE', message: 'Synthetic unconfirmed import response.' } }, 500) : fulfill({ artifactId: randomUUID(), imported: true })
    }
    if (path === '/api/v1/connections' && method === 'POST') {
      const body = request.postDataJSON()
      if (body.kind === 'google_drive' || body.kind === 'google_drive_storage') { observed.connections.push(body); if (observed.rejectStorageOnce && body.kind === 'google_drive_storage') { observed.rejectStorageOnce = false; return fulfill({ error: { code: 'INVALID_INPUT', message: 'Synthetic storage request was rejected before creating a folder.' } }, 422) } return fulfill({ id: randomUUID() }) }
    }
    if (path.startsWith('/api/v1/google-drive/') || !['GET', 'HEAD'].includes(method)) {
      observed.unexpectedWrites.push({ path, method })
      return fulfill({ error: { code: 'UI_PROOF_REFUSED', message: 'Unexpected synthetic UI operation refused.' } }, 403)
    }
    return route.continue()
  })
  return observed
}

async function renderReady(page, theme, errors, assets) {
  await page.locator('.google-drive-panel').waitFor()
  await page.waitForFunction(theme => document.querySelector('.app')?.getAttribute('data-theme') === theme && document.querySelector('.google-drive-authorize strong')?.textContent === 'Connected Google account', theme)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForLoadState('networkidle')
  const layout = await page.evaluate(() => ({ width: window.innerWidth, documentWidth: document.documentElement.scrollWidth, font: getComputedStyle(document.body).fontFamily, interReady: document.fonts.check('14px "Inter Variable"'), visibleBrand: [...document.querySelectorAll('[aria-label="steelkeep"]')].some(element => element.getBoundingClientRect().width > 0) }))
  if (layout.documentWidth > layout.width + 1) {
    const overflowing = await page.evaluate(() => [...document.querySelectorAll('body *')].map(element => ({ tag: element.tagName, className: typeof element.className === 'string' ? element.className : '', left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })).filter(element => element.right > innerWidth + 1 || element.left < -1).slice(0, 20))
    console.log(JSON.stringify({ layout, overflowing }))
    await page.screenshot({ path: `${directory}/overflow-${layout.width}-${theme}.png` })
  }
  assert.ok(layout.documentWidth <= layout.width + 1, 'Connections page must not have document horizontal overflow.')
  assert.ok(layout.font.includes('Inter') && layout.interReady && layout.visibleBrand, 'Original brand and Inter must render.')
  assert.ok(assets.some(asset => asset.url.includes('/brandassets/') && asset.status === 200), 'Original brand PNG must load from the application.')
  assert.equal(assets.filter(asset => asset.status >= 400).length, 0, 'No brand/font/script asset errors are allowed.')
  assert.equal(errors.length, 0, 'No uncaught browser errors are allowed.')
  return layout
}

async function openDrive(page) {
  await page.locator('.page-header').getByRole('button', { name: 'Add connection', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add connection', exact: true })
  await dialog.getByLabel('Connection type', { exact: true }).selectOption('google_drive')
  await dialog.getByText('Connected Google account', { exact: true }).waitFor()
  return dialog
}

async function workflows(page, observed) {
  let dialog = page.getByRole('dialog', { name: 'Add connection', exact: true })
  assert.equal(observed.authorizations.length, 0, 'Opening Add Connection cannot start OAuth automatically.')
  const flows = [
    { purpose: 'source', name: 'Synthetic source selection', folder: `https://drive.google.com/drive/u/0/folders/${sourceFolder}?usp=sharing`, kind: 'google_drive', expectedFolder: sourceFolder },
    { purpose: 'storage', name: 'Synthetic new archive storage', kind: 'google_drive_storage', expectedFolder: 'new' },
    { purpose: 'restore', name: 'Synthetic empty recovery destination', kind: 'google_drive', expectedFolder: 'new', restoreTarget: true },
    { purpose: 'recovery', name: 'Synthetic existing archive selection', folder: `https://drive.google.com/drive/folders/${archiveFolder}`, kind: 'google_drive_storage', expectedFolder: archiveFolder, readOnlyRecovery: true }
  ]
  for (const [index, flow] of flows.entries()) {
    if (index) dialog = await openDrive(page)
    if (flow.purpose === 'storage') {
      await dialog.getByRole('checkbox', { name: /Back up a folder/ }).uncheck()
      await dialog.getByRole('checkbox', { name: /Store backups in Drive/ }).check()
    } else if (['restore', 'recovery'].includes(flow.purpose)) {
      await dialog.locator('.google-drive-advanced > summary').click()
      await dialog.getByLabel('Recovery connection role', { exact: true }).selectOption(flow.purpose)
    }
    await dialog.getByLabel('Connection name', { exact: true }).fill(flow.name)
    if (flow.folder) await dialog.locator('.google-drive-folder input').fill(flow.folder)
    await dialog.getByRole('button', { name: 'Add connection', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const body = observed.connections.at(-1)
    assert.ok(body.name === flow.name && body.kind === flow.kind && body.folderId === flow.expectedFolder && body.grantId === grants[0].id, 'The common connection form must reuse one account grant with the selected role and canonical folder.')
    assert.equal(body.restoreTarget === true, flow.restoreTarget === true)
    assert.equal(body.readOnlyRecovery === true, flow.readOnlyRecovery === true)
    assert.ok(!('password' in body) && !('accessToken' in body) && !('refreshToken' in body), 'Connection forms cannot submit raw Google credentials.')
    checks.push(`unified-${flow.purpose}-connection-form`)
  }
  dialog = await openDrive(page)
  await dialog.getByLabel('Connection name', { exact: true }).fill('Synthetic dual role')
  await dialog.getByRole('checkbox', { name: /Store backups in Drive/ }).check()
  await dialog.getByLabel('Source folder', { exact: true }).fill(sourceFolder)
  observed.rejectStorageOnce = true
  await dialog.getByRole('button', { name: 'Add connections', exact: true }).click()
  await dialog.getByText('Synthetic storage request was rejected before creating a folder.', { exact: true }).waitFor()
  assert.ok(await dialog.getByLabel('Connection name', { exact: true }).isDisabled(), 'The first saved role freezes the original selection.')
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const dual = observed.connections.slice(-3)
  assert.equal(dual.filter(body => body.kind === 'google_drive').length, 1, 'Finishing a partially saved selection cannot create the source again.')
  dual.splice(1, 1)
  assert.deepEqual(dual.map(body => [body.kind, body.folderId, body.grantId]), [['google_drive', sourceFolder, grants[0].id], ['google_drive_storage', 'new', grants[0].id]])
  assert.equal(observed.authorizations.length, 0, 'Reusing a connected account for both roles cannot start OAuth again.')
  checks.push('one-account-both-typed-connections-partial-save-no-duplicate-source-or-oauth')

  await page.locator('.page-header').getByRole('button', { name: 'Drive recovery', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Google Drive recovery', exact: true })
  await panel.getByRole('link', { name: 'Save recovery key' }).waitFor()
  assert.equal(await panel.getByRole('link', { name: 'Save recovery key' }).getAttribute('href'), '/api/v1/google-drive/recovery-key')
  await panel.locator('.google-drive-recovery > summary').click()
  await panel.locator('.google-drive-catalog-controls select').selectOption(previousStorage)
  await panel.getByRole('button', { name: 'Browse archives', exact: true }).click()
  const importButton = panel.getByRole('button', { name: 'Verify and import', exact: true })
  await importButton.waitFor();assert.ok(await importButton.isDisabled(), 'Archive import requires explicit trust acknowledgement.')
  await panel.getByRole('button', { name: 'Next', exact: true }).click()
  await panel.getByText('Synthetic second-page snapshot', { exact: true }).waitFor()
  assert.equal(observed.catalog.at(-1).pageToken, 'next+synthetic/page=')
  await panel.getByRole('button', { name: 'Previous', exact: true }).click()
  await panel.getByText('Synthetic database snapshot', { exact: true }).waitFor()
  assert.equal(observed.catalog.at(-1).pageToken, null)
  checks.push('catalog-explicit-trust-and-opaque-pagination')
  await panel.locator('.google-drive-trust input').check()
  await importButton.click()
  await panel.getByText('The import result is not confirmed.', { exact: false }).waitFor()
  assert.equal(observed.imports.length, 1)
  await panel.getByRole('button', { name: 'Refresh Google Drive connections', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.google-drive-panel .google-drive-refresh')?.disabled)
  assert.equal(observed.imports.length, 1, 'Reading updated Drive data must not automatically repeat an import.')
  await panel.getByRole('button', { name: 'Recover import result', exact: true }).click()
  await panel.getByRole('link', { name: 'Open snapshots', exact: true }).waitFor()
  assert.equal(observed.imports.length, 2)
  assert.deepEqual(observed.imports[1], observed.imports[0], 'Unknown import recovery must retain the original request key and exact selection.')
  checks.push('uncertain-import-explicit-same-key-recovery-no-auto-replay')
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()

  await page.goto(base + '/plans', { waitUntil: 'domcontentloaded' })
  await page.locator('.page-header').getByRole('button', { name: 'Create plan', exact: true }).click()
  const plan = page.getByRole('dialog', { name: 'Create backup plan', exact: true })
  await plan.getByLabel('Backup source', { exact: true }).selectOption(sourceConnection)
  await plan.getByLabel('Backup storage', { exact: true }).selectOption(currentStorage)
  await plan.getByText('Google Drive folder:', { exact: false }).waitFor()
  assert.ok(!(await plan.innerText()).includes('undefined'))
  assert.equal(await plan.getByLabel('Backup storage', { exact: true }).locator(`option[value="${previousStorage}"]`).count(), 0, 'Read-only recovery storage must not be selectable for new backups.')
  await plan.getByRole('button', { name: 'Close dialog', exact: true }).click()
  checks.push('provider-neutral-backup-plan-labels-and-readonly-storage-exclusion')

  const claimTicket = 'gdc_' + 'a'.repeat(64)
  await page.goto(base + '/overview', { waitUntil: 'domcontentloaded' })
  await page.goto(base + '/connections#google-drive=' + claimTicket)
  dialog = page.getByRole('dialog', { name: 'Add connection', exact: true })
  await dialog.getByText('Google account connected.', { exact: false }).waitFor()
  assert.ok(!new URL(page.url()).hash.includes('google-drive'), 'OAuth claim capability must be removed from the browser URL.')
  assert.equal(observed.claims.length, 1)
  assert.ok(observed.claims[0].ticket === claimTicket, 'Only the expected synthetic claim is redeemed.')
  await page.reload()
  await page.locator('.page-header').getByRole('button', { name: 'Add connection', exact: true }).waitFor()
  assert.equal(observed.claims.length, 1, 'Reloading the clean callback URL cannot redeem the claim again.')
  assert.equal(observed.keyDownloads, 0, 'Recovery-key export must remain an explicit user action.')
  checks.push('oauth-return-opens-unified-modal-single-claim-and-scrubbed-fragment')

  observed.ownerAccess = false
  await page.locator('.page-header').getByRole('button', { name: 'Add connection', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Add connection', exact: true })
  await dialog.getByLabel('Connection type', { exact: true }).selectOption('google_drive')
  await dialog.getByText('Sign in with the owner account', { exact: false }).waitFor()
  assert.equal(await dialog.getByRole('link', { name: 'Save recovery key' }).count(), 0)
  assert.equal(await dialog.getByRole('button', { name: 'Connect with Google', exact: true }).count(), 0)
  observed.ownerAccess = true
  await dialog.getByRole('button', { name: 'Refresh Google Drive connections', exact: true }).click()
  await dialog.getByText('Connected Google account', { exact: true }).waitFor()
  checks.push('nonowner-status-hides-connect-and-recovery-key-controls')
  const navigated = page.waitForURL('https://accounts.google.com/**')
  await dialog.getByRole('button', { name: 'Connect another account', exact: true }).click()
  await navigated
  await page.getByRole('heading', { name: 'Synthetic Google approval boundary', exact: true }).waitFor()
  assert.equal(observed.authorizations.length, 1)
  assert.deepEqual(observed.authorizations[0], { purpose: 'account' })
  assert.equal(observed.googleNavigation.length, 1)
  assert.equal(new URL(observed.googleNavigation[0]).searchParams.get('redirect_uri'), base + '/api/v1/google-drive/oauth/callback')
  assert.equal(observed.unexpectedWrites.length, 0)
  checks.push('explicit-combined-account-oauth-to-synthetic-google-boundary')
}

async function main() {
  guard();await mkdir(directory, { recursive: true });await seed()
  let stop, browser
  try {
    stop = await startServer();browser = await chromium.launch()
    const bootstrap = await browser.newContext({ baseURL: base })
    const response = await bootstrap.request.post('/api/v1/auth/setup', { headers: { authorization: 'Bearer ' + readFileSync(process.env.STEELKEEP_TOKEN_FILE, 'utf8').trim() }, data: { name: 'Synthetic Drive UI owner', email: `drive-ui-${randomBytes(8).toString('hex')}@example.test`, password: randomBytes(24).toString('hex') } })
    assert.equal(response.status(), 201, 'The real disposable installation must create its synthetic owner through the actual API.')
    const storageState = await bootstrap.storageState();await bootstrap.close()
    for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
      const name = `${mobile ? 'mobile' : 'desktop'}-${theme}`
      const context = await browser.newContext({ baseURL: base, storageState, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, colorScheme: theme })
      try {
        await context.addInitScript(theme => localStorage.setItem('steelkeep-theme', theme), theme)
        const observed = await installSyntheticGoogle(context), page = await context.newPage(), errors = [], assets = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('response', response => { const url = response.url();if (/\/(?:assets|brandassets)\//.test(url)) assets.push({ url, status: response.status() }) })
        await page.goto('/connections', { waitUntil: 'domcontentloaded' })
        await page.locator('.page-header').getByRole('button', { name: 'Add connection', exact: true }).waitFor()
        assert.equal(await page.locator('.google-drive-panel').count(), 0, 'Drive must not occupy a detached always-visible panel.')
        await openDrive(page)
        const layout = await renderReady(page, theme, errors, assets)
        await page.screenshot({ path: `${directory}/${name}.png` })
        if (!mobile && theme === 'light') await workflows(page, observed)
        assert.equal(errors.length, 0, 'Functional flows must not produce uncaught browser errors.')
        assert.equal(observed.unexpectedWrites.length, 0)
        results.push({ name, layout, pngAssets: assets.filter(asset => asset.url.includes('/brandassets/')).length, forms: observed.connections.length, claims: observed.claims.length, importRequests: observed.imports.length, realGoogleRequests: 0, uncaughtErrors: errors.length })
      } finally { await context.close() }
    }
    assert.equal(results.length, 4)
    await require('./check-interface.cjs').checkInterface({ browser, base, storageState, installSyntheticGoogle, directory: directory + '/interface' })
    console.log('Google Drive UI passed four desktop/mobile theme captures and native forms, OAuth claim, catalog and uncertain-import controls; Google provider responses were synthetic.')
  } finally {
    await writeFile(`${directory}/results.json`, JSON.stringify({ commit: process.env.GITHUB_SHA, boundary: 'Real compiled application/auth/PostgreSQL; browser-intercepted Google provider endpoints and Drive connection writes; no real Google account or native-recovery claim.', checks, cases: results }, null, 2))
    if (browser) await browser.close()
    if (stop) await stop()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })

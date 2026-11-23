const assert = require('node:assert/strict')
const { mkdir, writeFile } = require('node:fs/promises')

/** Runs only inside the existing disposable real-app Drive UI fixture. */
exports.checkInterface = async function checkInterface({ browser, base, storageState, installSyntheticGoogle, directory }) {
  assert.ok(process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true' && process.env.STEELKEEP_UI_ACCEPTANCE === 'github-google-drive' && process.env.STEELKEEP_GOOGLE_DRIVE_ACCEPTANCE === 'synthetic-ci', 'Interface proof requires the isolated GitHub fixture.')
  const database = new URL(process.env.DATABASE_URL || '')
  assert.ok(database.hostname === '127.0.0.1' && database.pathname === '/steelkeep_drive_ci' && database.username === 'steelkeep_drive_ci' && database.password === 'synthetic-drive-ci-only', 'Only the disposable Drive CI database is allowed.')
  await mkdir(directory, { recursive: true })
  const cases = [], checks = []
  try {
    for (const [device, viewport] of [['desktop', { width: 1440, height: 1000 }], ['tablet', { width: 820, height: 1180 }], ['mobile', { width: 390, height: 844 }]]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ baseURL: base, storageState, viewport, colorScheme: theme })
      let releaseScripts
      try {
        await context.addInitScript(theme => localStorage.setItem('steelkeep-theme', theme), theme)
        const observed = await installSyntheticGoogle(context), page = await context.newPage(), errors = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => { if (['error', 'warning'].includes(message.type()) && /hydrat|did not match|server.rendered/i.test(message.text())) errors.push('Hydration warning: ' + message.text()) })
        const hydration = new Promise(resolve => { releaseScripts = resolve })
        await page.route(/\/assets\/[^?]+\.js(?:\?.*)?$/, async route => { await hydration; await route.continue() })
        await page.goto('/connections', { waitUntil: 'commit' })
        await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme)
        const firstPaint = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, background: getComputedStyle(document.documentElement).backgroundColor }))
        assert.equal(firstPaint.theme, theme, 'Saved theme must exist before hydration scripts run.')
        assert.equal(firstPaint.background, theme === 'light' ? 'rgb(248, 250, 252)' : 'rgb(24, 28, 35)', 'The initial document surface must match the saved theme.')
        releaseScripts()
        await page.locator('.page-header').getByRole('button', { name: 'Add connection', exact: true }).waitFor()
        await page.locator('.connection-browser-filters').waitFor()
        await page.evaluate(() => document.fonts.ready)
        const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
        assert.ok(width.document <= width.viewport + 1, 'Workspace must fit its viewport.')
        const connectionNames = await page.locator('.connection-browser-table .connection-name>span:last-child').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width))
        assert.ok(connectionNames.length > 0 && connectionNames.every(width => width >= 120), 'Connection names need readable line width; use cards when the content panel is narrow: ' + JSON.stringify(connectionNames))
        await page.screenshot({ path: `${directory}/${device}-${theme}.png` })
        const marker = await page.evaluate(() => { window.__steelkeepInterfaceDocument = crypto.randomUUID(); return window.__steelkeepInterfaceDocument })
        const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
        if (device !== 'mobile') {
          const separator = page.getByRole('separator', { name: 'Resize sidebar' })
          await separator.focus();await page.keyboard.press('End')
          await page.waitForFunction(() => document.querySelector('.sidebar')?.getBoundingClientRect().width === 340)
          await page.keyboard.press('ArrowLeft')
          await page.waitForFunction(() => document.querySelector('.sidebar')?.getBoundingClientRect().width === 324)
          const bounds = await separator.boundingBox()
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);await page.mouse.down();await page.mouse.move(280, bounds.y + 100);await page.mouse.up()
          await page.waitForFunction(() => Math.abs(document.querySelector('.sidebar')?.getBoundingClientRect().width - 280) <= 1)
          await sidebar.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
          await page.waitForFunction(() => document.querySelector('.sidebar')?.getBoundingClientRect().width === 72)
          await page.reload()
          await sidebar.getByRole('button', { name: 'Expand sidebar', exact: true }).waitFor()
          await page.waitForFunction(() => document.querySelector('.sidebar')?.getBoundingClientRect().width === 72)
          await sidebar.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
          await page.waitForFunction(() => Math.abs(document.querySelector('.sidebar')?.getBoundingClientRect().width - 280) <= 1)
          const footer = await sidebar.locator('.sidebar-bottom').evaluate(element => { const owner = element.querySelector('.installation-avatar').getBoundingClientRect(), utilities = element.querySelector('.sidebar-utilities').getBoundingClientRect();return { owner: owner.y + owner.height / 2, utilities: utilities.y + utilities.height / 2 } })
          assert.ok(Math.abs(footer.owner - footer.utilities) <= 2, 'Owner avatar and theme/logout controls share one row.')
        } else {
          await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
          assert.ok(await sidebar.getByRole('link', { name: 'Dashboard', exact: true }).isVisible())
          assert.ok(!(await sidebar.getByRole('button', { name: 'Collapse sidebar', exact: true }).isVisible()), 'Mobile drawer cannot expose desktop rail controls.')
          await sidebar.getByRole('button', { name: 'Close navigation', exact: true }).click()
        }
        const documentMarker = device === 'mobile' ? marker : await page.evaluate(() => { window.__steelkeepInterfaceDocument = crypto.randomUUID(); return window.__steelkeepInterfaceDocument })
        if (device === 'mobile') await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
        await sidebar.getByRole('link', { name: 'Backup plans', exact: true }).click()
        await page.waitForURL('**/plans')
        assert.equal(await page.evaluate(() => window.__steelkeepInterfaceDocument), documentMarker, 'Internal navigation must retain its browser document.')
        if (device === 'mobile') await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
        await sidebar.getByRole('link', { name: 'Connections', exact: true }).click()
        await page.waitForURL('**/connections')
        await page.setViewportSize({ ...viewport, height: Math.min(viewport.height, 720) })
        const opener = page.locator('.page-header').getByRole('button', { name: 'Add connection', exact: true })
        await opener.click()
        const dialog = page.getByRole('dialog', { name: 'Add connection', exact: true })
        await dialog.waitFor()
        const locked = await page.evaluate(() => ({ body: document.body.style.position, root: document.documentElement.style.overflow, x: scrollX, y: scrollY, focus: document.querySelector('dialog[open]')?.contains(document.activeElement) }))
        assert.equal(locked.body, 'fixed');assert.equal(locked.root, 'hidden');assert.equal(locked.focus, true)
        const body = dialog.locator('.modal-body'), scroll = await body.evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight }))
        assert.ok(scroll.content > scroll.height, 'Real connection form must exercise internal long-content scrolling.')
        await body.hover();await page.mouse.wheel(0, 500)
        await page.waitForFunction(() => document.querySelector('dialog[open] .modal-body')?.scrollTop > 0)
        await page.mouse.move(2, 2);await page.mouse.wheel(0, 500)
        assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY })), { x: locked.x, y: locked.y }, 'Wheel outside the dialog cannot move the page.')
        await page.keyboard.press('Tab')
        assert.ok(await dialog.evaluate(element => element.contains(document.activeElement)), 'Keyboard focus stays inside the modal.')
        await page.keyboard.press('Escape');await dialog.waitFor({ state: 'hidden' })
        assert.equal(await page.evaluate(() => document.body.style.position), '', 'Closing the last modal restores body positioning.')
        assert.equal(await opener.evaluate(element => element === document.activeElement), true, 'Escape returns focus to the opener.')
        const controls = await page.locator('.connection-browser-filters select').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().width > 0).map(element => {
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element), probe = document.createElement('span')
          // Native selects may report line-height:normal; measure the same font's line box instead of parsing it as a number.
          Object.assign(probe.style, { position: 'fixed', visibility: 'hidden', whiteSpace: 'nowrap', padding: '0', border: '0', fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight })
          probe.textContent = 'Ag';document.body.append(probe)
          const line = probe.getBoundingClientRect().height;probe.remove()
          return { label: element.parentElement.firstChild.textContent, height: rect.height, arrow: parseFloat(style.paddingRight), line, computedLine: style.lineHeight, padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom), client: element.clientHeight }
        }))
        assert.ok(controls.length >= 3 && controls.every(control => control.height === 38 && control.arrow >= 28 && control.line + control.padding <= control.client + 1), 'Native filter selects align and leave room for their arrow and text: ' + JSON.stringify(controls))
        assert.equal(errors.length, 0)
        assert.equal(observed.keyDownloads, 0)
        cases.push({ device, theme, viewport, modalViewportHeight: Math.min(viewport.height, 720), firstPaint, width, controls: controls.length, uncaughtErrors: errors.length })
      } finally { releaseScripts?.();await context.close() }
    }
    for (const storage of ['fresh', 'blocked']) {
      const context = await browser.newContext({ baseURL: base, storageState })
      let release
      try {
        await context.addInitScript(storage => { if (storage === 'blocked') Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Synthetic blocked storage', 'SecurityError') } });else { localStorage.removeItem('steelkeep-theme');localStorage.removeItem('steelkeep-auth-theme') } }, storage)
        const page = await context.newPage()
        const scripts = new Promise(resolve => { release = resolve })
        await page.route(/\/assets\/[^?]+\.js(?:\?.*)?$/, async route => { await scripts;await route.continue() })
        await page.goto('/connections', { waitUntil: 'commit' })
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgb(24, 28, 35)', 'Fresh and blocked storage must paint the default dark surface.')
        release()
        await page.waitForLoadState('domcontentloaded')
        if (storage === 'blocked') {
          const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
          await sidebar.getByRole('button', { name: 'Switch to light theme', exact: true }).click()
          await sidebar.getByRole('link', { name: 'Backup plans', exact: true }).click()
          await page.waitForURL('**/plans')
          assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'A storage-blocked browser retains its chosen theme during native navigation.')
        }
      } finally { release?.();await context.close() }
    }
    checks.push('six-responsive-theme-captures', 'theme-before-hydration', 'fresh-and-blocked-storage-dark-default', 'no-hydration-console-warnings', 'keyboard-pointer-sidebar-resize-and-reload-persistence', 'collapsed-icon-rail-and-mobile-drawer', 'owner-footer-single-row', 'internal-navigation-same-document', 'modal-background-scroll-focus-escape-return', 'native-select-geometry', 'readable-connection-names-at-panel-breakpoints')
    console.log('Interface quality passed six viewport/theme cases, prehydration theme, persistent sidebar, native navigation, modal scroll/focus and select geometry.')
  } finally { await writeFile(`${directory}/results.json`, JSON.stringify({ commit: process.env.GITHUB_SHA, boundary: 'Real compiled app/auth/metadata with synthetic Google endpoints; no production or native backup claim.', checks, cases }, null, 2)) }
}

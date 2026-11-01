const { chromium } = require('playwright')
const { mkdir, writeFile } = require('node:fs/promises')
const assert = require('node:assert/strict')

async function main() {
  const directory = 'output/playwright/github-readme'
  await mkdir(directory, { recursive: true })
  const browser = await chromium.launch()
  const results = []
  try {
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, colorScheme })
      try {
        const page = await context.newPage()
        const response = await page.goto('https://github.com/grootbro/steelkeep', { waitUntil: 'domcontentloaded' })
        assert.equal(response.status(), 200)
        const article = page.locator('article.markdown-body')
        await article.waitFor()
        await article.getByRole('heading', { name: 'Database backups. A clear path to recovery.', exact: true }).waitFor()
        await article.locator('img').evaluateAll(images => images.forEach(image => image.loading = 'eager'))
        await page.waitForFunction(() => {
          const images = [...document.querySelectorAll('article.markdown-body img')]
          return images.length >= 6 && images.every(image => image.complete && image.naturalWidth > 0)
        }, undefined, { timeout: 30000 })
        await page.evaluate(() => document.fonts.ready)
        const images = await article.locator('img').evaluateAll(images => images.map(image => ({ alt: image.alt, source: image.currentSrc, width: image.naturalWidth })))
        assert.equal(images.length, 6)
        assert.ok(images.find(image => image.alt === 'steelkeep').source.includes(`lockup-${colorScheme}.png`))
        assert.ok(images.find(image => image.alt.startsWith('Steelkeep dashboard')).source.includes(`dashboard-${colorScheme}.png`))
        assert.equal(await article.locator('details').count(), 2)
        assert.equal(await article.getByRole('heading', { name: 'Self-host', exact: true }).count(), 1)
        const name = `${mobile ? 'mobile' : 'desktop'}-${colorScheme}`
        await article.evaluate(element => element.scrollIntoView({ block: 'start' }))
        await page.screenshot({ path: `${directory}/${name}-viewport.png` })
        await article.screenshot({ path: `${directory}/${name}-readme.png` })
        results.push({ name, url: page.url(), images, details: 2, httpStatus: response.status() })
      } finally { await context.close() }
    }
  } finally {
    await writeFile(`${directory}/results.json`, JSON.stringify(results, null, 2))
    await browser.close()
  }
  assert.equal(results.length, 4)
  console.log('README rendered on GitHub in desktop/mobile and light/dark; all six images loaded in every case.')
}

main().catch(error => { console.error(error); process.exitCode = 1 })

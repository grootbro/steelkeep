import {defineConfig} from '@playwright/test'

// A config import must not silently launch a browser against another installation.
const fixtureMetadata='postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep'
if(process.env.STEELKEEP_ACCEPTANCE!=='synthetic-local-ui'||process.env.DATABASE_URL!==fixtureMetadata||process.env.STEELKEEP_DATABASE_PASSWORD_FILE)throw new Error('UI recovery requires synthetic-local-ui and the exact isolated loopback metadata DATABASE_URL documented in acceptance/ui/README.md.')
if(process.env.DEBUG||process.env.PWDEBUG||process.env.NODE_DEBUG||process.argv.some(arg=>arg==='--debug'||arg==='--ui'||arg==='--headed'||arg==='--trace'||(arg.startsWith('--trace=')&&arg!=='--trace=off')))throw new Error('Disable interactive/debug/protocol recording options for the credential-bearing UI recovery suite.')
// Pinned Playwright's automatic failure DOM-copy prompt is deliberately disabled.
// We attach only explicitly masked failure screenshots, never an auth DOM dump.
process.env.PLAYWRIGHT_NO_COPY_PROMPT='1'

export default defineConfig({
  testDir:'./acceptance/ui',testMatch:['recovery.spec.ts','management.spec.ts'],
  fullyParallel:false,workers:1,retries:0,timeout:300000,
  expect:{timeout:15000},forbidOnly:true,reporter:[['list']],
  outputDir:'./test-results/ui-recovery',
  use:{
    baseURL:'http://127.0.0.1:4310',browserName:'chromium',headless:true,
    viewport:{width:1440,height:1000},locale:'en-GB',timezoneId:'Asia/Bangkok',
    trace:'off',video:'off',screenshot:'off',
    actionTimeout:15000,navigationTimeout:30000,
    // No saved storageState, HAR, persistent context or auto-started webServer.
  }
})

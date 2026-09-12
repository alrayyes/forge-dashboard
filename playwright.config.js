// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests',
  use: {
    baseURL: 'http://localhost:8080',
  },
  reporter: 'list',
  // Every test here drives a real WebAuthn ceremony through Chrome's CDP
  // virtual authenticator against one shared Go binary — real CTAP2 crypto,
  // real HTTP round trips. Two of those running at once under CI's default
  // worker count is a genuine resource/timing race, not a bug in the tests
  // themselves: confirmed live across three separate runs, each timing out
  // on a different, otherwise-passing assertion (a toHaveURL after login, a
  // dashboard stat never leaving its loading placeholder). Local runs stay
  // parallel — this is a CI-under-load problem, not a test-isolation one.
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 1 : 0,
});

// Registers the first user (the owner) and saves its session to
// tests/.auth/admin.json. The Lighthouse job uses it to audit the signed-in
// pages (scripts/lighthouse-session.js reads the file). Run with bun against a
// running server on an empty database: E2E_BASE_URL defaults to
// http://localhost:8080.
import path from 'node:path';
import { chromium } from '@playwright/test';
import { addVirtualAuthenticator } from '../tests/webauthn-helper';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const statePath = path.join(__dirname, '..', 'tests', '.auth', 'admin.json');

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await addVirtualAuthenticator(page);
  await page.goto(`${baseURL}/login.html`);
  await page.click('#show-register');
  await page.fill('#register-username', 'admin');
  await page.fill('#register-display-name', 'Admin');
  await page.click('#register-submit');
  await page.waitForURL(`${baseURL}/`, { timeout: 10000 });
  await context.storageState({ path: statePath });
} finally {
  await browser.close();
}

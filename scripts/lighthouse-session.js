// Lighthouse CI puppeteerScript: signs the audit browser in by reusing the
// session cookie Playwright's global setup saved to tests/.auth/admin.json,
// so every page except /login.html is audited as a signed-in user rather
// than as a redirect to the login page. lhci runs it before each URL.
const fs = require('node:fs');
const path = require('node:path');

const statePath = path.join(__dirname, '..', 'tests', '.auth', 'admin.json');

module.exports = async (browser, context) => {
  if (new URL(context.url).pathname === '/login.html') return;
  const { cookies } = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const page = await browser.newPage();
  await page.setCookie(
    ...cookies.map(({ name, value, path, httpOnly, sameSite }) => ({
      name,
      value,
      path,
      httpOnly,
      sameSite,
      url: new URL(context.url).origin,
    })),
  );
  await page.close();
};

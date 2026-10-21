// One server per Playwright worker, with one signed-in user and a reset
// between tests (#1880). A spec that imports `test` from here instead of
// ./fixtures gets:
//
//   - `server` (worker-scoped): a binary started on a free port with a temp
//     database and a random key, with its one owner registered through the
//     Chrome virtual authenticator, exactly as a first visit does. Stopped and
//     removed when the worker ends.
//   - `signedIn` (test-scoped, automatic): before each test, POST /__e2e/reset
//     empties everything the previous test left and answers with a fresh
//     session cookie, so the page starts signed in and a spec that logs out or
//     revokes a session only hurts itself.
//   - `baseURL` pointed at that server.
//
// The binary has to be built with `-tags e2e` (the route does not exist
// otherwise); E2E_BINARY names it, default ./forge-dashboard-e2e at the repo
// root. tests/run-local.sh and CI build it.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CDPSession, Page } from '@playwright/test';
import { test as base } from './fixtures';
import { addVirtualAuthenticator } from './webauthn-helper';

export const OWNER_USERNAME = 'owner';

// A credential as CDP's WebAuthn.getCredentials returns it, handed back to
// WebAuthn.addCredential untouched; the protocol type isn't exported to tests.
type Credential = object;

export type E2EServer = {
  baseURL: string;
  credentials: Credential[];
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('could not read a free port'));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(
  baseURL: string,
  child: ChildProcess,
  spawnError: () => Error | undefined,
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const failed = spawnError();
    if (failed)
      throw new Error(`could not start the server: ${failed.message}`);
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `the server exited (code ${child.exitCode}, signal ${child.signalCode})`,
      );
    try {
      if ((await fetch(`${baseURL}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server at ${baseURL} never became healthy`);
}

// Re-adds the owner's passkey to a page's virtual authenticator, for a spec
// that logs in with it again: an authenticator belongs to one browser session,
// so the one that registered the owner is gone by the time a test runs.
export async function addOwnerPasskey(
  page: Page,
  server: E2EServer,
): Promise<{ client: CDPSession; authenticatorId: string }> {
  const added = await addVirtualAuthenticator(page);
  for (const credential of server.credentials) {
    await added.client.send('WebAuthn.addCredential', {
      authenticatorId: added.authenticatorId,
      credential: credential as never,
    });
  }
  return added;
}

type Started = {
  baseURL: string;
  stop: () => Promise<void>;
  log: () => string;
};

const LOG_LIMIT = 20_000;

// One attempt: a free port, a temp database, a random key. The port is closed
// before the server binds it, so another process can take it in between; the
// caller retries when the server exits before it is healthy.
async function startOnce(): Promise<Started> {
  const binary =
    process.env.E2E_BINARY ?? path.join(__dirname, '..', 'forge-dashboard-e2e');
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-dashboard-e2e-'));
  const port = await freePort();
  const baseURL = `http://localhost:${port}`;
  const child = spawn(binary, [], {
    env: {
      PATH: process.env.PATH,
      ADDR: `127.0.0.1:${port}`,
      DB_PATH: path.join(dir, 'e2e.db'),
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      RP_ID: 'localhost',
      RP_ORIGIN: baseURL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const keep = (d: Buffer) => {
    log = (log + d).slice(-LOG_LIMIT);
  };
  // A wrong E2E_BINARY path is reported by this event, not thrown.
  let spawnFailure: Error | undefined;
  child.once('error', (err) => {
    spawnFailure = err;
  });
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);

  // A worker that is killed outright never runs its fixture teardown, so the
  // server dies with the process that owns it.
  const killOnExit = () => child.kill('SIGKILL');
  process.once('exit', killOnExit);
  const stop = async () => {
    process.off('exit', killOnExit);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGTERM');
      const hardKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(hardKill);
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await waitForHealth(baseURL, child, () => spawnFailure);
  } catch (err) {
    await stop();
    throw Object.assign(err as Error, { serverLog: log });
  }
  return { baseURL, stop, log: () => log };
}

// Starts a server with no users yet: the first visit registers the owner.
async function startServer(): Promise<Started> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await startOnce();
    } catch (err) {
      last = err;
    }
  }
  console.error(
    `server log\n${(last as { serverLog?: string }).serverLog ?? ''}`,
  );
  throw last;
}

export const test = base.extend<
  { signedIn: undefined; freshServer: { baseURL: string } },
  { server: E2EServer }
>({
  server: [
    async ({ browser }, use) => {
      const started = await startServer();
      try {
        // The first visit registers the owner, as a person's first visit does.
        const context = await browser.newContext();
        let credentials: Credential[];
        try {
          const page = await context.newPage();
          const { client, authenticatorId } =
            await addVirtualAuthenticator(page);
          await page.goto(`${started.baseURL}/login.html`);
          await page.click('#show-register');
          await page.fill('#register-username', OWNER_USERNAME);
          await page.fill('#register-display-name', 'Owner');
          await page.click('#register-submit');
          await page.waitForURL(`${started.baseURL}/`, { timeout: 15_000 });
          // Saved so a spec that logs in with the passkey again can re-add it
          // to its own authenticator (addOwnerPasskey).
          ({ credentials } = await client.send('WebAuthn.getCredentials', {
            authenticatorId,
          }));
        } finally {
          await context.close();
        }

        await use({ baseURL: started.baseURL, credentials });
      } catch (err) {
        console.error(`server log\n${started.log()}`);
        throw err;
      } finally {
        await started.stop();
      }
    },
    { scope: 'worker' },
  ],

  baseURL: async ({ server }, use) => {
    await use(server.baseURL);
  },

  signedIn: [
    async ({ context, server }, use) => {
      const res = await context.request.post(`${server.baseURL}/__e2e/reset`);
      if (!res.ok())
        throw new Error(`reset failed (${res.status()}): ${await res.text()}`);
      await use(undefined);
    },
    { auto: true },
  ],

  // A server with no users, for the few specs that need a virgin database: the
  // first visit registering, registration closing afterwards. The page starts
  // signed out, and visits its URL with page.goto(`${freshServer.baseURL}/...`).
  freshServer: async ({ context }, use) => {
    const started = await startServer();
    await context.clearCookies();
    try {
      await use({ baseURL: started.baseURL });
    } finally {
      await started.stop();
    }
  },
});

// The server fixture signs the page in and clears everything without loading
// a page, so a spec starts on a blank tab. This loads the pull request list
// against the real server. A spec that mocks the API should not call it first:
// install the routes, then load the page once, so nothing loads unmocked.
export async function landOnPullRequests(page: Page) {
  await page.goto('/pull-requests.html');
}

export { expect } from './fixtures';

import type { Page } from '@playwright/test';

const installed = new WeakSet<Page>();

// A stand-in for the browser's EventSource on the dashboard stream, so a spec
// can send the page a stream message when it wants one instead of waiting out
// a poll. It opens at once, like a stream that connected, and stays open.
//
// The stream carries the whole dashboard payload; a spec sends only the part
// it is about, and the page ignores what it has no use for. Named events (the
// job lists of an open pipeline dialog) go through pushNamedStream.
export async function installFakeStream(page: Page) {
  // Once per page: a spec and a helper may both ask for it.
  if (installed.has(page)) return;
  installed.add(page);
  await page.addInitScript(() => {
    // tsx (esbuild keepNames) wraps the class below in a __name() call, and
    // this function runs in the browser, where nothing defines it. Playwright's
    // own transform doesn't, so only the screenshot script needs the stand-in.
    const scope = window as unknown as Record<string, unknown>;
    scope.__name ??= (fn: unknown) => fn;
    type Event = { data?: string };
    type Handler = ((event: { data: string }) => void) | null;
    const open: FakeSource[] = [];
    class FakeSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: Handler = null;
      onerror: (() => void) | null = null;
      listeners = new Map<string, ((event: Event) => void)[]>();
      constructor(public url: string) {
        open.push(this);
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.();
          this.dispatch('open', {});
        });
      }
      addEventListener(type: string, fn: (event: Event) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
      }
      dispatch(type: string, event: Event) {
        for (const fn of this.listeners.get(type) ?? []) fn(event);
      }
      close() {
        this.readyState = 2;
        open.splice(open.indexOf(this), 1);
      }
    }
    Object.assign(window, {
      EventSource: FakeSource,
      __streamClose: () => {
        for (const source of [...open]) {
          source.readyState = 2;
          source.onerror?.();
          source.dispatch('error', {});
        }
      },
      __streamPush: (message: unknown) => {
        const data = JSON.stringify(message);
        for (const source of open) source.onmessage?.({ data });
      },
      __streamPushNamed: (name: string, message: unknown) => {
        const data = JSON.stringify(message);
        for (const source of open) source.dispatch(name, { data });
      },
    });
  });
}

// Sends the page one stream message.
export async function pushStream(page: Page, message: unknown) {
  await page.evaluate(
    (data) =>
      (
        window as unknown as { __streamPush: (m: unknown) => void }
      ).__streamPush(data),
    message,
  );
}

// Sends the page one named stream event, such as "run".
export async function pushNamedStream(
  page: Page,
  name: string,
  message: unknown,
) {
  await page.evaluate(
    ([event, data]) =>
      (
        window as unknown as {
          __streamPushNamed: (n: string, m: unknown) => void;
        }
      ).__streamPushNamed(event as string, data),
    [name, message] as const,
  );
}

// Closes the stream the way the browser does when the server answers it with
// an error: the source is CLOSED and will not retry on its own.
export async function closeStream(page: Page) {
  await page.evaluate(() =>
    (window as unknown as { __streamClose: () => void }).__streamClose(),
  );
}

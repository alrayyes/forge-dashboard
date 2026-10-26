import type { Page } from '@playwright/test';

// A stand-in for the browser's EventSource on the dashboard stream, so a spec
// can send the page a stream message when it wants one instead of waiting out
// a poll. It opens at once, like a stream that connected, and stays open.
//
// The stream carries the whole dashboard payload; a spec sends only the part
// it is about, and the page ignores what it has no use for.
export async function installFakeStream(page: Page) {
  await page.addInitScript(() => {
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
      constructor(public url: string) {
        open.push(this);
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.();
        });
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
        }
      },
      __streamPush: (message: unknown) => {
        const data = JSON.stringify(message);
        for (const source of open) source.onmessage?.({ data });
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

// Closes the stream the way the browser does when the server answers it with
// an error: the source is CLOSED and will not retry on its own.
export async function closeStream(page: Page) {
  await page.evaluate(() =>
    (window as unknown as { __streamClose: () => void }).__streamClose(),
  );
}

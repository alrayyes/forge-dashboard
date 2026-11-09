// Stories run with no Go server behind them, so a component that reads
// /api/v1/... gets the answer a story hands it. Only fetch is replaced; the
// component code is the real one. Each story installs its own routes and gets
// the original fetch back when it is torn down.
export type MockRoute = {
  // Matched against the path and query of the request URL.
  match: RegExp;
  status?: number;
  body?: unknown;
  // Never answers, for a loading state.
  hang?: boolean;
  // Called with the request body each time the route answers.
  onCall?: (body: string) => void;
};

export function mockFetch(routes: MockRoute[]): () => void {
  const original = window.fetch;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(raw, window.location.href);
    const route = routes.find((r) => r.match.test(url.pathname + url.search));
    if (!route) return original(input, init);
    if (route.hang) return new Promise<Response>(() => {});
    route.onCall?.(typeof init?.body === 'string' ? init.body : '');
    if (route.status === 204)
      return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(
      new Response(JSON.stringify(route.body ?? {}), {
        status: route.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return () => {
    window.fetch = original;
  };
}

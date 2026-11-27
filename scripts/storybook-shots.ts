// What the Storybook screenshot script shoots and how each shot is framed
// (#3872). It is kept apart from the browser code so it can be tested.

export type Size = { width: number; height: number };
export type Box = { x: number; y: number; width: number; height: number };

export type Variant = {
  name: 'desktop' | 'phone' | 'dark';
  viewport: Size;
  colorScheme: 'light' | 'dark';
  // Appended to the story ID. The desktop shot keeps the bare ID.
  suffix: string;
};

export const VARIANTS: Variant[] = [
  {
    name: 'desktop',
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
    suffix: '',
  },
  {
    name: 'phone',
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    suffix: '--phone',
  },
  {
    name: 'dark',
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
    suffix: '--dark',
  },
];

// Space left around a cropped component, in CSS pixels.
export const MARGIN = 16;

export const shotName = (id: string, variant: Variant) =>
  `${id}${variant.suffix}.png`;

// What the page reported about a story: the box around everything it drew
// (null when it drew nothing), and whether an open dialog or fixed layer is
// on screen, whose backdrop belongs in the picture.
export type Measure = { box: Box | null; overlay: boolean };

export type Plan =
  | { kind: 'blank' }
  | { kind: 'full' }
  | { kind: 'clip'; clip: Box };

export function planShot(measure: Measure, viewport: Size): Plan {
  if (measure.overlay) return { kind: 'full' };
  const { box } = measure;
  if (!box || box.width <= 0 || box.height <= 0) return { kind: 'blank' };
  const x = Math.max(0, box.x - MARGIN);
  const y = Math.max(0, box.y - MARGIN);
  const right = Math.min(viewport.width, box.x + box.width + MARGIN);
  const bottom = Math.min(viewport.height, box.y + box.height + MARGIN);
  return { kind: 'clip', clip: { x, y, width: right - x, height: bottom - y } };
}

// One shot to take: a story at one size.
export type ShotJob = { id: string; variant: Variant };

export const shotJobs = (ids: string[]): ShotJob[] =>
  VARIANTS.flatMap((variant) => ids.map((id) => ({ id, variant })));

// Browsers to run at once: one per core, and no more than the four a CI runner
// has, so a many-core workstation doesn't start dozens in the pre-push hook.
export const workerCount = (cores: number) => Math.min(4, Math.max(1, cores));

// Runs every item with `count` running at once, and answers in the items'
// order. `worker` is the slot an item runs in, which no other item holds
// meanwhile, so it can pick that slot's browser.
export async function inParallel<T, R>(
  items: T[],
  count: number,
  run: (item: T, worker: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, items.length) }, async (_, worker) => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index] as T, worker);
      }
    }),
  );
  return results;
}

// The requests a page has open. Kept by request, not by URL: a URL asked for
// twice stays open until both have ended.
export function openRequests<R extends { url: () => string }>() {
  const open = new Set<R>();
  return {
    opened: (request: R) => void open.add(request),
    ended: (request: R) => void open.delete(request),
    pending: () => [...open].map((request) => request.url()),
  };
}

// What is known about a story that never finished (#5051). A page that couldn't
// be asked says why instead.
export type Stall = {
  page:
    | {
        // Each render phase and the page's clock when it was first seen.
        phases: [string, number][];
        error: string | null;
        // Whether an animation frame still came.
        frame: boolean;
      }
    | { unanswered: string };
  pending: string[];
  messages: string[];
};

// The lines printed under a story's timeout, indented like the axe targets.
export function stallReport({ page, pending, messages }: Stall): string {
  const state =
    'unanswered' in page
      ? [`the page did not answer: ${page.unanswered}`]
      : [
          `render phases: ${page.phases.map(([phase, at]) => `${phase} at ${at}ms`).join(', ') || 'none seen'}`,
          `story error: ${page.error ?? 'none'}`,
          `animation frames: ${page.frame ? 'running' : 'stopped'}`,
        ];
  return [
    ...state,
    `requests still open: ${pending.join(', ') || 'none'}`,
    `console: ${messages.join('\n      ') || 'nothing'}`,
  ]
    .map((line) => `    ${line}`)
    .join('\n');
}

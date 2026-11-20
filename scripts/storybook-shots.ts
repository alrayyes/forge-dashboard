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

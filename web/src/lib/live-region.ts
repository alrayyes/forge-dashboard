// Saying a line in a polite live region. A screen reader speaks a region when
// its text changes, so the same line twice in a row is silent the second
// time. The region is emptied first and the line set a moment later. No DOM
// here: the caller says how to write the text.

export type Speaker = {
  (line: string): void;
  /** Empties the region and drops a line still waiting. */
  clear(): void;
};

export function createSpeaker(
  write: (text: string) => void,
  delayMs = 60,
): Speaker {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    write('');
  };
  const speak = (line: string) => {
    clear();
    timer = setTimeout(() => write(line), delayMs);
  };
  speak.clear = clear;

  return speak;
}

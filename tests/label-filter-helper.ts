import type { Locator, Page } from '@playwright/test';

// The Label filter is a button that opens a group of checkboxes (one per
// label on offer). These drive it the way a person does.

export const labelButton = (page: Page): Locator =>
  page.locator('#shared-label-filter-button').first();

export const labelPanel = (page: Page): Locator =>
  page.locator('#shared-label-filter-panel').first();

async function open(page: Page) {
  const button = labelButton(page);
  if ((await button.getAttribute('aria-expanded')) !== 'true')
    await button.click();
}

async function close(page: Page) {
  const button = labelButton(page);
  if ((await button.getAttribute('aria-expanded')) === 'true')
    await button.click();
}

// The labels the filter offers, as written.
export async function labelChoices(page: Page): Promise<string[]> {
  await open(page);
  const names = await labelPanel(page)
    .locator('.label-filter-option span')
    .allTextContents();
  await close(page);
  return names;
}

// Ticks (or, when already ticked, unticks) each label by name.
export async function toggleLabels(page: Page, ...names: string[]) {
  await open(page);
  for (const name of names)
    await labelPanel(page).getByRole('checkbox', { name, exact: true }).click();
  await close(page);
}

// Empties the pick through the control's own Clear.
export async function clearLabels(page: Page) {
  await open(page);
  await labelPanel(page).getByRole('button', { name: 'Clear labels' }).click();
  await close(page);
}

// The choices of a shared filter by control id, the "All ..." entry first, for
// specs that check every dynamic control the same way. The Label filter is
// checkboxes, the rest are selects.
export async function choicesOf(page: Page, id: string): Promise<string[]> {
  if (id === 'shared-label-select')
    return ['All labels', ...(await labelChoices(page))];
  return page
    .locator(`#${id} option`)
    .evaluateAll((os) =>
      os.map((o) => (o as HTMLOptionElement).textContent?.trim() ?? ''),
    );
}

// The lowercase labels that are ticked.
export async function pickedLabels(page: Page): Promise<string[]> {
  await open(page);
  const picked = await labelPanel(page)
    .locator('input:checked')
    .evaluateAll((boxes) => boxes.map((b) => (b as HTMLInputElement).value));
  await close(page);
  return picked;
}

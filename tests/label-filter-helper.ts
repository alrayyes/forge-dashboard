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
// checkboxes (id 'shared-label-filter'), as are Repo and Author (ids
// 'shared-repo-filter' and 'shared-author-filter'); the rest are selects.
export async function choicesOf(page: Page, id: string): Promise<string[]> {
  if (id === 'shared-label-filter')
    return ['All labels', ...(await labelChoices(page))];
  const pick = /^shared-(repo|author)-filter$/.exec(id);
  if (pick) {
    const key = pick[1] as PickKey;
    return [`All ${key}s`, ...(await pickTexts(page, key))];
  }
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

// Repo and Author are the same kind of control as Label: a button that opens a
// group of checkboxes. A pick is named by its saved, lowercase value
// ("github:acme/api", "ann").
export type PickKey = 'label' | 'repo' | 'author';

export const pickButton = (page: Page, key: PickKey): Locator =>
  page.locator(`#shared-${key}-filter-button`).first();

export const pickPanel = (page: Page, key: PickKey): Locator =>
  page.locator(`#shared-${key}-filter-panel`).first();

async function openPick(page: Page, key: PickKey) {
  const button = pickButton(page, key);
  if ((await button.getAttribute('aria-expanded')) !== 'true')
    await button.click();
}

async function closePick(page: Page, key: PickKey) {
  const button = pickButton(page, key);
  if ((await button.getAttribute('aria-expanded')) === 'true')
    await button.click();
}

// Read from the markup, so the panel stays shut and focus and pointer stay put.
// The names the control offers, as written.
export async function pickTexts(page: Page, key: PickKey): Promise<string[]> {
  const names = await pickPanel(page, key)
    .locator('.label-filter-option .pick-name')
    .allTextContents();
  return names;
}

// The saved values that are ticked.
export async function pickedValues(
  page: Page,
  key: PickKey,
): Promise<string[]> {
  const picked = await pickPanel(page, key)
    .locator('input:checked')
    .evaluateAll((boxes) => boxes.map((b) => (b as HTMLInputElement).value));
  return picked;
}

// Ticks (or unticks) each value.
export async function togglePicks(
  page: Page,
  key: PickKey,
  ...values: string[]
) {
  await openPick(page, key);
  for (const value of values)
    await pickPanel(page, key)
      .locator(`input[value="${value.toLowerCase()}"]`)
      .click();
  await closePick(page, key);
}

// Leaves exactly this value picked, or nothing for ''. What choosing from the
// old single-value list did.
export async function pickOnly(page: Page, key: PickKey, value: string) {
  await clearPicks(page, key);
  if (value) await togglePicks(page, key, value);
}

export async function clearPicks(page: Page, key: PickKey) {
  await openPick(page, key);
  const clear = pickPanel(page, key).locator('.label-filter-clear');
  if (await clear.isEnabled()) await clear.click();
  await closePick(page, key);
}

// The saved values the control offers, ticked or not.
export async function offeredValues(
  page: Page,
  key: PickKey,
): Promise<string[]> {
  const values = await pickPanel(page, key)
    .locator('input')
    .evaluateAll((boxes) => boxes.map((b) => (b as HTMLInputElement).value));
  return values;
}

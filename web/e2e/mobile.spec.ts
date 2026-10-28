import { expect, test } from '@playwright/test';

/** Rulează în proiectul „mobil” (ecran de telefon, atingere). */
test('pagina principală și formularul de intrare încap pe ecranul telefonului', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Intră într-o cameră' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);

  await page.getByRole('textbox', { name: 'Codul sau link-ul camerei' }).fill('http://exemplu/#/join/abcdefghjk');
  await page.getByRole('button', { name: 'Continuă' }).click();
  await expect(page.getByLabel('Codul camerei')).toHaveValue('abcdefghjk');
  const box = await page.getByRole('button', { name: 'Intră în cameră' }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44); // țintă tactilă suficient de mare
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

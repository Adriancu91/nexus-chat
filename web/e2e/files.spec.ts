import { readFile } from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createRoom, enrollAdmin, joinAs, messages, sendMessage } from './helpers.ts';

/** Fișiere, căutare și backup prin interfață, pe serverul real. */
test.describe.configure({ mode: 'serial' });

const PASSWORD = 'fisiere-si-cautare-7';
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let adminCtx: BrowserContext;
let admin: Page;
let ana: { ctx: BrowserContext; page: Page };
let ion: { ctx: BrowserContext; page: Page };

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext();
  admin = await adminCtx.newPage();
  await enrollAdmin(admin, 'Laptop fișiere');
  const room = await createRoom(admin, 'Fișiere test', PASSWORD);
  ana = await joinAs(browser, room.link, PASSWORD, 'Ana');
  ion = await joinAs(browser, room.link, PASSWORD, 'Ion');
});
test.afterAll(async () => {
  await Promise.all([adminCtx.close(), ana.ctx.close(), ion.ctx.close()]);
});

test('un fișier trimis de Ana ajunge la Ion și se descarcă identic', async () => {
  const content = 'Rețeta bunicii: 3 ouă, făină, zahăr.\n';
  await ana.page.getByTestId('file-input').setInputFiles({ name: 'rețetă.txt', mimeType: 'text/plain', buffer: Buffer.from(content) });
  const card = ion.page.getByTestId('file-card').filter({ hasText: 'rețetă.txt' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('B'); // dimensiunea, ex. „41 B”

  const downloadPromise = ion.page.waitForEvent('download');
  await card.getByRole('button', { name: /Descarcă/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('rețetă.txt');
  expect(await readFile((await download.path())!, 'utf8')).toBe(content);
});

test('imaginile au previzualizare în chat', async () => {
  await ana.page.getByTestId('file-input').setInputFiles({ name: 'poza.png', mimeType: 'image/png', buffer: PNG_1PX });
  const img = ion.page.getByTestId('image-preview').last();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
  // sursa este un blob local: tokenul nu apare în nicio adresă
  expect(await img.getAttribute('src')).toMatch(/^blob:/);
});

test('programele executabile sunt refuzate cu un mesaj clar', async () => {
  await ana.page.getByTestId('file-input').setInputFiles({ name: 'joc.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ....') });
  await expect(ana.page.getByRole('alert').filter({ hasText: 'nu sunt permise' })).toBeVisible();
  await expect(ana.page.getByTestId('upload-progress')).toHaveCount(0);
});

test('panoul „Fișiere” listează fișierele camerei', async () => {
  await ion.page.getByRole('button', { name: 'Fișiere' }).click();
  const list = ion.page.getByTestId('file-list');
  await expect(list).toContainText('rețetă.txt');
  await expect(list).toContainText('poza.png');
  await expect(list).toContainText('Ana');
  await ion.page.getByRole('button', { name: 'Închide panoul' }).click();
});

test('căutarea găsește mesaje fără diacritice și sare la mesaj', async () => {
  await sendMessage(ana.page, 'Mâine la ora 12 ne vedem la bunica');
  await sendMessage(ana.page, 'Altceva fără legătură');
  await expect(messages(ion.page).last()).toContainText('Altceva');

  await ion.page.getByRole('button', { name: 'Caută în conversație' }).click();
  await ion.page.getByRole('searchbox', { name: 'Text de căutat' }).fill('maine bunica');
  const result = ion.page.getByTestId('search-result');
  await expect(result).toHaveCount(1);
  await expect(result.locator('mark').first()).toHaveText('Mâine');
  await result.click();
  await expect(ion.page.locator('.msg-flash')).toContainText('Mâine la ora 12');

  // și numele fișierelor
  await ion.page.getByRole('searchbox', { name: 'Text de căutat' }).fill('reteta');
  await expect(ion.page.getByTestId('search-result')).toContainText('rețetă.txt');
});

test('administratorul face un backup verificat și verifică integritatea arhivei', async () => {
  await admin.goto('/#/admin/stare');
  await expect(admin.getByRole('heading', { name: 'Backup', exact: true })).toBeVisible();
  const rowsBefore = await admin.getByTestId('backup-row').count();
  await admin.getByRole('button', { name: 'Fă backup acum' }).click();
  await expect(admin.getByText(/Backup creat și verificat/)).toBeVisible();
  await expect(admin.getByTestId('backup-row')).toHaveCount(rowsBefore + 1);

  await admin.getByTestId('backup-row').first().getByRole('button', { name: 'Verifică' }).click();
  await expect(admin.getByText('Backup verificat: toate amprentele SHA-256 corespund.')).toBeVisible();

  await admin.getByRole('button', { name: 'Verifică integritatea arhivei' }).click();
  await expect(admin.getByTestId('integrity-result')).toContainText('Totul este în regulă');
});

test('politica de retenție cere confirmare înainte de ștergere', async () => {
  await admin.goto('/#/admin/stare');
  await admin.getByRole('combobox', { name: 'Cât timp se păstrează mesajele' }).selectOption({ label: '30 de zile' });
  await admin.getByRole('button', { name: 'Aplică', exact: true }).click();
  const dlg = admin.getByRole('dialog');
  await expect(dlg).toContainText('Se vor șterge definitiv 0 mesaje');
  await dlg.getByRole('button', { name: 'Anulează' }).click();
  // revenire la păstrare nelimitată
  await admin.getByRole('combobox', { name: 'Cât timp se păstrează mesajele' }).selectOption({ label: 'Pentru totdeauna' });
  await admin.getByRole('button', { name: 'Aplică', exact: true }).click();
  await expect(admin.getByText('Mesajele se păstrează pentru totdeauna.')).toBeVisible();
});

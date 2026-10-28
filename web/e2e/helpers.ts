import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const dataDir = fileURLToPath(new URL('../.e2e-data/data', import.meta.url));
const cli = fileURLToPath(new URL('../../server/src/cli/admin-code.ts', import.meta.url));

/** Cod de înrolare emis direct din arhiva locală, exact ca `npm run admin:code` pe laptop. */
export function issueAdminCode(dir = dataDir): string {
  const out = execFileSync(process.execPath, [cli, '--data-dir', dir], { encoding: 'utf8' });
  const m = /([0-9A-Z]{5}(?:-[0-9A-Z]{5}){3})/.exec(out);
  if (!m) throw new Error('Nu am găsit codul în ieșirea CLI: ' + out);
  return m[1]!;
}

export async function enrollAdmin(page: Page, label = 'Laptop test', dir?: string): Promise<void> {
  await page.goto('/#/admin');
  await page.getByLabel('Cod de înrolare').fill(issueAdminCode(dir));
  await page.getByLabel('Numele dispozitivului').fill(label);
  await page.getByRole('button', { name: 'Înregistrează acest dispozitiv' }).click();
  await expect(page.getByRole('link', { name: 'Camere' })).toBeVisible();
}

export async function createRoom(page: Page, name: string, password: string): Promise<{ link: string; code: string }> {
  await page.goto('/#/admin/camere');
  const form = page.getByTestId('create-room');
  await form.getByLabel('Numele camerei').fill(name);
  await form.getByLabel('Parola camerei').fill(password);
  await form.getByRole('button', { name: 'Creează camera' }).click();
  const link = (await page.getByTestId('invite-link').textContent())!;
  await page.getByRole('button', { name: 'Gata' }).click();
  const code = /#\/join\/(.+)$/.exec(link)![1]!;
  return { link, code };
}

export async function joinAs(browser: Browser, link: string, password: string, name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await page.getByLabel('Parola camerei').fill(password);
  await page.getByLabel('Numele tău').fill(name);
  await page.getByRole('button', { name: 'Intră în cameră' }).click();
  await expect(page.getByTestId('conn-status')).toHaveText(/online/);
  return { ctx, page };
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Scrie un mesaj' }).fill(text);
  await page.getByRole('button', { name: 'Trimite' }).click();
}

export function messages(page: Page) {
  return page.getByTestId('message');
}

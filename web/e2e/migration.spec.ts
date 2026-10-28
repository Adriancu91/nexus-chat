import { expect, test, type BrowserContext } from '@playwright/test';
import { createRoom, enrollAdmin, joinAs } from './helpers.ts';

/**
 * Mutarea serverului pe alt calculator schimbă adresa lui. Simulăm că sesiunile și cheia de
 * administrator au fost salvate pentru o adresă veche și verificăm că, după ce `config.json`
 * publică adresa veche în `previousBackendUrls`, nimeni nu trebuie să reintre sau să se reînregistreze.
 */
const OLD = 'https://server-vechi.example';
const CURRENT = 'http://127.0.0.1:18788';

async function publishPrevious(ctx: BrowserContext) {
  await ctx.route('**/config.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ backendUrl: CURRENT, previousBackendUrls: [OLD] }) }),
  );
}

test('participantul rămâne în cameră după schimbarea adresei serverului', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await enrollAdmin(admin, 'Laptop mutare');
  const room = await createRoom(admin, 'Cameră mutare', 'parola-mutare-1');
  const p = await joinAs(browser, room.link, 'parola-mutare-1', 'Elena');
  try {
    // sesiunea pare salvată pentru adresa veche
    await p.page.evaluate((old) => {
      const list = JSON.parse(localStorage.getItem('nexus.roomSessions') ?? '[]');
      localStorage.setItem('nexus.roomSessions', JSON.stringify(list.map((s: object) => ({ ...s, backend: old }))));
      localStorage.setItem('nexus.backendUrl', old); // și o setare manuală veche
    }, OLD);

    // fără adresa veche publicată: sesiunea nu se vede (testul de control)
    await p.page.evaluate(() => localStorage.removeItem('nexus.backendUrl'));
    await p.page.goto('/#/');
    await expect(p.page.getByRole('link', { name: /Cameră mutare/ })).toHaveCount(0);
    await p.page.evaluate((old) => localStorage.setItem('nexus.backendUrl', old), OLD);

    await publishPrevious(p.ctx);
    await p.page.goto('/#/');
    await p.page.reload();
    await p.page.getByRole('link', { name: /Cameră mutare/ }).click();
    await expect(p.page.getByTestId('conn-status')).toHaveText(/online/);
    expect(await p.page.evaluate(() => localStorage.getItem('nexus.backendUrl'))).toBeNull();
  } finally {
    await p.ctx.close();
    await adminCtx.close();
  }
});

test('dispozitivul de administrator nu trebuie reînregistrat după mutare', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await enrollAdmin(page, 'Telefon mutare');
    // cheia (CryptoKey ne-exportabil) pare salvată pentru adresa veche
    await page.evaluate(
      ({ old, current }) =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('nexus-admin', 1);
          req.onsuccess = () => {
            const store = req.result.transaction('devices', 'readwrite').objectStore('devices');
            const get = store.get(current);
            get.onsuccess = () => {
              store.put({ ...get.result, backend: old });
              store.delete(current);
            };
            store.transaction.oncomplete = () => resolve();
            store.transaction.onerror = () => reject(store.transaction.error);
          };
          req.onerror = () => reject(req.error);
        }),
      { old: OLD, current: CURRENT },
    );
    await page.evaluate(() => sessionStorage.clear());

    await page.goto('/#/admin');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Înregistrează acest dispozitiv ca administrator' })).toBeVisible();

    await publishPrevious(ctx);
    await page.reload();
    await expect(page.getByRole('link', { name: 'Camere' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Înregistrează acest dispozitiv ca administrator' })).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

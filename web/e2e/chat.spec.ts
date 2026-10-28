import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createRoom, enrollAdmin, joinAs, messages, sendMessage } from './helpers.ts';

/**
 * Scenariul complet, pe serverul real: administratorul își înregistrează dispozitivul,
 * creează o cameră, doi participanți intră cu link + parolă + nume și discută.
 */
test.describe.configure({ mode: 'serial' });

let adminCtx: BrowserContext;
let admin: Page;
let room: { link: string; code: string };
const PASSWORD = 'mere-pere-prune-42';

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext();
  admin = await adminCtx.newPage();
});
test.afterAll(async () => {
  await adminCtx.close();
});

test('fără dispozitiv înregistrat, pagina de administrare cere codul de înrolare', async ({ page }) => {
  await page.goto('/#/admin');
  await expect(page.getByRole('heading', { name: 'Înregistrează acest dispozitiv ca administrator' })).toBeVisible();
  await page.getByLabel('Cod de înrolare').fill('AAAAA-AAAAA-AAAAA-AAAAA');
  await page.getByRole('button', { name: 'Înregistrează acest dispozitiv' }).click();
  await expect(page.getByRole('alert')).toContainText('Cod de înrolare invalid sau expirat');
});

test('administratorul se înregistrează și creează o cameră', async () => {
  await enrollAdmin(admin);
  room = await createRoom(admin, 'Familia Test', PASSWORD);
  expect(room.link).toMatch(/#\/join\/[a-z2-9]{10}$/);
  await expect(admin.getByTestId('admin-room').filter({ hasText: 'Familia Test' })).toBeVisible();
});

test('parola greșită afișează o eroare clară, în română', async ({ page }) => {
  await page.goto(`/#/join/${room.code}`);
  await page.getByLabel('Parola camerei').fill('gresita-123');
  await page.getByLabel('Numele tău').fill('Intrus');
  await page.getByRole('button', { name: 'Intră în cameră' }).click();
  await expect(page.getByRole('alert')).toHaveText('Codul camerei sau parola nu sunt corecte.');
});

test('participanții discută în timp real, cu numele lângă mesaje', async ({ browser }) => {
  const ana = await joinAs(browser, room.link, PASSWORD, 'Ana');
  const ion = await joinAs(browser, room.link, PASSWORD, 'Ion');
  try {
    await expect(ana.page.getByTestId('conn-status')).toHaveText(/Ion/);

    await sendMessage(ana.page, 'Bună, Ion!');
    await expect(messages(ion.page).last()).toContainText('Bună, Ion!');
    await expect(messages(ion.page).last()).toContainText('Ana');

    await sendMessage(ion.page, 'Salut, Ana!');
    await expect(messages(ana.page).last()).toContainText('Salut, Ana!');
    await expect(messages(ana.page).last()).toContainText('Ion');

    // marcaj temporal HH:MM pe fiecare mesaj
    await expect(messages(ana.page).first().locator('time')).toHaveText(/^\d{2}:\d{2}$/);

    // lista de participanți online
    await ana.page.getByRole('button', { name: 'Participanți' }).click();
    await expect(ana.page.getByTestId('people-list')).toContainText('Ana (tu)');
    await expect(ana.page.getByTestId('people-list')).toContainText('Ion');
  } finally {
    await ana.ctx.close();
    await ion.ctx.close();
  }
});

test('istoricul rămâne după reîncărcarea paginii; sesiunea este păstrată', async ({ browser }) => {
  const maria = await joinAs(browser, room.link, PASSWORD, 'Maria');
  try {
    await expect(messages(maria.page)).toHaveCount(2);
    await sendMessage(maria.page, 'Mesaj de la Maria');
    await expect(messages(maria.page)).toHaveCount(3);
    await maria.page.reload();
    await expect(maria.page.getByTestId('conn-status')).toHaveText(/online/);
    await expect(messages(maria.page)).toHaveCount(3);
    await expect(messages(maria.page).last()).toContainText('Mesaj de la Maria');
    // camera apare în „Camerele mele” pe pagina principală
    await maria.page.goto('/#/');
    await expect(maria.page.getByRole('link', { name: /Familia Test/ })).toBeVisible();
  } finally {
    await maria.ctx.close();
  }
});

test('HTML din mesaje este afișat ca text, nu executat (XSS)', async ({ browser }) => {
  const eve = await joinAs(browser, room.link, PASSWORD, '<b>Eve</b>');
  try {
    let dialogShown = false;
    eve.page.on('dialog', (d) => {
      dialogShown = true;
      void d.dismiss();
    });
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    await sendMessage(eve.page, payload);
    await expect(messages(eve.page).last()).toContainText(payload);
    await expect(eve.page.locator('.messages img, .messages script, .messages b')).toHaveCount(0);
    expect(dialogShown).toBe(false);
  } finally {
    await eve.ctx.close();
  }
});

test('administratorul scrie în cameră și apare cu insigna admin', async ({ browser }) => {
  const dan = await joinAs(browser, room.link, PASSWORD, 'Dan');
  try {
    await admin.goto('/#/admin/camere');
    await admin.getByTestId('admin-room').filter({ hasText: 'Familia Test' }).getByRole('link', { name: 'Deschide chat' }).click();
    await expect(admin.getByTestId('conn-status')).toHaveText(/online/);
    await sendMessage(admin, 'Mesaj de la administrator');
    const last = messages(dan.page).last();
    await expect(last).toContainText('Mesaj de la administrator');
    await expect(last.locator('.badge')).toHaveText('admin');
  } finally {
    await dan.ctx.close();
  }
});

test('mesajele scrise fără conexiune sunt trimise automat la reconectare', async ({ browser }) => {
  // Conexiunea WebSocket trece printr-un proxy de test care poate simula o cădere de rețea.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let block = false;
  let cut: () => void = () => undefined;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (block) return ws.close({ code: 4000, reason: 'retea cazuta' });
    const server = ws.connectToServer();
    cut = () => {
      block = true;
      server.close();
      ws.close({ code: 4000, reason: 'retea cazuta' });
    };
  });
  await page.goto(room.link.replace(/^https?:\/\/[^/]+/, ''));
  await page.getByLabel('Parola camerei').fill(PASSWORD);
  await page.getByLabel('Numele tău').fill('Radu');
  await page.getByRole('button', { name: 'Intră în cameră' }).click();
  await expect(page.getByTestId('conn-status')).toHaveText(/online/);

  cut();
  await expect(page.getByTestId('conn-status')).toHaveText(/Deconectat|reconectează/);
  await sendMessage(page, 'Scris fără internet');
  await expect(page.getByTestId('pending-message')).toContainText('Scris fără internet');

  block = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('conn-status')).toHaveText(/online/, { timeout: 15_000 });
  await expect(page.getByTestId('pending-message')).toHaveCount(0);
  await expect(messages(page).last()).toContainText('Scris fără internet');

  // trimis o singură dată, deși a fost retrimis după reconectare
  await page.reload();
  await expect(page.getByTestId('conn-status')).toHaveText(/online/);
  await expect(messages(page).filter({ hasText: 'Scris fără internet' })).toHaveCount(1);
  await ctx.close();
});

test('administratorul revocă un participant, care este deconectat imediat', async ({ browser }) => {
  const gelu = await joinAs(browser, room.link, PASSWORD, 'Gelu');
  try {
    await admin.goto('/#/admin/camere');
    const row = admin.getByTestId('admin-room').filter({ hasText: 'Familia Test' });
    await row.getByRole('button', { name: 'Participanți' }).click();
    await row.getByTestId('participant-row').filter({ hasText: 'Gelu' }).getByRole('button', { name: 'Revocă accesul' }).click();
    await admin.getByRole('dialog').getByRole('button', { name: 'Revocă' }).click();
    await expect(row.getByTestId('participant-row').filter({ hasText: 'Gelu' })).toContainText('revocat');

    await expect(gelu.page.getByText('Accesul tău în această cameră a fost revocat')).toBeVisible();
    await expect(gelu.page.getByRole('textbox', { name: 'Scrie un mesaj' })).toBeHidden();
  } finally {
    await gelu.ctx.close();
  }
});

test('ștergerea camerei cere confirmarea codului', async () => {
  const temp = await createRoom(admin, 'De șters', 'parola-temporara-1');
  const row = admin.getByTestId('admin-room').filter({ hasText: 'De șters' });
  await row.getByRole('button', { name: 'Șterge' }).click();
  const dlg = admin.getByRole('dialog');
  await dlg.getByRole('textbox').fill('cod-gresit');
  await dlg.getByRole('button', { name: 'Șterge definitiv' }).click();
  await expect(dlg.getByRole('alert')).toHaveText('Codul nu corespunde.');
  await dlg.getByRole('textbox').fill(temp.code);
  await dlg.getByRole('button', { name: 'Șterge definitiv' }).click();
  await expect(admin.getByTestId('admin-room').filter({ hasText: 'De șters' })).toHaveCount(0);
});

test('panoul de stare arată arhiva locală', async () => {
  await admin.goto('/#/admin/stare');
  await expect(admin.getByText('Mesaje arhivate', { exact: true })).toBeVisible();
  await expect(admin.getByText('Folderul arhivei', { exact: true })).toBeVisible();
});

test('pagina publicată are Content-Security-Policy strict', async ({ page }) => {
  await page.goto('/');
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("default-src 'none'");
});

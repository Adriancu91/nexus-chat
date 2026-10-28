import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createRoom, enrollAdmin } from './helpers.ts';

/**
 * Apeluri pe serverul real (NEXUS + LiveKit), cu cameră și microfon simulate de Chrome.
 * Verifică și topologia: fiecare browser are conexiuni media doar către serverul media,
 * niciodată direct către celălalt participant.
 */
const LIVEKIT = fileURLToPath(new URL('../../.tools/livekit/livekit-server.exe', import.meta.url));
test.skip(!existsSync(LIVEKIT) && !process.env.CI_LIVEKIT, 'livekit-server nu este disponibil');
test.describe.configure({ mode: 'serial' });

const PASSWORD = 'apel-de-test-55';
const LIVEKIT_MEDIA_PORTS = [7881, 7882];

/** Ține evidența conexiunilor WebRTC create de pagină, pentru verificarea topologiei. */
const TRACK_PCS = `
  window.__pcs = [];
  const Original = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) { const pc = new Original(...args); window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = Original.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Original);
`;

async function participant(ctx: BrowserContext, link: string, name: string): Promise<Page> {
  await ctx.addInitScript(TRACK_PCS);
  const page = await ctx.newPage();
  await page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await page.getByLabel('Parola camerei').fill(PASSWORD);
  await page.getByLabel('Numele tău').fill(name);
  await page.getByRole('button', { name: 'Intră în cameră' }).click();
  await expect(page.getByTestId('conn-status')).toHaveText(/online/);
  return page;
}

async function joinCall(page: Page, viaBanner = false) {
  if (viaBanner) await page.getByTestId('call-banner').getByRole('button', { name: 'Intră' }).click();
  else await page.getByRole('button', { name: 'Apel audio-video' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Intră în apel' }).click();
  await expect(page.getByRole('dialog', { name: /Apel în/ })).toBeVisible();
}

/** Adresele (ip:port) cu care comunică efectiv conexiunile WebRTC ale paginii. */
async function mediaPeers(page: Page): Promise<{ address: string; port: number; protocol: string }[]> {
  return page.evaluate(async () => {
    const out: { address: string; port: number; protocol: string }[] = [];
    for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      const byId = new Map<string, any>();
      stats.forEach((s: any) => byId.set(s.id, s));
      stats.forEach((s: any) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) {
          const pair = byId.get(s.selectedCandidatePairId);
          const remote = pair && byId.get(pair.remoteCandidateId);
          if (remote) out.push({ address: remote.address ?? remote.ip, port: remote.port, protocol: remote.protocol });
        }
      });
    }
    return out;
  });
}

let adminCtx: BrowserContext;
let anaCtx: BrowserContext;
let ionCtx: BrowserContext;
let admin: Page;
let ana: Page;
let ion: Page;

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext();
  admin = await adminCtx.newPage();
  await enrollAdmin(admin, 'Laptop apeluri');
  const room = await createRoom(admin, 'Apel familie', PASSWORD);
  anaCtx = await browser.newContext();
  ionCtx = await browser.newContext();
  ana = await participant(anaCtx, room.link, 'Ana');
  ion = await participant(ionCtx, room.link, 'Ion');
});
test.afterAll(async () => {
  await Promise.all([adminCtx?.close(), anaCtx?.close(), ionCtx?.close()]);
});

test('Ana pornește un apel, Ion vede apelul în curs și intră; se văd și se aud reciproc', async () => {
  await joinCall(ana);
  await expect(ana.getByTestId('call-status')).toHaveText(/Aștepți/);
  await expect(ana.getByTestId('local-video')).toBeVisible();

  const banner = ion.getByTestId('call-banner');
  await expect(banner).toContainText('Apel în curs: Ana');
  await joinCall(ion, true);

  for (const page of [ana, ion]) {
    await expect(page.getByTestId('call-status')).toHaveText('2 în apel', { timeout: 15_000 });
    await expect(page.getByTestId('call-tile')).toHaveCount(2);
    const remote = page.getByTestId('remote-video');
    await expect(remote).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => remote.evaluate((v) => (v as HTMLVideoElement).videoWidth), { timeout: 15_000 }).toBeGreaterThan(0);
  }
  // sunetul celuilalt este primit (element audio atașat și pornit)
  await expect.poll(() => ana.locator('audio').count()).toBeGreaterThan(0);
});

test('topologie: media trece doar prin serverul media, nu direct între participanți', async () => {
  for (const page of [ana, ion]) {
    const peers = await mediaPeers(page);
    expect(peers.length).toBeGreaterThan(0);
    for (const p of peers) expect(LIVEKIT_MEDIA_PORTS).toContain(p.port);
    // cel mult două conexiuni (trimitere + primire), ambele către server
    const pcs = await page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((pc) => pc.connectionState !== 'closed').length);
    expect(pcs).toBeLessThanOrEqual(2);
  }
});

test('microfonul oprit se vede la ceilalți', async () => {
  await ana.getByRole('button', { name: 'Oprește microfonul' }).click();
  const anaTileAtIon = ion.getByTestId('call-tile').filter({ hasText: 'Ana' });
  await expect(anaTileAtIon.getByRole('img', { name: 'microfon oprit' })).toBeVisible();
  await ana.getByRole('button', { name: 'Pornește microfonul' }).click();
  await expect(anaTileAtIon.getByRole('img', { name: 'microfon oprit' })).toHaveCount(0);
});

test('camera oprită: tile cu inițiale în locul imaginii', async () => {
  await ion.getByRole('button', { name: 'Oprește camera' }).click();
  const ionTileAtAna = ana.getByTestId('call-tile').filter({ hasText: 'Ion' });
  await expect(ionTileAtAna.locator('video')).toHaveCount(0);
  await expect(ionTileAtAna.locator('.call-avatar')).toHaveText('I');
});

test('participantul revocat este scos imediat și din apel', async () => {
  await admin.goto('/#/admin/camere');
  const row = admin.getByTestId('admin-room').filter({ hasText: 'Apel familie' });
  await row.getByRole('button', { name: 'Participanți' }).click();
  await row.getByTestId('participant-row').filter({ hasText: 'Ion' }).getByRole('button', { name: 'Revocă accesul' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Revocă' }).click();

  await expect(ion.getByRole('dialog', { name: /Apel în/ })).toHaveCount(0, { timeout: 15_000 });
  await expect(ana.getByTestId('call-status')).toHaveText(/Aștepți/, { timeout: 15_000 });
});

test('ieșirea din apel eliberează resursele și actualizează starea camerei', async () => {
  await ana.getByRole('button', { name: 'Închide apelul' }).click();
  await expect(ana.getByRole('dialog', { name: /Apel în/ })).toHaveCount(0);
  await expect
    .poll(() => ana.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((pc) => pc.connectionState !== 'closed').length))
    .toBe(0);
  await expect(ana.getByTestId('call-banner')).toBeHidden();
});

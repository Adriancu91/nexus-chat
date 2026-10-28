import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createRoom, enrollAdmin } from './helpers.ts';

/**
 * Apel prin releul TURN al serverului media (varianta folosită când porturile directe
 * nu sunt accesibile, ex. prin Tailscale Funnel). Al doilea backend de test are releul activ,
 * iar serverul îi spune clientului să trimită media DOAR prin releu.
 */
const LIVEKIT = fileURLToPath(new URL('../../.tools/livekit/livekit-server.exe', import.meta.url));
test.skip(!existsSync(LIVEKIT), 'livekit-server nu este disponibil');
test.describe.configure({ mode: 'serial' });

const RELAY_BACKEND = 'http://127.0.0.1:18789';
const RELAY_DATA = fileURLToPath(new URL('../.e2e-data-relay/data', import.meta.url));
const PASSWORD = 'apel-prin-releu-9';

const SETUP = `
  localStorage.setItem('nexus.backendUrl', '${RELAY_BACKEND}');
  window.__pcs = [];
  const Original = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) { const pc = new Original(...args); window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = Original.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Original);
`;

async function participant(ctx: BrowserContext, link: string, name: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await page.getByLabel('Parola camerei').fill(PASSWORD);
  await page.getByLabel('Numele tău').fill(name);
  await page.getByRole('button', { name: 'Intră în cameră' }).click();
  await expect(page.getByTestId('conn-status')).toHaveText(/online/);
  return page;
}

// PROBLEMĂ CUNOSCUTĂ (28.10.2026): a trecut o dată, apoi a eșuat 3/3. Pachetele dintre releul TURN și
// serverul media (același calculator) se pierd; cauza nu este încă identificată. Drumul direct
// (calls.spec.ts) funcționează. Vezi docs/ROADMAP.md, M5.
test.fixme('doi participanți se văd prin releul TURN; nicio conexiune directă', async ({ browser }) => {
  const ctxs = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  for (const c of ctxs) await c.addInitScript(SETUP);
  const [adminCtx, aCtx, bCtx] = ctxs as [BrowserContext, BrowserContext, BrowserContext];
  try {
    const admin = await adminCtx.newPage();
    await enrollAdmin(admin, 'Admin releu', RELAY_DATA);
    const room = await createRoom(admin, 'Apel prin releu', PASSWORD);
    const a = await participant(aCtx, room.link, 'Maria');
    const b = await participant(bCtx, room.link, 'Dan');

    for (const [page, viaBanner] of [[a, false], [b, true]] as const) {
      if (viaBanner) await page.getByTestId('call-banner').getByRole('button', { name: 'Intră' }).click();
      else await page.getByRole('button', { name: 'Apel audio-video' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Intră în apel' }).click();
    }
    for (const page of [a, b]) {
      await expect(page.getByTestId('call-status')).toHaveText('2 în apel', { timeout: 20_000 });
      const remote = page.getByTestId('remote-video');
      await expect.poll(() => remote.evaluate((v) => (v as HTMLVideoElement).videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);

      const pairs = await page.evaluate(async () => {
        const out: { localType: string; remotePort: number }[] = [];
        for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs) {
          if (pc.connectionState === 'closed') continue;
          const stats = await pc.getStats();
          const byId = new Map<string, any>();
          stats.forEach((s: any) => byId.set(s.id, s));
          stats.forEach((s: any) => {
            if (s.type !== 'transport' || !s.selectedCandidatePairId) return;
            const pair = byId.get(s.selectedCandidatePairId);
            out.push({ localType: byId.get(pair.localCandidateId)?.candidateType, remotePort: byId.get(pair.remoteCandidateId)?.port });
          });
        }
        return out;
      });
      expect(pairs.length).toBeGreaterThan(0);
      // Fiecare conexiune trece prin releu (candidat local „relay”) către serverul media.
      for (const p of pairs) {
        expect(p.localType).toBe('relay');
        expect([17881, 17882]).toContain(p.remotePort);
      }
    }
  } finally {
    await Promise.all(ctxs.map((c) => c.close()));
  }
});

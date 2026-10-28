# Acces din internet — ghid pas cu pas

Rezultatul final: familia deschide pe telefon o pagină de pe GitHub Pages, iar pagina vorbește
criptat (HTTPS/WSS) cu laptopul tău prin **Tailscale Funnel**. În router nu se deschide niciun port.

```
Telefon (4G / Wi-Fi)                                   Laptopul tău
  │  1. descarcă pagina (HTML/JS, fără date)               │
  ├──────────────► GitHub Pages                            │
  │  2. mesaje, fișiere: HTTPS + WSS                       │
  └──────────────► releu Tailscale ──(criptat)──► tailscaled ──► NEXUS server (127.0.0.1:8787)
                     vede doar metadate          decriptează TLS aici, pe laptop
```

## Stare (28.10.2026, după mutare)
- **Serverul rulează pe workstation-ul DESKTOP-BR58S2C** (port 8788), adresa publică
  `https://desktop-br58s2c.tailb799d9.ts.net`. Vezi [MUTARE-WORKSTATION.md](MUTARE-WORKSTATION.md).
  Secțiunile de mai jos descriu configurarea inițială de pe laptop.

## Stare inițială (laptop)
- **Funnel este pornit**: `https://kronos.tailb799d9.ts.net` → serverul NEXUS (`127.0.0.1:8787`). Doar acest port este expus.
- **Pagina este publicată**: <https://adriancu91.github.io/nexus-chat/> (ramura `gh-pages`), cu `config.json` către adresa de mai sus.
- Verificări din exterior trecute: 12/12 (`npm run check:external`), plus prin releul public Funnel: HTTPS valid, CORS, preflight, refuz origine străină, 401 fără sesiune, WebSocket.
- **Rămâne de făcut (tu):** înregistrarea dispozitivului de administrator, testul de pe telefon pe date mobile (Android și iPhone).
- **Rămâne de făcut (eu, după înregistrarea ta):** verificarea antetului cu IP-ul real (pasul 4).

## Ce exista deja pe laptop
Am verificat pe 28.10.2026:
- Tailscale 1.104.2 este instalat și autentificat; laptopul se numește `kronos`.
- Contul are HTTPS și Funnel permise (porturile 443, 8443, 10000).
- **Funnel este oprit.** Nimic nu este expus în acest moment.

Adresa publică va fi: `https://kronos.tailb799d9.ts.net`
(numele laptopului și al rețelei Tailscale apar în adresă; laptopul poate fi redenumit din consola
Tailscale, dacă vrei alt nume).

## Decizie necesară: un domeniu separat pentru NEXUS

Toate site-urile GitHub Pages ale contului `Adriancu91` stau pe **aceeași origine**,
`https://adriancu91.github.io`. Acum sunt publicate acolo: Ai-personal, Coin-pet-go, Cybernet-game,
farm-planet, reffining_calculator, taptap.

Browserul tratează originea ca pe un singur site. Orice script dintr-unul din acele proiecte (sau
dintr-o bibliotecă pe care o încarcă) ar putea:
- citi sesiunile participanților NEXUS din `localStorage`;
- folosi cheia de administrator din `IndexedDB` pentru a semna o autentificare (cheia nu poate fi
  copiată, dar poate fi *folosită* de orice cod de pe aceeași origine).

| Variantă | Ce faci tu | Cost | Recomandare |
|---|---|---|---|
| **A. Organizație GitHub separată** | Creezi gratuit o organizație (ex. `nexus-familie`) și muți repository-ul în ea. Adresa devine `https://nexus-familie.github.io/nexus-chat/` — originea e doar a NEXUS. | 0 € | **Recomandat** |
| B. Domeniu propriu | Cumperi un domeniu (ex. `chat.familia-ta.ro`) și îl configurezi pentru GitHub Pages. | ~10 €/an | Bun, mai multă configurare |
| C. Rămâi pe `adriancu91.github.io` | Nimic. | 0 € | Nu recomand: securitatea NEXUS ar depinde de toate celelalte proiecte |

**Decizia ta (28.10.2026): varianta C — risc acceptat.** Consecință practică: nu adăuga în celelalte
proiecte Pages scripturi de la terți necunoscuți și nu publica cod netestat acolo. Poți trece oricând la
varianta A; trebuie doar schimbată originea (`npm run config`) și republicată pagina.

## Pașii, după aprobarea ta

Comenzile marcate *(eu)* le pot rula eu, la cererea ta; restul necesită contul tău.
Pe acest laptop, comenzile npm din PowerShell se scriu `npm.cmd …` (politica de execuție blochează `npm.ps1`).

1. **(tu, doar pentru varianta A)** Creează organizația: github.com → „+” → *New organization* → *Free*.
   Apoi în repository: *Settings → General → Transfer ownership* către organizație.
2. **(eu)** Permite pagina publicată să vorbească cu serverul:
   ```bash
   npm run config -- --allow-origin https://ORIGINEA-ALEASA
   ```
3. **(eu)** Pornește serverul (`npm start`) și apoi Funnel:
   ```bash
   tailscale funnel --bg 8787
   ```
   `--bg` înseamnă că Funnel rămâne activ și după repornirea laptopului, până îl oprești.
4. **(eu)** Verific ce adresă IP vede serverul prin Funnel (`/api/admin/diagnostics/request`) și,
   dacă Tailscale trimite antetul `X-Forwarded-For`, activez limitarea pe IP-ul real:
   ```bash
   npm run config -- --trust-proxy x-forwarded-for
   ```
   Fără acest pas, toate cererile din internet par să vină de la laptop, iar limitarea încercărilor
   greșite de parolă s-ar aplica tuturor deodată.
5. **(eu, cu aprobarea ta)** Public pagina și activez GitHub Pages pe ramura `gh-pages`:
   ```bash
   npm run deploy:pages -- --backend https://kronos.tailb799d9.ts.net
   ```
6. **(eu)** Verificare automată din exterior:
   ```bash
   npm run check:external -- --backend https://kronos.tailb799d9.ts.net --origin https://ORIGINEA-ALEASA
   ```
7. **(tu)** Testul decisiv, pe telefon, **cu Wi-Fi-ul oprit** (date mobile):
   - [ ] pagina se deschide, fără avertismente de securitate;
   - [ ] Administrare: înregistrezi telefonul cu un cod din Administrare → Dispozitive (pe laptop);
   - [ ] creezi o cameră de test și intri în ea de pe alt telefon (al unui membru al familiei);
   - [ ] mesaje în ambele sensuri, o poză trimisă și descărcată;
   - [ ] pornești modul avion câteva secunde: mesajul scris între timp pleacă la revenire;
   - [ ] pe iPhone (Safari) și pe Android (Chrome).

## Oprire și revocare
- Oprire imediată a accesului din internet: `tailscale funnel --https=443 off`
  (sau `tailscale funnel reset`). Pagina de pe GitHub rămâne, dar nu mai ajunge la laptop.
- Laptopul trebuie să fie pornit și să nu intre în somn pentru ca ceilalți să poată scrie
  (Setări Windows → Sistem → Alimentare → „Când este conectat, intră în repaus după: Niciodată”).
- Revocarea unei persoane: Administrare → Camere → Participanți → Revocă accesul.

## Ce văd furnizorii

| Cine | Ce vede | Ce NU vede |
|---|---|---|
| Tailscale (releul Funnel) | IP-ul vizitatorilor, numele `kronos.tailb799d9.ts.net`, ora și volumul traficului | Conținutul: TLS se termină pe laptop |
| GitHub | Cine descarcă pagina statică (IP, browser) | Mesaje, fișiere, parole, sesiuni |
| Operatorul de internet / rețeaua Wi-Fi | Că telefonul vorbește cu Tailscale și GitHub | Conținutul (criptat) |
| Let's Encrypt | Certificatul pentru `kronos.tailb799d9.ts.net` apare în registrele publice de certificate | Nimic altceva |

## Ce NU acoperă M4
Apelurile audio-video (M5) au nevoie de UDP sau de o soluție separată — vezi
[CONECTIVITATE.md](CONECTIVITATE.md).

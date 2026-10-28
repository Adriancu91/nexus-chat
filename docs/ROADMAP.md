# Plan și stare

| Milestone | Conținut | Stare |
|---|---|---|
| M0 | Inspecție, arhitectură, riscuri, documentație | **Finalizat** |
| M1 | Backend: admin criptografic, camere, sesiuni, SQLite + migrații, mesaje în timp real, teste | **Finalizat** (41/41 teste) |
| M2 | Web Client responsive (română), intrare în cameră, chat, panou admin, reconectare, teste E2E | **Finalizat** (13/13 E2E) |
| M3 | Fișiere (upload/download, SHA-256, limite, spațiu pe disc), backup + restaurare testată, retenție, căutare (FTS5) | **Finalizat** (61/61 server, 20/20 E2E) |
| M4 | GitHub Pages + Tailscale Funnel, teste de pe rețele diferite | **În curs** — partea locală gata; așteaptă aprobările tale (vezi [ACCES-EXTERN.md](ACCES-EXTERN.md)) |
| M5 | Apeluri: semnalizare, mediasoup pe laptop, 1:1 apoi grup, verificarea topologiei | Planificat — risc ridicat (vezi CONECTIVITATE.md) |
| M6 | Aplicația Windows (Tauri): instalare, pornire/oprire, iconiță, backup, actualizare | Planificat |
| M7 | Audit de securitate, regresie, restaurare, documentație de operare, checklist lansare | Planificat |

Modificare de ordine: căutarea în istoric (cerută în UI) a fost mutată în M3, împreună cu arhiva,
deoarece necesită o migrație FTS5 și politica de retenție.

## Raport M1

**Implementat**
- Inițializarea administratorului cu cod de unică folosință; înrolare dispozitive cu chei ECDSA P-256;
  autentificare provocare-răspuns; revocare dispozitive; cod de recuperare local (`npm run admin:code`).
- Camere: creare/listare/modificare/închidere/redeschidere/ștergere (cu confirmare), doar de către
  administrator; parole scrypt; limită de participanți.
- Participanți: intrare cu cod + parolă + nume; sesiune legată de o cameră; revocare.
- Mesaje în timp real prin WebSocket: autentificare în primul mesaj, abonare, trimitere idempotentă,
  prezență, istoric paginat, sincronizare după reconectare (`afterSeq`).
- SQLite: WAL + synchronous=FULL, chei străine, migrații tranzacționale, refuz la downgrade.
- Jurnal administrativ; endpoint de stare (dimensiune arhivă, spațiu liber pe disc, conexiuni).
- Limitarea încercărilor (intrare cameră, autentificare admin, ritm mesaje).

**Testat** (`npm test`, 41 de teste, Windows 11 + Node 24.20): vezi lista din
[SECURITATE.md](SECURITATE.md#măsuri-implementate-în-m1-cu-teste) și `server/test/`.
Include persistența mesajelor după repornirea serverului.

**Neimplementat încă:** interfața web (deci nicio funcție nu este încă utilizabilă din browser
de un om), fișiere, backup, căutare, acces extern, apeluri, aplicația Windows.

**Riscuri rămase**
- Media prin laptop din exterior (M5) — nedovedit; posibil cost VPS.
- `node:sqlite` este „release candidate” în Node 24 (izolat în `server/src/db/`).
- Limitarea încercărilor este în memorie (se resetează la repornire).
- Repository-ul este **public**: orice secret comis ar fi expus. `.gitignore` exclude `data/`,
  `*.db`, `.env`; codurile și tokenurile se generează doar la rulare.

## Raport M2

**Implementat** (`web/`, TypeScript + Vite, fără framework; o singură pagină statică, publicabilă pe GitHub Pages)
- Acasă: „Camerele mele” (sesiunile salvate pe dispozitiv) și intrare cu cod sau link.
- Intrare în cameră: cod (precompletat din link), parolă, nume; erori clare în română.
- Chat: bule de mesaje în stilul unui grup de chat, nume colorat per participant, insignă admin,
  marcaje temporale, separatoare pe zile, link-uri, mesaje pe mai multe rânduri, „Încarcă mesaje mai
  vechi”, lista participanților online, ieșire din cameră (revocă sesiunea), număr de mesaje necitite
  în titlul filei.
- Conexiune: indicator (Se conectează / online / Deconectat), reconectare automată cu așteptare
  progresivă, coadă de mesaje scrise fără conexiune, retrimise fără dubluri, sincronizare după
  reconectare, oprire definitivă la revocare cu mesaj explicativ.
- Administrare: înregistrarea dispozitivului (cheie WebCrypto), camere (creare cu parolă sugerată,
  link de invitație, participanți + revocare, setări, închidere/redeschidere, ștergere cu
  confirmarea codului), dispozitive (adăugare telefon prin cod, revocare), jurnal, stare și arhivă.
- Setări: adresa serverului, verificată înainte de salvare.
- Responsive (telefon, tabletă, desktop), mod întunecat automat, ținte tactile ≥ 44 px,
  etichete accesibile, navigare cu tastatura.

**Testat**: `npm run test:e2e`, 13 teste Playwright pe serverul real și pe build-ul de producție
(Chrome desktop + profil de telefon Pixel 7). Capturi verificate manual: chat pe telefon și desktop,
mod întunecat, administrare, înrolare.

**Încă neimplementat (fără butoane inactive în interfață):** fișiere și descărcări, căutare în
istoric, backup/restaurare (M3; ecranul de stare spune explicit asta), apeluri (M5), notificări push.

**Riscuri rămase**
- Testat doar în Chrome (desktop + emulare telefon). Safari pe iPhone și Firefox nu au fost testate
  încă; vor fi verificate pe dispozitive reale în M4, când aplicația devine accesibilă din internet.
- Dacă datele site-ului sunt șterse din browser, cheia de administrator a acelui dispozitiv se pierde:
  se reînrolează cu un cod nou (de pe alt dispozitiv sau `npm run admin:code`).

## Raport M3

**Implementat**
- **Fișiere:** upload cu progres și anulare (buton, sau trage-și-plasează pe desktop), mesaj cu
  fișier și text opțional, descărcare autorizată, previzualizare pentru imagini JPEG/PNG/GIF/WebP
  verificate după conținut, panoul „Fișiere” al camerei.
  - Pe disc: `data/files/<aa>/<uuid>`, nume generat de server; SHA-256 calculat în timpul
    transferului; scriere în `tmp/` + `fsync` + redenumire atomică, apoi tranzacție SQLite.
  - Refuzate: programe și scripturi Windows (după extensie și după semnătura `MZ`, chiar deghizate).
  - Limite: 100 MB per fișier (`NEXUS_MAX_FILE_MB`), refuz dacă pe disc ar rămâne sub 1 GB,
    30 de upload-uri / 10 min per sesiune.
  - Ștergerea camerei sau retenția șterg și fișierele de pe disc. La pornire: curățarea
    transferurilor neterminate și a fișierelor fără înregistrare (după o cădere de curent).
- **Căutare** în istoricul camerei (SQLite FTS5): fără diacritice („maine” → „Mâine”), după prefix,
  inclusiv în numele fișierelor; termenii găsiți sunt evidențiați; clic pe rezultat → salt la mesaj.
- **Backup:** automat (implicit la 24 h, ultimele 7 copii) și manual („Fă backup acum”).
  Baza de date copiată consistent cu `VACUUM INTO` (merge cu serverul pornit); fișierele copiate o
  singură dată într-un depozit comun (incremental); manifest cu SHA-256 pentru tot; un backup apare
  doar după ce a fost scris complet. Verificare la cerere. Folder configurabil (disc extern).
- **Restaurare** (linia de comandă, cu serverul oprit): verifică întâi backup-ul complet, refuză
  dacă serverul rulează, construiește arhiva nouă separat și păstrează arhiva veche redenumită.
- **Retenție** configurabilă (pentru totdeauna / 1 an / 6 luni / 3 luni / 30 de zile), cu
  previzualizarea a ce se va șterge și confirmare.
- **Integritate:** `PRAGMA integrity_check`, chei străine și SHA-256 pentru fiecare fișier.
- **Blocarea arhivei:** un al doilea server pe aceeași arhivă este refuzat.

**Testat**
- `npm test`: 61 de teste. Include un ciclu real backup → ștergerea camerei → restaurare →
  pornirea serverului pe arhiva restaurată, cu mesajele, poza (octet cu octet) și sesiunile înapoi.
  Mai acoperă: backup corupt refuzat, comenzile din linia de comandă, izolarea fișierelor între
  camere, tipurile refuzate, retenția (inclusiv fișierele de pe disc și indexul de căutare),
  detectarea fișierelor lipsă sau corupte.
- `npm run test:e2e`: 20 de teste, dintre care 7 noi (upload → descărcare identică, previzualizare,
  refuz .exe, panoul de fișiere, căutare cu salt, backup și verificare, confirmarea retenției).

**Neimplementat**
- **Backup-ul nu este criptat.** Recomandare: disc extern cu BitLocker To Go (inclus în Windows 11
  Pro). Criptarea în aplicație ar cere o parolă de backup care, dacă se pierde, face backup-ul
  inutilizabil; o pot adăuga dacă vrei.
- Restaurarea din interfață (vine cu aplicația Windows, M6, care poate opri serverul).
- Miniaturi micșorate: previzualizarea descarcă imaginea întreagă.
- Retenția per cameră (acum este globală).

**Riscuri rămase**
- Backup-ul implicit e pe același disc cu arhiva; interfața avertizează și cere un disc extern.
- Un fișier de 100 MB este ținut în memorie de browser la descărcare (acceptabil pe telefoane
  moderne; pentru fișiere mai mari ar fi nevoie de descărcare directă prin link temporar).

## M4 — stare intermediară

**Gata (local, testat):** fișier de configurare pe laptop (`npm run config`), IP-ul real al clientului
în spatele proxy-ului (doar ultima adresă din `X-Forwarded-For`, doar de la proxy-ul local), diagnostic
pentru administrator, adresa serverului publicată în `config.json` lângă pagină, script de publicare pe
`gh-pages` cu verificarea conținutului (`npm run deploy:pages`), verificator extern
(`npm run check:external`), ghid pas cu pas. Teste: 69/69 server, 20/20 E2E.

**Publicat (cu aprobarea ta):** Funnel pornit pe portul 8787; pagina pe <https://adriancu91.github.io/nexus-chat/>.
Verificări din exterior trecute (HTTPS, CORS, autorizare, WSS), inclusiv prin releul public Funnel.

**Testat de proprietar (28.10.2026), telefon pe date mobile:** înregistrare administrator, creare cameră,
intrare de pe telefon, mesaje în ambele sensuri, trimiterea unei poze — funcționează; „se mișcă puțin
cam greu”.

**Măsurat:** prin releul Funnel o conexiune nouă durează 1,9–7,7 s (TLS prin Frankfurt), față de 7 ms local.
Mesajele merg pe WebSocket-ul deja deschis; încetineala se simte la încărcarea paginii, la upload-uri și la
previzualizări (care descarcă imaginea întreagă).

**Neverificat încă:** Safari/iOS, antetul IP prin Funnel (Diagnostic conexiune).

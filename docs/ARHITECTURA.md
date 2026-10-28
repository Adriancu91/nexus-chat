# Arhitectura NEXUS CHAT

## Pe scurt

```
 Telefon / laptop (browser)                         Laptopul gazdă (Windows 11)
 ┌───────────────────────────┐                     ┌──────────────────────────────────────────┐
 │ Web Client (static)       │  HTTPS + WSS        │ Desktop Host (Tauri)  ── pornește/oprește│
 │ găzduit pe GitHub Pages   │ ──────────────────► │   │                                      │
 │ fără secrete, fără arhivă │   prin tunel        │   ▼                                      │
 └───────────────────────────┘   securizat         │ Backend Node.js (server/)                │
            │                                      │   • API HTTP + WebSocket                 │
            │  WebRTC (DTLS-SRTP)                  │   • camere, sesiuni, autorizare          │
            └────────────────────────────────────► │   • semnalizare apeluri (M5)             │
                                                   │ Media server SFU (M5, mediasoup)         │
                                                   │ Arhivă locală: SQLite + fișiere pe disc  │
                                                   └──────────────────────────────────────────┘
```

GitHub găzduiește **doar** codul sursă și interfața statică. Nu stochează mesaje, fișiere,
parole sau sesiuni. Toate datele private stau pe laptopul gazdă.

## Componente

| Componentă | Tehnologie | Stare |
|---|---|---|
| Backend | Node.js 24 + TypeScript, `ws` | **M1 — implementat** |
| Arhivă | SQLite (`node:sqlite`, inclus în Node) + fișiere pe disc | **M1 + M3 — implementat** (căutare FTS5, backup, retenție) |
| Web Client | TypeScript + Vite, fără framework, română | **M2 — implementat** |
| Conectare externă | Tailscale Funnel (recomandat) — vezi [CONECTIVITATE.md](CONECTIVITATE.md) | M4 |
| Server media | mediasoup (SFU) pe laptop | M5 |
| Desktop Host | Tauri 2 (Rust) care rulează backend-ul ca proces separat | M6 |

## Decizii tehnice

### D1. Backend: Node.js + TypeScript, fără framework web
- Node 24 rulează TypeScript direct (eliminarea tipurilor), deci nu există pas de build în
  dezvoltare; `tsc` verifică tipurile.
- O singură dependență de execuție: `ws` (server WebSocket matur, fără dependențe). HTTP-ul folosește
  `node:http` cu un router de ~50 de linii: suprafață de atac mică, nimic ascuns.
- mediasoup (M5) este o bibliotecă Node.js, deci semnalizarea și SFU-ul stau în același proces.

### D2. SQLite prin `node:sqlite` (modulul inclus în Node)
- Evită module native compilate (`better-sqlite3`), care complică instalarea pe Windows.
- `journal_mode=WAL` + `synchronous=FULL`: o tranzacție confirmată supraviețuiește unei căderi de
  curent. Integritatea arhivei are prioritate față de viteză.
- `foreign_keys=ON`, migrații versionate în `server/src/db/migrations.ts`, fiecare într-o tranzacție;
  serverul refuză o bază de date cu schemă mai nouă decât el (protecție la downgrade).
- Mesajele au `id` UUID și `seq` crescător (pentru sincronizare după reconectare).
- Riscul: `node:sqlite` este marcat „release candidate” în Node 24. API-ul folosit este minim
  (`prepare/run/get/all/exec`), deci o eventuală migrare la `better-sqlite3` ar fi locală, în `db/`.

### D3. Autentificarea administratorului: chei criptografice per dispozitiv
Nu există parolă de administrator. Fiecare dispozitiv al administratorului (laptop, telefon)
generează în browser o pereche de chei ECDSA P-256 cu WebCrypto (cheia privată ne-exportabilă,
păstrată în IndexedDB). Serverul păstrează doar cheia publică. Autentificarea = semnarea unui nonce
aleator, de unică folosință, valabil 60 s. Detalii în [SECURITATE.md](SECURITATE.md).

### D4. Participanții nu au conturi
Intrarea = cod cameră + parolă cameră + nume ales. Rezultatul este o sesiune legată de **o singură
cameră**. Parola camerei nu dă niciodată drepturi de administrator.

### D5. Tokenuri bearer, nu cookie-uri
Clientul este pe `github.io`, serverul pe alt domeniu. Cookie-urile ar fi cookie-uri terțe
(blocate de Safari/iOS). Tokenul se trimite în antetul `Authorization` (HTTP) și în primul mesaj
WebSocket (nu în URL). Consecințe: CSRF nu se aplică; riscul principal devine XSS, tratat prin
CSP strict în client (M2) și afișarea textului mesajelor exclusiv ca text.

### D6. Serverul ascultă doar pe 127.0.0.1
Implicit backend-ul nu este accesibil nici măcar din rețeaua locală. Accesul extern se face printr-un
tunel care se conectează din interior spre exterior (nu se deschid porturi în router).

### D7. Desktop Host: Tauri, nu Electron
Tauri produce un instalator mic (~10 MB vs ~150 MB), nu cere drepturi de administrator (instalare
per utilizator) și oferă iconiță în zona de notificare. Backend-ul Node rulează ca proces-copil
(„sidecar”), deci aplicația desktop doar îl pornește, îl oprește și îi afișează starea. Costul: Rust
în proiect (deja instalat pe laptop: rustc 1.99).

## Structura directoarelor

```
nexus-chat/
├── server/                 Backend Node.js (M1+)
│   ├── src/
│   │   ├── app.ts          compunere: HTTP + WebSocket + bază de date
│   │   ├── main.ts         punct de intrare (npm start)
│   │   ├── config.ts       configurare (variabile de mediu, limite)
│   │   ├── db/             SQLite, migrații, tranzacții
│   │   ├── crypto/         parole (scrypt), tokenuri, semnături ECDSA
│   │   ├── services/       logica: admin, sesiuni, camere, mesaje, audit, limitare
│   │   ├── http/           router, rute, CORS, citire JSON
│   │   ├── ws/             hub WebSocket (timp real, prezență)
│   │   └── cli/            unelte locale (cod de înrolare de recuperare)
│   └── test/               teste node:test (unitare + integrare + securitate)
├── web/                    Web Client (M2)
│   ├── src/
│   │   ├── main.ts         rutare (#/…), compatibilă cu GitHub Pages
│   │   ├── realtime.ts     WebSocket: reconectare, coadă de mesaje, sincronizare
│   │   ├── adminAuth.ts    cheia de administrator (WebCrypto + IndexedDB)
│   │   ├── dom.ts          construire DOM fără innerHTML (anti-XSS)
│   │   └── views/          ecrane: acasă, intrare, chat, administrare, setări
│   └── e2e/                teste Playwright pe serverul real
├── desktop/                Aplicația Windows Tauri (M6)
├── docs/                   documentație
└── .github/workflows/      CI
```

## Fluxuri de date

### Mesaje (implementat în M1)
1. Clientul deschide `wss://…/ws`; serverul verifică `Origin` față de lista aprobată.
2. Primul mesaj: `{type:"auth", token}`. Sesiunea este verificată în SQLite (expirare, revocare,
   participant revocat, cameră închisă).
3. `{type:"subscribe", roomId, afterSeq?}` → autorizare pe cameră → istoricul lipsă.
4. `{type:"send", roomId, body, clientMsgId}` → sesiunea este **re-verificată**, autorizarea pe cameră
   este re-verificată, textul este validat, mesajul este **salvat în tranzacție**, apoi distribuit
   abonaților camerei. `clientMsgId` face retrimiterea idempotentă.
5. După reconectare sau repornirea serverului, `subscribe` cu `afterSeq` aduce exact mesajele lipsă.

### Fișiere (M3)
1. Browserul trimite fișierul ca flux binar (`POST /api/rooms/:id/files`), numele în antetul `X-File-Name`.
2. Serverul verifică sesiunea, camera, dimensiunea, spațiul liber pe disc și limita de ritm.
3. Conținutul se scrie în `data/tmp/`, cu SHA-256 calculat pe parcurs, apoi `fsync`.
4. Tipul este stabilit din extensie **și** din primii octeți; programele sunt refuzate.
5. Fișierul este mutat atomic în `data/files/<aa>/<uuid>`; metadatele și mesajul se salvează într-o tranzacție.
6. Mesajul este distribuit prin WebSocket; descărcarea (`GET /api/files/:id`) verifică din nou accesul la cameră.

Căile de pe disc provin exclusiv din baza de date; numele trimis de utilizator este doar afișat.

### Backup și restaurare (M3)
```
backups/
  store/<aa>/<uuid>            fișierele, copiate o singură dată (incremental)
  snapshots/nexus-<dată>/      nexus.db (VACUUM INTO) + manifest.json (SHA-256 pentru tot)
```
Restaurarea (`npm run restore -- <nume>`) verifică manifestul, construiește arhiva într-un folder separat,
apoi o pune în locul celei vechi, care este doar redenumită.

### Apeluri (M5)
Descrise în [CONECTIVITATE.md](CONECTIVITATE.md).

## Politica de istoric
- Mesajele, fișierele și metadatele sunt păstrate pentru totdeauna, implicit. Administratorul poate
  alege o perioadă de păstrare (30 de zile – 1 an); ce e mai vechi se șterge automat (verificare la 10 min).
- Ștergerea unei camere șterge mesajele și fișierele ei. Backup-urile existente nu sunt modificate
  de retenție; dispar când sunt înlocuite de copii mai noi.
- Apelurile nu sunt înregistrate. O eventuală înregistrare va fi o funcție separată, vizibilă
  tuturor participanților, controlată explicit.
- Jurnalul administrativ (`audit_log`) păstrează acțiunile administrative, fără parole, tokenuri
  sau conținutul mesajelor.

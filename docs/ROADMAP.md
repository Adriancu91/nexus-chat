# Plan și stare

| Milestone | Conținut | Stare |
|---|---|---|
| M0 | Inspecție, arhitectură, riscuri, documentație | **Finalizat** |
| M1 | Backend: admin criptografic, camere, sesiuni, SQLite + migrații, mesaje în timp real, teste | **Finalizat** (41/41 teste) |
| M2 | Web Client responsive (română), intrare în cameră, chat, panou admin, reconectare, teste E2E | Următorul |
| M3 | Fișiere (upload/download, SHA-256, limite, spațiu pe disc), backup + restaurare testată, retenție, căutare (FTS5) | Planificat |
| M4 | GitHub Pages + Tailscale Funnel, teste de pe rețele diferite | Planificat — necesită aprobarea ta pentru publicare |
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

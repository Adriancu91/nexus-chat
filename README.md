# NEXUS CHAT

Aplicație privată de comunicare pentru familie și prieteni. Serverul și arhiva rulează pe laptopul
proprietarului (Windows 11); interfața web va fi publicată pe GitHub Pages.

> **Stare:** M4 finalizat — chat, fișiere, căutare, backup, acces din internet (GitHub Pages + Tailscale Funnel).
> Serverul rulează pe workstation-ul pornit 24/7. Apelurile (M5) nu există încă.
> Vezi [docs/ROADMAP.md](docs/ROADMAP.md).

## Documentație
- [Arhitectură și decizii](docs/ARHITECTURA.md)
- [Securitate și model de încredere](docs/SECURITATE.md)
- [Acces din internet — ghid pas cu pas](docs/ACCES-EXTERN.md)
- [Conectare din exterior și apeluri](docs/CONECTIVITATE.md)
- [API](docs/API.md)
- [Plan și stare](docs/ROADMAP.md)

## Pornire rapidă (dezvoltare)

Cerințe: [Node.js 24](https://nodejs.org/) sau mai nou.

```bash
npm install
npm test
npm start
```

Într-un al doilea terminal, interfața web:

```bash
npm run dev:web
```

Apoi deschide <http://localhost:5173> pe laptop.

1. La prima pornire serverul afișează un **cod de inițializare a administratorului**. Nu-l trimite
   nimănui. În pagină: **Administrare** (pictograma scut) → introdu codul → laptopul devine dispozitiv
   de administrator.
2. **Camere** → creează o cameră → copiază link-ul și parola.
3. Participanții deschid link-ul, introduc parola și un nume.

Teste end-to-end (pornesc singure serverul și pagina, folosesc Chrome-ul instalat):

```bash
npm run test:e2e
```

Serverul ascultă doar pe `127.0.0.1:8787`. Arhiva se află în `%LOCALAPPDATA%\NexusChat\data`.

| Variabilă | Implicit | Rol |
|---|---|---|
| `NEXUS_PORT` | `8787` | portul local |
| `NEXUS_DATA_DIR` | `%LOCALAPPDATA%\NexusChat\data` | folderul arhivei |
| `NEXUS_ALLOWED_ORIGINS` | `http://localhost:5173,…` | originile web permise (separate prin virgulă) |
| `NEXUS_TRUST_PROXY_HEADER` | — | antetul cu IP-ul real al clientului, doar în spatele unui proxy de încredere |

Oprire: `Ctrl+C` (închide arhiva în siguranță).

Recuperare acces administrator (pe laptop): `npm run admin:code`.

## Backup și restaurare

Serverul face automat un backup verificat la 24 de ore (configurabil în **Administrare → Stare și
arhivă**, unde există și butonul „Fă backup acum”). Implicit backup-urile stau în
`%LOCALAPPDATA%\NexusChat\backups` — **pe același disc**; alege un disc extern în „Setări backup”.

Restaurare (cu serverul oprit):

```bash
npm run backup -- --list
```

```bash
npm run restore -- nexus-20261028-194757-461
```

Arhiva curentă nu este ștearsă, ci redenumită `data.inainte-de-restaurare-…`. Backup-ul este
verificat complet (SHA-256) înainte de a fi folosit. Backup-urile **nu sunt criptate**: folosește
BitLocker To Go pe discul extern.

## Ce nu face (intenționat)
- Nu stochează nimic în cloud sau pe GitHub.
- Nu are criptare end-to-end: administratorul poate citi arhiva de pe laptopul său.

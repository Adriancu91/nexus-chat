# NEXUS CHAT

Aplicație privată de comunicare pentru familie și prieteni. Serverul și arhiva rulează pe laptopul
proprietarului (Windows 11); interfața web va fi publicată pe GitHub Pages.

> **Stare:** M2 finalizat — backend și interfață web funcționale și testate, **doar pe laptop**
> (accesul din internet vine în M4). Fișiere, backup și apeluri nu există încă.
> Vezi [docs/ROADMAP.md](docs/ROADMAP.md).

## Documentație
- [Arhitectură și decizii](docs/ARHITECTURA.md)
- [Securitate și model de încredere](docs/SECURITATE.md)
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

## Ce nu face (intenționat)
- Nu stochează nimic în cloud sau pe GitHub.
- Nu are criptare end-to-end: administratorul poate citi arhiva de pe laptopul său.

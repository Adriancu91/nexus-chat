# Mutarea serverului de pe laptop pe workstation

De pe laptopul `kronos` (4G) pe workstation-ul `DESKTOP-BR58S2C` (cablu, pornit 24/7).
Durată estimată: 15–20 minute, din care chatul este indisponibil ~10 minute (pașii 1–7).

**Ce nu se schimbă pentru familie:** link-ul paginii, camerele, parolele, istoricul, fișierele.
Sesiunile din telefoane și dispozitivele de administrator trec singure pe noua adresă
(`previousBackendUrls` din `config.json`, testat E2E), deci nu trebuie reintrat sau reînregistrat.

## Pregătit deja
- Workstation: Node 24 (fără administrator), proiectul în `C:\NexusChat\nexus-chat`, 70/70 teste.
- `scripts/windows/start-nexus.cmd`: pornește serverul și îl repornește dacă se oprește; jurnal în
  `%LOCALAPPDATA%\NexusChat\logs\server.log`.
- `scripts/windows/install-autostart.cmd`: pornire automată la autentificarea în Windows (folderul
  Startup al utilizatorului, fără drepturi de administrator). Condiție: utilizatorul rămâne logat pe
  workstation; după o repornire Windows fără autentificare, serverul nu pornește până la login.

## Pași

| # | Unde | Cine | Comandă / acțiune |
|---|---|---|---|
| 0 | workstation | sesiunea Kronos | `git pull` în `C:\NexusChat\nexus-chat`, `npm.cmd ci`, `npm.cmd test` |
| 1 | laptop | eu (tab terminal) | oprește serverul (Ctrl+C în tab-ul „NEXUS server”) |
| 2 | laptop | eu | `npm.cmd run backup` apoi `npm.cmd run backup -- --verify <nume>` |
| 3 | laptop | eu | arhivează folderul `%LOCALAPPDATA%\NexusChat\backups` într-un `.zip` |
| 4 | laptop → workstation | eu | `tailscale file cp <zip> desktop-br58s2c:` (criptat, direct prin Tailscale, fără cloud) |
| 5 | workstation | sesiunea Kronos | `tailscale file get C:\NexusChat\import`, dezarhivare, `npm.cmd run restore -- <nume> --backup-dir C:\NexusChat\import\backups` (verifică SHA-256 înainte) |
| 6 | workstation | sesiunea Kronos | `npm.cmd run config -- --allow-origin https://adriancu91.github.io`, `scripts\windows\install-autostart.cmd`, pornirea serverului, `tailscale funnel --bg 8788` (vezi „Rezultat”: portul 8787 e ocupat pe workstation) |
| 7 | laptop | eu | `tailscale funnel --https=443 off` |
| 8 | laptop | eu | `npm run deploy:pages -- --backend https://desktop-br58s2c.tailb799d9.ts.net --previous https://kronos.tailb799d9.ts.net` |
| 9 | laptop | eu | `npm run check:external -- --backend https://desktop-br58s2c.tailb799d9.ts.net --origin https://adriancu91.github.io` |
| 10 | telefon | tu | deschizi pagina: ești încă în cameră și administrator; trimiți un mesaj și o poză |

## Dacă ceva nu merge
- **Înainte de pasul 8:** pornim din nou serverul pe laptop (`npm.cmd start`) și Funnel
  (`tailscale funnel --bg 8787`). Pagina indică încă laptopul, deci nimeni nu observă nimic.
- **După pasul 8:** republicăm pagina cu `--backend https://kronos.tailb799d9.ts.net`.
- Arhiva de pe laptop **nu este ștearsă**; rămâne ca rezervă până confirmi că totul merge.

## După mutare
- Serverul de pe laptop **nu se mai pornește** (două servere ar avea istorice diferite).
- Pe workstation: Administrare → Stare și arhivă → „Diagnostic conexiune”, pentru IP-ul real prin Funnel.
- Backup-ul automat rulează pe workstation; recomandat un al doilea disc acolo.

## Rezultat (28.10.2026, ~22:00)

Mutarea a reușit. Serverul rulează pe workstation, iar laptopul nu mai servește nimic.

- Restaurare `nexus-20261028-214646-197`: toate amprentele SHA-256 verificate.
- **Port 8788 pe workstation**, nu 8787: portul 8787 e folosit acolo de interfața Kronos AI. Setat în
  `%LOCALAPPDATA%NexusChatconfig.json` (`"port": 8788`). Funnel: `https://desktop-br58s2c.tailb799d9.ts.net` →
  `http://127.0.0.1:8788`. **Nu porni niciodată Funnel pe 8787 pe workstation**: ar expune interfața Kronos.
- Pornire automată: `%APPDATA%MicrosoftWindowsStart MenuProgramsStartupNexusChat-server.cmd`.
- Taildrop pe Windows salvează automat fișierele primite în Downloads (`tailscale file get` găsește coada goală).
- Pagina republicată cu `previousBackendUrls` = adresa laptopului. Verificări din exterior: 12/12; prin releul
  public o cerere durează ~0,8 s (de pe laptop 2–8 s).
- Funnel pe laptop: oprit. Arhiva de pe laptop: păstrată ca rezervă, nu se mai pornește.

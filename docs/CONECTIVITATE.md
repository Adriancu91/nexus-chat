# Conectare din afara rețelei de acasă

Status: **analiză (M0)**. Nimic din acest document nu este încă configurat sau testat.
Implementarea și testele de pe rețele diferite sunt în M4 (chat) și M5 (apeluri).

## Cerințe
- Pagina de pe GitHub Pages este HTTPS → backend-ul trebuie să fie HTTPS/WSS cu certificat valid
  (browserele blochează conținutul mixt).
- Fără porturi deschise inutil în router; funcționează pe 4G/5G și Wi-Fi; accesul se poate opri.
- Istoricul rămâne pe laptop.

## Opțiuni pentru chat (HTTPS + WSS)

| Opțiune | Porturi deschise | Unde se termină TLS | Ce vede furnizorul | Cost | Dificultate |
|---|---|---|---|---|---|
| **Tailscale Funnel** | Niciunul (conexiune de ieșire) | **Pe laptop** | IP-urile vizitatorilor, numele `*.ts.net` (SNI), volumul și ora traficului. **Nu** vede conținutul. | Gratuit (plan personal) | Mică: instalare + 2 comenzi |
| Cloudflare Tunnel | Niciunul | La Cloudflare | **Tot traficul în clar** (Cloudflare decriptează și re-criptează), inclusiv mesaje și tokenuri | Gratuit, dar necesită un domeniu propriu | Medie |
| Port forwarding + DNS dinamic + Let's Encrypt | 443 deschis spre laptop | Pe laptop | Nimic (doar ISP-ul vede metadate) | Gratuit | Mare; laptopul expus direct; nu merge în spatele CGNAT |
| VPS propriu + tunel WireGuard | Doar pe VPS | Pe laptop (dacă VPS-ul doar redirecționează TCP) | Furnizorul VPS vede metadate | ~4–5 €/lună | Mare |

### Recomandare: Tailscale Funnel
- Certificat valid automat pentru `<laptop>.<tailnet>.ts.net`.
- TLS este decriptat **pe laptop**, deci conținutul mesajelor nu este vizibil furnizorului —
  spre deosebire de Cloudflare Tunnel, unde ar fi.
- Oprire instantanee: `tailscale funnel off` (sau din aplicația desktop, în M6).
- Participanții **nu** instalează nimic; deschid pagina GitHub Pages ca orice site.
- Limitări de verificat în M4: lățimea de bandă a Funnel (nedocumentată oficial ca valoare fixă),
  latența prin releele Tailscale.

## Apelurile audio-video: riscul principal al proiectului

Cerința: fluxurile media trec **efectiv prin laptop** (SFU pe laptop, nu peer-to-peer).
Problema: WebRTC transportă media prin **UDP** (ideal) sau TCP, direct către adresa SFU-ului.
Un tunel HTTPS nu transportă UDP.

| Variantă | Cum ajunge media la laptop | Avantaje | Riscuri |
|---|---|---|---|
| A. ICE-TCP prin Funnel (TCP brut, port 10000 sau 8443) | Funnel redirecționează TCP către portul TCP al mediasoup | Zero porturi deschise, zero cost | Nedovedit: mediasoup trebuie să anunțe adresa publică Funnel; TCP peste relee = latență mai mare, calitate scăzută la pierderi de pachete |
| B. VPS + WireGuard, redirecționare UDP | VPS-ul primește UDP și îl trimite prin WireGuard la laptop; SFU-ul rămâne pe laptop | Calitate bună (UDP), funcționează pe orice rețea | Cost lunar, configurare mai complexă |
| C. Port forwarding UDP în router | Direct | Cea mai bună calitate | Expune porturi; nu merge sub CGNAT (frecvent la operatorii mobili/fibră) |
| D. Participanții instalează Tailscale | Rețea privată | Simplu tehnic | Nepractic pentru familie |

Plan M5: prototip A (2 participanți, rețele diferite), cu verificarea topologiei în
`chrome://webrtc-internals` (perechea ICE selectată trebuie să fie adresa laptopului/Funnel, nu
adresa celuilalt participant). Dacă A nu oferă calitate acceptabilă, B este varianta de rezervă,
cu decizia ta privind costul.

Nu vom afirma un număr de participanți suportat înainte de măsurători reale (CPU, bandă de upload
a laptopului — de obicei factorul limitativ).

## Ce verifică M4 înainte de a declara „funcționează din internet”
- Acces de pe 4G (Wi-Fi oprit) și dintr-o altă rețea Wi-Fi.
- Certificat valid, fără avertismente în browser.
- Cereri de la o origine neaprobată → refuzate.
- Fără token → 401; token de participant → 403 pe API-ul de administrare.
- `tailscale funnel off` → serviciul devine inaccesibil din exterior.

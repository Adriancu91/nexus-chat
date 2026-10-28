# Securitate și model de încredere

## Model de încredere

| Cine | Ce poate vedea | Observații |
|---|---|---|
| Administratorul (proprietarul laptopului) | Tot: mesaje, fișiere, metadate, jurnal | Arhiva este pe laptopul lui, necriptată la nivel de aplicație. Protecția discului = BitLocker (recomandat). |
| Participant | Doar camera în care a intrat cu parolă | Nu poate citi, scrie sau enumera alte camere. |
| Furnizorul de conectivitate | Depinde de soluție — vezi [CONECTIVITATE.md](CONECTIVITATE.md) | Cu Tailscale Funnel TLS se termină pe laptop. |
| GitHub | Codul sursă și interfața statică | Nicio dată privată. |

**NEXUS CHAT nu are criptare end-to-end.** HTTPS/WSS protejează datele în tranzit între browser și
laptop; pe laptop, serverul vede conținutul (trebuie să-l arhiveze). Nu vom afirma altceva.
Parola camerei controlează **accesul**; nu criptează nimic.

## Administratorul

### Inițializare (prima pornire)
1. Serverul vede că nu există niciun dispozitiv de administrator și afișează în consola locală un
   **cod de inițializare** de 100 de biți, de unică folosință, valabil 30 de minute.
2. Pe laptop, pagina de administrare generează o pereche de chei ECDSA P-256 (WebCrypto,
   ne-exportabilă) și trimite **doar cheia publică** + codul.
3. Codul este consumat atomic; dispozitivul este înregistrat.

Nu există parole sau tokenuri implicite. Codul nu ajunge niciodată în Git (este generat la rulare,
în baza de date se păstrează doar hash-ul său).

### Autentificare
`POST /api/admin/challenge` → nonce aleator (256 biți), valabil 60 s → dispozitivul semnează
`nexus-chat/admin-login/v1\n<challengeId>\n<nonce>` → `POST /api/admin/login`. Provocarea se consumă
la prima încercare (fără reluare). Rezultatul: sesiune de administrator de 12 ore.

### Adăugarea telefonului
De pe un dispozitiv deja autentificat: „Adaugă dispozitiv” → cod de înrolare valabil 10 minute →
pe telefon se introduce codul; telefonul își generează propria cheie. Fiecare dispozitiv are cheia
lui și poate fi revocat individual.

### Revocare și recuperare
- Revocarea unui dispozitiv anulează imediat toate sesiunile lui și închide conexiunile active.
- Dacă toate dispozitivele sunt pierdute: `npm run admin:code` **pe laptop** emite un cod nou
  direct în arhiva locală. Necesită acces la fișierele laptopului, deci nu poate fi folosit de la
  distanță. Aceasta este „rădăcina de încredere”: cine controlează laptopul controlează serverul.

### De ce nu adresa IP / „cererea vine de pe localhost”
Tunelul se conectează la server de pe 127.0.0.1, deci orice cerere din internet *pare* locală.
Verificarea pe IP ar fi o falsă securitate; nu este folosită nicăieri.

## Participanți și camere
- Parolele camerelor: scrypt (N=2¹⁵, r=8, p=1, sare de 16 octeți), minim 8 caractere.
- Cod de cameră inexistent și parolă greșită → **același** răspuns și același cost de calcul
  (nu se pot enumera camerele).
- Limitare: 10 eșecuri / 15 min per IP și 30 eșecuri / 15 min per cameră. Când limita este
  atinsă, chiar și parola corectă este refuzată până la expirarea ferestrei.
  *Compromis documentat:* un atacator poate bloca temporar intrările noi într-o cameră (participanții
  deja conectați nu sunt afectați). Recomandare: parole de cameră lungi (fraze).
- Sesiune participant: 30 de zile, legată de o singură cameră; revocabilă individual, la schimbarea
  parolei (opțional) și automat la închiderea sau ștergerea camerei.

## Tokenuri
256 de biți aleatori; în baza de date doar SHA-256. Trimise în antetul `Authorization` sau în primul
mesaj WebSocket — niciodată în URL (URL-urile ajung în jurnale de proxy).

## Măsuri implementate în M1 (cu teste)

| Măsură | Unde | Test |
|---|---|---|
| Autorizare pe fiecare operațiune | `services/access.ts` | `rooms.test.ts`, `realtime.test.ts` |
| Izolare între camere (HTTP și WebSocket) | `requireRoomAccess` | „un participant nu poate citi…”, „izolare…” |
| Sesiune re-verificată la fiecare mesaj WebSocket | `ws/hub.ts` `revalidate` | „participantul revocat este deconectat imediat” |
| CORS cu listă explicită; `Origin` verificat la WebSocket | `http/http.ts`, `ws/hub.ts` | „CORS…”, „origine neaprobată…” |
| Limite: corp HTTP 16 KiB, mesaj 4000 caractere, cadru WS 64 KiB, 200 conexiuni, 20 mesaje/10 s | `config.ts` | „cereri invalide…”, „limitarea ritmului…” |
| Validare intrări, eliminare caractere de control și bidi din nume | `validation.ts` | `unit.test.ts` |
| Antete de securitate (`nosniff`, CSP `default-src 'none'`, `no-store`) | `http/http.ts` | — |
| Jurnal administrativ fără secrete | `services/audit.ts` | „…jurnalul nu conține tokenuri” |
| Interogări SQL parametrizate (fără concatenare de date) | `services/*` | — |

## Măsuri în interfața web (M2, cu teste E2E)

| Măsură | Detalii |
|---|---|
| Fără innerHTML | Tot textul (mesaje, nume) intră în pagină ca nod text (`web/src/dom.ts`). Link-urile din mesaje devin `<a>` doar pentru `http(s)://`, cu `rel="noopener noreferrer"`. Test: „HTML din mesaje este afișat ca text”. |
| CSP strict | `default-src 'none'; script-src 'self'; style-src 'self'`, fără scripturi sau stiluri inline. Test: „pagina publicată are CSP strict”. |
| Cheia administratorului | Generată cu `extractable: false`: nici măcar codul paginii nu o poate citi, doar semna cu ea. Tokenul de administrator stă în `sessionStorage` (dispare la închiderea filei). |
| Tokenul participantului | În `localStorage` (pentru a rămâne în cameră după repornirea telefonului). Risc acceptat: un XSS l-ar putea citi; atenuat de CSP și de lipsa innerHTML. „Ieși din cameră” revocă tokenul și pe server. |
| Adresa serverului | Vine din build sau din Setări, **niciodată din link-uri**, ca un link primit să nu poată trimite pe cineva către un server străin. Pentru adrese non-locale se acceptă doar https://. |
| Fără cookie-uri | `credentials: omit`, deci CSRF nu se aplică. |

## Fișiere și backup (M3, cu teste)

| Măsură | Detalii |
|---|---|
| Path traversal imposibil | Pe disc: `files/<aa>/<uuid>` generat de server; numele utilizatorului e doar afișat, curățat de căi, caractere de control și nume rezervate Windows. |
| Fișiere periculoase | Extensiile executabile Windows sunt refuzate, iar orice fișier care începe cu semnătura `MZ` (program) e refuzat chiar dacă se numește „poza.jpg”. |
| Servire sigură | Doar imaginile verificate după conținut sunt servite cu tipul real; restul ca `application/octet-stream` + `attachment`, plus `nosniff` și `CSP: sandbox`. Un HTML deghizat nu poate rula. |
| Autorizare | Fiecare descărcare verifică sesiunea și camera. Tokenul merge în antet, nu în URL; previzualizările sunt blob-uri locale. |
| Abuz de resurse | 100 MB/fișier, 30 upload-uri/10 min, refuz când discul ar rămâne sub 1 GB. |
| Integritate | SHA-256 la upload, la backup (verificat după copiere), la restaurare și la verificarea la cerere. |
| Backup | Fără date private în GitHub. **Necriptat**: protejează folderul de backup cu BitLocker To Go pe un disc extern. Restaurarea refuză un backup cu amprente greșite și nu șterge arhiva existentă. |
| O singură instanță | Fișierul `server.lock` împiedică două servere să scrie în aceeași arhivă. |

## Apeluri (M5, cu teste)

| Măsură | Detalii |
|---|---|
| Acces | Bilet JWT semnat de NEXUS, valabil 10 min, limitat la o cameră; fără drept de canal de date. Doar cine are acces la cameră îl primește (test). |
| Revocare | Participantul revocat / camera închisă → scos imediat și din apel (test E2E). |
| Semnalizare | LiveKit ascultă doar pe 127.0.0.1; din exterior doar prin NEXUS (`/rtc`), cu aceeași verificare de origine. |
| Webhook-uri | Acceptate doar cu semnătură JWT validă peste SHA-256 al corpului (test). |
| Topologie | Verificat automat: fiecare browser comunică media doar cu serverul media (cel mult 2 conexiuni), niciodată direct cu ceilalți. |
| Criptare | Media e criptată în tranzit (DTLS-SRTP) până la serverul media; **nu este end-to-end**: serverul gazdei poate accesa fluxurile (nu le înregistrează). |
| Înregistrare | Nu există. Componenta de înregistrare LiveKit nu este instalată. |
| Secret | `livekit-keys.json` generat local la prima pornire, în folderul arhivei. |

## Riscuri acceptate explicit
- **Origine comună GitHub Pages** (28.10.2026): NEXUS este publicat pe `adriancu91.github.io`, aceeași origine cu alte
  6 site-uri ale contului. Codul acelor site-uri ar putea citi sesiunile participanților și folosi cheia de
  administrator a browserului. Alternativa recomandată (organizație GitHub separată) rămâne disponibilă.

## Încă neimplementat (planificat)
- Criptarea backup-urilor în aplicație (opțională; vezi raportul M3).
- HTTPS/WSS extern (M4) — local serverul vorbește HTTP pe 127.0.0.1; TLS este oferit de tunel.
- Audit de securitate complet (M7).

## Raportarea problemelor
Proiect privat de familie. Problemele de securitate se raportează direct proprietarului, nu în
issue-uri publice.

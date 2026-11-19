# nuxt-shield-layer

Scudo per qualsiasi sito Nuxt 3 / 4, da aggiungere con una riga di configurazione:

- **Anti-scanning**: chi cerca file e pannelli che il sito non ha (`/wp-login.php`, `/.env`, `/phpmyadmin`...), manda
  payload d'attacco (SQL injection, path traversal, Log4Shell...) o usa strumenti come sqlmap e nuclei viene bloccato.
- **Limiti di frequenza** su login, API e pagine, e blocco di chi accumula login falliti o pagine inesistenti.
- **Anti-scraping**: respinge i crawler che raccolgono contenuti per l'IA e gli strumenti di copia (HTTrack, wget,
  python-requests, Chrome headless...). I finti Googlebot vengono smascherati con il DNS inverso.
- **Blocco per paese** (anche la rete Tor), con i dati di Cloudflare o gli intervalli IP di ipdeny.com.
- **IP fidati**, mai bloccati: ufficio, casa, clienti.
- **Pannello di gestione** su `/admin/shield` (o dentro l'area admin del sito) e **riga di comando**.
- **Nessun database richiesto**: blocchi, IP fidati e paesi si salvano su file. Per i siti con più istanze c'è
  l'archivio su MySQL, oppure se ne scrive uno proprio.

Funziona dietro Cloudflare, nginx e Docker: legge l'IP vero del visitatore senza farsi ingannare da header falsificati.

---

## 1. Installazione

```bash
npm install github:MrMagicalSoftware/nuxt-shield-layer
```

Poi, nel `nuxt.config.ts` del progetto:

```ts
export default defineNuxtConfig({
  extends: ['nuxt-shield-layer'],
  nitro: { preset: 'node-server' }, // lo scudo ha bisogno del server Node
})
```

Basta questo: lo scudo è attivo, salva i dati in `./.data/shield` e il pannello è su `/admin/shield`
(per entrare serve `NUXT_SHIELD_ADMIN_PASSWORD`, vedi sotto).

> **Non funziona con `nuxt generate`** (hosting statico): il firewall è un middleware del server.
>
> **Con `nuxi dev` lo scudo non blocca nessuno**: il server di sviluppo non vede l'IP dei visitatori. Si prova con la
> build (`nuxi build` e `node .output/server/index.mjs`).

## 2. Che cosa blocca

Ogni IP accumula punti che calano di 6 al minuto; a 100 punti viene bloccato (risposta `403`).

| Comportamento | Effetto |
|---|---|
| Percorso-trappola (`/wp-login.php`, `/.env`, `/.git`, `/phpmyadmin`, file `.php` `.sql` `.bak`...) | blocco immediato (risponde `404`) |
| Payload d'attacco nell'URL o negli header (path traversal, SQLi, XSS, Log4Shell...) | blocco immediato |
| User agent di scanner (sqlmap, nikto, nuclei, masscan, wpscan...) | blocco immediato |
| Finto motore di ricerca (user agent di Googlebot da un IP che non è di Google) | `403`, al secondo tentativo blocco |
| Crawler per l'IA (GPTBot, ClaudeBot, CCBot...) e strumenti di copia (wget, curl, HTTrack...) | `403`, chi insiste viene bloccato |
| Circa 20 pagine inesistenti ravvicinate | blocco |
| Circa 10 login falliti ravvicinati | blocco |
| Metodi HTTP anomali (TRACE, PROPFIND...) | `405`, al secondo tentativo blocco |
| Oltre 20 login, 300 chiamate API o 600 pagine al minuto | `429` con `Retry-After` |
| Corpo della richiesta oltre 1 MB, URL oltre 2048 caratteri | `413` / `414` |

- **Durata dei blocchi**: 1 ora, poi 6 ore, 24 ore e 7 giorni per le recidive nell'arco di 30 giorni. I blocchi per
  motivi gravi (trappole, payload, scanner) durano almeno 24 ore. Gli IPv6 si bloccano per rete `/64`.
- **Mai bloccati**: gli IP fidati e i proxy stessi (bloccarli vorrebbe dire bloccare tutti i visitatori).
- **Motori di ricerca**: Googlebot, Bingbot, Applebot... verificati con il DNS inverso non vengono penalizzati per 404 e
  frequenza e non sono soggetti al blocco per paese. Trappole, payload e user agent di scanner valgono anche per loro.
- **Le pagine del sito non sono mai trappole**: se il progetto ha una pagina `/backup` o una route del server con file
  `.zip`, lo scudo se ne accorge da solo in fase di build e non le tratta come trappole.
- **404 di immagini, font, stili e script** non contano: capitano anche ai visitatori veri.
- I file statici (`public/`, `/_nuxt/`) sono serviti da Nitro prima dello scudo.

Lo scudo è il primo middleware del sito: filtra le richieste prima dei middleware del progetto.

## 3. Configurazione

### Variabili d'ambiente

| Variabile | Default | Descrizione |
|---|---|---|
| `NUXT_SHIELD_MODE` | `block` | `monitor` scrive nel log i blocchi senza applicarli (utile i primi giorni), `off` spegne lo scudo |
| `NUXT_SHIELD_ALLOWLIST` | | IP o reti CIDR mai bloccati, separati da virgola (oltre a quelli aggiunti dal pannello) |
| `NUXT_SHIELD_TRUSTED_PROXIES` | | proxy da cui accettare `X-Forwarded-For`, oltre a loopback, reti private e Cloudflare |
| `NUXT_SHIELD_CLOUDFLARE` | `true` | `false` se il sito non è dietro Cloudflare |
| `NUXT_SHIELD_DATA_DIR` | `./.data/shield` | cartella dell'archivio su file |
| `NUXT_SHIELD_ADMIN_PASSWORD` | | password del pannello (se il progetto non usa `authorize`, vedi sotto) |
| `NUXT_SHIELD_SESSION_SECRET` | casuale | chiave che firma il cookie del pannello; se manca, a ogni riavvio bisogna rientrare |
| `NUXT_SHIELD_SESSION_HOURS` | `12` | durata della sessione del pannello |
| `NUXT_SHIELD_CONTACT` | | contatto mostrato a chi viene bloccato, es. `info@miosito.it` |

Gli stessi valori si possono scrivere nel `nuxt.config.ts` del progetto, in `runtimeConfig.shield`
(es. `runtimeConfig: { shield: { contact: 'info@miosito.it' } }`).

Generare un secret robusto: `openssl rand -base64 32`.

### Regole del sito: `configureShield()`

Archivio, accesso al pannello e regole sui percorsi si impostano con `configureShield()`, in un plugin Nitro del
progetto. Tutte le opzioni sono facoltative; le liste di percorsi **si aggiungono** a quelle predefinite.

```ts
// server/plugins/shield.ts
export default defineNitroPlugin(() => {
  configureShield({
    // Login del sito: un 401 conta come tentativo fallito, e c'è il limite stretto (20 al minuto)
    loginPaths: ['/api/auth/login'],
    // Altre API con il limite stretto (solo POST)
    authPaths: ['/api/auth/register', '/api/auth/password-reset'],
    // Trappole in più, es. un link invisibile nelle pagine (vietarlo in robots.txt!)
    honeypots: ['/scarica-tutto'],
    // Cartelle di file statici i cui 404 non contano
    ignore404: ['/uploads/'],
    // Percorsi esclusi dal controllo anti-copia (es. le API usate da un'app)
    scraping: { exclude: ['/api/app/'] },
    // Percorsi mai bloccati per paese (es. i webhook dei pagamenti)
    countryExempt: ['/api/stripe/webhook'],
    // Paesi che non si possono bloccare dal pannello
    protectedCountries: ['IT'],
  })
})
```

| Opzione | Descrizione |
|---|---|
| `store` | dove salvare i dati (vedi [Archivio](#7-archivio)); predefinito: file in `NUXT_SHIELD_DATA_DIR` |
| `authorize(event)` | chi può usare il pannello: restituisce il nome o l'email dell'amministratore, oppure lancia un errore 401/403 |
| `loginPaths` | login del sito (POST): un 401 vale 10 punti; limite di 20 richieste al minuto. Già inclusi: il login del pannello e quello di [nuxt-blog-layer](https://github.com/MrMagicalSoftware/nuxt-blog-layer) |
| `authPaths` | altre API (POST) con il limite di 20 al minuto |
| `rateLimits` | richieste al minuto per IP: `{ auth: 20, api: 300, pages: 600 }` |
| `honeypots` | percorsi-trappola in più |
| `allowPaths` | percorsi mai considerati trappole, anche con estensioni sospette |
| `ignore404` | percorsi i cui 404 non contano |
| `scraping` | `false` spegne il blocco di crawler IA e strumenti di copia; `{ exclude: [...] }` esclude dei percorsi |
| `countryExempt` | percorsi mai bloccati per paese |
| `protectedCountries` | paesi che il pannello non permette di bloccare |
| `allowLargeBody(event)` | eccezioni al limite di 1 MB sul corpo delle richieste (es. upload di un'area admin autenticata) |
| `maxBodyBytes` | limite sul corpo delle richieste, in byte |
| `messages` | testi delle risposte: `{ blocked, country, tooMany }` |

Un percorso scritto come stringa vale come prefisso (maiuscole e minuscole indifferenti); si può usare anche una `RegExp`.

> **Trappole e motori di ricerca.** Le trappole valgono anche per Googlebot. Se metti nelle pagine un link-trappola
> invisibile, vietalo in `robots.txt` (`Disallow: /scarica-tutto`): i crawler corretti non lo seguiranno, chi copia il
> sito sì.

### Accesso al pannello con il login del sito

Se il sito ha già i suoi amministratori, il pannello può usare quel login al posto della password:

```ts
// con nuxt-auth-utils
configureShield({
  authorize: async (event) => {
    const { user } = await requireUserSession(event)
    if (!user.admin) throw createError({ statusCode: 403, message: 'Accesso negato' })
    return user.email
  },
})
```

Il nome restituito compare nel pannello (chi ha bloccato un paese, chi ha aggiunto un IP fidato).

## 4. Pannello

La pagina `/admin/shield` è pronta all'uso: stato dello scudo, IP fidati, blocco per paese, blocco e sblocco degli IP,
elenco degli IP bloccati con ricerca. Non viene indicizzata e non passa dal rendering sul server.

Per metterlo nell'area admin del sito basta il componente:

```vue
<template>
  <ShieldPanel @unauthorized="navigateTo('/login')" />
</template>
```

| Prop / evento | Descrizione |
|---|---|
| `api` | indirizzo delle API (default `/api/shield`) |
| `@unauthorized` | le API hanno risposto 401 e l'accesso lo gestisce il sito (`authorize`): es. per tornare al login |

Con l'accesso a password il componente mostra da solo il modulo di login.

**Grafica.** Il pannello non dipende da librerie di componenti: ha un suo CSS con classi `.ns-*`. Se il sito usa
[Nuxt UI](https://ui.nuxt.com) prende da solo i colori del tema, compreso quello scuro. Altrimenti si adatta
ridefinendo le variabili nel CSS del progetto:

```css
:root {
  --ns-accent: #f97316;     /* pulsanti principali */
  --ns-danger: #dc2626;
  --ns-success: #16a34a;
  --ns-warning: #d97706;
  --ns-bg: #ffffff;
  --ns-bg-muted: #f8fafc;
  --ns-bg-elevated: #f1f5f9;
  --ns-text: #334155;
  --ns-text-strong: #0f172a;
  --ns-text-muted: #64748b;
  --ns-border: #e2e8f0;
  --ns-border-strong: #cbd5e1;
  --ns-on-accent: #ffffff;  /* testo sui pulsanti */
  --ns-radius: 0.5rem;
  --ns-font: 'Inter', sans-serif;
}
```

## 5. Dietro Cloudflare, nginx o Docker

`X-Forwarded-For` e `CF-Connecting-IP` si leggono solo se la connessione arriva da un proxy fidato: loopback, reti
private (nginx sulla stessa macchina, rete di Docker), IP di Cloudflare e `NUXT_SHIELD_TRUSTED_PROXIES`. La catena si
legge da destra, quindi un visitatore non può falsificare il proprio IP.

Consigli:
- accetta sulla porta del sito solo connessioni da Cloudflare (firewall): nessuno potrà aggirare lo scudo puntando
  direttamente all'IP del server;
- con nginx davanti a Node: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`;
- se il sito non è dietro Cloudflare: `NUXT_SHIELD_CLOUDFLARE=false`.

## 6. Blocco per paese

Dal pannello si sceglie un paese: lo scudo scarica i suoi intervalli IP (IPv4 e IPv6) da
[ipdeny.com](https://www.ipdeny.com), li salva nell'archivio e li riscarica ogni 7 giorni. Chi si collega da lì riceve un `403`.

- Se la richiesta passa da Cloudflare vale l'header `CF-IPCountry`, più preciso (e l'unico modo per riconoscere la
  rete Tor, codice `T1`). L'header si usa solo se la richiesta arriva davvero da Cloudflare.
- Passano sempre gli IP fidati, i motori di ricerca verificati e i percorsi `countryExempt`.
- Il pannello non permette di bloccare il paese da cui ti colleghi (a meno che il tuo IP non sia fidato) né i
  `protectedCountries`.
- Attenzione ai paesi con molti data center (Stati Uniti, Irlanda, Paesi Bassi, Germania): da lì passano anche servizi
  usati dal sito (pagamenti, email, anteprime dei social).

## 7. Archivio

Lo scudo tiene tutto in memoria (nessuna lettura per richiesta) e si riallinea con l'archivio all'avvio e ogni minuto,
così vede anche le modifiche fatte da altre istanze o dalla riga di comando. Se l'archivio non risponde, continua a
funzionare in memoria. I blocchi scaduti da oltre 30 giorni vengono cancellati (gli IP sono dati personali).

### Su file (predefinito)

```
.data/shield/
  bans/<ip>.json          un file per IP bloccato
  trusted.json            IP fidati
  countries.json          paesi bloccati
  countries/<XX>-v4.txt   intervalli IP del paese
```

Per sbloccare un IP a mano basta cancellare il suo file in `bans/`. In produzione la cartella deve sopravvivere ai
deploy: con Docker va montata come volume.

```yaml
services:
  sito:
    environment:
      - NUXT_SHIELD_ADMIN_PASSWORD=${NUXT_SHIELD_ADMIN_PASSWORD}
      - NUXT_SHIELD_SESSION_SECRET=${NUXT_SHIELD_SESSION_SECRET}
    volumes:
      - shield-dati:/app/.data/shield
volumes:
  shield-dati:
```

### MySQL / MariaDB

Per i siti che hanno già un database (i dati valgono per tutte le istanze e non serve un volume):

```ts
// server/plugins/shield.ts
import mysql from 'mysql2/promise'

const pool = mysql.createPool(process.env.DATABASE_URL!)

export default defineNitroPlugin(() => {
  configureShield({ store: createMysqlShieldStore(pool) })
})
```

Al posto del pool si può passare una funzione che lo restituisce (`createMysqlShieldStore(() => usePool())`). Le tabelle
`shield_ban`, `shield_fidato` e `shield_paese` si creano da sole; per crearle a parte:
`createMysqlShieldStore(pool, { createTables: false })` e le istruzioni in `SHIELD_MYSQL_TABLES` (`lib/mysql-store.mjs`).

### Un archivio diverso

Redis, PostgreSQL o altro: basta un oggetto con i metodi dell'interfaccia `ShieldStore` (`lib/types.d.mts`):
`listBans`, `saveBan`, `deleteBan`, `purgeBans`, `listTrusted`, `saveTrusted`, `deleteTrusted`, `listCountries`,
`getCountryRanges`, `saveCountry`, `deleteCountry` e, facoltativa, `init`.

## 8. Riga di comando

Per gestire lo scudo anche a sito spento, per esempio per sbloccare un amministratore rimasto fuori:

```bash
npx nuxt-shield list                          # IP bloccati
npx nuxt-shield unban 203.0.113.7             # sblocca (e azzera la storia dell'IP)
npx nuxt-shield ban 203.0.113.7 24 motivo     # ore; 0 = permanente
npx nuxt-shield trusted                       # IP fidati
npx nuxt-shield trust 93.49.90.0/24 Ufficio   # aggiunge un IP o una rete ai fidati
npx nuxt-shield untrust 93.49.90.0/24
npx nuxt-shield countries                     # paesi bloccati
npx nuxt-shield unblock-country CN
```

Usa la cartella `NUXT_SHIELD_DATA_DIR` (o `--dir`); con `--mysql <url>` (o `NUXT_SHIELD_MYSQL_URL`) lavora sulle tabelle
MySQL. Legge il file `.env` della cartella corrente. Il sito in esecuzione recepisce le modifiche entro un minuto.

## 9. Funzioni per il server del progetto

Disponibili in tutte le route e i plugin Nitro senza import:

| Funzione | Restituisce |
|---|---|
| `configureShield(options)` | configura lo scudo (vedi sopra) |
| `getClientIp(event)` | IP reale del visitatore (`null` con `nuxi dev`) |
| `viaCloudflare(event)` | `true` se la richiesta è passata davvero da Cloudflare (i suoi header `CF-*` sono affidabili) |
| `isTrustedProxy(ip)` · `isShieldTrusted(ip)` | l'IP è un proxy fidato · è tra gli IP fidati |
| `normalizeIp(raw)` · `shieldKey(ip)` | IP ripulito · chiave usata dallo scudo (IPv6 per rete /64) |
| `shieldPenalize(event, punti, motivo)` | punti all'IP della richiesta, per regole del progetto (100 = blocco) |
| `shieldScore(chiave, punti, motivo)` | come sopra, a partire da una chiave |
| `shieldBan(ip, { hours, reason })` · `shieldUnban(ip)` | blocca (0 ore = permanente) · sblocca un IP |
| `shieldActiveBan(ip)` | blocco attivo dell'IP, se c'è |
| `isSearchBot(userAgent)` | lo user agent è di un motore di ricerca |
| `requireShieldAdmin(event)` | protegge API aggiuntive con lo stesso accesso del pannello |
| `SHIELD_SCORES` | punti assegnati dalle regole predefinite |
| `createFileShieldStore(dir)` · `createMysqlShieldStore(pool)` | archivi pronti |

Esempio: limitare il download massivo di contenuti.

```ts
export default defineEventHandler(async (event) => {
  if (await troppiDownload(event)) {
    shieldPenalize(event, 10, 'troppi download') // al decimo di fila l'IP viene bloccato
    throw createError({ statusCode: 429, message: 'Rallenta un po\'' })
  }
  // ...
})
```

## 10. API HTTP

| Metodo | Percorso | Descrizione |
|---|---|---|
| GET | `/api/shield?q=&page=` | stato, IP fidati, paesi e IP bloccati (20 per pagina, ricerca per IP, motivo, percorso, user agent) |
| POST | `/api/shield/ban` | `{ ip, hours, reason? }` blocca un IP (hours 0 = permanente) |
| POST | `/api/shield/unban` | `{ ip }` sblocca un IP |
| POST | `/api/shield/trusted` | `{ address, note? }` aggiunge un IP o una rete ai fidati (e toglie i blocchi che ricadono lì) |
| DELETE | `/api/shield/trusted` | `{ address }` toglie un IP dai fidati |
| POST | `/api/shield/countries` | `{ code }` blocca un paese o ne aggiorna gli intervalli |
| DELETE | `/api/shield/countries` | `{ code }` sblocca un paese |
| POST | `/api/shield/login` | `{ password }` accesso con `NUXT_SHIELD_ADMIN_PASSWORD` |
| POST | `/api/shield/logout` | chiude la sessione |

Tutte tranne login e logout richiedono l'accesso al pannello.

## 11. Sicurezza e limiti

- Il cookie del pannello è firmato (HMAC), `HttpOnly`, `SameSite=Strict` e `Secure` in https. La password si confronta a
  tempo costante; dopo 10 tentativi errati in 15 minuti l'IP deve aspettare (e lo scudo lo blocca se insiste).
- Non ci si può chiudere fuori: il pannello non blocca il tuo IP né il paese da cui ti colleghi, e mostra il pulsante
  per aggiungere il tuo IP ai fidati.
- Subito dopo un riavvio il firewall aspetta che i blocchi salvati siano caricati (al massimo 3 secondi).
- Punteggi e limiti di frequenza sono in memoria, per istanza: con più istanze ognuna conta per conto suo, mentre
  blocchi, IP fidati e paesi valgono per tutte (con un archivio condiviso).
- Gli intervalli IP di Cloudflare sono in `server/shield/ip.ts`: vanno verificati ogni tanto su
  https://www.cloudflare.com/ips/.

## 12. Sviluppo del layer

```bash
npm install
cp .playground/.env.example .playground/.env   # imposta la password del pannello
npm test             # test dell'archivio su file e degli indirizzi IP
npm run dev          # sito di prova su http://localhost:3000 (lo scudo non blocca in sviluppo)
npm run build        # build del sito di prova
npm run preview      # avvia la build: qui lo scudo è attivo
npm run typecheck
```

La cartella `.playground/` è un sito Nuxt minimo che estende il layer, come farebbe un progetto reale. Per provare lo
scudo in locale si simulano visitatori esterni con l'header `X-Forwarded-For` (le richieste da `127.0.0.1` arrivano da
un proxy fidato):

```bash
curl -A 'Mozilla/5.0' -H 'X-Forwarded-For: 203.0.113.9' http://localhost:3000/wp-admin   # 404, e l'IP viene bloccato
curl -A 'Mozilla/5.0' -H 'X-Forwarded-For: 203.0.113.9' http://localhost:3000/           # 403
```

## Licenza

[MIT](LICENSE)

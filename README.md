# Böxle Backend

![Status](https://img.shields.io/badge/status-production-brightgreen)
![License](https://img.shields.io/badge/license-view--only-blue)
![Snapshot](https://img.shields.io/github/v/tag/kvaszt/boexle-push-service?label=snapshot)

Öffentlich einsehbarer Quellcode des Backend-Dienstes, der die **Böxle-iOS-App** mit der **Telekom-SprachBox** verbindet. Veröffentlicht, damit Nutzer und Dritte **nachvollziehen können, was auf dem Server mit ihren Daten passiert**.

> **Hinweis**: Dies ist ein **öffentlich einsehbarer Snapshot** des Produktiv-Codes, der zum Zweck der Nachprüfbarkeit veröffentlicht wird. Der Betrieb des Dienstes erfolgt ausschließlich durch den Herausgeber der Böxle-App; siehe [`LICENSE`](./LICENSE). Sicherheitsmeldungen bitte gemäß [`SECURITY.md`](./SECURITY.md).

## Rolle des Backends

Das Backend verbindet die **Böxle**-iOS-App mit dem **Telekom-SprachBox**-Postfach per **IMAP** und löst **Apple-Push-Benachrichtigungen (APNs)** aus, wenn neue Sprachnachrichten eintreffen. Die App zeigt die Nachrichten an; das Backend **lädt keine Voicemail-Audioinhalte herunter** und **leitet keine Inhalte** an Dritte weiter. Verarbeitet werden ausschließlich IMAP-Metadaten (UIDs, Betreffzeile der SprachBox-Benachrichtigung).

## Ablauf in Kurzform

1. **Anmeldung / Token**
   Die App sendet Telekom-IMAP-Zugangsdaten (E-Mail, App-Passwort) an `POST /api/auth/token`. Der Server prüft sie durch eine kurze IMAP-Verbindung zum `SprachBox`-Ordner. Bei Erfolg werden ein **Access-Token** (JWT, HMAC-SHA256, Geheimnis: `AUTH_TOKEN_SECRET`, 15 min gültig) und ein **Refresh-Token** (opaque, 32-Byte-Zufall, serverseitig nur als SHA-256-Hash in `refresh_sessions` gespeichert) ausgestellt.

2. **Geräteregistrierung**
   Mit `Authorization: Bearer <accessToken>` ruft die App `POST /api/devices/register` auf und übermittelt den **APNs-Gerätetoken**, die Telekom-E-Mail (muss zur `sub`-Claim des Access-Tokens passen) und das **App-Passwort**. Der IMAP-Host ist serverseitig fest auf `secureimap.t-online.de:993` verdrahtet (SSRF-Schutz). **Benutzer und Passwort werden AES-256-GCM-verschlüsselt** gespeichert, zusätzlich wird die aktuelle `UIDNEXT` der SprachBox als Baseline festgehalten.

3. **Abfrage (Polling)**
   Für jedes aktive Gerät verbindet sich der Server periodisch per IMAP, liest Metadaten neuer Nachrichten im Ordner `SprachBox` und erkennt aus der Betreffzeile Anrufernummer und Dauer. Plaintext-Credentials werden **nur pro Poll-Zyklus kurz im RAM** entschlüsselt, nie global gecacht.

4. **Push**
   Neue Nachrichten (UID ≥ Baseline-UIDNEXT bei Registrierung) werden in `seen_messages` vermerkt und via **APNs** an das Gerät zugestellt. Bereits vorhandene Voicemails im Postfach zum Registrierungszeitpunkt lösen **keinen** Push aus, um „Push-Floods" nach (Re-)Login zu vermeiden.

5. **Token erneuern**
   `POST /api/auth/refresh` tauscht den Refresh-Token gegen ein neues Token-Paar (One-Time-Use, Rotation: der alte Refresh-Token wird sofort entwertet).

6. **Abmeldung**
   `DELETE /api/devices/:token` mit gültigem Bearer-Token entfernt den Gerätedatensatz, löscht alle Refresh-Sessions des Nutzers und **inkrementiert die Token-Version** — dadurch werden auch noch nicht abgelaufene Access-Tokens sofort ungültig.

## Welche Daten wo anfallen

| Daten | Wo | Zweck |
|-------|----|-------|
| IMAP-E-Mail / App-Passwort | HTTP-Body bei Login und Registrierung | IMAP-Validierung und späteres Polling; in der DB **AES-256-GCM-verschlüsselt** |
| APNs-Gerätetoken | Registrierung | Zustellung von Push-Benachrichtigungen |
| IMAP-UIDs gesehener Nachrichten | SQLite (`seen_messages`) | Duplikat-Vermeidung; rollende Bereinigung nach `SEEN_MESSAGES_RETENTION_DAYS` (Standard 90) |
| Refresh-Session | SQLite (`refresh_sessions`) | Token-Rotation; gespeichert werden nur Hash, Ablaufdatum und verschlüsselter Nutzerbezug, kein Klartext-Token |
| Token-Version | SQLite (`token_versions`) | Sofortige Revocation aller Access-Tokens beim Logout/Geräte-Delete |

**Nicht** gespeichert oder weitergegeben: Voicemail-Audio, Transkriptionen, Betreffzeilen unbekannten Formats (diese werden nur als gekürzter SHA-256-Hash geloggt). Rufnummern anrufender Personen werden serverseitig **nicht** geloggt.

## Speicherung auf dem Server (SQLite)

- **`devices`** — APNs-Token, verschlüsselter IMAP-Nutzer/-Passwort, Zeitstempel, Baseline-UIDNEXT, Polling-Hilfsfelder.
- **`seen_messages`** — Pro Gerät die IMAP-UIDs bereits verarbeiteter Nachrichten.
- **`refresh_sessions`** — Hash des Refresh-Tokens, verschlüsselter Nutzerbezug (`imap_user`), zusätzlicher `imap_user_hash` für Lookups, `expires_at`.
- **`token_versions`** — Pro Nutzer eine Versionsnummer; Access-Tokens enthalten diese als `tv`-Claim und werden serverseitig bei jedem Request geprüft.

Pfad der Datenbankdatei ist über `DB_PATH` konfigurierbar (Standard: `./boexle.db`).

## Verschlüsselung ruhender Zugangsdaten

IMAP-Benutzername und -Passwort werden mit **AES-256-GCM** verschlüsselt (`src/utils/crypto.ts`, zufällige IV je Verschlüsselung, Auth-Tag geprüft). Der Schlüssel kommt ausschließlich aus der Umgebungsvariable **`ENCRYPTION_KEY`** (64 Hex-Zeichen = 32 Byte). Ohne diesen Schlüssel sind die gespeicherten Werte nicht nutzbar.

## Authentifizierung der HTTP-API

- **`POST /api/auth/token`** — Body mit `imapUser`, `imapPass`; bei erfolgreicher IMAP-Prüfung JSON mit `accessToken` und `refreshToken`.
- **`POST /api/auth/refresh`** — Body mit `refreshToken`; liefert ein neues Token-Paar (Rotation, alter Token sofort entwertet).
- **`POST /api/devices/register`** und **`DELETE /api/devices/:token`** — Header `Authorization: Bearer <accessToken>`. Der `sub`-Claim des Tokens muss zum Ziel-`imapUser` bzw. zum Besitzer des Geräte-Tokens passen; Geräte-Tokens, die bereits auf einen anderen Account registriert sind, werden mit `409 Conflict` abgewiesen.

Zugriff auf geschützte Routen erfolgt ausschließlich über Bearer-Token; es gibt keinen separaten API-Key.

## Rate-Limits

Rate-Limits greifen pro IP und nur, wenn `TRUST_PROXY` zur Infrastruktur passt (siehe unten).

| Endpunkt | Limit |
|----------|-------|
| `POST /api/auth/token` | 5 / 15 min |
| `POST /api/auth/refresh` | 60 / 15 min |
| `POST /api/devices/register`, `DELETE /api/devices/:token` | 30 / 15 min |

Zusätzlich: `helmet`-Header, `express.json({ limit: '10kb' })`, generische Validierungsfehler (`400 Invalid request`), striktes Zod-Schema für alle Eingaben.

## Endpunkte (Überblick)

| Methode | Pfad | Kurzbeschreibung |
|---------|------|------------------|
| `POST` | `/api/auth/token` | IMAP prüfen, Token ausstellen |
| `POST` | `/api/auth/refresh` | Token-Paar rotieren |
| `POST` | `/api/devices/register` | Gerät + verschlüsselte IMAP-Daten speichern (Bearer) |
| `DELETE` | `/api/devices/:token` | Gerät entfernen, Access-Tokens revoken (Bearer) |
| `GET` | `/api/health` | Statusendpunkt (`status`, `timestamp`; keine Metriken) |

## Push-Inhalte

Der APNs-Payload enthält standardmäßig nur `type: 'new_voicemail'` plus Alert-Text. Wenn `PUSH_INCLUDE_CALLER=1` gesetzt ist, wird zusätzlich die **Anrufer-Rufnummer** im Payload mitgesendet, damit die App sie direkt anzeigen kann. In diesem Fall verarbeitet Apple (APNs, USA) die Rufnummer als Teil der Auftragsverarbeitung — das ist in der Datenschutzerklärung der App transparent gemacht. Serverseitige Logs enthalten **keine** Rufnummern.

## Reverse-Proxy / `TRUST_PROXY`

`TRUST_PROXY=1` ausschließlich dann setzen, wenn vor dem Node-Prozess tatsächlich ein Reverse-Proxy (nginx/Caddy/Traefik) läuft, der `X-Forwarded-For` zuverlässig setzt. Bei Direktbetrieb leer lassen — sonst werten `express-rate-limit` und Logging die Proxy-IP statt der echten Client-IP aus und Rate-Limits greifen effektiv nicht.

## Dateirechte (Empfehlung)

- Der systemd-Dienst läuft mit `UMask=0077`, neu erstellte Dateien (`boexle.db`, WAL/SHM) sind damit nur für den Service-User lesbar.
- Bestehende Dateien einmalig härten:

```bash
chmod 600 /opt/boexle-backend/boexle.db /opt/boexle-backend/boexle.db-wal /opt/boexle-backend/boexle.db-shm 2>/dev/null || true
chmod 400 /opt/boexle-backend/certs/AuthKey_*.p8
```

Der APNs-`.p8`-Key wird beim Serverstart geprüft; bei zu lockeren Rechten (`mode & 0o077`) startet der Dienst nicht.

## Technische Hinweise zum Nachlesen im Code

- API-Routen und Authentifizierung: `src/api/routes.ts`, Token-Logik: `src/api/authTokens.ts`
- Datenbankschema, Migrations und Housekeeping: `src/db/database.ts`
- IMAP-Abruf und Betreff-Parsing: `src/imap/imapService.ts`, Polling und Baseline-Logik: `src/imap/poller.ts`
- APNs inkl. Startup-Validierung: `src/push/pushService.ts`
- Gemeinsames Log-Sanitizing: `src/utils/log.ts`, Krypto: `src/utils/crypto.ts`

Einstieg am besten über `src/index.ts` und den obigen Pfaden.

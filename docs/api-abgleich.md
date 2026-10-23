# HomeAPI – Abgleich Spec vs. Vorwissen

Quelle: `docs/homeapi-openapi.json` (OpenAPI 3.1.0, `info.version: v1`), abgerufen 2026-10-20
öffentlich ohne Key von `https://home-api.smartdevice.liebherr.com/v3/api-docs/homeapi`
(Swagger-UI: `/swagger-ui/index.html`). Die Doku-Seite auf developer.liebherr.com erfordert Login.

Spec ist springdoc-generiert („Generated server url“). Beispielwerte sind teils inkonsistent zu den Enums
(siehe unten) → **Enums gelten, Beispiele nicht.** Alles hier bleibt gegen echte Antworten zu prüfen.

## Bestätigt

| Punkt | Stand |
|---|---|
| Base-URL | `https://home-api.smartdevice.liebherr.com` |
| Auth | Header `api-key` (securityScheme `apiKey`, `in: header`) |
| `GET /v1/devices` | Array `Device` |
| `GET /v1/devices/{deviceId}/controls` | Array `DeviceControl` |
| SSE `GET /v1/sse/devices/{deviceId}/controls` | `text/event-stream`, jedes Event: Array `DeviceControl` |
| `POST …/controls/temperature` | Body `{ zoneId*, target*, unit? }`, `unit` ∈ `°C`/`°F`, `target` int |
| Toggles `nightmode`, `partymode` | Body `{ value* }` (BaseToggle) |
| Toggles `supercool`, `superfrost` | Body `{ zoneId*, value* }` (ZoneToggle) |

## Neu (nicht im Vorwissen)

**Endpunkte**
- `GET /v1/devices/{deviceId}` – einzelnes Gerät
- `GET /v1/devices/{deviceId}/controls/{controlName}?zoneId=` – einzelnes Control (Array), `controlName` ∈
  `supercool, superfrost, nightmode, partymode, temperature, icemaker, autodoor, presentationlight, biofreshplus, hydrobreeze`
  → geeignet für gezielten **Readback** nach Write.

**Device**: `deviceId` (= Seriennummer!), `nickname`, `deviceType` ∈ `FRIDGE|FREEZER|COMBI|WINE`,
`imageUrl` (nullable), `deviceName` (Modell, nullable). Kein Online-Flag.

**Control-Typen** (Discriminator `type`; alle zonenbezogenen haben `zoneId` + `zonePosition` ∈ `top|middle|bottom`):

| type | Lesefelder | Write-Pfad | Write-Body |
|---|---|---|---|
| `TemperatureControl` | `value` (Ist), `target`, `min`, `max`, `unit`, `setTemperatureSteps[]`, `setTemperatureStepsEnabled` | `temperature` | `{zoneId, target, unit?}` |
| `ToggleControl` | `name`, `value: bool`, `zoneId?` | `<name>` | s. o. |
| `IceMakerControl` | `iceMakerMode` ∈ `OFF|ON|MAX_ICE`, `hasMaxIce` | `icemaker` | `{zoneId, iceMakerMode}` – 422 wenn MaxIce nicht unterstützt |
| `BioFreshPlusControl` | `currentMode`, `supportedModes[]`, `temperatureUnit` (Modi `ZERO_ZERO|ZERO_MINUS_TWO|MINUS_TWO_MINUS_TWO|MINUS_TWO_ZERO`) | `biofreshplus` | `{zoneId, bioFreshPlusMode}` – 422 wenn nicht aktiv |
| `HydroBreezeControl` | `currentMode` ∈ `OFF|LOW|MEDIUM|HIGH` | `hydrobreeze` | `{zoneId, hydroBreezeMode}` – 422 wenn BioFreshPlus nicht aktiv |
| `AutoDoorControl` | `value` ∈ `CLOSED|OPEN|MOVING` | `autodoor` | `{zoneId, value: bool}` – öffnet/schließt Tür! |
| `PresentationLightControl` | `value` int, `max` int (kein `zoneId`) | `presentationlight` | `{target}` |

**Fehler**: Body `ApiError { status: "<code> <TEXT>", message, error }`. Writes: `204` OK,
`400` ungültig, `404` **Gerät nicht erreichbar**, `412` nicht im Haushalt, `422` Funktion nicht verfügbar,
`500`, `503` interner Dienst nicht erreichbar.

## Befunde echte Geräte (Probe 2026-10-20, `test/fixtures/`)

Geräte: `FRIDGE` IRBbi 4170-150 2, `FREEZER` GNP 3755-107 2.

| Gerät | Controls |
|---|---|
| Kühlschrank | `hydrobreeze` (HydroBreezeControl, Zone 0), `nightmode`, `partymode` (ohne Zone), `supercool` (Zone 0), `temperature` (Zone 0, 3…9 °C) |
| Gefrierschrank | `superfrost` (Zone 0), `temperature` (Zone 0, −28…−14 °C) |

- Felder entsprechen der Spec. `setTemperatureSteps: []`, `setTemperatureStepsEnabled: false` bei beiden.
- `…/controls/temperature` mit und ohne `?zoneId=0` liefert identisch ein Array mit einem Element.
- `imageUrl` zeigt auf `assets-cdn.liebherr.com/versions/<uuid>/web-png/` (modellbezogen, unkritisch).
- HydroBreeze wird gemeldet, obwohl kein `BioFreshPlusControl` existiert (Spec-422-Hinweis „BioFreshPlus enabled“ also nicht zwingend).

**SSE** (`text/event-stream;charset=UTF-8`, beide Geräte 90 s stabil):
- Event-Name `device-update`, kein `id:`, kein `retry:`, Feld ohne Leerzeichen (`data:[…]`).
- **Erstes Event = Vollstand** (~0,5 s nach Connect).
- **Folge-Events = Teilstand** (nur betroffene Controls, gruppiert). → Merge in bestehenden Zustand, fehlende Controls **nicht** als entfernt werten.
- Heartbeat: Kommentar `:keep-alive` alle ~30 s. → Watchdog z. B. 75 s ohne Daten ⇒ Reconnect.
- Beobachtet: PartyMode an in der App ⇒ zwei Events binnen 0,4 s: `nightmode`+`partymode:true`, dann `hydrobreeze`+`supercool:true`+`temperature`. PartyMode schaltet also SuperCool mit.

**Fehler / Limits:**
- Ungültiger Key ⇒ `401`, **HTML-Body ohne Content-Type** (`Invalid API Key Version` bzw. bei kurzem Key `… Format`). → Fehlerbody nicht als JSON voraussetzen.
- Ungültiges `deviceId`-Format ⇒ `400` `ApiError`, `error: "… Invalid DeviceId format. Format has to be in 00.000.000.0"` → Regex `^\d{2}\.\d{3}\.\d{3}\.\d$` vor jedem Request.
- **Keine Rate-Limit-Header** (`X-RateLimit-*`, `Retry-After`) in irgendeiner Antwort. 13 Requests in ~2 s ohne 429.
- Antwortzeiten 40–480 ms.

## Offen / Widersprüche in der Spec

- **Rate Limits / 429 / `Retry-After`:** nicht dokumentiert (429 nur im generischen Status-Enum). → Defensiv
  behandeln, am Gerät beobachten.
- **401/403** bei falschem Key: nicht dokumentiert (Probe ohne Key auf `/v1/openapi.json` → 401 ohne Body).
- **SSE:** Event-Name, Heartbeat, Reconnect, ob jedes Event *alle* Controls oder nur Änderungen trägt – nicht
  dokumentiert. Laut Beschreibung „current device controls“ → vermutlich Vollstand. Am Gerät prüfen.
- **Temperaturen nur `int32`** – keine Nachkommastellen; `°F`-Geräte möglich.
- Beispiele widersprechen Enums: `deviceType` „Fridge“ vs. `FRIDGE`; `temperatureUnit` „CELSIUS“ vs. `°C`;
  PresentationLight `name` „PresentationLight“ vs. Pfad `presentationlight`. → Vergleiche case-insensitiv.
- `ToggleControl`-Namen sind nicht als Enum festgelegt → unbekannte Toggle-Namen read-only anlegen,
  schreibbar nur für bekannte Pfade.
- Kein Online-Status am Device; Erreichbarkeit nur indirekt über `404 Device is not reachable`.
- Sicherheit: `deviceId` ist die Seriennummer → in Logs maskieren, Objekt-IDs per HMAC mit Instanz-Salt maskieren (entschieden, siehe CLAUDE.md „Objektstruktur“).
- `autodoor` bewegt physisch eine Tür → Write nur mit bewusster Freischaltung (Config-Option, Default aus)?

## Fehlt in der HomeAPI (App kann es, Stand 2026-10-23)

In der SmartDevice-App vorhanden, aber weder in der Spec (frisch geladen 2026-10-23, inhaltlich unverändert) noch in den
Antworten der eigenen Geräte, auch nicht als unbekannter Control unter `raw.*`:

| Funktion | Gerät | Stand |
|---|---|---|
| **Bottle-Timer** | Gefrierschrank GNP 3755 | nicht in der HomeAPI |
| **Holiday-Mode** (Urlaubsmodus) | Kühlschrank IRBbi 4170 | nicht in der HomeAPI |

- Die App nutzt eine interne Schnittstelle; die nachzubauen widerspricht der Clean-Room-Regel (nur offizielle Spec + eigene Tests).
- Wunsch an Liebherr über das Beta-Programm der App gemeldet bzw. zu melden (Sven).
- Kommt es später als `ToggleControl` (z. B. `holidaymode`): erscheint automatisch read-only; nach Test am Gerät in
  `WRITABLE_TOGGLES` (`src/lib/model/mapper.ts`) aufnehmen, das Widget zeigt es dann als Schalter.
- Kommt es als neuer Control-Typ: landet als `raw.<name>` (JSON) und wird einmal geloggt → Mapper + Widget gezielt ergänzen.

# Audit-Nachtrag: VIS-2-Widget (Phase 8)

Stand: 2026-10-23 · Version 0.2.0 · Ergänzt [AUDIT-2026-10-22.md](AUDIT-2026-10-22.md) · Maßstab: Universal Audit Template

Geprüft: `src-widgets/` (Quellen), `widgets/liebherr-home/` (Build), `tools/build-widgets.mjs`, Änderungen an
`io-package.json`, `package.json`, `eslint.config.mjs`. Konzept: [docs/vis2-widget.md](../vis2-widget.md).

## Kurzfazit

| Stufe | Anzahl |
|---|---|
| 🔴 Kritisch | 0 |
| 🟠 Hoch | 0 |
| 🟡 Mittel | 1 (✅ erledigt) |
| 🔵 Niedrig | 3 (2 ✅ erledigt) |

Das Widget hat keine eigene Netzwerkverbindung, lädt nichts aus dem Internet und rendert alle Werte als Text (React).
Es schreibt nur über `context.setValue` in beschreibbare States des gewählten Geräteordners.

## Sicherheit (ETSI EN 303 645 / ISO 27402, soweit für ein Frontend relevant)

| Punkt | Befund |
|---|---|
| Fremde Inhalte / XSS | Namen und Werte aus States werden von React escaped; kein `innerHTML`, `dangerouslySetInnerHTML`, `eval`, `new Function` (Suche über `src-widgets/src`). |
| Netzwerk | Kein `fetch`/`XMLHttpRequest`; nur der Socket von VIS-2. Fonts als woff2 im Bundle, URL relativ zum Bundle (`new URL(…, import.meta.url)`). |
| Schreibrechte | Nur States mit `common.write=true` werden zu Bedienelementen; `autodoor*` nie; `raw.*` nie. Im Editor (`editMode`) keine Befehle und kein Dialog. |
| Geheimnisse | Kein Zugriff auf API-Key oder `native` der Instanz; keine Seriennummern (nur HMAC-Objekt-IDs). Build-Ausgabe auf lokale Pfade geprüft: keine. |
| Abhängigkeiten zur Laufzeit | Nur React (shared von VIS-2). MUI, gui-components, types-vis-2 nur für Typen, nicht im Bundle. |
| Lizenzen | Barlow / Barlow Condensed: SIL OFL 1.1, Lizenztext in `src-widgets/src/fonts/OFL.txt`. `@iobroker/types-vis-2` (CC BY-NC) nur als Typquelle. |

## 🟡 MITTEL

### WM1 – Steuerung über das Widget noch nicht an echten Geräten getestet – ✅ erledigt
Befehlslogik (offen → Bestätigung, 15-s-Timeout, vom Adapter wiederhergestellter Wert, Esc) ist gegen ein simuliertes
Gerät ohne Adapter (`liebherr-home.1.fridge_test` im dev-server) geprüft; dabei wurden Schreibzugriffe auf
`liebherr-home.0` per WebSocket-Proxy blockiert. Der Adapter-Teil (Debounce, Readback) ist seit Phase 5 live bestätigt.
**Erledigt 2026-10-23:** Live-Test an den echten Geräten durch Sven über das Widget – in Ordnung.

## 🔵 NIEDRIG

### WN1 – `npm audit` im Widget-Projekt
11 × „high“ über `node-forge` (Abhängigkeit von `@iobroker/gui-components`), nur Entwicklungsabhängigkeit für Typen,
nicht im Bundle. `npm audit --omit=dev`: 0. Mit gui-components-Update erneut prüfen.

### WN2 – Kein ESLint für `src-widgets/` – ✅ erledigt
Geprüft wird mit `tsc` (strict) und Prettier; die Root-ESLint-Konfiguration ignoriert `src-widgets/`.
Eine React-ESLint-Konfiguration kann später ergänzt werden.
**Erledigt 2026-10-24:** `src-widgets/eslint.config.mjs` (ioBroker-Config + `reactConfig`, typgeprüft),
`npm run lint:widgets` mit `--max-warnings 0`. Ohne `jsdoc/require-jsdoc`/`require-param` (typisierte Props und
Interface-Felder). Gefunden und behoben: 3 unnötige Type-Assertions, 1 Methode ohne `this` (jetzt `static`).

### WN3 – Build-Ausgabe wird nicht in CI gegengeprüft – ✅ erledigt
`widgets/liebherr-home/` ist committed (Installation von GitHub). CI baut sie nicht nach; ein vergessenes
`npm run build:widgets` fiele nicht auf. Der Build ist reproduzierbar (gleiche Quellen → byte-gleiche Ausgabe, geprüft).
Möglich: CI-Schritt „build:widgets + git diff --exit-code“.
**Erledigt 2026-10-24:** CI-Job `widgets` (lint:widgets, build:widgets, `git diff --exit-code -- widgets` inkl. neuer
Dateien). Reproduzierbarkeit zusätzlich in einem Klon an anderem Pfad geprüft (byte-gleich).
Nebenbefund: Die Module-Federation-Chunks hießen nach ihrem virtuellen Modul (bis 143 Zeichen) – ein Klon in einen
tieferen Windows-Pfad scheiterte an MAX_PATH. Jetzt `assets/mf-[hash].js` (`vite.config.mts`); Widget danach in
VIS-2 (dev-server) geladen, Kacheln mit Live-Werten, keine Konsolenfehler.

## Qualität (ISO 25010)

- **Funktionale Eignung:** Kachel und Dialog im dev-server mit echten Gerätedaten geprüft (Kühlschrank, Gefrierschrank),
  Handy-Breite 390 px geprüft.
- **Wartbarkeit:** Gerätemodell als reine Funktionen (`src-widgets/src/model.ts`); Contract-Test
  `src/lib/model/widget-contract.test.ts` baut den Objektbaum mit dem echten `DeviceStore` aus den Fixtures und prüft,
  dass das Widget ihn versteht (7 Tests, insgesamt 68).
- **Benutzbarkeit:** Touch-Ziele ≥ 44 px, echte `<button>` mit `aria-pressed`/`aria-label`, `aria-live` für Sync und Sollwert,
  Fokus auf „Schließen“ beim Öffnen, Esc schließt.
- **Übertragbarkeit:** 11 Sprachen; `en`, `de` und `ru` müssen vorhanden sein, sonst liest `I18n.extendTranslations`
  die Datei falsch (bei 8.1 gefunden und behoben).

## Nicht auditiert

- Verhalten in VIS-2-Versionen vor 2.20 und in älteren Browsern (Build-Ziel `chrome89`).
- Bottle-Timer und Urlaubsmodus: fehlen in der HomeAPI, siehe `docs/api-abgleich.md`.

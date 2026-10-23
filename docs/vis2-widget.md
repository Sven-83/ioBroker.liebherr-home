# VIS-2-Widget „Liebherr-Gerät“ – Konzept

Stand: 2026-10-23 · Phase 8 · ersetzt den Entwurf `liebherr-vis2-widget-konzept.md` (vor der API-Analyse geschrieben)

Visueller Entwurf: Design-Canvas „Liebherr VIS-2 Widget“ (klickbar, privat), Stand Version 4.

## 1. Ziel

- Keine eigene VIS-Seite für die Kühlgeräte. Auf der Hauptseite je eine **Kachel** pro Gerät.
- Klick auf die Kachel öffnet ein **Pop-up (Dialog)** mit Zustand und Steuerung.
- **Keine Regler/Räder**, kein Wischen, kein Pull-to-refresh. Bedient wird nur über Tasten.
- Optik im **Jäger-Stil** wie beim Klima-Dashboard: dunkles Waldgrün mit Amber.

## 2. Entscheidung: Widget-Set im Adapter selbst

Das Widget wird als React-Widget-Set (Vite + Module Federation) direkt in `ioBroker.liebherr-home` ausgeliefert, kein eigenes Paket, kein iframe.

| Variante | Bewertung |
|---|---|
| iframe-Kachel + iframe-Pop-up | ❌ Das Pop-up wird am iframe-Rahmen abgeschnitten. |
| HTML-Widget + Dialog-View | ⚠️ Logik und Optik verstreut, nicht wiederverwendbar. |
| **Widget-Set im Adapter (React)** | ✅ Nativ in VIS-2, Dialog im selben DOM, ein Widget für alle Geräte, kommt mit dem Adapter. |

**So kommt es in VIS-2 (geprüft am Quelltext von vis-2, `src/lib/install.ts` / `readAdapterList`):** VIS-2 nimmt beim Start
jeden Adapter mit Instanz, der `common.visWidgets` hat, und kopiert dessen Ordner `widgets/` in seine eigenen Dateien.
Deshalb `restartAdapters: ["vis-2"]` in `io-package.json`. Ein reines Widget-Paket (`onlyWWW`) ist nicht nötig.

## 3. Was die HomeAPI hergibt (und was nicht)

Grundlage: `docs/api-abgleich.md`, Fixtures der eigenen Geräte.

| Im Entwurf vorgesehen | Realität |
|---|---|
| Ist-Temperatur mit Nachkomma (`5,2°`) | Temperaturen sind `int32` → ganze Grad (`3°`, `−18°`) |
| BioFresh-Modi Fisch/Frisch/Gemüse | `BioFreshPlusControl` mit `ZERO_ZERO`, `ZERO_MINUS_TWO`, `MINUS_TWO_MINUS_TWO`, `MINUS_TWO_ZERO` – an Svens Kühlschrank nicht vorhanden |
| HydroBreeze an/aus | Modus `OFF`/`LOW`/`MEDIUM`/`HIGH` → Segment-Tasten |
| IceMaker, MaxIce | `IceMakerControl` `OFF`/`ON`/`MAX_ICE` (MaxIce nur bei `hasMaxIce`) – am Gefrierschrank nicht vorhanden |
| Tür offen, Temperaturalarm | **gibt die API nicht** |
| Eco, Urlaubsmodus | **gibt die API nicht** |
| Restlaufzeit SuperCool/SuperFrost | **gibt die API nicht** → nur „aktiv · endet automatisch“ |
| Push für Tür/Alarm | Push gibt es (SSE), Tür/Alarm nicht |

**Svens Geräte:** Kühlschrank IRBbi 4170: `temperature` (Zone 0, 3 … 9 °C), `hydrobreeze`, `supercool`, `partymode`, `nightmode`.
Gefrierschrank GNP 3755: `temperature` (Zone 0, −28 … −14 °C), `superfrost`.
Beobachtet: Party-Modus schaltet SuperCool mit ein.

## 4. Datenquelle: bestehender Objektbaum

Das Widget passt sich dem Baum des Adapters an (siehe `CLAUDE.md` → Objektstruktur), nicht umgekehrt.

| Zweck | State (relativ zu `liebherr-home.0.<deviceKey>`) | Typ / Rolle | rw |
|---|---|---|---|
| Name | `info.name` | string | ro |
| Gerätetyp | `info.type` (`FRIDGE`, `FREEZER`, …) | string | ro |
| Erreichbar | `info.reachable` | boolean | ro |
| Letzte Meldung | `info.lastUpdate` | number (ts) | ro |
| Ist-Temperatur | `zones.<n>.temperature` | `value.temperature` | ro |
| Soll-Temperatur | `zones.<n>.setpoint` (`common.min/max/step`) | `level.temperature` | rw |
| Zonen-Funktionen | `zones.<n>.supercool`, `.superfrost` | `switch` | rw |
| Zonen-Modi | `zones.<n>.hydrobreeze`, `.icemaker`, `.biofreshplus` (`common.states`) | `level.mode` | rw |
| Geräte-Funktionen | `functions.partymode`, `functions.nightmode` | `switch` | rw |
| Präsentationslicht | `functions.presentationlight` (`min/max`) | `level.dimmer` | rw |
| Instanz-Echtzeit | `liebherr-home.0.info.realtime` | boolean | ro |

- `autodoor` und `raw.*` zeigt das Widget nicht an (Tür bewegt sich physisch; Rohdaten sind nichts für die Kachel).
- Unbekannte `switch`-States in `zones.*`/`functions.*` erscheinen generisch als Schalter mit ihrem Namen.

**Capabilities = vorhandene States.** Das Widget liest beim Start die Objekte unter `<deviceKey>.*` und zeigt nur, was existiert
und `common.write=true` hat. Keine Modell-Sonderlogik, kein `info.capabilities`-State.

## 5. UI-Spezifikation

### 5.1 Kachel

| Element | Inhalt |
|---|---|
| Kopf | Icon (Kühlschrank bzw. Schneeflocke nach `info.type`), Name, Statuspunkt |
| Hauptwert | Ist-Temperatur der ersten Zone groß (`3°`), daneben klein `Soll 3°` |
| Chips | nur aktive Funktionen: `HydroBreeze Hoch`, `SuperCool`/`SuperFrost` (amber), `Party` (amber), `Nachtmodus`, `IceMaker`, `BioFresh` |
| Statuspunkt | grün = erreichbar + Echtzeit · amber = Befehl offen oder nur Polling · rot = Gerät nicht erreichbar |

Die Kachel ist ein `<button>`; Klick öffnet den Dialog. Im VIS-Editor öffnet sie nicht.

### 5.2 Dialog

1. **Kopf:** Titel, Sync-Zeile, Schließen-Taste (X). Klick auf den Hintergrund und `Esc` schließen ebenfalls.
2. **Je Zone ein Bereich:** Ist-Temperatur, Soll mit `−`/`+` (Schritt `common.step`, Grenzen `common.min/max`; an der Grenze deaktiviert).
   Zonen-Modi (HydroBreeze, BioFresh, IceMaker) als Segment-Tasten im Bereich der Zone.
   Bei mehreren Zonen heißt der Bereich nach Gerätetyp und Position (z. B. „Kühlzone“, „Gefrierzone oben“).
3. **Funktionen:** Schalter-Kacheln im Raster (SuperCool, SuperFrost, Party-Modus, Nachtmodus, …).
   SuperCool/SuperFrost zeigen „aktiv · endet automatisch“.
4. **Statuszeile:** Gerät (erreichbar/nicht), Verbindung (Echtzeit/nur Polling/getrennt), letzte Meldung (relativ, z. B. „vor 8 s“).

**Sync-Zeile:**

| Zustand | Text | Farbe |
|---|---|---|
| Echtzeit | „Synchron · Echtzeit“ | ok |
| nur Polling | „Synchron · Polling“ | amber |
| nicht erreichbar | „Gerät nicht erreichbar“ | alarm |
| Befehl offen | „Befehl gesendet · warte auf Bestätigung“ | amber |
| kein ack nach 15 s | „Nicht bestätigt · alter Wert wiederhergestellt“ | alarm |

### 5.3 Bedienregeln

- Nur `−`/`+`, Segment-Tasten und Schalter. Touch-Ziele mindestens 44 px.
- Jede Bedienung schreibt sofort (`setValue`, `ack=false`), kein Bestätigen-Button.
- Ein Befehl ist offen, bis für diesen State ein Wert mit `ack=true` kommt. Der Adapter bestätigt per Readback (live ~3–4 s)
  oder schreibt bei Fehler den echten Wert mit `ack=true` zurück; das Widget zeigt dann einfach diesen Wert.
- Kommt nach 15 s kein ack (Adapter: 0,5 s Debounce + Readback nach 2 s und ggf. 8 s ≈ 10,5 s plus Requests): Anzeige „nicht bestätigt“ und zurück auf den letzten bestätigten Wert.
- Mehrfaches `+` hintereinander ist erlaubt; der Adapter entprellt (Debounce in `writer.ts`).

### 5.4 Handy

Unter ca. 500 px Breite wird der Dialog zum Vollbild-Sheet (Kopf fest, Inhalt scrollt).

### 5.5 Design-Tokens (Jäger)

| Token | Wert | Verwendung |
|---|---|---|
| `bg` | `#0f1a14` | Seitenhintergrund (nur Vorschau) |
| `surface` | `#16241c` | Kachel |
| `dialog` | `#142019` | Dialog |
| `section` | `#1a2a21` | Bereiche im Dialog |
| `control` | `#1b2b22` / `#213529` | Tasten |
| `border` | `#2f4a39` (stark) · `#24382b` (fein) | Rahmen |
| `chip` | `#1f3328` / amber `#3a2f17` | Chips |
| `text` | `#ece7da` | Text |
| `muted` | `#a3b0a5` | Labels |
| `accent` | `#e0a43a` | Soll-Wert, aktive Funktion, offener Befehl |
| `accent-bg` | `rgba(224,164,58,0.14)` | aktive Taste |
| `cold` | `#8cc3d4` | Geräte-Icons |
| `ok` | `#6fbf87` / `#8fc79f` | Statuspunkt / Sync ok |
| `alarm` | `#e5675a` | nicht erreichbar, nicht bestätigt |

- Schrift: Barlow (Text) und Barlow Condensed (Zahlen), **als woff2 im Widget mitgeliefert** (SIL OFL 1.1), keine Anfrage an Google.
- Zahlen deutsch mit echtem Minus `−` (`−18°`); englisch mit `-`.
- Radien: Kachel 18 px, Dialog 22 px, Bereiche 16 px, Tasten 12–14 px.

## 6. Architektur

```
src-widgets/                     eigenes npm-Projekt (private), nicht im Adapter-Paket
├─ package.json                  react, vite, @module-federation/vite, @iobroker/types-vis-2
├─ vite.config.ts                federation: name vis2LiebherrHome, exposes LiebherrDevice + translations
└─ src/
   ├─ LiebherrDevice.tsx         VisRxWidget: Kachel + Dialog
   ├─ model.ts                   Objekte → Gerätemodell (reine Funktionen, testbar)
   ├─ components/                Stepper, Segments, ToggleTile, StatusDot, Dialog
   ├─ theme.ts / fonts/          Jäger-Tokens, Barlow woff2
   └─ i18n/                      de, en (+ Pflichtsprachen)
tools/build-widgets.mjs          baut src-widgets und kopiert nach widgets/liebherr-home/
widgets/liebherr-home/           Build-Ausgabe (customWidgets.js …), committed wie build/
```

`io-package.json`:

```json
"restartAdapters": ["vis-2"],
"visWidgets": {
  "vis2LiebherrHome": {
    "i18n": "component",
    "name": "vis2LiebherrHome",
    "url": "liebherr-home/customWidgets.js",
    "bundlerType": "module",
    "components": ["LiebherrDevice"]
  }
}
```

Widget-Attribute: `device` (Objekt-ID des Geräteordners, z. B. `liebherr-home.0.fridge_db4c8f36`), `title` (optional, sonst `info.name`).
Set-Icon = Adapter-Icon. Werte per `socket.subscribeState`, Befehle per `context.setValue`.
React und MUI kommen von VIS-2 (shared singletons), das Bundle enthält nur das Widget.

## 7. Phase 8

| Schritt | Inhalt | Ergebnis |
|---|---|---|
| 8.1 | Gerüst `src-widgets/`, `visWidgets`, Build nach `widgets/`, Platzhalter-Widget | Widget erscheint in VIS-2 |
| 8.2 | `model.ts` + Kachel mit Live-Werten, Statuspunkt, Chips, Jäger-Theme, Fonts | Kachel live |
| 8.3 | Dialog: Zonen, Stepper, Segmente, Schalter, Sync/ack-Logik mit 15-s-Timeout | Steuerung per Widget |
| 8.4 | i18n, Handy-Sheet, Unit-Tests für `model.ts`, README-Abschnitt, Repochecker, Audit-Nachtrag; Version 0.2.0 | grüner Stand gepusht |

Befehle an echte Geräte beim Test nur nach Svens OK.

## 8. Offene Punkte

- **Bottle-Timer (Gefrierschrank) und Holiday-Mode (Kühlschrank)** gibt es in der App, aber nicht in der HomeAPI
  (Details: `docs/api-abgleich.md` → „Fehlt in der HomeAPI“). Sobald Liebherr sie liefert, als Schalter bzw. eigene Anzeige ergänzen.

- Mehrere Zonen (Kombigeräte): Benennung und Reihenfolge der Bereiche erst mit Fixture prüfbar.
- `info.realtime` gilt für die ganze Instanz, nicht pro Gerät; reicht für den Statuspunkt, solange alle Streams gemeinsam laufen.

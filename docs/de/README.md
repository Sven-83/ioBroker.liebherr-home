# ioBroker.liebherr-home – Deutsche Anleitung

[English](../../README.md)

Liest und steuert Liebherr-Kühl- und -Gefriergeräte über die offizielle, cloudbasierte **Liebherr SmartDevice HomeAPI**.

## Funktionen
- Ist- und Solltemperatur je Zone, SuperCool / SuperFrost, Nachtmodus, Party-Modus
- HydroBreeze, IceMaker, BioFresh-Plus und Präsentationslicht, falls das Gerät sie hat
- Automatische Tür: Status, Öffnen/Schließen nur nach ausdrücklicher Freigabe in den Einstellungen
- Echtzeit-Aktualisierung per Server-Sent Events, regelmäßige Abfrage läuft zum Abgleich weiter
- Es wird nur angelegt, was ein Gerät meldet; unbekannte Funktionen landen als JSON unter `raw`, damit neue
  Funktionen ohne Adapter-Update sichtbar werden
- Seriennummern erscheinen nie in Objekt-IDs, States oder im Log
- VIS-2-Widget: eine Kachel je Gerät mit Pop-up zur Steuerung (siehe unten)

## Voraussetzungen
- Liebherr-Geräte, die in der **SmartDevice-App** eingebunden sind (die HomeAPI sieht nur Geräte, die dort online sind)
- Ein HomeAPI-Key aus der SmartDevice-App (siehe unten)
- Node.js 22 oder neuer, js-controller 6.0.11 oder neuer, Admin 7.6.20 oder neuer
- Internetzugang vom ioBroker-Host zu `home-api.smartdevice.liebherr.com`

## API-Key erzeugen
In der SmartDevice-App: *Einstellungen* → *Beta-Tester werden* → *Beta-Test HomeAPI* aktivieren → *Neuen Key erzeugen*.
Den Key sofort kopieren, er wird nur einmal angezeigt. Ein neuer Key macht den alten ungültig – der Adapter meldet
dann „rejected the API key“, bis der neue Key eingetragen ist.

Die HomeAPI ist ein Beta-Dienst von Liebherr; Felder und Endpunkte können sich ändern.

## Installation
Der Adapter ist noch nicht in den ioBroker-Repositories. Er wird direkt von GitHub installiert:

- **Admin:** auf der Seite *Adapter* das GitHub-Symbol (Installation aus eigener URL) anklicken, den Reiter für eine
  eigene URL wählen und `https://github.com/Sven-83/ioBroker.liebherr-home` eintragen
- **Kommandozeile:** `iobroker url https://github.com/Sven-83/ioBroker.liebherr-home`

Danach eine Instanz anlegen und den API-Key eintragen. Updates kommen nicht automatisch – für ein Update denselben
Befehl erneut ausführen.

## Konfiguration
| Einstellung | Beschreibung |
|---|---|
| API-Key | Key aus der SmartDevice-App. Wird verschlüsselt gespeichert. |
| Echtzeit-Updates (SSE) | Ein Ereignis-Stream pro Gerät; Änderungen kommen in wenigen Sekunden an. Die Abfrage bleibt zum Abgleich aktiv. |
| Öffnen und Schließen automatischer Türen erlauben | Legt pro automatischer Tür einen Befehls-State an. **Die Tür bewegt sich tatsächlich** – nur aktivieren, wenn sich niemand verletzen kann. Standard: aus. |
| Abfrageintervall | Sekunden (60–3600, Standard 300). |

## States
Jedes Gerät bekommt ein Gerät `liebherr-home.<n>.<typ>_<id>`, z. B. `fridge_3f9a1c2e`. Die ID wird aus der
Seriennummer mit einem geheimen Schlüssel (HMAC) und einem zufälligen Salt pro Instanz gebildet und lässt sich
nicht auf die Seriennummer zurückführen. Sie bleibt gleich, solange die Instanz besteht; eine neue Instanz
erzeugt neue IDs (Skripte und VIS dann anpassen).

**`info.*`** (nur lesbar)

| State | Typ | Beschreibung |
|---|---|---|
| `name` | string | Name des Geräts in der SmartDevice-App |
| `model` | string | Modell, z. B. `IRBbi 4170-150 2` |
| `type` | string | `FRIDGE`, `FREEZER`, `COMBI`, `WINE` |
| `reachable` | boolean | Die Cloud erreicht das Gerät |
| `lastUpdate` | number | Letzte Daten aus der Cloud (ms seit 1970) |

**`zones.<n>.*`** – ein Kanal pro Zone (`Zone 0 (top)` …)

| State | Typ | Schreibbar | Beschreibung |
|---|---|---|---|
| `temperature` | number °C/°F | – | Ist-Temperatur |
| `setpoint` | number °C/°F | ✓ | Soll-Temperatur, ganze Grad innerhalb der Gerätegrenzen (`min`/`max` im Objekt) |
| `supercool` / `superfrost` | boolean | ✓ | SuperCool / SuperFrost |
| `hydrobreeze` | string | ✓ | `OFF`, `LOW`, `MEDIUM`, `HIGH` |
| `icemaker` | string | ✓ | `OFF`, `ON`, `MAX_ICE` (falls unterstützt) |
| `biofreshplus` | string | ✓ | Modi, die das Gerät unterstützt |
| `autodoor` | string | – | `CLOSED`, `OPEN`, `MOVING` |
| `autodoorCommand` | boolean | ✓ | `true` öffnet, `false` schließt – nur mit aktivierter Einstellung |

**`functions.*`** – Funktionen ohne Zone

| State | Typ | Schreibbar | Beschreibung |
|---|---|---|---|
| `nightmode` | boolean | ✓ | Nachtmodus |
| `partymode` | boolean | ✓ | Party-Modus (das Gerät schaltet SuperCool mit ein) |
| `presentationlight` | number | ✓ | Helligkeit 0 … max |

**`raw.*`** – Controls unbekannten Typs als JSON (nur lesbar).

**Instanz-States:** `info.connection` (HomeAPI erreichbar, Key akzeptiert) und `info.realtime` (Ereignis-Streams aller Geräte offen).

### Befehle
Befehle werden vor dem Senden geprüft (Wertebereich, ganze Grad, erlaubte Modi). Ungültige Werte werden nicht
gesendet; der State springt auf den echten Wert zurück, und das Log nennt den Grund. Schnelle Änderungen
(z. B. ein Schieberegler) werden zusammengefasst, nur der letzte Wert wird gesendet. Hat die Cloud einen Befehl
angenommen, liest der Adapter den Wert nach und bestätigt ihn mit `ack: true`. Schlägt ein Befehl fehl, wird der
zuletzt bestätigte Wert wiederhergestellt.

## VIS-2-Widget
Der Adapter bringt ein eigenes VIS-2-Widget-Set **Liebherr** mit. Es wird mit dem Adapter installiert; VIS-2 startet
dafür einmal neu.

1. Im VIS-2-Editor **Liebherr-Gerät** aus der Palette auf eine View ziehen.
2. Rechts den Haken bei der Gruppe **Gerät** setzen und unter **Gerät (Geräteordner)** den Ordner wählen, z. B.
    `liebherr-home.0.fridge_3f9a1c2e` (ein beliebiger State in diesem Ordner geht auch).
3. Optional einen **Namen** eintragen; leer = Name aus der SmartDevice-App.

Die **Kachel** zeigt Ist- und Solltemperatur, Chips für aktive Funktionen und einen Statuspunkt
(grün = Echtzeit, amber = Befehl offen oder nur Polling, rot = Gerät nicht erreichbar).
Sie ist für 280 × 220 px ausgelegt und skaliert mit der Widget-Größe; im Editor einfach größer oder kleiner ziehen.
Ein Klick öffnet das **Pop-up**: Solltemperatur mit −/+ in den Grenzen des Geräts, HydroBreeze-, IceMaker- und
BioFresh-Modi als Tasten, Schalter für SuperCool, SuperFrost, Party- und Nachtmodus sowie eine Statuszeile.
Nur Tasten, keine Regler. Jeder Tastendruck wird sofort gesendet; das Pop-up wartet auf die Bestätigung des Adapters
und zeigt „nicht bestätigt“ und den alten Wert, wenn nach 15 s keine kommt. Unter 500 px Breite füllt das Pop-up den
Bildschirm. Das Widget zeigt nur, was das Gerät meldet und was beschreibbar ist. Die Schrift (Barlow, SIL OFL) ist
mitgeliefert, es wird nichts aus dem Internet geladen.

## Sicherheit
- Der API-Key wird verschlüsselt gespeichert und nie in Logs, URLs oder States geschrieben.
- Seriennummern werden in allen Log-Meldungen maskiert und nie in Objekten oder States gespeichert.
- Automatische Türen lassen sich nur nach Aktivieren der zugehörigen Einstellung bewegen.
- Sicherheitslücken bitte vertraulich melden, wie in [SECURITY.md](../../SECURITY.md) beschrieben.

## Bekannte Einschränkungen
- Die HomeAPI ist ein Beta-Dienst; Liebherr kann sie jederzeit ändern.
- Temperaturen nur in ganzen Grad (die API kennt keine Nachkommastellen).
- Es gibt keinen Online-Status; ein Gerät gilt als nicht erreichbar, wenn die Cloud „Gerät nicht erreichbar“ meldet.
- Rate-Limits der HomeAPI sind nicht dokumentiert; der Adapter beachtet HTTP 429 und `Retry-After`, falls sie auftreten.
- Bottle-Timer und Urlaubsmodus gibt es in der SmartDevice-App, aber nicht in der HomeAPI; der Adapter kann sie daher nicht anbieten.
- Getestet mit einem Kühlschrank (IRBbi 4170) und einem Gefrierschrank (GNP 3755). IceMaker, BioFresh-Plus,
  Präsentationslicht, automatische Tür und °F-Geräte sind nach der API-Spezifikation umgesetzt, aber nicht an echten
  Geräten getestet. Ein Integrationstest prüft sie gegen eine simulierte API (Objekte, Befehle, Bestätigung).
  Rückmeldungen von Besitzern solcher Geräte sind willkommen.

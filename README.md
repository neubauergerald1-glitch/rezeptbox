# Geralds Rezeptbox – App

Eigenständige Web-App (PWA) mit allen 642 Rezepten aus der Rezeptbox.
Läuft offline, lässt sich am iPhone/Android wie eine normale App auf den Home-Bildschirm legen
und braucht keinen Server und keine Datenbank: Alles wird lokal im Browser gespeichert (IndexedDB).

## Funktionen
- Suche über Titel, Zutaten, Tags und Notizen
- Filter: Küche, Ernährung, Gang, Sport & Aufwand, Favoriten, Gekocht, Mit Foto
- Sortierung: neueste, beste Bewertung, schnellste, meiste Proteine, A–Z, zufällig
- Rezeptansicht mit Portionsrechner, Zutaten zum Abhaken, Schritten zum Abhaken
- Kochmodus: größere Schrift, Bildschirm bleibt an
- Bewertung, „Schon gekocht“, eigene Notizen, Teilen
- Rezepte anlegen, bearbeiten, löschen, eigenes Foto pro Rezept
- Optional: Rezepte aus Text oder Fotos (Kochbuchseite, Screenshot) mit Claude erfassen –
  dafür in den Einstellungen einen eigenen API-Schlüssel von console.anthropic.com eintragen
- Sicherung als JSON-Datei herunterladen und wieder einspielen (inkl. Fotos)

## Dateien
| Datei | Inhalt |
|---|---|
| `index.html` | Seitengerüst |
| `styles.css` | Gestaltung (hell/dunkel automatisch) |
| `app.js` | gesamte App-Logik |
| `data/recipes.json` | die 642 Rezepte (Startdaten) |
| `sw.js` | Service Worker für den Offline-Betrieb |
| `manifest.webmanifest`, `icons/` | App-Name und Icons für den Home-Bildschirm |

## Starten

Lokal am Computer (im Ordner der App):

```bash
python3 -m http.server 8000
```

Dann im Browser `http://localhost:8000` öffnen.
(Einfach `index.html` doppelklicken funktioniert nicht, weil der Browser dann die Rezeptdaten nicht laden darf.)

## Aufs Handy bringen

Die App muss einmal über eine https-Adresse erreichbar sein, z. B. kostenlos mit
- **Netlify Drop** (app.netlify.com/drop): den ganzen Ordner ins Browserfenster ziehen, fertig.
- **GitHub Pages**: Ordner in ein Repository hochladen, unter Settings → Pages aktivieren.

Am iPhone die Adresse in Safari öffnen → Teilen → „Zum Home-Bildschirm“.
Ab dann startet die Rezeptbox wie eine App und funktioniert auch ohne Internet.

## Täglicher Abgleich mit der Rezeptbox auf claude.ai
Eine geplante Claude-Aufgabe holt jede Nacht den aktuellen Stand aus der Rezeptbox
(Rezepte und bis zu 60 neue Fotos pro Lauf) und legt ihn hier ab:
`data/recipes.json`, `data/meta.json` und `images/`. Erzeugt wird das mit `tools/build_data.py`.

Die App prüft bei jedem Öffnen, ob es einen neueren Stand gibt, und übernimmt ihn:
- neue Rezepte kommen dazu, gelöschte verschwinden,
- ein Rezept wird nur ersetzt, wenn es sich in der Rezeptbox geändert hat –
  Bewertungen oder Notizen, die du nur in der App setzt, bleiben bis dahin erhalten,
- in der App selbst angelegte Rezepte werden nie gelöscht,
- eigene Fotos (in der App gewählt oder per Exportdatei eingespielt) haben Vorrang vor den Fotos hier.

## Hinweise
- Daten bleiben auf dem jeweiligen Gerät. Für den Umzug auf ein anderes Gerät:
  Einstellungen → „Sicherung herunterladen“ und dort „Sicherung einspielen“.
- Der API-Schlüssel wird nur lokal gespeichert und direkt an api.anthropic.com gesendet.
- Neue Rezepte von Websites: Text auf der Website markieren, kopieren und unter
  „Rezept hinzufügen → Text einfügen“ einfügen (Browser-Apps dürfen fremde Websites nicht direkt laden).

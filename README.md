# Humus Bestellungen

Kleine Web-App für Take-away-Bestellungen (Mr. & Mrs. Humus). Läuft im Browser auf Handy und iPad.
Oberfläche komplett auf Deutsch.

- **Kellner**: Speisekarte antippen, Abholzeit wählen, Bestellung senden, später noch ändern (solange nicht „Fertig“).
- **Küche**: Bestellungen erscheinen sofort mit Ton. Einmal tippen = „In Zubereitung“, nochmal = „Fertig“.
- **Admin (Chef)**: Bestellungen nach Datum suchen, Umsatz sehen, als CSV exportieren.

## Aufbau (bewusst klein)

```
Browser (Handy/iPad)  <-- WebSocket (live) -->  Supabase (Frankfurt): Login + Datenbank + Realtime
        ^
   statische Dateien von GitHub Pages
```

| Datei | Inhalt |
|---|---|
| `index.html`, `style.css` | Seite und Aussehen |
| `app.js` | gesamte Logik (Login, Kellner, Küche, Admin) |
| `menu.js` | Speisekarte (Preise in Cent) |
| `config.js` | Supabase-URL und öffentlicher Anon-Key |
| `schema.sql` | Datenbank, Rollen und Zugriffsregeln (einmal ausführen) |

Keine Build-Tools, kein Framework. Einzige Bibliothek: `supabase-js` per CDN.

## Einrichtung

1. Supabase-Projekt anlegen (Region Frankfurt). Registrierung neuer Nutzer ausschalten.
2. Drei Benutzer anlegen: `kellner@…`, `kueche@…`, `chef@…` (der Teil vor dem @ bestimmt die Rolle).
3. `schema.sql` im Supabase **SQL Editor** ausführen.
4. URL und Anon-Key in `config.js` eintragen.
5. Lokal testen: `python3 -m http.server 8000`, dann `http://localhost:8000` öffnen.
6. Veröffentlichen mit GitHub Pages (Settings → Pages → Branch `main`).

## Sicherheit

- Anmeldung mit E-Mail und Passwort, keine öffentliche Registrierung.
- Row Level Security in der Datenbank: Kellner darf senden und ändern (nicht den Status), Küche darf nur den Status ändern, Admin darf alles lesen.
- Der Anon-Key ist öffentlich gedacht. **Niemals** den `service_role`-Schlüssel ins Repository legen.

## Speisekarte ändern

`menu.js` bearbeiten und neu veröffentlichen. Gespeicherte Bestellungen behalten ihre alten Namen und Preise.

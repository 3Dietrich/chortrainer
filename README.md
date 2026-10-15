# Chor-Trainer

Übe-Werkzeug für Chorsänger im Browser: Noten mitlesen, die eigene Stimme hervorheben,
die anderen leiser stellen, Tempo ändern, Takte markieren und wiederholen, einzählen
lassen. Läuft auf Handy und Rechner, auch offline (Service Worker) und als Web-App vom
Startbildschirm.

**Ausprobieren:** [pankd.de/noten](https://pankd.de/noten/) mit dem Lied „Bereit"
(Text: Charlotte Pank, Musik: Dietrich Pank).

Im Einsatz ist der Trainer beim Chor TotalVokal an der Nahe mit dessen
Liedern hinter einem Chor-Login. Beide Fassungen kommen aus diesem Repo.

## Aufbau

- `index.html`: Oberfläche und zugleich Vorlage. Die Abschnitte zwischen
  `<!-- <<KOPF>> -->`, `<<LIEDER>>` und `<<FUSS>>` setzt jeder Ort selbst ein.  
- `trainer.js`: die ganze Logik (MusicXML laden, Stimmen aufteilen, Wiedergabe,
  Bedienung, Hilfe, Offline-Speicher). Listet `index.html` Lieder ohne `data-frei`,
  gibt es einen Chor-Login; sind alle frei, entfällt er.  
- `style.css`, `sw.js` (offline), `manifest.json` und Symbole (Web-App).  
- `alphaTab_v1_8_1.js`: [alphaTab](https://alphatab.net) 1.8.1 (MPL-2.0) mit einer
  Anpassung für das Einzählen (im Code markiert); dazu `sonivox.sf2` aus dem alphaTab-Paket
  und die Notenschrift Bravura (`font/`, SIL OFL).  
- `html-to-image_1_11_11.js` (MIT): Bildschirmfoto für die Rückmeldung (nur im Chor).  
- `ausliefern.py`: bringt den Stand an beide Orte.  
- `werkzeug/symbol.py`: erzeugt die Symbole der öffentlichen Fassung.

Lokal starten: `python3 -m http.server` in diesem Ordner, dann im Browser öffnen.

Das Lied „Bereit" (Noten, Text, Aufnahme) steht nicht unter einer freien Lizenz.

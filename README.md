# Chor-Trainer

Übe-Werkzeug für Chorsänger im Browser: Noten mitlesen, die eigene Stimme hervorheben,
die anderen leiser stellen, Tempo ändern, Takte markieren und wiederholen, einzählen
lassen. Läuft auf Handy und Rechner, auch offline (Service Worker) und als Web-App vom
Startbildschirm.

**Ausprobieren:** [pankd.de/noten](https://pankd.de/noten/) mit dem Lied „Bereit"
(Text: Charlotte Pank, Musik: Dietrich Pank).

Im Einsatz ist der Trainer beim Chor [TotalVokal](https://totalvokal-nahe.de) in Waldböckelheim mit dessen
Liedern hinter einem Chor-Login. Beide Fassungen kommen aus diesem Repo.

## Zwei Orte, ein Motor

Programm und Oberfläche sind an beiden Orten gleich. Verschieden ist nur, was der Ort selbst
mitbringt:

| | pankd.de/noten/ | Chor |
|---|---|---|
| Lieder | nur „Bereit" | alle Lieder des Chors, „Bereit" frei, die übrigen mit Login |
| Titel, Fußzeile | „Bereit · Chor-Trainer", Link zu pankd.de und hierher | „Chor-Trainer", Link zur alten Ansicht |
| Symbol | Noten (`werkzeug/symbol.py`) | Logo des Chors |
| Nur dort | | Login, Rückmeldung mit Bildschirmfoto, Begrüßung, alte Ansicht |

`./ausliefern.py stand` zeigt diese Tabelle für den tatsächlichen Stand, dazu die live
laufenden Versionen und ob ein Ort hinter der Quelle zurückliegt.

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

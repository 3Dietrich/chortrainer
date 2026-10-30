# Klang „Gesang“: Routine

Künstliche Stimmen (MBROLA) singen den Liedtext, synchron zu Noten, Tempo, Bereich und Stimmenwahl.
Gerendert wird auf dem Mac **vor** dem Hochladen. Auf dem Server liegen fertige MP3s, das Handy spielt
sie nur ab.

## Neues oder geändertes Lied

1. In MuseScore ändern, als MusicXML exportieren.  
2. Datei in den Lied-Ordner legen:  
   Verein: `TotalVokal/www.totalvokal.de/trainer/`, neues Lied zusätzlich in `www_dazu/trainer/ort/lieder.html` eintragen  
   pankd: `~/Music/chortrainer/` (nur Bereit)  
3. Ausliefern:  
   `./ausliefern.py tv` bzw. `./ausliefern.py pankd`  
   rendert den Gesang (nur geänderte Lieder) und lädt ihn **vor** `index.html` hoch.  

Neues **freies** Lied beim Verein (ohne Login): außer `data-frei` und der Datei in der `.htaccess`
des Trainers auch `gesang/<Lied>/` freigeben (Muster dort: Bereit).  
Bricht das Hochladen ab: einfach nochmal ausliefern, schon Hochgeladenes wird übersprungen.  

Erst nur schauen: `./ausliefern.py tv -n`  
Nur rendern, nichts hochladen: `./ausliefern.py gesang` (oder `./ausliefern.py gesang Ruhe.musicxml`)  

## Was automatisch passiert

| Fall | Ergebnis im Trainer |
|---|---|
| Lied mit deutschem Text | Gesang, alle Stimmen |
| Stimme ohne Text (z.B. Bass) | singt auf „du“, Hinweis unter „Klang“ |
| Englischer Text | Gesang mit den englischen Stimmen us1 (Frauen) und us3 (Männer) |
| Lied ganz ohne Text | kein Gesang, es klingt „Duu“ |
| Noten geändert, Gesang nicht neu gerendert | Trainer merkt es (stand.txt) und spielt „Duu“, Hinweis |

## Tempo

Vorgerendert in drei Stufen: **100 %, 85 %, 70 %**. Das Handy nimmt die nächstliegende Stufe und dehnt
nur den Rest (genau auf einer Stufe: keine Rechenarbeit).

## Offline

Wer „Gesang“ wählt, bekommt die Spuren aller Stufen in den Offline-Speicher (je Lied 8 bis 20 MB).
Ohne Netz läuft der Gesang dann weiter. Wer bei „Duu“ bleibt, lädt nichts davon.

## Aussprache korrigieren

`werkzeug/gesang.py`, Tabelle `AUSSPRACHE` (Silbe oder Wort → Laute), Tippfehler der Partitur in
`KORREKTUR`. Danach `./ausliefern.py gesang` (Renderer-Version `VERSION` erhöhen, wenn alle Lieder
neu sollen).

## Einmalig auf einem neuen Mac

MBROLA und die Stimmen de5/de6 nach `werkzeug/mbrola/`, Befehle stehen im Kopf von `werkzeug/gesang.py`.
Ohne MBROLA liefert `ausliefern.py` trotzdem aus, nur ohne neuen Gesang.

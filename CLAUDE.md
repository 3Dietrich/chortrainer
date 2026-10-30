# chortrainer: Einstiegs-Karte

**Einzige Quelle des Chor-Trainers** für zwei Orte. Hier entwickeln, nirgends sonst.

| Ort | Adresse | Was dort eigen ist |
|---|---|---|
| pankd | `pankd.de/noten/` (lokal `~/Documents/pankd.de/webseite/noten/`) | nichts: Repo-Inhalt 1:1, nur „Bereit", ohne Login |
| tv | `totalvokal-nahe.de/trainer/` (Repo `~/Documents/Cursor/projects/Waldböckelheim/TotalVokal`, Ordner `www.totalvokal.de/trainer/`) | Liedliste/Titel/Fußzeile in `www_dazu/trainer/ort/*.html`, Lieder, Vereinslogo, manifest, PHP (Login, Rückmeldung), alte Ansicht |

- **Übersicht: `./ausliefern.py stand`** zeigt beide Orte nebeneinander (Motor auf Stand?, Version lokal/live,
  Titel, Lieder, Fußzeile) und was zu tun ist. Bei jeder Frage „wo steht was" zuerst das laufen lassen.  
- **„Liefer aus“ heißt immer alles: Verein (tv), pankd und GitHub-Push** (@dd 2026-10-30: „immer alles, VOR
  ALLEM auf / für den Verein“). Ohne „liefer aus“ wird nichts ausgeliefert.  
- Nie in `~/Documents/pankd.de/webseite/noten/` korrigieren: dort überschreibt die nächste Auslieferung alles.  
- Ausliefern: `./ausliefern.py pankd` bzw. `./ausliefern.py tv [Lied.musicxml …]`, `-n` = nur zeigen.
  Vorher hier committen (tv verlangt das; der Commit steht in der Vereins-Commit-Message).  
- `ausliefern.py tv` lädt über das `hochladen.sh` des Vereins hoch (Lied-Prüfung, Versionsnummer),
  committet dort und führt die Versionsleiter nach. `hochladen.sh` direkt bricht ab, wenn der
  Motor im Vereins-Ordner von hier abweicht.  
- Die Motor-Dateien im Vereins-Ordner sind Kopien: dort nie ändern. Steht eine direkte Änderung
  dort, bricht `ausliefern.py tv` ab (Stand: `ort/motor-stand.json`).  
- Login-Logik: `MIT_LOGIN` in `trainer.js` = es gibt Lieder ohne `data-frei`. Davon hängen Schlösser,
  Login-Eintrag, Rückmeldung, Hinweistexte und die ungefragte Startbildschirm-Begrüßung ab.  
- Vereinslogo (TV) nie in die öffentliche Fassung; deren Symbol kommt aus `werkzeug/symbol.py`.  
- Klang „Gesang“: `werkzeug/gesang.py` rendert je Lied MBROLA-Spuren (3 Tempo-Stufen) nach `gesang/<Lied>/`
  bzw. `gesang/tv/<Lied>/` (gitignoriert). `./ausliefern.py gesang` rendert, was veraltet ist; `pankd`/`tv`
  rendern vor dem Ausliefern selbst und laden die Spuren mit hoch. MBROLA und Stimmen: `werkzeug/mbrola/`
  (gitignoriert, Einrichtung im Kopf von gesang.py). Englischer Text: Stimmen us1/us3 (espeak-ng en-us).  
- Prüfbilder nach `.shots/` (gitignoriert). Test lokal headless (Playwright), Ports 8780-8799 vorher prüfen.  
- Repo ist öffentlich (github.com/3Dietrich/chortrainer): keine Vereinslieder, keine Zugangsdaten,
  nichts aus dem Vereins-Repo außer dem Motor.

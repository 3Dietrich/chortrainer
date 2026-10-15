# chortrainer: Einstiegs-Karte

**Einzige Quelle des Chor-Trainers** für zwei Orte. Hier entwickeln, nirgends sonst.

| Ort | Adresse | Was dort eigen ist |
|---|---|---|
| pankd | `pankd.de/noten/` (lokal `~/Documents/pankd.de/webseite/noten/`) | nichts: Repo-Inhalt 1:1, nur „Bereit", ohne Login |
| tv | `totalvokal-nahe.de/trainer/` (Repo `~/Documents/Cursor/projects/Waldböckelheim/TotalVokal`, Ordner `www.totalvokal.de/trainer/`) | Liedliste/Titel/Fußzeile in `www_dazu/trainer/ort/*.html`, Lieder, Vereinslogo, manifest, PHP (Login, Rückmeldung), alte Ansicht |

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
- Prüfbilder nach `.shots/` (gitignoriert). Test lokal headless (Playwright), Ports 8780-8799 vorher prüfen.  
- Repo ist öffentlich (github.com/3Dietrich/chortrainer): keine Vereinslieder, keine Zugangsdaten,
  nichts aus dem Vereins-Repo außer dem Motor.

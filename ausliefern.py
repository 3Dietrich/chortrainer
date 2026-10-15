#!/usr/bin/env python3
"""Chor-Trainer an seine beiden Orte ausliefern. Quelle ist immer dieses Repo.

    ./ausliefern.py pankd            öffentliche Fassung (nur Bereit) nach pankd.de/noten/
    ./ausliefern.py tv [Lied.musicxml …]
                                     Motor in den Chor-Trainer des Vereins (totalvokal-nahe.de/trainer/)
    -n                               nur anzeigen, was sich ändern würde
    ./ausliefern.py tv --pruefen     Rückgabe 1, wenn der Vereins-Ordner nicht dem Motor entspricht
                                     (ruft hochladen.sh im Verein vor jedem Upload auf)

Motor = Programmdateien (MOTOR) plus index.html als Vorlage. Die Abschnitte zwischen
<!-- <<KOPF>> -->, <<LIEDER>> und <<FUSS>> gehören dem Ort: pankd nimmt die Vorlage, wie sie
ist; der Verein setzt seine Fassung aus TotalVokal/www_dazu/trainer/ort/*.html ein.
Alles andere (Lieder, Symbole, Manifest, PHP) liegt nur am jeweiligen Ort.

pankd: kopiert nach ~/Documents/pankd.de/webseite/noten/ und gleicht mit abgleich.py ab
(vorher und nachher, damit nichts vom Server übergangen wird).
tv: schreibt geänderte Motor-Dateien in den Vereins-Ordner, lädt sie mit dessen
hochladen.sh hoch (Lied-Prüfung, Versionsnummer) und committet dort samt Versionsleiter.
Wurde eine Motor-Datei im Vereins-Ordner direkt geändert, bricht es ab, statt sie zu
überschreiben (Stand der letzten Auslieferung: ort/motor-stand.json).
"""
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

QUELLE = Path(__file__).resolve().parent
MOTOR = ['trainer.js', 'style.css', 'sw.js', 'alphaTab_v1_8_1.js', 'sonivox.sf2',
         'html-to-image_1_11_11.js'] + sorted(
    str(p.relative_to(QUELLE)) for p in (QUELLE / 'font').iterdir() if not p.name.startswith('.'))
PANKD_EIGEN = ['manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
               'favicon-32.png', 'Bereit.musicxml', 'bereit.mp3']
ABSCHNITTE = ['KOPF', 'LIEDER', 'FUSS']

PANKD = Path.home() / 'Documents/pankd.de'
PANKD_ZIEL = PANKD / 'webseite/noten'
TV = Path.home() / 'Documents/Cursor/projects/Waldböckelheim/TotalVokal'
TV_ZIEL = TV / 'www.totalvokal.de/trainer'
TV_ORT = TV / 'www_dazu/trainer/ort'
TV_STAND = TV_ORT / 'motor-stand.json'

VERSION_RE = [
    (re.compile(r'(name="trainer-version" content=")[^"]*'), r'\g<1>{v}'),
    (re.compile(r'((?:style\.css|trainer\.js)\?v=)[^"]*'), r'\g<1>{v}'),
]


def sha(daten):
    return hashlib.sha256(daten).hexdigest()


def version_von(html):
    m = re.search(r'name="trainer-version" content="([^"]*)"', html)
    return m.group(1) if m else ''


def version_setzen(html, v):
    for muster, ersatz in VERSION_RE:
        html = muster.sub(ersatz.replace('{v}', v), html)
    return html


def ohne_version(daten):
    """index.html ohne Versionsnummern, damit nur echte Änderungen zählen."""
    return version_setzen(daten.decode(), '').encode()


def index_bauen(abschnitte=None, version=''):
    """Vorlage mit den Abschnitten des Orts füllen (None = Vorlage unverändert)."""
    html = (QUELLE / 'index.html').read_text()
    for name, inhalt in (abschnitte or {}).items():
        muster = re.compile(r'(<!-- <<%s>> -->)(.*?)(<!-- <</%s>> -->)' % (name, name), re.S)
        if len(muster.findall(html)) != 1:
            sys.exit(f'Abschnitt {name} fehlt in der Vorlage index.html')
        html = muster.sub(lambda m: m.group(1) + inhalt + m.group(3), html)
    return version_setzen(html, version) if version else html


def git_stand(ordner):
    sauber = not subprocess.run(['git', 'status', '--porcelain'], cwd=ordner,
                                capture_output=True, text=True).stdout.strip()
    kopf = subprocess.run(['git', 'log', '-1', '--format=%h %s'], cwd=ordner,
                          capture_output=True, text=True).stdout.strip()
    return sauber, kopf


def pankd(nur_zeigen):
    abgleich = [str(PANKD / 'abgleich.py')]
    if not nur_zeigen:
        print('== Abgleich vorher (Serverstand holen)')
        subprocess.run(abgleich, cwd=PANKD, check=True)
    PANKD_ZIEL.mkdir(exist_ok=True)
    alt_index = PANKD_ZIEL / 'index.html'
    alte_version = version_von(alt_index.read_text()) if alt_index.exists() else ''
    neu = {f: (QUELLE / f).read_bytes() for f in MOTOR + PANKD_EIGEN}
    neu['index.html'] = index_bauen(version=alte_version or 'neu').encode()
    geaendert = [f for f, d in neu.items()
                 if not (PANKD_ZIEL / f).exists() or (PANKD_ZIEL / f).read_bytes() != d]
    if not geaendert:
        print('pankd.de/noten/ ist schon auf dem Stand der Quelle.')
        return
    v = time.strftime('%Y.%m.%d-%H%M')
    neu['index.html'] = index_bauen(version=v).encode()
    if 'index.html' not in geaendert:
        geaendert.append('index.html')
    print(f'Version {v}, geändert:', *geaendert, sep='\n  ')
    if nur_zeigen:
        return
    for f in geaendert:
        ziel = PANKD_ZIEL / f
        ziel.parent.mkdir(parents=True, exist_ok=True)
        # Neue Änderungszeit (nicht die der Quelle): abgleich.py lässt die neuere Fassung gewinnen
        ziel.write_bytes(neu[f])
    print('== Abgleich nachher (hochladen)')
    subprocess.run(abgleich, cwd=PANKD, check=True)
    print('Live: https://pankd.de/noten/')


def tv_abschnitte():
    return {n: (TV_ORT / f'{n.lower()}.html').read_text() for n in ABSCHNITTE}


def tv_vergleich():
    """(geändert, Konflikte, neue Inhalte) für den Vereins-Ordner."""
    stand = json.loads(TV_STAND.read_text()) if TV_STAND.exists() else None
    alt_index = (TV_ZIEL / 'index.html').read_text()
    neu = {f: (QUELLE / f).read_bytes() for f in MOTOR}
    neu['index.html'] = index_bauen(tv_abschnitte(), version_von(alt_index)).encode()
    geaendert, konflikte = [], []
    for f, d in neu.items():
        p = TV_ZIEL / f
        alt = p.read_bytes() if p.exists() else None
        if alt == d:
            continue
        geaendert.append(f)
        vergleich = ohne_version(alt) if (alt and f == 'index.html') else alt
        if alt is not None and stand is not None and stand.get(f) != sha(vergleich):
            konflikte.append(f)
    return geaendert, konflikte, neu


def tv(lieder, nur_zeigen, pruefen, ueberschreiben):
    geaendert, konflikte, neu = tv_vergleich()
    if pruefen:
        if geaendert:
            print('Chor-Trainer: diese Motor-Dateien weichen von ~/Music/chortrainer ab:',
                  *geaendert, sep='\n  ')
            print('Hochladen bitte über ~/Music/chortrainer/ausliefern.py tv [Lieder …]')
            sys.exit(1)
        return
    if konflikte and not ueberschreiben:
        print('Diese Motor-Dateien wurden im Vereins-Ordner direkt geändert (nicht über die Quelle):',
              *konflikte, sep='\n  ')
        print('Änderung nach ~/Music/chortrainer übernehmen, oder mit --ueberschreiben verwerfen'
              ' (z.B. nach einer Notbremse mit zurueck.sh).')
        sys.exit(1)
    sauber, kopf = git_stand(QUELLE)
    if not sauber and not nur_zeigen:
        sys.exit('~/Music/chortrainer hat ungesicherte Änderungen: erst committen, dann ausliefern.')
    if not geaendert and not lieder:
        print('Der Vereins-Ordner ist schon auf dem Stand der Quelle.')
        return
    print('Motor-Dateien:', *(geaendert or ['(keine)']), sep='\n  ')
    if nur_zeigen:
        return
    for f in geaendert:
        (TV_ZIEL / f).write_bytes(neu[f])
    unter = [f for f in geaendert if '/' in f]
    oben = [f for f in geaendert if '/' not in f and f != 'index.html']
    subprocess.run([str(TV / 'www_dazu/trainer/hochladen.sh'), *oben, *lieder], check=True)
    if unter:
        print('Achtung, Unterordner lädt hochladen.sh nicht hoch, bitte von Hand:', *unter, sep='\n  ')
    # Stand der Auslieferung merken (index.html ohne Versionsnummer, die setzt hochladen.sh)
    stand = {f: sha((TV_ZIEL / f).read_bytes()) for f in MOTOR}
    stand['index.html'] = sha(ohne_version((TV_ZIEL / 'index.html').read_bytes()))
    TV_STAND.write_text(json.dumps(stand, indent=1, sort_keys=True) + '\n')
    git = lambda *a: subprocess.run(['git', *a], cwd=TV, check=True)
    git('add', '--', str(TV_ZIEL.relative_to(TV)), str(TV_ORT.relative_to(TV)))
    git('commit', '-q', '-m', f'Trainer: Motor aus chortrainer {kopf}')
    subprocess.run([str(TV / 'www_dazu/trainer/versionsleiter.py')], cwd=TV, check=True)
    git('add', 'www_dazu/trainer/VERSIONEN.md')
    git('commit', '-q', '-m', 'Versionsleiter nachgeführt')
    print('Live: https://totalvokal-nahe.de/trainer/')


def main():
    args = sys.argv[1:]
    schalter = {a for a in args if a.startswith('-')}
    rest = [a for a in args if not a.startswith('-')]
    if not rest or rest[0] not in ('pankd', 'tv'):
        sys.exit(__doc__)
    if rest[0] == 'pankd':
        pankd('-n' in schalter)
    else:
        tv(rest[1:], '-n' in schalter, '--pruefen' in schalter, '--ueberschreiben' in schalter)


if __name__ == '__main__':
    main()

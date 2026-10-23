#!/usr/bin/env python3
"""Chor-Trainer an seine beiden Orte ausliefern. Quelle ist immer dieses Repo.

    ./ausliefern.py stand            Übersicht: beide Orte nebeneinander, live-Versionen,
                                     ob der Motor dort dem Stand der Quelle entspricht
    ./ausliefern.py pankd            öffentliche Fassung (nur Bereit) nach pankd.de/noten/
    ./ausliefern.py tv [Lied.musicxml …]
                                     Motor in den Chor-Trainer des Vereins (totalvokal-nahe.de/trainer/)
    -n                               nur anzeigen, was sich ändern würde
    ./ausliefern.py tv --pruefen     Rückgabe 1, wenn der Vereins-Ordner nicht dem Motor entspricht
                                     (ruft hochladen.sh im Verein vor jedem Upload auf)
    ./ausliefern.py gesang [Lied.musicxml …]
                                     Gesangsspuren (Klang „Gesang“) für alle Lieder beider Orte
                                     rendern, nur wo Noten oder Renderer sich geändert haben

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

Gesang: pankd und tv rendern vor dem Ausliefern die Gesangsspuren ihrer Lieder, wo nötig
(werkzeug/gesang.py, Ablage gesang/<Lied>/ bzw. gesang/tv/<Lied>/, gitignoriert; beide
Orte haben eigene Fassungen derselben Lieder). Lieder mit Spuren bekommen in
index.html data-gesang. pankd lädt sie mit abgleich.py hoch, tv per scp nach gesang/<Lied>/
auf dem Server (vor index.html, damit data-gesang nie ins Leere zeigt).
"""
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.request
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
TV_SERVER = ('tv', 'totalvokal-nahe.de/httpdocs/trainer')   # ssh-Host und Ordner wie in hochladen.sh
GESANG = QUELLE / 'gesang'   # Spuren je Ort: gesang/<Lied> (pankd, wie die Entwicklungsseite) und gesang/tv/<Lied>
GESANG_ORT = {'pankd': GESANG, 'tv': GESANG / 'tv'}

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


def index_bauen(abschnitte=None, version='', ort='pankd'):
    """Vorlage mit den Abschnitten des Orts füllen (None = Vorlage unverändert)."""
    html = (QUELLE / 'index.html').read_text()
    for name, inhalt in (abschnitte or {}).items():
        muster = re.compile(r'(<!-- <<%s>> -->)(.*?)(<!-- <</%s>> -->)' % (name, name), re.S)
        if len(muster.findall(html)) != 1:
            sys.exit(f'Abschnitt {name} fehlt in der Vorlage index.html')
        html = muster.sub(lambda m: m.group(1) + inhalt + m.group(3), html)
    html = gesang_markieren(html, ort)
    return version_setzen(html, version) if version else html


# ---------------------------------------------------------------- Gesang

def gesang_modul():
    """werkzeug/gesang.py, oder None, wenn MBROLA hier nicht eingerichtet ist."""
    sys.path.insert(0, str(QUELLE / 'werkzeug'))
    import gesang
    if not Path(gesang.MBROLA).exists():
        print('Hinweis: MBROLA fehlt (werkzeug/mbrola/), Gesang wird nicht gerendert.')
        return None
    return gesang


def gesang_da(stamm, ort='pankd'):
    """Gibt es Gesangsspuren für dieses Lied?"""
    try:
        return bool(json.loads((GESANG_ORT[ort] / stamm / 'stimmen.json').read_text()).get('stimmen'))
    except (OSError, ValueError):
        return False


def gesang_dateien(stamm, ort='pankd'):
    """Dateinamen der Spuren eines Lieds (ohne Ordner)."""
    return sorted(p.name for p in (GESANG_ORT[ort] / stamm).iterdir() if p.is_file())


def gesang_markieren(html, ort):
    """Lieder mit Gesangsspuren bekommen data-gesang (sofern nicht schon gesetzt)."""
    def option(m):
        tag, stamm = m.group(0), Path(m.group(1)).stem
        if 'data-gesang' in tag or not gesang_da(stamm, ort):
            return tag
        return tag.replace('<option ', f'<option data-gesang="gesang/{stamm}" ', 1)
    return re.sub(r'<option value="([^"]+\.musicxml)"[^>]*>', option, html)


def gesang_rendern(lieder, ort, nur_zeigen=False):
    """Gesang für die Lieder (Pfade) rendern, wo Noten oder Renderer sich geändert haben."""
    g = gesang_modul()
    if not g:
        return
    for lied in lieder:
        ziel = GESANG_ORT[ort] / Path(lied).stem
        if g.aktuell(str(lied), str(ziel)):
            continue
        if nur_zeigen:
            print('Gesang würde neu gerendert:', Path(lied).name)
            continue
        print('Gesang rendern:', Path(lied).name, flush=True)
        g.rendern(str(lied), str(ziel))


def tv_lieder():
    return [TV_ZIEL / f for f in re.findall(r'<option value="([^"]+\.musicxml)"', tv_abschnitte()['LIEDER'])]


def tv_gesang_veraltet():
    """Lieder, deren Gesang auf dem Vereins-Server fehlt oder nicht dem Stand hier entspricht."""
    host, ordner = TV_SERVER
    veraltet = []
    for lied in tv_lieder():
        stamm = lied.stem
        if not gesang_da(stamm, 'tv'):
            continue
        quelle = GESANG_ORT['tv'] / stamm
        lokal = (quelle / 'stand.txt').read_text() + (quelle / 'stimmen.json').read_text()
        r = subprocess.run(['ssh', host, f"cat '{ordner}/gesang/{stamm}/stand.txt' '{ordner}/gesang/{stamm}/stimmen.json'"],
                           capture_output=True, text=True)
        if r.stdout != lokal:
            veraltet.append(stamm)
    return veraltet


def tv_gesang_hochladen(staemme):
    host, ordner = TV_SERVER
    for stamm in staemme:
        dateien = gesang_dateien(stamm, 'tv')
        # stand.txt zuletzt: bricht der Upload ab, gilt der Ordner auf dem Server nicht als aktuell
        dateien.sort(key=lambda f: f == 'stand.txt')
        quelle = GESANG_ORT['tv'] / stamm
        subprocess.run(['ssh', host, f"mkdir -p '{ordner}/gesang/{stamm}' && rm -f '{ordner}/gesang/{stamm}/stand.txt'"], check=True)
        subprocess.run(['scp', '-q', *[str(quelle / f) for f in dateien], f'{host}:{ordner}/gesang/{stamm}/'], check=True)
        print(f'Gesang hochgeladen: {stamm} ({len(dateien)} Dateien)')


def git_stand(ordner):
    sauber = not subprocess.run(['git', 'status', '--porcelain'], cwd=ordner,
                                capture_output=True, text=True).stdout.strip()
    kopf = subprocess.run(['git', 'log', '-1', '--format=%h %s'], cwd=ordner,
                          capture_output=True, text=True).stdout.strip()
    return sauber, kopf


def pankd_vergleich():
    """Dateien, in denen pankd.de/noten/ (lokal) von der Quelle abweicht."""
    alt_index = PANKD_ZIEL / 'index.html'
    alte_version = version_von(alt_index.read_text()) if alt_index.exists() else ''
    neu = {f: (QUELLE / f).read_bytes() for f in MOTOR + PANKD_EIGEN + pankd_gesang()}
    neu['index.html'] = index_bauen(version=alte_version or 'neu').encode()

    def gleich(f, d):
        p = PANKD_ZIEL / f
        if not p.exists():
            return False
        # Versionsmarken (?v=…) zählen nicht als Abweichung
        return ohne_version(p.read_bytes()) == ohne_version(d) if f == 'index.html' else p.read_bytes() == d
    return [f for f, d in neu.items() if not gleich(f, d)]


def pankd_gesang():
    """Gesangsspuren der pankd-Lieder als Pfade relativ zur Quelle (gesang/<Lied>/…)."""
    return [f'gesang/{Path(lied).stem}/{f}' for lied in PANKD_EIGEN
            if lied.endswith('.musicxml') and gesang_da(Path(lied).stem)
            for f in gesang_dateien(Path(lied).stem)]


def pankd(nur_zeigen):
    gesang_rendern([QUELLE / f for f in PANKD_EIGEN if f.endswith('.musicxml')], 'pankd', nur_zeigen)
    abgleich = [str(PANKD / 'abgleich.py')]
    if not nur_zeigen:
        print('== Abgleich vorher (Serverstand holen)', flush=True)
        subprocess.run(abgleich, cwd=PANKD, check=True)
    PANKD_ZIEL.mkdir(exist_ok=True)
    neu = {f: (QUELLE / f).read_bytes() for f in MOTOR + PANKD_EIGEN + pankd_gesang()}
    geaendert = pankd_vergleich()
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
    print('== Abgleich nachher (hochladen)', flush=True)
    subprocess.run(abgleich, cwd=PANKD, check=True)
    print('Live: https://pankd.de/noten/')


def tv_abschnitte():
    return {n: (TV_ORT / f'{n.lower()}.html').read_text() for n in ABSCHNITTE}


def tv_vergleich():
    """(geändert, Konflikte, neue Inhalte) für den Vereins-Ordner."""
    stand = json.loads(TV_STAND.read_text()) if TV_STAND.exists() else None
    alt_index = (TV_ZIEL / 'index.html').read_text()
    neu = {f: (QUELLE / f).read_bytes() for f in MOTOR}
    neu['index.html'] = index_bauen(tv_abschnitte(), version_von(alt_index), 'tv').encode()
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
    if not pruefen:
        gesang_rendern(tv_lieder(), 'tv', nur_zeigen)
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
    gesang_hoch = tv_gesang_veraltet()
    if not geaendert and not lieder and not gesang_hoch:
        print('Der Vereins-Ordner ist schon auf dem Stand der Quelle.')
        return
    print('Motor-Dateien:', *(geaendert or ['(keine)']), sep='\n  ')
    print('Gesang hochladen:', *(gesang_hoch or ['(nichts)']), sep='\n  ')
    if nur_zeigen:
        return
    # Gesang zuerst: index.html mit data-gesang kommt erst danach auf den Server
    tv_gesang_hochladen(gesang_hoch)
    if not geaendert and not lieder:
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


def live_version(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return version_von(r.read().decode()) or '?'
    except Exception as e:
        return f'nicht erreichbar ({e.__class__.__name__})'


def ort_merkmale(html):
    """Was ein Ort in seiner index.html anders macht, in Kurzform."""
    def text(s):
        return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', s)).strip()
    titel = re.search(r'<title>([^<]*)', html).group(1)
    lieder = re.findall(r'<option value="[^"]*\.musicxml"([^>]*)>([^<]*)', html)
    frei = [n for a, n in lieder if 'data-frei' in a]
    gesperrt = [n for a, n in lieder if 'data-frei' not in a]
    fuss = re.search(r'<!-- <<FUSS>> -->(.*?)<!-- <</FUSS>> -->', html, re.S)
    return {
        'Titel': titel,
        'Lieder frei': ', '.join(frei) or '-',
        'Lieder mit Login': ', '.join(gesperrt) or '- (kein Login)',
        'Fußzeile': text(fuss.group(1)) if fuss else '?',
    }


def stand():
    """Übersicht: Quelle, beide Orte, und worin sie sich unterscheiden."""
    sauber, kopf = git_stand(QUELLE)
    voraus = subprocess.run(['git', 'rev-list', '--count', '@{u}..HEAD'], cwd=QUELLE,
                            capture_output=True, text=True).stdout.strip()
    print(f'Quelle  ~/Music/chortrainer  {kopf}')
    print('        ' + ('alles committet' if sauber else 'UNGESICHERTE Änderungen')
          + (', auf GitHub' if voraus == '0' else f', {voraus or "?"} Commit(s) noch nicht auf GitHub'))
    pk = pankd_vergleich()
    tv_geaendert, tv_konflikte, _ = tv_vergleich()
    pk_html = (PANKD_ZIEL / 'index.html').read_text()
    tv_html = (TV_ZIEL / 'index.html').read_text()

    def motor(geaendert, konflikte=()):
        if konflikte:
            return 'DIREKT GEÄNDERT: ' + ', '.join(konflikte)
        return 'wie die Quelle' if not geaendert else 'veraltet: ' + ', '.join(geaendert)

    pk_live = live_version('https://pankd.de/noten/')
    tv_live = live_version('https://totalvokal-nahe.de/trainer/')
    zeilen = [
        ('', 'pankd.de/noten/', 'totalvokal-nahe.de/trainer/'),
        ('Motor (lokal)', motor(pk), motor(tv_geaendert, tv_konflikte)),
        ('Version lokal', version_von(pk_html), version_von(tv_html)),
        ('Version live', pk_live, tv_live),
    ]
    pm, tm = ort_merkmale(pk_html), ort_merkmale(tv_html)
    zeilen += [(k, pm[k], tm[k]) for k in pm]
    zeilen += [('Symbol', 'Noten (werkzeug/symbol.py)', 'Vereinslogo'),
               ('Nur dort', '-', 'Login, Rückmeldung, alte Ansicht, Begrüßung')]
    b1 = max(len(z[0]) for z in zeilen)
    b2 = max(len(z[1]) for z in zeilen)
    print()
    for a, b, c in zeilen:
        print(f'{a:<{b1}}  {b:<{b2}}  {c}')
    hinweise = []
    if pk:
        hinweise.append('pankd ausliefern: ./ausliefern.py pankd')
    if tv_geaendert and not tv_konflikte:
        hinweise.append('Verein ausliefern: ./ausliefern.py tv')
    if version_von(pk_html) != pk_live:
        hinweise.append('pankd: lokal und live verschieden, abgleich.py in ~/Documents/pankd.de laufen lassen')
    if version_von(tv_html) != tv_live:
        hinweise.append('Verein: lokal und live verschieden (nicht hochgeladen oder Notbremse?)')
    if hinweise:
        print('\nZu tun:', *hinweise, sep='\n  ')


def main():
    args = sys.argv[1:]
    schalter = {a for a in args if a.startswith('-')}
    rest = [a for a in args if not a.startswith('-')]
    if not rest or rest[0] not in ('pankd', 'tv', 'stand', 'gesang'):
        sys.exit(__doc__)
    if rest[0] == 'stand':
        stand()
    elif rest[0] == 'gesang':
        pk = [QUELLE / f for f in PANKD_EIGEN if f.endswith('.musicxml')]
        tv_l = tv_lieder()
        if rest[1:]:   # nur die genannten Lieder (Dateiname genügt)
            namen = {Path(a).name for a in rest[1:]}
            pk, tv_l = [l for l in pk if l.name in namen], [l for l in tv_l if l.name in namen]
        gesang_rendern(pk, 'pankd', '-n' in schalter)
        gesang_rendern(tv_l, 'tv', '-n' in schalter)
    elif rest[0] == 'pankd':
        pankd('-n' in schalter)
    else:
        tv(rest[1:], '-n' in schalter, '--pruefen' in schalter, '--ueberschreiben' in schalter)


if __name__ == '__main__':
    main()

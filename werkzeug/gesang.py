#!/usr/bin/env python3
"""Ein Lied (MusicXML) mit MBROLA singen lassen: Gesangsspuren für den Klang „Gesang“.

Aufruf:  werkzeug/gesang.py <Lied.musicxml> [--ziel <ordner>] [--erzwingen] [--anhoeren <ordner>]

Ziel (Standard gesang/<Lied>/ im Repo, gitignoriert):
  <Trackname>.mp3        Originaltempo, Name genau wie die Spur im Trainer
                         (mehrstimmige Stimmen geteilt wie dort: "Alt 1", "Alt 2")
  <Trackname>_85.mp3 …   vorgerendert langsamer (TEMPI), das Handy dehnt nur noch den Rest
  stand.txt              SHA-256 der MusicXML: der Trainer nimmt die Spuren nur, solange er passt
  stimmen.json           {"stimmen": {Name: "text"|"vokalise"}, "tempi": [...], "version": …}
Ist der Stand aktuell, passiert nichts (--erzwingen rendert trotzdem).

Jede Spur beginnt bei Liedanfang (Takt 1, Schlag 1), Wiederholungen sind ausgeklappt wie
bei alphaTab, Tempoangaben gelten ab ihrer Stelle im Takt. Aussprache: espeak-ng (deutsch)
je Wort, auf die Silben der Partitur verteilt; Korrekturen in AUSSPRACHE. Englischer Text
(per Wortliste erkannt) singen die Stimmen us1 (Frauen) und us3 (Männer), Aussprache espeak-ng en-us,
Laute nach der Tabelle von espeak-ng (phsource/mbrola/us) auf MBROLA-us umgesetzt (ENGLISCH).

MBROLA (AGPL) und die Stimmen de5/de6 liegen in werkzeug/mbrola/ (gitignoriert):
  git clone https://github.com/numediart/MBROLA werkzeug/mbrola/MBROLA && make -C werkzeug/mbrola/MBROLA
  Stimmen: https://github.com/numediart/MBROLA-voices/tree/master/data/de5 (und de6, us1, us3) nach werkzeug/mbrola/voices/
"""
import argparse, functools, math, os, re, subprocess, sys, xml.etree.ElementTree as ET
import numpy as np, soundfile as sf

HIER = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HIER)
MBROLA = os.path.join(HIER, 'mbrola', 'MBROLA', 'Bin', 'mbrola')
STIMMEN_DB = os.path.join(HIER, 'mbrola', 'voices')
TMP = os.path.join(REPO, '.shots', 'gesang-tmp')
SR = 22050
VERSION = 3          # erhöhen, wenn sich der Klang ändert: dann wird alles neu gerendert
TEMPI = [100, 85, 70]  # vorgerenderte Tempo-Stufen in %
MP3_KBPS = 48        # mono, 22 kHz: reicht für die Stimmen, hält den Offline-Speicher klein

# Vibrato: wenig Tonhöhe, mehr Lautstärke
VIB_HZ, VIB_CENT, VIB_AM, VIB_EIN, VIB_RAMPE = 5.2, 4, 0.15, 0.22, 0.35

STEP = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
VOKALE = {'a', 'a:', 'e:', 'E', 'E:', 'I', 'i:', 'O', 'o:', 'U', 'u:', 'Y', 'y:', '2:', '9', '@', '6',
          'aI', 'aU', 'OY'}
DIPHTHONG = {'aI': ('a', 'I'), 'aU': ('a', 'U'), 'OY': ('O', 'Y')}
KONS_MS = {'VOR': 80, 'p': 70, 't': 70, 'k': 70, 'b': 60, 'd': 60, 'g': 60, '?': 40, 'h': 70, 'R': 55,
           'f': 90, 'v': 70, 's': 100, 'z': 80, 'S': 100, 'Z': 90, 'C': 100, 'x': 100, 'j': 60,
           'ts': 100, 'tS': 110, 'pf': 90, 'm': 75, 'n': 70, 'N': 70, 'l': 70}
VOKALE_DE, DIPHTHONG_DE, KONS_MS_DE = VOKALE, DIPHTHONG, KONS_MS
ATEM_MS = 180      # Pause bei Komma/Punkt
VOKALISE = 'du'    # Silbe für Stimmen ohne Text
LAUTHEIT = 0.063   # Ziel-RMS je Stimme (-24 dBFS)
VOKAL_MIN = 60     # kürzester Vokal; Konsonanten werden notfalls gestaucht

# Partitur-Tippfehler und eigene Aussprache (Silbe/Wort -> SAMPA, Leerzeichen getrennt)
KORREKTUR = {'fur': 'für', 'geich': 'gleich'}
AUSSPRACHE = {}

# espeak-ng (Mnemonik) -> SAMPA der MBROLA-Stimmen de5/de6
ESPEAK = {'_!': '?', '_|': '?', 'r': 'R', '3': '6', 'W': '9', 'Y:': '2:', 'A:': 'a:', 'A': 'a',
          'pF': 'pf', 'y': 'Y', 'i': 'i:', 'e': 'e:', 'o': 'o:', 'u': 'u:', 'a#': 'a', '@2': '@',
          'E2': 'E', 'aI@': 'aI', 'I2': 'I', 'aa': 'a:', '@-': '@'}

# Englisch: espeak-ng en-us (Mnemonik) -> SAMPA der MBROLA-Stimmen us1/us3
# (nach espeak-ng phsource/mbrola/us; p/t/k ohne Behauchung, sonst unverändert)
ENGLISCH = {'a#': '@', '@2': '@', '@5': '@', '@/': '@', '3': 'r=', 'I2': 'I', 'a': '{', 'aa': '{',
            '@L': '@ l', 'l/2': 'l', 'r/': 'r', 'r-': 'r', 'w/': 'w', ';': '', 'g-': '', 'x': 'k', '@-': '',
            'aI@': 'AI @', 'aI3': 'AI r=', 'aU@': 'aU r', '*': '4', 't#': '4', '3:': 'r=', 'IR': 'r=',
            'VR': 'r=', 'i:': 'i', 'A:': 'A', 'u:': 'u', 'eI': 'EI', 'aI': 'AI', 'oU': '@U', 'O:': 'O',
            '0': 'A', 'O2': 'O', 'O@': 'O r', 'o@': 'O r', 'A@': 'A r', 'e@': 'E r', 'U@': 'U r',
            'i@': 'I @', 'i@3': 'i r', 'I#': '@', 't2': 't', '?': 't', 'n-': 'n', 'e': 'E', 'o': '@U',
            'oI': 'OI', 'OI': 'OI'}
VOKALE_EN = {'i', 'I', 'E', '{', 'A', 'O', 'U', 'u', 'V', '@', 'r=', 'EI', 'AI', 'OI', '@U', 'aU'}
# Diphthonge sind in us1/us3 eigene Laute und bleiben meist ganz (geteilt wurde aus „Go“ ein „Long“).
# Nur AI wird auf A gehalten und gleitet am Ende nach I, ganz klang „night“ wie „näääaiit“ (@dd)
DIPHTHONG_EN = {'AI': ('A', 'I')}
# Konsonanten länger als im Deutschen, sonst verschluckt MBROLA-us die Anlaute (g, b, d nach Pausen)
KONS_EN = {'T': 90, 'D': 80, 'r': 80, 'w': 80, 'dZ': 100, '4': 40, 'g': 80, 'b': 80, 'd': 70, 'l': 90,
           'n': 80, 'm': 90, 'h': 90, 'k': 70, 't': 70, 'p': 70, 'p_h': 65, 't_h': 65, 'k_h': 65, 's': 75}
# Knall der Plosive lauter (Faktor, nur ein Fenster von 20 ms), sonst gehen t/p/k im Chor unter (Wunsch @dd)
PLOSIV_EN = {'p': 2.5, 't': 2.5, 'k': 2.5, 'p_h': 2.5, 't_h': 2.5, 'k_h': 2.5, 'b': 1.8, 'd': 1.8, 'g': 1.8,
             'tS': 1.8, 'dZ': 1.6}
HAUCH_EN = 0.15  # Lautstärke des Hauchs nach dem Knall von p/t/k („sTHHay“), 45 ms lang
ANSATZ_EN_MS = 70    # erstes Stück eines langen Vokals (ms): so lang dauert der Übergang vom Konsonanten
# MBROLA-Knall ist zu schwach: künstlicher Knall (abklingendes Rauschen, 12 ms) im Verhältnis zur
# Lautstärke des folgenden Vokals, Klangfarbe je Laut (t hell, k mittel, p dumpf)
KNALL_EN = {'t': 0.9, 't_h': 0.9, 'k': 0.8, 'k_h': 0.8, 'p': 0.7, 'p_h': 0.7}
# ganze englische Spur so viel früher (s); 0,05 klang zu früh (@dd 30.10.), darum aus
VORZIEHEN_EN = 0.0
SPRACHE = 'de'   # 'en' setzt rendern() für Lieder mit englischem Text


def sprache_setzen(sprache):
    """Laut-Tabellen der Sprache wählen (Deutsch ist der Grundzustand des Moduls)."""
    global SPRACHE, VOKALE, DIPHTHONG, KONS_MS
    SPRACHE = sprache
    VOKALE, DIPHTHONG, KONS_MS = ((VOKALE_EN, DIPHTHONG_EN, {**KONS_MS_DE, **KONS_EN}) if sprache == 'en'
                                  else (VOKALE_DE, DIPHTHONG_DE, KONS_MS_DE))


# ---------------------------------------------------------------- Partitur lesen

def zahl(el, tag, std=0):
    t = el.findtext(tag)
    return int(t) if t else std


def ablauf(part):
    """Takt-Reihenfolge mit Wiederholungen/Volten: [(taktindex, durchgang)]."""
    takte = part.findall('measure')
    vor, zurueck, volta = {}, {}, {}
    offen = None
    for i, m in enumerate(takte):
        for bl in m.findall('barline'):
            rep = bl.find('repeat')
            if rep is not None and rep.get('direction') == 'forward':
                vor[i] = True
            if rep is not None and rep.get('direction') == 'backward':
                zurueck[i] = int(rep.get('times') or 2)
            e = bl.find('ending')
            if e is not None and e.get('type') == 'start':
                offen = {int(x) for x in re.findall(r'\d+', e.get('number') or '1')}
        if offen:
            volta[i] = offen
        for bl in m.findall('barline'):
            e = bl.find('ending')
            if e is not None and e.get('type') in ('stop', 'discontinue'):
                offen = None
    folge, i, anfang, durchgang, spruenge = [], 0, 0, 1, {}
    while i < len(takte):
        if vor.get(i) and i != anfang:
            anfang, durchgang = i, 1
        if i in volta and durchgang not in volta[i]:
            # alphaTab wertet das Wiederholungszeichen auch in einem übersprungenen Klammer-Takt aus
            # (Fire in your heart: Rücksprung nach Takt 25, der in Durchgang 1 und 3 nicht klingt)
            if i in zurueck and spruenge.get(i, 0) < zurueck[i] - 1:
                spruenge[i] = spruenge.get(i, 0) + 1
                durchgang += 1
                i = anfang
                continue
            i += 1
            continue
        folge.append((i, durchgang))
        if i in zurueck and spruenge.get(i, 0) < zurueck[i] - 1:
            spruenge[i] = spruenge.get(i, 0) + 1
            durchgang += 1
            i = anfang
            continue
        if i in zurueck:
            spruenge[i] = 0
            anfang, durchgang = i + 1, 1
        i += 1
    return folge


def takt_inhalt(m, div, stimme=None):
    """Noten eines Takts: [(offset_q, dauer_q, element)], Tempos [(offset_q, bpm)], Länge, div."""
    q, noten, tempi, laenge = 0.0, [], [], 0.0
    for el in m:
        if el.tag == 'attributes' and el.find('divisions') is not None:
            div = int(el.findtext('divisions'))
        if el.tag == 'note':
            d = zahl(el, 'duration') / div
            if el.find('chord') is not None:
                if stimme is None or schluessel(el) == stimme:
                    noten.append((noten[-1][0] if noten else q, d, el))
                continue
            if stimme is None or schluessel(el) == stimme:
                noten.append((q, d, el))
            if el.find('grace') is None:
                q += d
        elif el.tag == 'backup':
            q -= zahl(el, 'duration') / div
        elif el.tag == 'forward':
            q += zahl(el, 'duration') / div
        for snd in ([el] if el.tag == 'sound' else el.iter('sound')):
            if snd.get('tempo'):
                tempi.append((q, float(snd.get('tempo'))))
        laenge = max(laenge, q)
    return noten, tempi, laenge, div


def schluessel(n):
    return f"{n.findtext('staff') or '1'}-{n.findtext('voice') or '1'}"


def spuren(root):
    """Trainer-Spuren wie createSoloAudioTracks: [(name, part, stimmschlüssel|None)]."""
    namen = {sp.get('id'): sp.findtext('part-name') for sp in root.iter('score-part')}
    aus = []
    for p in root.findall('part'):
        keys = sorted({schluessel(n) for n in p.iter('note')})
        if len(keys) > 1:
            aus += [(f'{namen[p.get("id")]} {k + 1}', p, key) for k, key in enumerate(keys)]
        else:
            aus.append((namen[p.get('id')], p, None))
    return aus


def zeitachse(root):
    """Für den Ablauf: Startsekunde und Tempos jedes gespielten Takts (aus der 1. Stimme)."""
    erste = root.find('part')
    takte = erste.findall('measure')
    folge = ablauf(erste)
    div, bpm, t, info = 1, 120.0, 0.0, []
    infos = []
    for m in takte:
        _, tempi, laenge, div = takt_inhalt(m, div)
        infos.append((tempi, laenge))
    for i, durchgang in folge:
        tempi, laenge = infos[i]
        abschnitte = []   # (offset_q, bpm) ab Taktanfang
        aktuell = bpm
        abschnitte.append((0.0, aktuell))
        for q, b in sorted(tempi):
            if q >= laenge and laenge > 0:
                continue   # gilt ab dem nächsten Takt
            abschnitte.append((q, b))
        info.append({'takt': i, 'durchgang': durchgang, 'start': t, 'tempi': abschnitte})
        for k, (q0, b) in enumerate(abschnitte):
            q1 = abschnitte[k + 1][0] if k + 1 < len(abschnitte) else laenge
            t += (q1 - q0) * 60 / b
        bpm = sorted(tempi)[-1][1] if tempi else abschnitte[-1][1]
    return info, t


def zeit_im_takt(takt, q):
    t = takt['start']
    ab = takt['tempi']
    for k, (q0, b) in enumerate(ab):
        q1 = ab[k + 1][0] if k + 1 < len(ab) else float('inf')
        if q <= q1:
            return t + (q - q0) * 60 / b
        t += (q1 - q0) * 60 / b
    return t


def silben_lesen(root, part, stimme, achse, vokalise=None):
    """[{start, ende, text, wort, atem, teile=[(a, e, hz)]}] einer Spur, ausgeklappt.
    vokalise: Silbe für eine Spur ganz ohne Text (jede Note neu, Bindebogen hält)."""
    takte = part.findall('measure')
    divs, d = [], 1
    for m in takte:   # divisions je Takt (kann sich ändern)
        a = m.find('attributes/divisions')
        if a is not None:
            d = int(a.text)
        divs.append(d)
    silben, wort = [], []
    for takt in achse:
        m = takte[takt['takt']]
        noten, _, _, _ = takt_inhalt(m, divs[takt['takt']], stimme)
        letzte_q = None
        for q, dq, n in noten:
            if n.find('rest') is not None or n.find('pitch') is None or n.find('grace') is not None:
                continue
            if n.find('chord') is not None and letzte_q == q:
                continue   # Akkord: oberste/erste Note singt
            letzte_q = q
            p = n.find('pitch')
            midi = 12 * (zahl(p, 'octave') + 1) + STEP[p.findtext('step')] + int(float(p.findtext('alter') or 0))
            hz = 440.0 * 2 ** ((midi - 69) / 12)
            a, e = zeit_im_takt(takt, q), zeit_im_takt(takt, q + dq)
            lyr = n.findall('lyric')
            ly = next((l for l in lyr if l.get('number') == str(takt['durchgang'])), None)
            if ly is None and lyr:
                ly = lyr[0]
            text = (ly.findtext('text') or '').strip() if ly is not None else ''
            gebunden = any(t.get('type') == 'stop' for t in n.findall('tie'))
            if vokalise and not gebunden:
                text = vokalise
            if text and re.search(r'\w', text):
                syl = (ly.findtext('syllabic') if ly is not None and not vokalise else None) or 'single'
                sauber = re.sub(r'[^\wäöüÄÖÜß\'‿ ]', '', text).replace('‿', ' ')
                sauber = KORREKTUR.get(sauber, sauber)
                s = {'start': a, 'ende': e, 'text': sauber, 'atem': bool(re.search(r'[,.;:!?]$', text)),
                     'teile': [(a, e, hz)], 'syl': syl}
                silben.append(s)
            elif silben and abs(silben[-1]['ende'] - a) < 1e-6:
                # Melisma oder Bindebogen: Vokal der Silbe davor weiterziehen
                silben[-1]['teile'].append((a, e, hz))
                silben[-1]['ende'] = e
    return silben


# ---------------------------------------------------------------- Aussprache

def espeak(text):
    return list(_espeak(text, SPRACHE))


@functools.lru_cache(maxsize=None)
def _espeak(text, sprache):
    out = subprocess.run(['espeak-ng', '-v', 'en-us' if sprache == 'en' else 'de', '-q', '-x', '--sep= ', text],
                         capture_output=True, text=True).stdout
    laute = []
    for tok in out.split():
        tok = tok.replace("'", '').replace(',', '')
        if not tok or tok == '_':
            continue
        if sprache == 'en':
            laute += ENGLISCH.get(tok, tok).split()
        else:
            laute.append(ESPEAK.get(tok, tok))
    if sprache == 'en':
        # p/t/k vor Vokal behaucht wie im Englischen (nicht nach s: sp, st, sk), sonst fehlen die Plosive
        for i, l in enumerate(laute):
            if l in ('p', 't', 'k') and i + 1 < len(laute) and laute[i + 1] in VOKALE_EN \
                    and not (i and laute[i - 1] == 's'):
                laute[i] = l + '_h'
    return tuple(laute)


def kerne(laute):
    return [i for i, l in enumerate(laute) if l in VOKALE]


def silben_laute(silben):
    """Jeder Silbe ihre Laute geben: Wörter am Stück aussprechen, dann aufteilen."""
    i = 0
    while i < len(silben):
        j = i
        while silben[j]['syl'] in ('begin', 'middle') and j + 1 < len(silben):
            j += 1
        gruppe = silben[i:j + 1]
        wort = ''.join(s['text'] for s in gruppe)
        if wort in AUSSPRACHE and len(gruppe) == 1:
            gruppe[0]['laute'] = AUSSPRACHE[wort].split()
        else:
            laute = espeak(wort)
            k = kerne(laute)
            if len(k) == len(gruppe) and len(gruppe) > 1:
                grenzen = [0]
                for g in range(1, len(gruppe)):
                    cluster = list(range(k[g - 1] + 1, k[g]))
                    eigen = espeak(gruppe[g]['text'])
                    kk = kerne(eigen)
                    an = len([l for l in eigen[:kk[0]] if l != '?']) if kk else 1
                    an = min(an, len(cluster))
                    grenze = k[g] - an
                    # Knacklaut gehört immer zur folgenden Silbe (ver-irrt)
                    while grenze > k[g - 1] + 1 and laute[grenze - 1] == '?':
                        grenze -= 1
                    grenzen.append(grenze)
                grenzen.append(len(laute))
                for g, s in enumerate(gruppe):
                    s['laute'] = laute[grenzen[g]:grenzen[g + 1]]
            elif len(gruppe) == 1:
                gruppe[0]['laute'] = laute
            else:
                for s in gruppe:
                    s['laute'] = espeak(s['text'])
        for s in gruppe:
            if s['text'] in AUSSPRACHE:
                s['laute'] = AUSSPRACHE[s['text']].split()
            if re.fullmatch(r'(?i)m+h*|hm+', s['text']):
                s['laute'] = ['m']   # Summen
            # Englisch: auf langen Tönen kein Schwa halten („won-der-lllll“): Vokal der Silbe für sich
            if SPRACHE == 'en' and s['ende'] - s['start'] >= 0.4:
                k = kerne(s['laute'])
                if len(k) == 1 and s['laute'][k[0]] == '@':
                    voll = [l for l in espeak(s['text']) if l in VOKALE_EN and l != '@']
                    if voll:
                        s['laute'] = s['laute'][:k[0]] + [voll[0]] + s['laute'][k[0] + 1:]
        i = j + 1


def zerlegen(laute):
    k = kerne(laute)
    if not k:   # kein Vokal: erster stimmhafter Laut trägt den Ton (Summen)
        trag = next((x for x in laute if x in ('m', 'n', 'N', 'l')), 'm')
        return [], trag, []
    # weitere Vokale in derselben Silbe (selten) fallen weg
    return laute[:k[0]], laute[k[0]], [l for l in laute[k[0] + 1:] if l not in VOKALE]


# ---------------------------------------------------------------- MBROLA-Steuerdatei

def vib_tiefe(t):
    return min(1.0, max(0.0, (t - VIB_EIN) / VIB_RAMPE))


def tonkurve(s, t_start, dauer_ms, versatz_ms=0):
    """Tonhöhenpunkte über einen Laut; versatz_ms = Abstand zum Tonbeginn (Teilstück)."""
    pkt = []
    schritt = max(20, int(dauer_ms / 40) + 1)   # MBROLA begrenzt die Punkte je Laut
    for t in range(0, int(dauer_ms) + 1, schritt):
        abs_t = t_start + t / 1000
        hz = next((h for a, e, h in s['teile'] if a <= abs_t < e), s['teile'][-1][2])
        tt = t + versatz_ms
        cent = VIB_CENT * vib_tiefe(tt / 1000) * math.sin(2 * math.pi * VIB_HZ * abs_t)
        if tt < 40:
            cent -= 25 * (1 - tt / 40)   # kleiner Ansatz von unten
        pkt.append(f'{100 * t / max(1, dauer_ms):.1f} {hz * 2 ** (cent / 1200):.1f}')
    return ' '.join(pkt)


def pho_bauen(silben, vorlauf):
    """Laute mit absoluten Zeiten (ms ab vorlauf vor dem ersten Einsatz) -> .pho-Zeilen.
    Gerundet wird auf absolute Grenzen, damit sich nichts aufsummiert."""
    teile = [zerlegen(s['laute']) for s in silben]
    # Vokal-Anlaut ("ein", "all"): mitten in der Phrase ohne Knacklaut gebunden
    # (Ruhe‿ein), sonst setzt MBROLA aus der Stille weich und hörbar zu spät an.
    # Nach einer Pause beginnt der Vokal darum etwas vor dem Schlag (VOR).
    for i, (an, vok, ab) in enumerate(teile):
        if an and an[0] == '?':
            gebunden = i > 0 and not silben[i - 1]['atem'] and silben[i]['start'] - silben[i - 1]['ende'] < 0.001
            teile[i] = ([] if gebunden else ['VOR']) + an[1:], vok, ab
        elif not an:
            frei = i == 0 or silben[i - 1]['atem'] or silben[i]['start'] - silben[i - 1]['ende'] >= 0.001
            if frei and vok in VOKALE:
                teile[i] = ['VOR'], vok, ab
    an_ms = [[KONS_MS.get(l, 70) for l in t[0]] for t in teile]
    ab_ms = [[KONS_MS.get(l, 70) for l in t[2]] for t in teile]
    null = silben[0]['start'] * 1000 - vorlauf * 1000
    ereignisse = []   # (laut, start_ms, ende_ms, silbe|None, hz)
    for i, s in enumerate(silben):
        an, vok, ab = teile[i]
        beat = s['start'] * 1000 - null
        if i + 1 < len(silben):
            naechst = silben[i + 1]['start'] * 1000 - null
            luecke = max(0.0, naechst - s['ende'] * 1000 + null)
            pause = luecke + (ATEM_MS if s['atem'] and luecke < ATEM_MS else 0)
        else:
            naechst = s['ende'] * 1000 - null + 300
            pause = 300
        verf = naechst - beat
        pause = min(pause, max(0.0, verf - VOKAL_MIN))
        # Englisch: stimmhafter Verschlusslaut am Phrasenende (land., sand.) klingt in MBROLA-us
        # wie eine eigene Silbe („lan-də“), darum vor einer Pause stimmlos und kurz (lan-t)
        if SPRACHE == 'en' and pause >= 250 and teile[i][2] and teile[i][2][-1] in ('b', 'd', 'g'):
            teile[i] = teile[i][0], teile[i][1], teile[i][2][:-1] + [{'b': 'p', 'd': 't', 'g': 'k'}[teile[i][2][-1]]]
            ab_ms[i] = ab_ms[i][:-1] + [50]
            ab = teile[i][2]
        nach = an_ms[i + 1] if i + 1 < len(silben) else []
        kons = sum(ab_ms[i]) + sum(nach)
        platz = verf - pause - VOKAL_MIN
        if kons > platz and kons > 0:   # zu eng: Endlaute und nächste Anlaute stauchen
            f = max(0.2, platz / kons)
            ab_ms[i] = [x * f for x in ab_ms[i]]
            if i + 1 < len(silben):
                an_ms[i + 1] = [x * f for x in an_ms[i + 1]]
        # Anlaute vor dem Schlag
        t = beat - sum(an_ms[i])
        vok_start = beat
        for l, d in zip(an, an_ms[i]):
            if l == 'VOR':
                vok_start = t   # Vokal beginnt schon hier
            else:
                ereignisse.append(('_' if l == '?' else l, t, t + d, None, s['teile'][0][2]))
            t += d
        vok_ende = naechst - pause - (sum(an_ms[i + 1]) if i + 1 < len(silben) else 0) - sum(ab_ms[i])
        ereignisse.append((vok, vok_start, vok_ende, s, None))
        t = vok_ende
        for l, d in zip(ab, ab_ms[i]):
            ereignisse.append((l, t, t + d, None, s['teile'][-1][2]))
            t += d
        if pause > 0:
            ereignisse.append(('_', t, t + pause, None, None))
    zeilen, ende = [], 0
    def raus(laut, a, e, rest=''):
        nonlocal ende
        if a > ende + 0.5:   # Lücke auffüllen
            zeilen.append(f'_ {round(a) - round(ende)}')
        d = round(e) - round(max(a, ende))
        if d > 0:
            zeilen.append(f'{laut} {d}{rest}')
        ende = max(ende, e)
    def gesungen(laut, a, e, s):
        # MBROLA schafft höchstens 2000 Perioden je Lautabschnitt: lange Töne in Stücke
        # desselben Lauts teilen (Diphone wie m-m gibt es)
        fmax = max(h for _, _, h in s['teile']) * 1.05
        grenzen = [a]
        # Englisch: MBROLA dehnt den Übergang Konsonant -> Vokal über die halbe Vokallänge, auf langen
        # Tönen kam der Vokal darum hörbar spät („sTHHHaaay“). Kurzes erstes Stück: der Übergang
        # bleibt kurz, der Rest ist derselbe Vokal
        if SPRACHE == 'en' and e - a > 2 * ANSATZ_EN_MS:
            grenzen.append(a + ANSATZ_EN_MS)
        rest_a = grenzen[-1]
        n = max(1, math.ceil((e - rest_a) / 1000 * fmax / 1200))
        grenzen += [rest_a + (e - rest_a) * (k + 1) / n for k in range(n)]
        for a1, e1 in zip(grenzen, grenzen[1:]):
            raus(laut, a1, e1, ' ' + tonkurve(s, s['start'] + (a1 - a) / 1000, e1 - a1, a1 - a))
    for laut, a, e, s, hz in ereignisse:
        if s is not None:
            dauer = e - a
            if laut in DIPHTHONG:
                x, y = DIPHTHONG[laut]
                kurz = min(110, dauer * 0.3)
                gesungen(x, a, e - kurz, s)
                raus(y, e - kurz, e, f" 50 {s['teile'][-1][2]:.1f}")
            else:
                gesungen(laut, a, e, s)
        elif laut == '_':
            raus('_', a, e)
        else:
            raus(laut, a, e, f' 50 {hz:.1f}')
    # lange Pausen teilen
    aus = []
    for z in zeilen:
        teile_z = z.split()
        if teile_z[0] == '_' and int(teile_z[1]) > 5000:
            n = int(teile_z[1])
            while n > 0:
                aus.append(f'_ {min(5000, n)}')
                n -= 5000
        else:
            aus.append(z)
    return aus + ['_ 800']


# ---------------------------------------------------------------- Klang

def lautstaerke_vibrato(x, sr, zeilen):
    g = np.ones(len(x))
    pos = 0.0
    for z in zeilen:
        t = z.split()
        d = float(t[1]) / 1000
        if len(t) > 4:   # gehaltene Töne tragen eine Tonkurve
            i0, i1 = int(pos * sr), min(len(x), int((pos + d) * sr))
            tt = np.arange(i1 - i0) / sr
            tiefe = np.clip((tt - VIB_EIN) / VIB_RAMPE, 0, 1) * np.clip((d - tt) / 0.08, 0, 1)
            g[i0:i1] = 1 + VIB_AM * tiefe * np.sin(2 * np.pi * VIB_HZ * (pos + tt))
        pos += d
    if SPRACHE == 'en':
        f, knall = plosive_formen(x, sr, zeilen)
        return x * g * f + knall
    return x * g


def plosive_formen(x, sr, zeilen):
    """Englisch: Knall der Plosive lauter, Hauch danach leiser („sTHHay“, „apHHart“). Der Hauch liegt
    schon im Übergang zum Vokal (Diphon t-EI), darum eigener Durchgang über die ganze Spur."""
    f = np.ones(len(x))
    zusatz = np.zeros(len(x))
    rng = np.random.default_rng(7)
    pos = 0.0
    for z in zeilen:
        t = z.split()
        d = float(t[1]) / 1000
        if t[0] in PLOSIV_EN:
            # stärkste Änderung im Laut (plus Übergang) = Knall, dort ein Fenster von 20 ms anheben
            i0, i1 = int(pos * sr), min(len(x), int((pos + d + 0.02) * sr))
            if i1 - i0 > 8:
                hp = np.abs(np.diff(x[i0:i1]))
                k = max(1, int(0.001 * sr))
                knall = i0 + int(np.argmax(np.convolve(hp, np.ones(k) / k, mode='same')))
                a, b = max(0, knall - int(0.006 * sr)), min(len(x), knall + int(0.014 * sr))
                f[a:b] = np.maximum(f[a:b], 1 + (PLOSIV_EN[t[0]] - 1) * np.hanning(b - a))
                # danach 45 ms Hauch leiser, weich zurück auf voll
                if t[0] in ('p', 't', 'k', 'p_h', 't_h', 'k_h'):
                    e = min(len(x), b + int(0.045 * sr))
                    n, rampe = e - b, int(0.004 * sr)
                    if n > 4 * rampe:
                        daempf = np.full(n, HAUCH_EN)
                        daempf[:rampe] = np.linspace(1, HAUCH_EN, rampe)
                        daempf[n - 3 * rampe:] = np.linspace(HAUCH_EN, 1, 3 * rampe)
                        f[b:e] = np.minimum(f[b:e], daempf)
                if t[0] in KNALL_EN:
                    vokal = np.abs(x[knall:min(len(x), knall + int(0.15 * sr))])
                    hoehe = KNALL_EN[t[0]] * (np.percentile(vokal, 98) if len(vokal) else 0.1)
                    n = int(0.012 * sr)
                    r = rng.standard_normal(n + 2)
                    if t[0].startswith('t'):
                        r = np.diff(r, 2)          # hell
                    elif t[0].startswith('k'):
                        r = np.diff(r, 1)[:n]      # mittel
                    else:
                        r = np.convolve(r, np.ones(3) / 3, mode='same')[:n]   # dumpf
                    r = r[:n] / (np.max(np.abs(r[:n])) or 1)
                    stoss = hoehe * r * np.exp(-np.arange(n) / (0.003 * sr))
                    e2 = min(len(x), knall + n)
                    zusatz[knall:e2] += stoss[:e2 - knall]
        pos += d
    return f, zusatz


def hall(y, sr):
    n = int(1.2 * sr)
    ir = np.random.default_rng(1).standard_normal(n) * np.exp(-np.arange(n) / (0.25 * sr))
    ir /= np.sqrt(np.sum(ir ** 2))
    nass = np.fft.irfft(np.fft.rfft(y, len(y) + n) * np.fft.rfft(ir, len(y) + n))[:len(y)]
    return 0.8 * y + 0.25 * nass


def auf_sr(x, sr):
    if sr == SR:
        return x
    return np.interp(np.arange(int(len(x) * SR / sr)) * sr / SR, np.arange(len(x)), x)


# ---------------------------------------------------------------- fehlende Diphone

_DIPHON_CACHE = {}


def diphon_da(db, a, b):
    """Kennt die Stimme den Übergang a-b? (einmal mit mbrola getestet, je Stimme in einer Datei gemerkt)"""
    import json
    datei = os.path.join(STIMMEN_DB, f'{db}.diphone.json')
    if db not in _DIPHON_CACHE:
        try:
            with open(datei) as fh:
                _DIPHON_CACHE[db] = json.load(fh)
        except (OSError, ValueError):
            _DIPHON_CACHE[db] = {}
    c = _DIPHON_CACHE[db]
    if f'{a} {b}' not in c:
        os.makedirs(TMP, exist_ok=True)
        pho = os.path.join(TMP, 'diphon.pho')
        with open(pho, 'w') as fh:
            fh.write(f'_ 50\n{a} 80\n{b} 80\n_ 50\n')
        r = subprocess.run([MBROLA, os.path.join(STIMMEN_DB, db), pho, os.path.join(TMP, 'diphon.wav')],
                           capture_output=True, text=True)
        c[f'{a} {b}'] = f'{a}-{b}' not in (r.stdout + r.stderr)
        with open(datei, 'w') as fh:
            json.dump(c, fh, sort_keys=True)
    return c[f'{a} {b}']


def diphone_reparieren(zeilen, db):
    """Fehlt der Stimme ein Übergang (us3: d-t_h in „hand to“), ersetzt mbrola -e ihn stumm durch
    etwas Falsches und der nächste Laut kommt hörbar zu spät. Darum vorher: den Konsonanten vor der
    Lücke durch Stille gleicher Länge ersetzen (bei Verschlusslauten ist das ohnehin der Verschluss)."""
    aus = list(zeilen)
    for i in range(len(aus) - 1):
        a, b = aus[i].split()[0], aus[i + 1].split()[0]
        if (a == '_' and b == '_') or diphon_da(db, a, b):
            continue
        # zuerst Behauchung weglassen (us3 kennt t_h nur nach Vokalen), sonst den Konsonanten davor
        if b.endswith('_h') and diphon_da(db, a, b[:-2]):
            aus[i + 1] = aus[i + 1].replace(b, b[:-2], 1)
        elif a.endswith('_h') and diphon_da(db, a[:-2], b):
            aus[i] = aus[i].replace(a, a[:-2], 1)
        elif a not in VOKALE and a != '_':
            aus[i] = '_ ' + aus[i].split()[1]
        elif b not in VOKALE and b != '_':
            aus[i + 1] = '_ ' + aus[i + 1].split()[1]
        elif a == b:
            pass   # gleicher Vokal (geteilter langer Ton): unten zusammenlegen
        else:
            print(f'  Übergang {a}-{b} fehlt in {db}, bleibt (mbrola -e)')
    # geteilte lange Töne, deren Stimme den Übergang Vokal-gleicher Vokal nicht kennt (us3: @-@),
    # wieder zu einer Zeile zusammenlegen; die Tonhöhenpunkte werden auf die neue Länge umgerechnet
    zus = []
    for z in aus:
        t = z.split()
        if zus and len(t) > 2 and t[0] == zus[-1].split()[0] and len(zus[-1].split()) > 2 \
                and not diphon_da(db, t[0], t[0]):
            v = zus[-1].split()
            d1, d2 = int(v[1]), int(t[1])
            dd = d1 + d2
            pkt = [f'{float(v[i]) * d1 / dd:.1f} {v[i + 1]}' for i in range(2, len(v) - 1, 2)]
            pkt += [f'{100 * d1 / dd + float(t[i]) * d2 / dd:.1f} {t[i + 1]}' for i in range(2, len(t) - 1, 2)]
            zus[-1] = f'{v[0]} {dd} ' + ' '.join(pkt)
        else:
            zus.append(z)
    return zus


def mp3(wav, ziel):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', wav, '-ac', '1', '-b:a', f'{MP3_KBPS}k', ziel], check=True)


def stimme_fuer(name):
    n = name.lower()
    mann = 'tenor' in n or 'bass' in n or 'bariton' in n or 'männer' in n
    if SPRACHE == 'en':
        return 'us3' if mann else 'us1'
    return 'de6' if mann else 'de5'


def englisch(root):
    """Überwiegend englischer Text? (Anteil Wörter aus der englischen Wortliste)"""
    try:
        woerter = {w.strip().lower() for w in open('/usr/share/dict/words')}
    except OSError:
        return False
    ws, cur = [], ''
    for l in root.find('part').iter('lyric'):
        cur += re.sub(r"[^\w']", '', (l.findtext('text') or '').strip())
        if (l.findtext('syllabic') or 'single') in ('single', 'end'):
            ws.append(cur.lower())
            cur = ''
    ws = [w for w in ws if len(w) >= 3]
    return bool(ws) and sum(w in woerter for w in ws) / len(ws) > 0.6


def stand_von(lied):
    import hashlib
    with open(lied, 'rb') as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def aktuell(lied, ziel):
    """Passen die Spuren in ziel noch zu Partitur und Renderer?"""
    import json
    try:
        with open(os.path.join(ziel, 'stand.txt')) as fh:
            if fh.read().strip() != stand_von(lied):
                return False
        with open(os.path.join(ziel, 'stimmen.json')) as fh:
            info = json.load(fh)
        # 'englisch' = von einer Fassung ohne englischen Gesang übersprungen: jetzt nachholen
        return info.get('version') == VERSION and info.get('tempi') == TEMPI and info.get('hinweis') != 'englisch'
    except (OSError, ValueError):
        return False


def rendern(lied, ziel, anhoeren=None, erzwingen=False):
    """Gesang für ein Lied erzeugen; True, wenn neu gerendert wurde."""
    import json, shutil
    if not erzwingen and aktuell(lied, ziel):
        return False
    root = ET.parse(lied).getroot()
    achse, gesamt = zeitachse(root)
    name_lied = os.path.splitext(os.path.basename(lied))[0]
    tmp = os.path.join(TMP, name_lied)
    os.makedirs(tmp, exist_ok=True)
    if os.path.isdir(ziel):
        shutil.rmtree(ziel)   # alte Spuren (auch umbenannte Stimmen) weg
    os.makedirs(ziel)
    info = {'stimmen': {}, 'tempi': TEMPI, 'version': VERSION}
    # Hat das Lied überhaupt Text? Sonst gar kein Gesang (der Synth spielt)
    mit_text = any(re.search(r'\w', l.findtext('text') or '') for l in root.iter('lyric'))
    sprache_setzen('en' if mit_text and englisch(root) else 'de')
    if SPRACHE == 'en':
        info['sprache'] = 'en'
    vorlauf = 1.0
    chor = []
    for name, part, key in (spuren(root) if mit_text else []):
        silben = silben_lesen(root, part, key, achse)
        if silben:
            info['stimmen'][name] = 'text'
        else:
            # Stimme ohne Text in einem Lied mit Text: auf "du" singen
            silben = silben_lesen(root, part, key, achse, vokalise=VOKALISE)
            if not silben:
                continue
            info['stimmen'][name] = 'vokalise'
        silben_laute(silben)
        db = stimme_fuer(name)
        for tempo in TEMPI:
            f = tempo / 100
            # Langsamer singen statt dehnen: Notenzeiten strecken, Konsonanten bleiben natürlich
            sl = [dict(x, start=x['start'] / f, ende=x['ende'] / f,
                       teile=[(a / f, e / f, h) for a, e, h in x['teile']]) for x in silben]
            zeilen = diphone_reparieren(pho_bauen(sl, vorlauf), db)
            pho = os.path.join(tmp, f'{name}_{tempo}.pho')
            roh = os.path.join(tmp, f'{name}_{tempo}_roh.wav')
            with open(pho, 'w') as fh:
                fh.write('\n'.join(zeilen) + '\n')
            r = subprocess.run([MBROLA, '-e', os.path.join(STIMMEN_DB, db), pho, roh], capture_output=True, text=True)
            if r.returncode:
                sys.exit(f'{name_lied}/{name}: mbrola: {r.stderr.strip()}')
            x, sr = sf.read(roh)
            x = auf_sr(lautstaerke_vibrato(x, sr, zeilen), sr)
            y = hall(x, SR)
            # Gleich laut nach Lautheit (RMS der klingenden Stellen), nicht nach Spitze:
            # Frauen- und Männerstimme, Summen und Text passen so zueinander. Die Stimmen
            # werden im Trainer addiert, deshalb mit Reserve (LAUTHEIT ≈ -24 dBFS)
            klingt = np.abs(y) > 0.02 * np.max(np.abs(y))
            rms = np.sqrt(np.mean(y[klingt] ** 2)) if np.any(klingt) else 1.0
            y *= min(LAUTHEIT / max(rms, 1e-9), 0.5 / max(1e-9, np.max(np.abs(y))))
            vz = VORZIEHEN_EN if SPRACHE == 'en' else 0.0
            vorn = np.zeros(max(0, int((sl[0]['start'] - vorlauf - vz) * SR)))
            # Setzt die Stimme früher ein als der Vorlauf lang ist (Takt 1, Schlag 1), liegt sonst die
            # ganze Spur um den Rest des Vorlaufs zu spät: vorn so viel abschneiden
            y = y[max(0, int((vorlauf + vz - sl[0]['start']) * SR)):]
            voll = np.concatenate([vorn, y])
            wav = os.path.join(tmp, f'{name}_{tempo}.wav')
            sf.write(wav, voll, SR)
            mp3(wav, os.path.join(ziel, name + ('' if tempo == 100 else f'_{tempo}') + '.mp3'))
            if tempo == 100:
                chor.append(voll)
        print(f'  {name_lied}/{name} ({db}): {len(silben)} Silben' + (' auf „du“' if info['stimmen'][name] == 'vokalise' else ''))
    with open(os.path.join(ziel, 'stimmen.json'), 'w') as fh:
        json.dump(info, fh, ensure_ascii=False)
    # stand.txt zuletzt: bricht das Rendern ab, gilt der Ordner nicht als aktuell
    with open(os.path.join(ziel, 'stand.txt'), 'w') as fh:
        fh.write(stand_von(lied) + '\n')
    if anhoeren and chor:
        y = np.zeros(max(len(a) for a in chor))
        for a in chor:
            y[:len(a)] += a
        y *= 0.9 / np.max(np.abs(y))
        wav = os.path.join(tmp, 'chor.wav')
        sf.write(wav, y, SR)
        os.makedirs(anhoeren, exist_ok=True)
        mp3(wav, os.path.join(anhoeren, name_lied + '_Chor.mp3'))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('lieder', nargs='+')
    ap.add_argument('--ziel', help='Ordner (nur bei einem Lied); Standard gesang/<Lied>/')
    ap.add_argument('--anhoeren', help='Ordner für eine Chor-Mischung zum Anhören')
    ap.add_argument('--erzwingen', action='store_true')
    args = ap.parse_args()
    for lied in args.lieder:
        ziel = args.ziel or os.path.join(REPO, 'gesang', os.path.splitext(os.path.basename(lied))[0])
        neu = rendern(lied, ziel, args.anhoeren, args.erzwingen)
        print(f'{os.path.basename(lied)}: {"neu gerendert" if neu else "aktuell"}')


if __name__ == '__main__':
    main()

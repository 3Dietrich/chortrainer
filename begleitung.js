/*
 * Begleitung: live begleiten mit einer Taste (@dd 20261104).
 *
 * Ablauf (Akkorde, Sonderstellen) steht in <Lied>.ablauf.json, Text und Takte kommen aus der MusicXML.
 * Plan von @dd (Stimme üben mit Akkorden):
 * - Einstiegsknopf (früher A, @dd 20261107): zeigt Akkord und Ton der eigenen Stimme an der Stelle, an der die
 *   Begleitung steht, am Anfang z.B. „Am (c)“. Gedrückt: der Akkord tippt kurz an, der Ton der eigenen Stimme
 *   bleibt liegen, solange der Finger liegt. Läuft die Begleitung, geht es zurück an den Anfang.
 * - Anfang (z.B. 2:1 "Seele"): davor singen nur die Stimmen. Der erste Tipp startet den Klang, dann hört die
 *   Begleitung hin: der zweite Tipp gilt immer für die nächste Tippstelle (einen Takt bzw. 2/4 später), der Abstand
 *   gibt das Metrum. Das gilt nach jedem Start (Anfang, Pad, Stopp).
 * - Tippen auf: DDs (Stellen und Raster aus dem Ablauf), Takt (jede Eins), 2/4 (Eins und Drei), 1/4 (jeder Schlag).
 * - Nach einem Tipp laufen die Akkorde nur innerhalb desselben Taktes von selbst weiter. Kommt kein Tipp, bleibt
 *   es still; die Uhr schätzt weiter, wo der Chor ist, und der nächste Tipp rastet auf die nächstgelegene Stelle.
 * - Tempo: Mittel aus den Tipp-Abständen, dazu Faktoren aus dem Ablauf (Takt 18 zieht an, Schluss langsamer).
 *   Es ändert sich nur behutsam und bleibt immer zwischen 65 und 120 (@dd 20261107).
 * - Oben steht, welcher Tipp als Nächstes erwartet wird; hält die eigene Stimme dort einen Ton, steht „–“ statt
 *   eines Wortes. Metronom (sanft, dumpf, mit Lautstärke und Tiefpass) klickt, solange die Begleitung läuft.
 *
 * Aufruf: begleitung.html?lied=Bereit.musicxml (Ablauf: Bereit.ablauf.json daneben).
 */
'use strict';

const $ = id => document.getElementById(id);

/* ---------- Einstellungen (nur Bequemlichkeit pro Gerät, alles geht auch ohne Speicher) ---------- */

const SPEICHER = 'begleitung-einstellungen';
// modus: 'stellen' = DDs Stellen aus dem Ablauf, 'takte' = jede Eins, 'halbe' = Eins und Drei (2/4), 'viertel' = jeder Schlag
// waerme = Stereo-Chorus, hoehen = Tiefpass (hieß früher Wärme)
// stimme: aus welcher Stimme der Text kommt ('' = Textstimme des Ablaufs); spiel: 'akkord' oder 'bass' (nur Bass)
// metronom: 'an' | 'aus', metroLaut = Lautstärke, metroFilter = Tiefpass (links dumpf, rechts hell)
// Fest und unsichtbar (@dd 20261107): Wärme 50, Klick ganz dumpf (metroFilter 0); gespeicherte Werte zählen dafür nicht
// Klang-Vorgabe = @dds Einstellung auf der Hörseite (Stand 20261107). Gespeichert wird nur, was davon abweicht:
// wer nichts verstellt hat, bekommt eine neue Vorgabe von selbst, wer verstellt hat, behält seins (Knopf „Klang zurücksetzen“).
const VORGABE = { klang: 'strings', lautstaerke: 66, tiefbass: 96, waerme: 50, hoehen: 11, modus: 'viertel', stimme: '', spiel: 'akkord',
    metronom: 'an', metroLaut: 40, metroFilter: 0, stimmen: 8 };
const FEST = { waerme: 50, metroFilter: 0 };
const KLANG_FELDER = ['klang', 'lautstaerke', 'tiefbass', 'hoehen', 'metroLaut'];
let E = { ...VORGABE };
try {
    const alt = JSON.parse(localStorage.getItem(SPEICHER) || '{}');
    if (!('hoehen' in alt)) delete alt.waerme;   // alte Fassung: dort war waerme der Tiefpass
    delete alt.tempo; delete alt.wach;          // Felder alter Fassungen
    Object.assign(E, alt);
    if (E.klang === 'flaeche') E.klang = 'strings';
} catch (e) { /* privat/gesperrt */ }
Object.assign(E, FEST);
function sichern() {
    const abw = {};
    for (const k of Object.keys(E)) if (E[k] !== VORGABE[k]) abw[k] = E[k];
    try { localStorage.setItem(SPEICHER, JSON.stringify(abw)); } catch (e) { /* egal */ }
}
const TEMPO_MIN = 65, TEMPO_MAX = 120;
const tempoGrenzen = b => Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, b));

/* ---------- MusicXML lesen (Text, Taktanfänge) ---------- */

const SCHRITT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function partiturLesen(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const titel = (doc.querySelector('work-title, movement-title')?.textContent || '').trim();
    const silben = [];
    // je Stimme die klingenden Noten { t, ende, midi, name } (Stimme 1, ohne Pausen): wo ein Ton gehalten wird und
    // welcher Ton zum Einstieg klingt (midi klingend, name deutsch ohne Oktave: c, fis, b, h …)
    const noten = [];
    const partNamen = [...doc.querySelectorAll('part-list score-part')].map(sp => (sp.querySelector('part-name')?.textContent || '').trim());
    let taktAnfaenge = [], ende = 0;
    [...doc.querySelectorAll('part')].forEach((teil, si) => {
        let div = 1, t = 0, verschub = 0;
        const anfaenge = [];
        noten[si] = [];
        for (const takt of teil.querySelectorAll(':scope > measure')) {
            anfaenge.push(t);
            for (const e of takt.children) {
                const dauer = () => +(e.querySelector(':scope > duration')?.textContent || 0) / div;
                if (e.tagName === 'attributes') {
                    const d = e.querySelector('divisions');
                    if (d) div = +d.textContent;
                    // klingende Lage: Transposition, Oktavschlüssel; Tenor im Violinschlüssel ohne Angabe klingt eine Oktave tiefer
                    const tr = e.querySelector('transpose'), clef = e.querySelector('clef');
                    if (tr) verschub = +(tr.querySelector('chromatic')?.textContent || 0) + 12 * +(tr.querySelector('octave-change')?.textContent || 0);
                    if (clef && !tr) {
                        const okt = clef.querySelector('clef-octave-change');
                        verschub = okt ? 12 * +okt.textContent
                            : (clef.querySelector('sign')?.textContent === 'G' && /tenor/i.test(partNamen[si] || '') ? -12 : 0);
                    }
                } else if (e.tagName === 'backup') {
                    t -= dauer();
                } else if (e.tagName === 'forward') {
                    t += dauer();
                } else if (e.tagName === 'note') {
                    if (e.querySelector(':scope > grace') || e.querySelector(':scope > chord')) continue;
                    const d = dauer();
                    const stimme = e.querySelector(':scope > voice')?.textContent.trim();
                    if (stimme && stimme !== '1') { t += d; continue; }
                    const ly = e.querySelector(':scope > lyric');
                    const text = ly?.querySelector('text')?.textContent.trim();
                    if (text) silben.push({ t, stimme: si, text, syl: ly.querySelector('syllabic')?.textContent || 'single' });
                    const ph = e.querySelector(':scope > pitch');
                    if (ph && !e.querySelector(':scope > rest')) {
                        const step = ph.querySelector('step').textContent, alter = Math.round(+(ph.querySelector('alter')?.textContent || 0));
                        const midi = 12 * (+ph.querySelector('octave').textContent + 1) + SCHRITT[step] + alter + verschub;
                        noten[si].push({ t, ende: t + d, midi, name: tonName(step, alter) });
                    }
                    t += d;
                }
            }
        }
        if (si === 0) taktAnfaenge = anfaenge;
        ende = Math.max(ende, t);
    });
    return { titel, silben, noten, taktAnfaenge, ende, stimmen: partNamen };
}

/** deutscher Tonname ohne Oktave: C# → cis, Eb → es, Ab → as, Bb → b, B → h */
function tonName(step, alter) {
    const s = step.toLowerCase();
    if (alter > 0) return s + 'is';
    if (alter < 0) return s === 'b' ? 'b' : s === 'e' ? 'es' : s === 'a' ? 'as' : s + 'es';
    return s === 'b' ? 'h' : s;
}

/**
 * Einstiegston der Stimme si an pos: der Ton, der dort klingt, sonst der nächste innerhalb von zwei Takten.
 * (Kein Rückgriff mehr auf einen Auftakt davor: der Anfang ist 1:1, an 2:1 und 2:2 gilt der Ton dort, @dd 20261108)
 */
function tonFuer(pos, si) {
    const n = si >= 0 && P.noten[si];
    if (!n) return null;
    return n.find(x => x.t < pos + 1e-6 && x.ende > pos + 1e-6) || n.find(x => x.t >= pos - 1e-6 && x.t < pos + 8) || null;
}

/**
 * Was Stimme si an pos tut: 'silbe' (eine Silbe beginnt genau hier), 'halten' (ein Ton klingt weiter oder ein
 * Melisma/Haltebogen ohne neue Silbe), null (Pause oder Stimme unbekannt).
 */
function stimmeAn(pos, si) {
    if (si < 0 || !P.noten[si]) return null;
    if (P.silben.some(x => x.stimme === si && Math.abs(x.t - pos) < 1e-6)) return 'silbe';
    return P.noten[si].some(n => n.t < pos + 1e-6 && n.ende > pos + 1e-6) ? 'halten' : null;
}

let P = null;        // Partitur
let LEIT = [];       // Leitsilben: je Zeitpunkt die Silbe der obersten Stimme mit Text

const stimmeIndex = n => (n ? P.stimmen.findIndex(x => x.toLowerCase() === String(n).toLowerCase()) : -1);

function leitsilbenBilden() {
    // Rang: zuerst die Textstimme aus dem Ablauf (für @dd der Tenor, er singt danach), dann von oben nach unten
    // Rang: Meine Stimme, dann die Textstimme des Ablaufs (Tenor, singt von Anfang an), dann von oben nach unten
    const meine = stimmeIndex(E.stimme), text = stimmeIndex(A && A.textstimme);
    const rang = s => (s.stimme === meine ? -2 : s.stimme === text ? -1 : s.stimme);
    const jeZeit = new Map();
    for (const s of P.silben) {
        const k = s.t.toFixed(4);
        if (!jeZeit.has(k) || rang(jeZeit.get(k)) > rang(s)) jeZeit.set(k, s);
    }
    LEIT = [...jeZeit.values()].sort((a, b) => a.t - b.t);
}

/**
 * Das ganze Wort, in dem die erste Silbe ab pos liegt (in ihrer eigenen Stimme), mit Silbenstrichen; die Silbe an
 * pos fett. Ergebnis { html, letzte } (letzte = Zeit der letzten Silbe des Wortes) oder null.
 * Hält die eigene Stimme an pos einen Ton, fragt der Aufrufer vorher stimmeAn() und zeigt „–“ (@dd 20261107).
 */
function wortAn(pos, bis, stimme = -1, nurSilbe = false) {
    const eigen = stimme >= 0 ? P.silben.filter(x => x.stimme === stimme).sort((a, b) => a.t - b.t) : null;
    const x0 = (eigen || LEIT).find(x => x.t >= pos - 1e-6);
    if (!x0 || x0.t >= bis - 1e-6) return null;
    // Viertel (@dd 20261107): schmale Pads, das ganze Wort passt nicht („Ge-b…“ viermal). Nur die Silbe dieses
    // Schlags, mit Strichen davor/danach, wenn das Wort weitergeht: „Ge-“, „-bor-“, „-gen-“, „-heit“
    if (nurSilbe) {
        const txt = x0.text.replace(/[<>&]/g, '');
        // Wortgrenze wie unten auch bei langer Lücke (Bass: Summen „mh“ ... „su-che“ ist kein Wort)
        const reihe = P.silben.filter(x => x.stimme === x0.stimme).sort((a, b) => a.t - b.t), k = reihe.indexOf(x0);
        const vor = (x0.syl === 'middle' || x0.syl === 'end') && k > 0 && x0.t - reihe[k - 1].t <= 5 ? '-' : '';
        const nach = (x0.syl === 'begin' || x0.syl === 'middle') && reihe[k + 1] && reihe[k + 1].t - x0.t <= 5 ? '-' : '';
        return { html: `${vor}<b>${txt}</b>${nach}`, letzte: x0.t };
    }
    const eigene = P.silben.filter(x => x.stimme === x0.stimme).sort((a, b) => a.t - b.t);
    let i = eigene.indexOf(x0);
    const hier = i;
    // Wortgrenze auch bei langer Lücke (z.B. Summen „mh“ vor „su-che“ im Bass)
    while (i > 0 && (eigene[i].syl === 'middle' || eigene[i].syl === 'end') && eigene[i].t - eigene[i - 1].t <= 5) i--;
    const teile = [];
    let letzte = x0.t;
    for (let k = i; k < eigene.length; k++) {
        const x = eigene[k], txt = x.text.replace(/[<>&]/g, '');
        teile.push(k === hier && x.syl !== 'single' ? `<b>${txt}</b>` : txt);
        letzte = x.t;
        if (x.syl === 'single' || x.syl === 'end' || k - i > 6) break;
        if (eigene[k + 1] && eigene[k + 1].t - x.t > 5) break;
    }
    return { html: teile.join('-'), letzte };
}

/** Weitere Silben der Stimme si zwischen von (ausschließlich) und bis, klein unter dem Wort auf dem Pad */
function kleinText(von, bis, si) {
    if (si < 0) return '';
    let s = '', vorige = null;
    for (const x of P.silben) {
        if (x.stimme !== si || x.t <= von + 1e-6 || x.t >= bis - 1e-6) continue;
        const anhang = x.syl === 'middle' || x.syl === 'end';
        s += (anhang ? '-' : s ? ' ' : '') + x.text.replace(/[<>&]/g, '');
        vorige = x;
    }
    if (vorige && (vorige.syl === 'begin' || vorige.syl === 'middle')) s += '-';
    return s;
}

/**
 * Text von a bis b als HTML: Silben, die nicht aus „Meine Stimme“ kommen (sie singt dort nicht), in anderer
 * Farbe (@dd 20261105: der Text soll für alle Stimmen von Anfang an dastehen, deutlich sichtbar).
 */
function textHtml(a, b) {
    const meine = stimmeIndex(E.stimme);
    const silben = LEIT.filter(x => x.t >= a - 1e-6 && x.t < b - 1e-6);
    // hält die eigene Stimme am Anfang des Abschnitts einen Ton: „–“ statt des Wortes davor (@dd 20261107)
    let h = stimmeAn(a, meine) === 'halten' ? '–' : '';
    silben.forEach((x, k) => {
        const anhang = x.syl === 'middle' || x.syl === 'end';
        const offen = (x.syl === 'begin' || x.syl === 'middle') && k === silben.length - 1;
        const txt = x.text.replace(/[<>&]/g, '') + (offen ? '-' : '');
        h += (anhang || !h ? '' : ' ') + (meine >= 0 && x.stimme !== meine ? `<span class="fremd">${txt}</span>` : txt);
    });
    return h;
}

function textIn(a, b) {
    let s = '';
    for (const x of LEIT) {
        if (x.t < a - 1e-6) continue;
        if (x.t >= b - 1e-6) break;
        const anhang = x.syl === 'middle' || x.syl === 'end';
        s += (anhang || !s ? '' : ' ') + x.text + (x.syl === 'begin' || x.syl === 'middle' ? '-' : '');
    }
    return s.replace(/-(?=\S)/g, '').trim();
}

const taktBeginn = n => P.taktAnfaenge[n - 1];
const taktEnde = n => (n < P.taktAnfaenge.length ? P.taktAnfaenge[n] : P.ende);

/** "18:3" → Position in Vierteln */
function stellePos(s) {
    const [takt, schlag] = s.split(':').map(Number);
    return taktBeginn(takt) + (schlag || 1) - 1;
}

function stelleVon(pos) {
    let i = 0;
    while (i + 1 < P.taktAnfaenge.length && P.taktAnfaenge[i + 1] <= pos + 1e-6) i++;
    return { takt: i + 1, schlag: Math.floor(pos - P.taktAnfaenge[i] + 1e-6) + 1 };
}

/* ---------- Akkordsymbole → Töne ---------- */

const GRUNDTON = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, H: 11, B: 10 };   // deutsch: H = h, B = b
const ART = {
    '': [0, 4, 7], 'm': [0, 3, 7], '7': [0, 4, 7, 10], 'm7': [0, 3, 7, 10], 'maj7': [0, 4, 7, 11],
    '6': [0, 4, 7, 9], 'm6': [0, 3, 7, 9], 'sus4': [0, 5, 7], 'sus2': [0, 2, 7], 'dim': [0, 3, 6],
    '1': [0],   // nur der Grundton (in Oktaven), z.B. "A1" am Schluss
};

function akkordLesen(sym) {
    const m = /^([A-H])(#|b)?(.*)$/.exec(sym.trim());
    if (!m || !(m[3] in ART)) return null;
    const grund = (GRUNDTON[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
    return { grund, toene: ART[m[3]].map(x => (grund + x) % 12) };
}

let letzteLage = [57, 60, 64];   // Oberstimmen des vorigen Akkords, für weiche Stimmführung

/** Bass-Grundton (E2 bis Es3) plus Oberstimmen in enger Lage (G3 bis Bb4), möglichst nah am vorigen Akkord. */
/** Notenname mit Oktave (deutsch: H = h, B = b; auch C#4, Eb3) als MIDI-Nummer */
function notenNummer(n) {
    const m = /^([A-H])(#|b)?(-?\d)$/.exec(n.trim());
    if (!m) return null;
    return 12 * (+m[3] + 1) + GRUNDTON[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

function lageFuer(sym, fest = null) {
    const a = akkordLesen(sym);
    if (!a) return null;
    let bass = 40 + ((a.grund - 4 + 12) % 12);
    const optionen = a.toene.map(pc => [55, 67].map(o => o + ((pc - o % 12 + 12) % 12)).filter(m => m <= 70));
    let beste = null, besteKosten = Infinity;
    const durch = (i, wahl) => {
        if (i === optionen.length) {
            const s = [...wahl].sort((x, y) => x - y);
            if (s[s.length - 1] - s[0] > 12) return;
            const mitte = s.reduce((x, y) => x + y, 0) / s.length;
            const vorMitte = letzteLage.reduce((x, y) => x + y, 0) / letzteLage.length;
            let k = Math.abs(mitte - vorMitte) * 2;
            for (const m of s) k += Math.min(...letzteLage.map(v => Math.abs(v - m)));
            if (k < besteKosten) { besteKosten = k; beste = s; }
            return;
        }
        for (const m of optionen[i]) durch(i + 1, [...wahl, m]);
    };
    if (fest) beste = fest.split(/\s+/).map(notenNummer).filter(x => x != null).sort((x, y) => x - y);
    else if (a.toene.length === 1) beste = [55, 67].map(o => o + ((a.grund - o % 12 + 12) % 12));
    else durch(0, []);
    if (!beste) beste = a.toene.map(pc => 60 + ((pc - 0 + 12) % 12)).sort((x, y) => x - y);
    letzteLage = beste;
    return { bass, oben: beste };
}

/* ---------- Klangerzeugung (WebAudio, ohne Samples) ---------- */

let ctx = null, ausgang = null, lage = null, tonfilter = null, bassBus = null, wachQuelle = null, orgelWelle = null;
let chorusNass = null, vibrato = null, metroBus = null, metroFilter = null;
const klingend = new Map();          // Schlüssel → { stop }

function impuls(sek) {
    const len = Math.floor(ctx.sampleRate * sek), buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let k = 0; k < 2; k++) {
        const d = buf.getChannelData(k);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
}

function audioStart() {
    if (ctx) { if (ctx.state !== 'running') ctx.resume(); return; }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* iOS < 17 */ }
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    const komp = ctx.createDynamicsCompressor();
    komp.threshold.value = -16; komp.ratio.value = 3; komp.attack.value = 0.02; komp.release.value = 0.3;
    ausgang = ctx.createGain();
    // weiche Begrenzung hinter dem Verdichter (wie im Klavier): Summen sättigen rund statt hart abzuschneiden (Knacksen)
    const vor = ctx.createGain(), grenze = ctx.createWaveShaper();
    vor.gain.value = 0.6;
    const kurve = new Float32Array(1025);
    for (let i = 0; i < kurve.length; i++) kurve[i] = Math.tanh(1.5 * (i / 512 - 1)) / Math.tanh(1.5);
    grenze.curve = kurve; grenze.oversample = '2x';
    ausgang.connect(komp).connect(vor).connect(grenze).connect(ctx.destination);
    // lage: Gesamtpegel der Akkorde, die Nachhut blendet hierüber aus
    lage = ctx.createGain();
    lage.connect(ausgang);
    tonfilter = ctx.createBiquadFilter();
    tonfilter.type = 'lowpass'; tonfilter.Q.value = 0.4;
    tonfilter.connect(lage);
    // Wärme: Stereo-Chorus, zwei langsam schwankende Verzögerungen links und rechts
    chorusNass = ctx.createGain();
    const mischer = ctx.createChannelMerger(2);
    for (const [kanal, basis, rate] of [[0, 0.012, 0.31], [1, 0.018, 0.43]]) {
        const v = ctx.createDelay(0.05), lfo = ctx.createOscillator(), tiefe = ctx.createGain();
        v.delayTime.value = basis; lfo.frequency.value = rate; tiefe.gain.value = 0.004;
        lfo.connect(tiefe).connect(v.delayTime); lfo.start();
        tonfilter.connect(v); v.connect(mischer, 0, kanal);
    }
    mischer.connect(chorusNass).connect(lage);
    // Strings: leichtes gemeinsames Vibrato
    vibrato = ctx.createGain(); vibrato.gain.value = 7;   // Cent
    const vl = ctx.createOscillator(); vl.frequency.value = 5.2; vl.connect(vibrato); vl.start();
    // etwas Raum, damit es nicht trocken aus der Box kommt
    const hall = ctx.createConvolver(), nass = ctx.createGain();
    hall.buffer = impuls(2.4); nass.gain.value = 0.28;
    tonfilter.connect(hall).connect(nass).connect(lage);
    bassBus = ctx.createGain();
    bassBus.connect(lage);
    // Orgel: Grundton, Oktave, Quinte darüber, Superoktave (wie gezogene Flötenregister 8', 4', 2 2/3', 2')
    const re = new Float32Array([0, 1, 0.5, 0.22, 0.16, 0.05, 0.04]);
    orgelWelle = ctx.createPeriodicWave(re.map(() => 0), re);
    // Metronom: eigener Weg mit Tiefpass, unabhängig von der Lautstärke der Begleitung
    metroFilter = ctx.createBiquadFilter();
    metroFilter.type = 'lowpass'; metroFilter.Q.value = 0.5;
    metroBus = ctx.createGain();
    metroBus.connect(metroFilter).connect(komp);
    pegelSetzen();
    wachSetzen();
}

function pegelSetzen() {
    if (!ctx) return;
    const jetzt = ctx.currentTime;
    ausgang.gain.setTargetAtTime(Math.pow(E.lautstaerke / 100, 1.6) * 1.4, jetzt, 0.05);
    bassBus.gain.setTargetAtTime(E.tiefbass / 100, jetzt, 0.05);
    tonfilter.frequency.setTargetAtTime(250 * Math.pow(32, E.hoehen / 100), jetzt, 0.05);   // Höhen: 250 bis 8000 Hz
    chorusNass.gain.setTargetAtTime(E.waerme / 100 * 0.9, jetzt, 0.05);
    metroBus.gain.setTargetAtTime(E.metronom === 'an' ? Math.pow(E.metroLaut / 100, 1.6) * 0.9 : 0, jetzt, 0.05);
    metroFilter.frequency.setTargetAtTime(200 * Math.pow(30, E.metroFilter / 100), jetzt, 0.05);   // 200 bis 6000 Hz
}

/** Ein Metronom-Klick: kurzer, weicher Holzton (Dreieck mit kleinem Tonhöhen-Fall), die Eins etwas höher */
function metroKlick(wann, eins) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    const f = eins ? 520 : 390;
    o.type = 'triangle';
    o.frequency.setValueAtTime(f * 1.4, wann);
    o.frequency.exponentialRampToValueAtTime(f, wann + 0.015);
    g.gain.setValueAtTime(0, wann);
    g.gain.linearRampToValueAtTime(eins ? 0.9 : 0.6, wann + 0.004);
    g.gain.setTargetAtTime(0, wann + 0.006, 0.035);
    o.connect(g).connect(metroBus);
    o.start(wann); o.stop(wann + 0.4);
}

function wachSetzen() {
    if (!ctx) return;
    if (!wachQuelle) {
        // Gleichanteil weit unter Hörbarkeit (wie Teufel DC): die Box bekommt nie reine Stille
        wachQuelle = ctx.createConstantSource();
        wachQuelle.offset.value = 0.00002;
        wachQuelle.connect(ctx.destination);
        wachQuelle.start();
    }
}

function haltenAb(p, wann) {
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(wann);
    else { p.cancelScheduledValues(wann); p.setValueAtTime(p.value, wann); }
}

/** art: 'oben' | 'grund' (Bass-Grundton) | 'sub' (Tiefbass eine Oktave darunter); anstieg: feste Einschwingzeit */
/*
 * Stimmenklau (wie im Klavier, @dd 20261107: es knackste): höchstens MAX_STIMMEN Töne gleichzeitig. Kommt einer dazu,
 * verstummt zuerst der älteste schon ausklingende, sonst der älteste. Jeder Ton hängt sich nach dem Ende ganz aus dem
 * Klanggraphen (auch vom Vibrato), sonst sammeln sich tote Knoten und kosten das iPhone Rechenzeit.
 */
// Zahl der Stimmen einstellbar: 4, 6, 8, 12 (@dd 20261108: bei schnellen Tipps knackste es noch). Der gehaltene
// Sington beim Ansingen (Pad, Taste a) wird nie geklaut; die Akkordtöne treten für ihn zurück.
const MAX_STIMMEN = () => E.stimmen || 8;
const aktiv = [];   // klingende Töne, älteste zuerst
function stimmenKappen(max) {
    while (aktiv.length > max) {
        const frei = aktiv.findIndex(v => v !== stimmTon && v.frei());
        const i = frei >= 0 ? frei : aktiv.findIndex(v => v !== stimmTon);
        if (i < 0) break;
        aktiv.splice(i, 1)[0].daempfen();
    }
}

function tonAn(midi, art, wann, weich, anstieg = null) {
    stimmenKappen(MAX_STIMMEN() - 1);
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const knoten = [];   // zum Abhängen nach dem Ende
    const g = ctx.createGain();
    g.gain.value = 0;
    const oszis = [];
    const orgel = E.klang === 'orgel';
    if (art === 'sub') {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        o.connect(g); oszis.push(o); knoten.push(o);
        g.connect(bassBus);
    } else if (orgel) {
        const o = ctx.createOscillator(); o.setPeriodicWave(orgelWelle); o.frequency.value = f;
        o.connect(g); oszis.push(o); knoten.push(o);
        g.connect(tonfilter);
    } else {
        // Strings: zwei leicht verstimmte Sägezähne und ein Dreieck, weich gefiltert, mit Vibrato
        const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = Math.min(f * 4, 4000); nf.Q.value = 0.3;
        for (const [typ, cent, pegel] of [['sawtooth', -7, 0.5], ['sawtooth', 7, 0.5], ['triangle', 0, 0.8]]) {
            const o = ctx.createOscillator(), og = ctx.createGain();
            o.type = typ; o.frequency.value = f; o.detune.value = cent; og.gain.value = pegel;
            if (vibrato) vibrato.connect(o.detune);
            o.connect(og).connect(nf); oszis.push(o); knoten.push(o, og);
            o.vibratoDran = !!vibrato;
        }
        nf.connect(g); knoten.push(nf);
        g.connect(tonfilter);
    }
    // 'stimme': Einstiegston der eigenen Stimme, etwas lauter als ein Akkordton, damit er heraussticht
    const ziel = art === 'sub' ? 0.5 : art === 'grund' ? 0.12 : art === 'stimme' ? 0.17 : 0.1;
    anstieg ??= weich ? 0.35 : (orgel || art === 'sub' ? 0.03 : 0.12);
    knoten.push(g);
    oszis.forEach(o => o.start(wann));
    g.gain.setTargetAtTime(ziel, wann, anstieg);
    let ausAb = Infinity;      // ab hier klingt der Ton aus (für den Stimmenklau „frei“)
    let stumm = Infinity;      // ab hier ist er unhörbar, dann wird er abgeräumt
    let gestoppt = false;
    const stopBei = zeit => {
        if (gestoppt) return;
        gestoppt = true;
        oszis.forEach(o => { try { o.stop(zeit); } catch (e) { /* schon gestoppt */ } });
    };
    const ton = {
        tot: false,
        frei: () => gestoppt || ctx.currentTime >= ausAb,
        stumm: () => ctx.currentTime >= stumm,
        /** neuer Akkord mit diesem Ton: wieder auf volle Stärke (er war vielleicht schon am Ausklingen) */
        frisch(wannNeu, weichNeu) {
            haltenAb(g.gain, wannNeu);
            g.gain.setTargetAtTime(ziel, wannNeu, weichNeu ? 0.35 : anstieg);
            ausAb = stumm = Infinity;
        },
        /** ab wannAus langsam ausklingen, Zeitkonstante tc; nach sieben Zeitkonstanten wird er abgeräumt */
        ausklingen(wannAus, tc) {
            g.gain.setTargetAtTime(0, wannAus, tc);
            ausAb = wannAus; stumm = wannAus + 7 * tc;
        },
        stop(wannAus, abkling) {
            haltenAb(g.gain, wannAus);
            g.gain.setTargetAtTime(0, wannAus, abkling / 3);
            ausAb = wannAus; stumm = wannAus + abkling * 2;
            stopBei(wannAus + abkling * 2 + 0.1);
        },
        /** Stimmenklau: in wenigen Millisekunden weg */
        daempfen() {
            ton.tot = true;
            const t = ctx.currentTime;
            haltenAb(g.gain, t);
            g.gain.setTargetAtTime(0, t, 0.012);
            stopBei(t + 0.08);
        },
        /** Einstiegsakkord (@dd 20261107): 50 ms an, 50 ms halten, dann langes Abklingen (nach 1 s ein Viertel) */
        tupfer(an = 0.05, halten = 0.05, tc = 1 / Math.log(4)) {
            g.gain.cancelScheduledValues(wann);
            g.gain.setValueAtTime(0, wann);
            g.gain.linearRampToValueAtTime(ziel, wann + an);
            g.gain.setValueAtTime(ziel, wann + an + halten);
            g.gain.setTargetAtTime(0, wann + an + halten, tc);
            ausAb = wann + an + halten; stumm = ausAb + 7 * tc;
            stopBei(stumm);
        },
    };
    aktiv.push(ton);
    oszis[0].onended = () => {
        ton.tot = true;
        const i = aktiv.indexOf(ton); if (i >= 0) aktiv.splice(i, 1);
        for (const n of knoten) {
            try { if (n.vibratoDran) vibrato.disconnect(n.detune); } catch (e) { /* schon weg */ }
            try { n.disconnect(); } catch (e) { /* schon weg */ }
        }
    };
    return ton;
}

/** Ausgeklungene Akkordtöne abräumen (laufen sonst unhörbar weiter und kosten Rechenzeit) */
function aufraeumen() {
    if (!ctx) return;
    for (const [k, ton] of klingend) {
        if (ton.tot) klingend.delete(k);
        else if (ton.stumm()) { ton.stop(ctx.currentTime, 0.03); klingend.delete(k); }
    }
}

let akkordJetzt = '';

/** Spielt ein Akkordsymbol. Töne, die schon klingen, klingen ohne Neuanschlag weiter. */
/**
 * dauer (Viertel): fester Notenwert, danach kurz ab. Ohne dauer klingt der Akkord nach zwei Vierteln langsam
 * aus und ist nach einem 4/4-Takt weg (@dd 20261105: "Noten halten ist blöd").
 */
function akkordSpielen(sym, wann, weich, dauer = null, fest = null) {
    akkordJetzt = sym;
    const abkling = E.klang === 'orgel' ? 0.25 : 0.6;
    const viertel = 60 / U.bpm;
    if (sym === '-') { alleAus(wann, 0.4); return; }
    const l = lageFuer(sym, fest);
    if (!l) return;
    const soll = new Map();
    soll.set('g:' + l.bass, [l.bass, 'grund']);
    soll.set('s:' + (l.bass - 12), [l.bass - 12, 'sub']);
    // nur Bass (@dd 20261105): Grundton und Tiefbass, ohne die oberen Töne
    if (E.spiel !== 'bass') l.oben.forEach(m => soll.set('o:' + m, [m, 'oben']));
    for (const [k, ton] of klingend) if (!soll.has(k)) { ton.stop(wann, abkling); klingend.delete(k); }
    for (const [k, [m, art]] of soll) {
        if (klingend.has(k) && !klingend.get(k).tot && !klingend.get(k).stumm()) klingend.get(k).frisch(wann, weich);
        else klingend.set(k, tonAn(m, art, wann, weich));
    }
    for (const ton of klingend.values()) {
        if (dauer) ton.ausklingen(wann + dauer * viertel, Math.max(0.08, abkling / 3));
        else ton.ausklingen(wann + 2 * viertel, 0.5 * viertel);   // nach 4 Vierteln bei etwa -35 dB
    }
}

function alleAus(wann, sek) {
    for (const ton of klingend.values()) ton.stop(wann, sek);
    klingend.clear();
}

/* ---------- Pauke (Wirbel in den Takt 18 hinein, Schlag auf der 1) ---------- */

const PAUKE_HZ = 55;   // großes A
let wirbel = null;     // { ab, bis, naechster } in Sekunden

function paukenSchlag(wann, staerke) {
    const g = ctx.createGain(), o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(PAUKE_HZ * 1.5, wann);
    o.frequency.exponentialRampToValueAtTime(PAUKE_HZ, wann + 0.08);
    g.gain.setValueAtTime(0, wann);
    g.gain.linearRampToValueAtTime(staerke, wann + 0.005);
    g.gain.setTargetAtTime(0, wann + 0.01, staerke > 0.3 ? 0.9 : 0.25);
    o.connect(g).connect(ausgang);
    o.start(wann); o.stop(wann + 4);
    // Fellgeräusch: kurzes, tief gefiltertes Rauschen
    const n = ctx.createBufferSource(), nb = ctx.createBuffer(1, ctx.sampleRate * 0.12, ctx.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    n.buffer = nb;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 220; bp.Q.value = 1.2;
    const ng = ctx.createGain(); ng.gain.value = staerke * 0.6;
    n.connect(bp).connect(ng).connect(ausgang);
    n.start(wann);
}

function wirbelPlanen(bis) {
    if (!wirbel) return;
    while (wirbel.naechster < bis) {
        const t = wirbel.naechster;
        const anteil = Math.min(1, (t - wirbel.ab) / Math.max(0.3, wirbel.dauer));
        paukenSchlag(t, (0.04 + 0.3 * anteil * anteil) * (0.85 + Math.random() * 0.3));
        wirbel.naechster += 1 / 14;
    }
}

/* ---------- Ablauf: Ereignisse und Uhr ---------- */

let A = null;            // Ablauf aus JSON
let EV = [];             // Ereignisse, sortiert nach Position
let ix = 0;              // nächstes Ereignis, an dem die Uhr vorbeikommt
// Uhr: Position s0 (Viertel) zur Zeit t0 (Sekunden, performance-Uhr); bpm = basis mal Faktoren aus dem Ablauf
const U = { laeuft: false, s0: 0, t0: 0, bpm: 85, basis: 85 };
let letzterTipp = null;  // { pos, t }
let fertig = false;
let anfang = 0;          // Position, an der die Begleitung bereitsteht
let SEG = [];            // Positionen der Tippstellen ab dem Anfang
let stimmTon = null;     // klingender Stimmton (Taste A)
let gestopptBei = null;  // Stelle, an der gestoppt wurde (Leertaste, Stopp-Taste): dort geht es weiter
let hinhoeren = false;   // nach dem ersten Tipp: Uhr steht, bis der zweite Tipp das Metrum vorgibt
// „selbst weiter“ (@dd 20261107): läuft es glatt, erscheint ein Knopf; angetippt spielt die Begleitung ohne Tipps
// bis zum Schluss (auch über Wartestellen). Tipps korrigieren weiter Stelle und Tempo, Stopp und Einstieg beenden es.
let selbst = false;
let glatt = 0;           // Tipps in Folge, die nah an ihrer Stelle lagen
const GLATT_NOETIG = () => (E.modus === 'viertel' ? 6 : 3);
const fenster = () => ({ frueh: 0.3, spaet: 0.5, ...A.fenster });   // Anteile der Lücke

/** Tippstellen aus einem Raster: ab Takt ab alle schlaege Viertel */
function rasterStellen(ab, schlaege) {
    const r = [];
    for (let n = ab; n <= P.taktAnfaenge.length; n++)
        for (let p = taktBeginn(n); p < taktEnde(n) - 1e-6; p += schlaege) r.push(p);
    return r;
}

function ereignisseBilden() {
    const jePos = new Map();
    const ev = pos => {
        const k = pos.toFixed(4);
        if (!jePos.has(k)) jePos.set(k, { pos });
        return jePos.get(k);
    };
    // vor dem Anfang singen nur die Stimmen (ohne Akkorde); die Begleitung steht dort bereit. Tippstellen und Pads
    // gibt es trotzdem ab 1:1, damit man von vorn mitzählen kann, samt Auftakt-Text „Mei-ne“ (@dd 20261107)
    anfang = A.anfang ? stellePos(A.anfang) : 0;
    P.taktAnfaenge.forEach((p, i) => { ev(p).takt = i + 1; });
    for (const [s, sym, dauer, lage] of A.akkorde) {
        const e = ev(stellePos(s)); e.akkord = sym;
        if (dauer) e.dauer = dauer;
        if (lage) e.lage = lage;
    }
    // Tippstellen je Modus: DDs = Stellen und Raster aus dem Ablauf, Takt = jede Eins, 2/4 = Eins und Drei
    if (E.modus === 'takte') rasterStellen(1, 4).forEach(p => { ev(p).tippstelle = true; });
    else if (E.modus === 'halbe') rasterStellen(1, 2).forEach(p => { ev(p).tippstelle = true; });
    else if (E.modus === 'viertel') rasterStellen(1, 1).forEach(p => { ev(p).tippstelle = true; });
    else {
        ev(0).tippstelle = true;   // von vorn mitzählen: 1:1
        const stimmeVon = n => (n ? P.stimmen.findIndex(x => x.toLowerCase() === String(n).toLowerCase()) : -1);
        for (const t of A.tippstellen || []) {
            const e = ev(stellePos(typeof t === 'string' ? t : t.stelle));
            e.tippstelle = true;
            const si = typeof t === 'string' ? -1 : stimmeVon(t.stimme);
            if (si >= 0) e.stimme = si;
        }
        const r = A.raster || (A.taktweise_ab ? { ab: A.taktweise_ab, schlaege: 4 } : null);
        if (r) rasterStellen(r.ab, r.schlaege || 4).forEach(p => { ev(p).tippstelle = true; });
    }
    ev(anfang).tippstelle = true;
    for (const [s, o] of Object.entries(A.stellen || {})) {
        const e = ev(stellePos(s));
        if (o.warten) e.warten = true;
        if (o.tempo) e.tempo = o.tempo;
        if (o.pauke) { e.paukenSchlag = true; ev(stellePos(o.pauke)).wirbelAb = true; }
    }
    const schluss = ev(P.ende); schluss.ende = true; schluss.warten = true;
    EV = [...jePos.values()].sort((a, b) => a.pos - b.pos);
    // Lücke: Abstand zur vorigen Tippstelle (in Vierteln), Maß für die Fenster
    let vorige = 0;
    for (const e of EV) if (e.tippstelle || e.warten) { e.luecke = Math.max(1, e.pos - vorige); vorige = e.pos; }
    // Abschnitte für Anzeige, Pads und zurück: von Tippstelle zu Tippstelle
    SEG = EV.filter(e => (e.tippstelle || e.warten) && !e.ende).map(e => e.pos);
}

// Die Uhr läuft in Echtzeit (performance.now), nicht in der Audiozeit: die steht beim ersten Tipp noch,
// bis das Audiogerät anläuft, und würde das erste Tempo verfälschen.
const jetzt = () => performance.now() / 1000;
const audioZeit = t => Math.max(ctx.currentTime, ctx.currentTime + (t - jetzt()));
const uhrPos = t => (U.laeuft ? U.s0 + (t - U.t0) * U.bpm / 60 : U.s0);
const zeitVon = pos => U.t0 + (pos - U.s0) * 60 / U.bpm;
const taktVon = pos => stelleVon(pos).takt;

// das wirksame Tempo bleibt immer zwischen 65 und 120, auch mit den Faktoren aus dem Ablauf (@dd 20261107)
function uhrSetzen(pos, t, bpm = U.bpm) { U.s0 = pos; U.t0 = t; U.bpm = tempoGrenzen(bpm); }

/* ---------- Metronom: klickt jeden Schlag, solange die Begleitung nach einem Tipp läuft ---------- */

let metroNaechster = null;   // Position (Viertel) des nächsten Klicks

/** nächster Schlag ab p (einschließlich), gezählt vom Taktanfang */
function naechsterSchlag(p) {
    const n = stelleVon(p).takt, b = taktBeginn(n);
    const q = b + Math.ceil(p - b - 1e-6);
    return q >= taktEnde(n) - 1e-6 ? taktEnde(n) : q;
}
const istEins = q => Math.abs(q - taktBeginn(stelleVon(q).takt)) < 1e-6;

/** Bis wohin geklickt wird: bis zur nächsten erwarteten Tippstelle bzw. zum Ende des getippten Taktes.
 *  Kommt dort kein Tipp, schweigt auch das Metronom (wie die Akkorde). */
function metroGrenze() {
    if (selbst) return P.ende - 1e-3;
    const n = EV.find(e => (e.tippstelle || e.warten) && e.pos > letzterTipp.pos + 1e-6);
    return Math.min(P.ende - 1e-3, Math.max(n ? n.pos : 0, taktEnde(taktVon(letzterTipp.pos)) - 1e-3));
}

function metroPlanen(t) {
    if (E.metronom !== 'an' || !U.laeuft || !letzterTipp || metroNaechster == null) return;
    const grenze = metroGrenze(), horizont = uhrPos(t + 0.08), p = uhrPos(t);
    while (metroNaechster <= horizont + 1e-6 && metroNaechster <= grenze + 1e-6) {
        // verpasste Schläge (Tab im Hintergrund) nicht nachholen
        if (metroNaechster >= p - 0.1) metroKlick(audioZeit(Math.max(t, zeitVon(metroNaechster))), istEins(metroNaechster));
        metroNaechster = naechsterSchlag(metroNaechster + 1e-3);
    }
}

/** Produkt der Tempo-Faktoren aus dem Ablauf bis einschließlich pos (Takt 18 zieht an, Schluss langsamer) */
function faktorBis(pos) {
    let f = 1;
    for (const e of EV) { if (e.pos > pos + 1e-6) break; if (e.tempo) f *= e.tempo; }
    return f;
}

/** Führt ein Ereignis zur Zeit t aus. getippt: an dieser Stelle kam ein Tipp. */
function ausfuehren(e, t, getippt) {
    const ta = audioZeit(t);
    if (e.wirbelAb) wirbel = { ab: ta, naechster: ta, dauer: (zeitVon(naechstePos(e, 'paukenSchlag')) - t) };
    if (e.paukenSchlag && wirbel) { wirbel = null; paukenSchlag(ta, 0.9); }
    if (e.akkord) akkordSpielen(e.akkord, ta, false, e.dauer, e.lage);
    else if (e.tippstelle && getippt) {
        // Tipp an einer Stelle ohne eigenen Wechsel (z.B. 20:1, 22:1): der geltende Akkord schlägt neu an
        const a = akkordBei(e.pos);
        if (a) akkordSpielen(a, ta, false);
    }
}

function naechstePos(e, feld) {
    const f = EV.find(x => x.pos > e.pos && x[feld]);
    return f ? f.pos : e.pos + 2;
}

/**
 * Läuft alle 20 ms. Die Uhr schätzt weiter, wo der Chor ist. Klingen darf nur, was im selben Takt wie der
 * letzte Tipp liegt (@dd 20261105: kein Weiterspielen in spätere Takte, kein Einblenden); was danach kommt,
 * wartet auf den nächsten Tipp. An Wartestellen und am Schluss hält die Uhr.
 */
function takt() {
    if (!ctx) return;
    const t = jetzt();
    if (U.laeuft) {
        const horizont = uhrPos(t + 0.06);
        while (ix < EV.length && EV[ix].pos <= horizont + 1e-6) {
            const e = EV[ix];
            if (e.warten && !(selbst && !e.ende)) {
                if (uhrPos(t) < e.pos - 1e-6) break;
                if (e.ende) { schluss(t); break; }
                // anhalten: Uhr steht auf der Wartestelle, bis getippt wird
                uhrSetzen(e.pos, t);
                U.laeuft = false;
                zeigen();
                break;
            }
            const tz = Math.max(t, zeitVon(e.pos));
            if (selbst) {
                // Selbstlauf: alles erklingt; an jeder Eins ohne eigenen Wechsel schlägt der geltende Akkord neu an
                ausfuehren(e, tz, false);
                if (e.takt && !e.akkord) { const a = akkordBei(e.pos); if (a) akkordSpielen(a, audioZeit(tz), false); }
            } else if (letzterTipp && taktVon(e.pos) === taktVon(letzterTipp.pos)) ausfuehren(e, tz, false);
            if (e.tempo) uhrSetzen(e.pos, tz, U.basis * faktorBis(e.pos));
            ix++;
        }
        metroPlanen(t);
        // Kein Tipp mehr und nicht „selbst weiter“ (@dd 20261108: still weiterlaufen bringt nichts): einen Takt nach
        // der erwarteten Stelle anhalten (Zusatztakt); weiter startet dann an der verpassten Stelle
        if (U.laeuft && !selbst && letzterTipp) {
            const n = EV.find(e => (e.tippstelle || e.warten) && e.pos > letzterTipp.pos + 1e-6);
            const bei = n ? n.pos : letzterTipp.pos, nr = taktVon(bei);
            if (uhrPos(t) >= bei + (taktEnde(nr) - taktBeginn(nr))) {
                gestopptBei = n && !n.ende ? n.pos : null;
                schluss(t, 0.4);
            }
        }
    }
    wirbelPlanen(ctx.currentTime + 0.1);
    aufraeumen();
}
setInterval(takt, 20);

/** Der eine Tipp. zeit = Zeitstempel des Ereignisses (Sekunden, performance-Uhr), sonst jetzt. */
function tippen(zeit) {
    if (!P) return;
    // Zeit vor dem Audiostart nehmen: das Anlegen des Audiogeräts beim ersten Tipp dauert
    const t = zeit > 0 && zeit <= jetzt() ? zeit : jetzt();
    audioStart();
    wachhalten();
    stimmtonAus(audioZeit(t));
    if (fertig && gestopptBei != null) {
        // nach Stopp (Leertaste, Stopp-Taste): an der gestoppten Stelle neu starten
        springenAuf(gestopptBei, true, false);
        gestopptBei = null;
    } else if (fertig) { neuAnfang(); return; }
    if (!U.laeuft) {
        // Uhr steht (Anfang, Wartestelle, nach Sprung)
        const e = EV[ix];
        if (e && e.ende && Math.abs(e.pos - U.s0) < 1e-6) { schluss(t); return; }
        if (hinhoeren) {
            // zweiter Tipp nach dem Start: gilt immer für die nächste Tippstelle, der Abstand ist das Metrum
            hinhoeren = false;
            const n = EV.find(x => (x.tippstelle || x.warten) && x.pos > U.s0 + 1e-6);
            TIPPS.push({ uhr: +U.s0.toFixed(2), stelle: n ? +n.pos.toFixed(2) : null, metrum: true });
            if (!n || n.ende) { schluss(t); return; }
            einrasten(n.pos, t, 'voll');
            return;
        }
        const start = !letzterTipp;
        einrasten(U.s0, t, false);
        if (start) { U.laeuft = false; hinhoeren = true; zeigen(); }
        return;
    }
    // Uhr läuft: der Tipp gehört zur nächstgelegenen Tippstelle nach dem letzten Tipp (früh oder spät)
    const p = uhrPos(t);
    const f = fenster();
    const kandidaten = EV.filter(e => (e.tippstelle || e.warten) && (!letzterTipp || e.pos > letzterTipp.pos + 1e-6));
    let ziel = null;
    kandidaten.forEach((e, k) => {
        const d = e.pos - p;   // > 0: Tipp vor der Stelle
        const danach = kandidaten[k + 1];
        const ok = d >= 0 ? d <= Math.max(0.75, f.frueh * e.luecke)
            : -d <= Math.max(0.75, f.spaet * ((danach ? danach.pos : e.pos + 4) - e.pos));
        if (ok && (!ziel || Math.abs(d) < Math.abs(ziel.pos - p))) ziel = e;
    });
    TIPPS.push({ uhr: +p.toFixed(2), stelle: ziel ? +ziel.pos.toFixed(2) : null, bpm: Math.round(U.bpm) });
    // glatt: der Tipp lag nah an seiner Stelle (höchstens ein Fünftel Viertel daneben)
    glatt = ziel && Math.abs(ziel.pos - p) <= 0.2 ? glatt + 1 : 0;
    if (ziel) {
        if (ziel.ende) { schluss(t); return; }
        einrasten(ziel.pos, t, true);
    } else {
        // weit weg von jeder Stelle: "ja genau, mach weiter", ändert nichts
        bestaetigt = t;
    }
    zeigen();
}

let bestaetigt = -1;
const TIPPS = [];   // Protokoll zum Auswerten nach einer Probe: Uhrstand, Stelle, Tempo

/** Tipp gilt für die Stelle pos: Tempo nachführen, die Stelle erklingt, Uhr neu ansetzen. */
function einrasten(pos, t, tempoMessen) {
    if (tempoMessen && letzterTipp) {
        const viertel = pos - letzterTipp.pos, sek = t - letzterTipp.t;
        // dazwischen ein Tempowechsel aus dem Ablauf: der Abstand misst kein einheitliches Tempo
        const wechsel = EV.some(e => e.tempo && e.pos > letzterTipp.pos + 1e-6 && e.pos <= pos + 1e-6);
        if (viertel >= 0.9 && sek > 0.25 && !wechsel) {
            const gemessen = viertel * 60 / sek / faktorBis(pos);
            if (tempoMessen === 'voll') {
                // zweiter Tipp nach dem Start: das Tempo kommt ganz aus diesem Abstand
                U.basis = tempoGrenzen(gemessen);
            } else {
                // behutsam (@dd 20261107: nicht hektisch): ein Ausreißer zählt höchstens als 0,8 bis 1,25 des
                // bisherigen Tempos, und ein Tipp bewegt es nur zu einem Zehntel (Viertel) bis gut einem Drittel (Takt und mehr)
                const neu = Math.min(U.basis * 1.25, Math.max(U.basis * 0.8, gemessen));
                const w = Math.min(0.35, Math.max(0.1, viertel / 10));
                U.basis = tempoGrenzen(U.basis * (1 - w) + neu * w);
            }
        }
    }
    // Wirbel, der vor einem übersprungenen Paukenschlag begann, endet hier
    if (wirbel && !EV.some(e => e.paukenSchlag && e.pos >= pos - 1e-6)) wirbel = null;
    const i = EV.findIndex(x => x.pos >= pos - 1e-6);
    const e = EV[i];
    uhrSetzen(pos, t, U.basis * faktorBis(pos));
    U.laeuft = true;
    letzterTipp = { pos, t };
    metroNaechster = naechsterSchlag(pos);   // liegt der Tipp auf einem Schlag, klickt es sofort mit
    if (e && Math.abs(e.pos - pos) < 1e-6) {
        if (!e.akkord && !e.tippstelle) { const a = akkordBei(pos); if (a) akkordSpielen(a, audioZeit(t), false); }
        ausfuehren(e, t, true);
        ix = i + 1;
    } else {
        const a = akkordBei(pos);
        if (a) akkordSpielen(a, audioZeit(t), false);
        ix = i < 0 ? EV.length : i;
    }
    zeigen();
}

/** Ende des Laufs: am Liedschluss lang ausklingen, beim Stopp sofort still (@dd 20261107: Stopp muss beim Drücken reagieren) */
function schluss(t, abkling = 3) {
    wirbel = null; hinhoeren = false; selbst = false; glatt = 0;
    alleAus(audioZeit(t), abkling);
    U.laeuft = false;
    fertig = true;
    zeigen();
}

function neuAnfang() {
    springenAuf(anfang, false, false);
}

/** Bereitstellen am Anfang ohne Klang (beim Laden, vor dem ersten Antippen). */
function anfangStellen() {
    ix = EV.findIndex(e => e.pos >= anfang - 1e-6);
    U.basis = tempoGrenzen(A.tempo);
    uhrSetzen(anfang, jetzt(), U.basis * faktorBis(anfang));
    U.laeuft = false;
    letzterTipp = null;
    hinhoeren = false;
}

/**
 * Einstiegsstelle für den Einstiegsknopf: steht die Begleitung (bereit, nach Pad oder Stopp), die Stelle, an der
 * es weitergeht; läuft sie, die Stelle, an der sie gerade ist; nach dem Schluss der Anfang.
 */
function einstieg() {
    // läuft die Begleitung: die Stelle, an der sie gerade ist (@dd 20261108: nicht zurück an den Anfang springen)
    if (hinhoeren) return U.s0;
    if (U.laeuft) return SEG[segIndex(uhrPos(jetzt()))];
    if (fertig) return gestopptBei != null ? gestopptBei : anfang;
    return U.s0;
}

/** Akkord, der an pos gilt; bei einer Pause dort der nächste */
function einstiegsAkkord(pos) {
    return akkordBei(pos) || (EV.find(x => x.pos >= pos - 1e-6 && x.akkord && x.akkord !== '-') || {}).akkord || null;
}

/**
 * Einstieg für Stimme si an pos (Pads, Taste a): der Ton, mit dem sie dort einsetzt, und der Akkord dazu. Setzt sie
 * erst später ein (Sopran: Takt 18), ihr erster Ton danach mit dem Akkord an dieser Stelle.
 */
function einstiegFuer(pos, si) {
    // nur der Ton, der an pos klingt; hat die Stimme dort Pause, gibt es keinen Ton, nur den Akkord
    // (@dd 20261108: ein Ton aus der Pause heraus ist immer der falsche)
    const n = si >= 0 && P.noten[si] ? P.noten[si].find(x => x.t < pos + 1e-6 && x.ende > pos + 1e-6) || null : null;
    return { a: einstiegsAkkord(pos), n };
}

/**
 * Akkord nur antippen: 50 ms an, 50 ms halten, dann langes Abklingen (nach 1 s ein Viertel), damit der Einstiegston
 * deutlich allein stehen bleibt. Läuft neben den Akkorden der Begleitung her (nicht in „klingend“).
 */
function akkordTupfer(sym, wann) {
    const l = lageFuer(sym);
    if (!l) return;
    akkordJetzt = sym;
    const toene = [[l.bass, 'grund'], [l.bass - 12, 'sub'], ...(E.spiel !== 'bass' ? l.oben.map(m => [m, 'oben']) : [])];
    return toene.map(([m, art]) => { const t = tonAn(m, art, wann, false, 0.05); t.tupfer(); return t; });
}

/**
 * Pad drücken (@dd 20261108): Einstieg an dieser Stelle. Der Akkord tippt kurz an (50 ms an, 50 ms halten, langes
 * Abklingen), der Ton der eigenen Stimme bleibt liegen, solange der Finger liegt. Wird daraus ein Wischen, ist
 * beides sofort weg.
 */
let padToene = [];
function padAn(pos) {
    audioStart();
    const ta = ctx.currentTime;
    stimmtonAus(ta);
    padToene.forEach(t => t.daempfen());
    const { a, n } = einstiegFuer(pos, stimmeIndex(E.stimme));
    if (n) stimmTon = tonAn(n.midi, 'stimme', ta, false, 0.008);   // zuerst: beim Stimmenklau geschützt
    padToene = a ? akkordTupfer(a, ta) || [] : [];
}
function padAus(wischen) {
    if (!ctx) return;
    stimmtonAus(ctx.currentTime);
    if (wischen) { padToene.forEach(t => t.daempfen()); padToene = []; }
}

/**
 * Einstiegsknopf drücken (@dd 20261107): der Akkord der Einstiegsstelle klingt nur 0,1 s an, der Ton der eigenen Stimme
 * bleibt liegen, solange gedrückt (Gate). Die Begleitung steht danach an dieser Stelle, weiter startet von dort.
 */
function stimmton(si = stimmeIndex(E.stimme)) {
    if (!P || stimmTon) return;
    selbst = false; glatt = 0;
    audioStart();
    const ta = ctx.currentTime;
    const pos = einstieg();
    const { a, n } = einstiegFuer(pos, si);
    springenAuf(pos, false, false);
    gestopptBei = null;
    alleAus(ta, 0.1);
    // sofort und mit kurzem Einschwingen (Gate); in einer Pause kein Ton; zuerst, damit er geschützt ist
    if (n) stimmTon = tonAn(n.midi, 'stimme', ta, false, 0.008);
    if (a) akkordTupfer(a, ta);   // nur angetippt, klingt lang ab; der Ton der Stimme ist die Vorgabe
    zeigen();
}

function stimmtonAus(ta) {
    if (!stimmTon) return;
    stimmTon.stop(ta, 0.4);
    stimmTon = null;
}

/** Akkord, der an pos gilt (letzter Wechsel bis dorthin), ohne Pause */
function akkordBei(pos) {
    const e = [...EV].reverse().find(x => x.pos <= pos + 1e-6 && x.akkord);
    return e && e.akkord !== '-' ? e.akkord : null;
}

/** Zu Takt n springen: dort steht die Uhr, der nächste Tipp startet. */
function springen(n, tempoBehalten = false) { springenAuf(taktBeginn(n), tempoBehalten); }

function springenAuf(ziel, tempoBehalten = false, anspielen = true) {
    if (!P) return;
    audioStart();
    const t = jetzt(), ta = ctx.currentTime;
    fertig = false; wirbel = null; hinhoeren = false; selbst = false; glatt = 0;
    const pos = Math.max(ziel, 0);
    ix = EV.findIndex(e => e.pos >= pos - 1e-6);
    if (!tempoBehalten) U.basis = tempoGrenzen(A.tempo);
    // Stelle antippen: der Akkord, der dort gilt, klingt eine Halbe an (@dd 20261105), weiter startet von hier
    const a = akkordBei(pos);
    if (!anspielen) { /* Klang macht der Aufrufer (Pads: solange der Finger liegt) */ }
    else if (a && ziel > 0) akkordSpielen(a, ta, false, 2); else alleAus(ta, 0.8);
    uhrSetzen(pos, t, U.basis * faktorBis(pos));
    U.laeuft = false;
    letzterTipp = null;
    zeigen();
}

/** Zurück (Tastatur): an den Anfang des laufenden Abschnitts, ist der gerade erst begonnen, einen davor. */
function zurueck() {
    if (!P) return;
    const p = uhrPos(jetzt());
    const i = segIndex(p);
    springenAuf(p - SEG[i] > 1 ? SEG[i] : SEG[Math.max(0, i - 1)], true);
}

/* ---------- Anzeige ---------- */

const segIndex = p => { let i = 0; while (i + 1 < SEG.length && SEG[i + 1] <= p + 1e-6) i++; return i; };
const segEnde = i => (i + 1 < SEG.length ? SEG[i + 1] : P.ende);
const anzeigeName = sym => (sym === '-' ? 'Pause' : sym.endsWith('1') ? 'nur ' + sym.slice(0, -1) : sym);

/** Name eines Abschnitts: im Taktmodus die Taktzahl, sonst Takt:Schlag */
function segName(pos) {
    const st = stelleVon(pos);
    return E.modus === 'takte' ? String(st.takt) : `${st.takt}:${st.schlag}`;
}

/** Ist die Uhr schon an einer Tippstelle vorbei, ohne dass getippt wurde? Dann ist die Stelle geschätzt. */
function geschaetzt(p) {
    if (!U.laeuft || !letzterTipp || selbst) return false;
    const n = EV.find(e => (e.tippstelle || e.warten) && e.pos > letzterTipp.pos + 1e-6);
    return !!n && p > n.pos + 0.25;
}

/**
 * Welche Stelle der nächste Tipp trifft (Anzeige oben, Pad markiert): bereit/Wartestelle/nach Sprung = die Stelle,
 * an der die Uhr steht; nach dem Starttipp die nächste Tippstelle (Metrum); sonst die nächste nach dem letzten Tipp,
 * beim Schätzen die nächste noch vor der Uhr. null = Schluss bzw. Ende.
 */
function erwartetePos(p) {
    if (fertig) return null;
    const nach = x => EV.find(e => (e.tippstelle || e.warten) && e.pos > x + 1e-6);
    let n;
    if (hinhoeren) n = nach(U.s0);
    else if (!U.laeuft) return U.s0;
    else {
        n = nach(letzterTipp ? letzterTipp.pos : U.s0);
        if (n && (geschaetzt(p) || selbst)) n = nach(p - 0.25) || n;
    }
    return n && !n.ende ? n.pos : null;
}

function akkordeIn(a, b) {
    return A.akkorde.filter(([s]) => { const p = stellePos(s); return p >= a - 1e-6 && p < b - 1e-6; })
        .map(([, sym]) => anzeigeName(sym)).join(' ');
}

function zeigen() {
    if (!P) return;
    const t = jetzt();
    const p = Math.min(uhrPos(t), P.ende - 1e-3);
    const laeuft = U.laeuft || hinhoeren;
    const schaetzt = geschaetzt(p);
    const st = stelleVon(p);
        // kurz, damit es neben S A T B passt: „Takt 12:2“
    $('stelle').textContent = `Takt ${st.takt}` + (laeuft || st.schlag > 1 ? `:${st.schlag}` : '');
    $('tempoAnz').textContent = `♩ ${Math.round(U.bpm)}`;
    let zustand = hinhoeren ? 'hört hin' : U.laeuft ? (selbst ? 'läuft selbst' : schaetzt ? 'schätzt' : 'läuft') : 'wartet auf Tipp';
    if (fertig) zustand = gestopptBei != null ? 'gestoppt' : 'Schluss';
    if (!U.laeuft && !letzterTipp && Math.abs(U.s0 - anfang) < 1e-6) zustand = 'bereit';
    if (stimmTon) zustand = 'Einstieg';
    if (bestaetigt > 0 && t - bestaetigt < 0.6) zustand = 'ja, weiter';
    $('zustand').textContent = zustand;
    $('zustand').dataset.art = schaetzt ? 'schaetzt' : (laeuft ? 'laeuft' : 'wartet');
    // geschätzt: der Akkord, der an der vermuteten Stelle gälte, blass (er klingt nicht)
    const ak = schaetzt ? akkordBei(p) : akkordJetzt;
    $('akkord').textContent = ak && ak !== '-' && !fertig ? anzeigeName(ak) : '';
    $('akkord').classList.toggle('blass', schaetzt);
    const i = segIndex(p);
    $('jetzt').innerHTML = textHtml(SEG[i], segEnde(i));
    $('dann').innerHTML = i + 1 < SEG.length
        ? `dann <b>${segName(SEG[i + 1])}</b> <b class="ak">${akkordeIn(SEG[i + 1], segEnde(i + 1))}</b> ${textHtml(SEG[i + 1], segEnde(i + 1))}` : 'Schluss';
    // erwarteter Tipp oben (@dd 20261107): Wort mit fetter Tippsilbe bzw. „–“, daneben die Stelle
    // nach Stopp: wo weiter neu startet; nach dem Liedschluss: wieder bei Seele (statt eines leeren „Ende“, @dd 20261107)
    const ep = fertig ? (gestopptBei != null ? gestopptBei : anfang) : erwartetePos(p);
    const ei = ep == null ? -1 : SEG.findIndex(x => Math.abs(x - ep) < 1e-6);
    const art = stimmTon ? 'Einstieg' : fertig ? (gestopptBei != null ? 'weiter ab' : 'neu ab')
        : hinhoeren ? 'Tempo-Tipp' : (!letzterTipp && !U.laeuft) ? 'Start' : 'Tipp';
    $('erwartet').innerHTML = ei < 0 ? `<span class="was">${art}</span> <span class="wort">Schluss</span>`
        : `<span class="was">${art}</span> <span class="wort">${PADS[ei].gross === '·' ? 'zählen' : PADS[ei].gross}</span> <span class="wo">${segName(SEG[ei])}</span>`;
    [...$('streifen').children].forEach((b, k) => { b.classList.toggle('an', k === i); b.classList.toggle('soll', k === ei); });
    streifenFuehren(i);
    selbstKnopfZeigen();
}

/** „selbst weiter“: sichtbar, wenn es glatt läuft oder schon selbst läuft; schwebt rechts über den Tasten */
function selbstKnopfZeigen() {
    const k = $('selbstKnopf');
    const sichtbar = !fertig && U.laeuft && (selbst || glatt >= GLATT_NOETIG());
    if (k.hidden !== !sichtbar) {
        k.hidden = !sichtbar;
        if (sichtbar) {
            const r = $('tasten').getBoundingClientRect();
            k.style.bottom = (innerHeight - r.top + 8) + 'px';
            k.style.right = (innerWidth - r.right) + 'px';
        }
    }
    if (k.getAttribute('aria-pressed') !== String(selbst)) {
        k.setAttribute('aria-pressed', String(selbst));
        k.querySelector('span').textContent = selbst ? 'läuft selbst · antippen = mittippen' : 'selbst weiter';
    }
}
function selbstUmschalten() {
    if (!U.laeuft || fertig) return;
    const t = jetzt();
    if (selbst) {
        // zurück zum Mittippen: als hätte man eben hier getippt (Akkorde laufen im Takt weiter)
        selbst = false; glatt = 0;
        letzterTipp = { pos: uhrPos(t), t };
    } else {
        selbst = true;
    }
    zeigen();
}

/**
 * Der gesungene Abschnitt bleibt im Streifen etwa im oberen Drittel bis zur Mitte, damit der nächste Text zu
 * sehen ist (@dd 20261107). Gescrollt wird erst, wenn er dieses Band verlässt, dann sanft an den oberen Rand des
 * Bandes; so springt es nur alle paar Zeilen. Wer gerade selbst im Streifen wischt, wird nicht gestört.
 */
let streifenAngefasst = -1e9;
function streifenFuehren(i) {
    const s = $('streifen'), b = s.children[i];
    if (!b || jetzt() - streifenAngefasst < 2.5) return;
    const h = s.clientHeight, rel = b.getBoundingClientRect().top - s.getBoundingClientRect().top;
    if (s.scrollHeight <= h + 2) return;
    // in der Mitte halten (@dd 20261108): weicht die Zeilenmitte mehr als ein Achtel der Höhe ab, sanft zurück
    const mitte = rel + b.offsetHeight / 2;
    if (Math.abs(mitte - h / 2) <= h * 0.125) return;
    s.scrollTo({ top: Math.max(0, s.scrollTop + mitte - h / 2), behavior: 'smooth' });
}
setInterval(() => { if (U.laeuft) zeigen(); }, 100);

let PADS = [];   // je Abschnitt { gross } (Wort mit Tippsilbe, „–“ oder Wort einer anderen Stimme), für die Anzeige oben

function streifenZeigen() {
    const s = $('streifen');
    s.innerHTML = '';
    PADS = [];
    // Viertel (@dd 20261107): alle Pads gleich groß und schmaler, eine Zeile = ein Takt (breit: zwei Takte)
    const schlaege = Math.round(taktEnde(Math.min(2, P.taktAnfaenge.length)) - taktBeginn(Math.min(2, P.taktAnfaenge.length))) || 4;
    const viertel = E.modus === 'viertel';
    s.classList.toggle('viertel', viertel);
    s.style.setProperty('--schlaege', schlaege);
    s.style.setProperty('--schlaege2', schlaege * 2);
    SEG.forEach((pos, i) => {
        const b = document.createElement('button');
        const text = textIn(pos, segEnde(i)), ak = akkordeIn(pos, segEnde(i));
        // Taktmodus: Akkorde des Taktes; Stellenmodus: das erste Wort, auf das getippt wird
        // Pad: oben Stelle (im Stellenmodus mit Akkord), darunter das Wort mit fetter Tippsilbe bzw. die Akkorde
        // in jedem Modus mit Text (@dd 20261105); die Stimme des Wortes aus dem Ablauf, sonst die Textstimme
        const ev = EV.find(e => Math.abs(e.pos - pos) < 1e-6);
        const oben = segName(pos) + (ak ? ' · ' + ak : '');
        const si = E.stimme ? stimmeIndex(E.stimme) : (ev && ev.stimme != null ? ev.stimme : stimmeIndex(A.textstimme));
        // hält die eigene Stimme hier einen Ton: „–“ statt eines Wortes (@dd 20261107: sonst bringt es raus);
        // singt sie hier nicht: das Wort der anderen, andersfarbig. Darunter klein der weitere Text bis zur nächsten Stelle.
        const bis = segEnde(i);
        let gross, klein = '', oben2 = null;   // oben2: ganzes Wort für die Anzeige oben (dort ist Platz)
        if (stimmeAn(pos, si) === 'halten') {
            gross = '<b>–</b>';
            klein = kleinText(pos, bis, si);
        } else {
            const eigen = wortAn(pos, bis, si, viertel);
            if (eigen) {
                gross = eigen.html;
                if (viertel) oben2 = wortAn(pos, bis, si).html;
                klein = kleinText(Math.max(pos, eigen.letzte), bis, si);
            } else {
                // hält dort die Textstimme (Tenor) einen Ton, auch bei den anderen „–“ statt „·“
                const ts = stimmeIndex(A.textstimme);
                const fremd = stimmeAn(pos, ts) === 'halten' ? { html: '<b>–</b>' }
                    : wortAn(pos, bis, ts, viertel) || wortAn(pos, bis, -1, viertel);
                gross = fremd ? `<span class="fremd">${fremd.html}</span>` : '·';
                if (viertel && fremd) { const w = fremd.html === '<b>–</b>' ? fremd : wortAn(pos, bis, ts) || wortAn(pos, bis); oben2 = `<span class="fremd">${w.html}</span>`; }
            }
        }
        // Pad, auf dem die eigene Stimme nicht singt: deutlich anders (kein Kartenkörper, blau, kursiv)
        if (!/^<b>–<\/b>$/.test(gross) && (gross === '·' || gross.startsWith('<span class="fremd">'))) b.classList.add('fremdpad');
        PADS.push({ gross: oben2 || gross });
        b.innerHTML = `<span class="t">${oben}</span><span class="w">${gross}</span>` + (klein ? `<span class="k">${klein}</span>` : '');
        b.title = (ak ? ak + ': ' : '') + text;
        b.tabIndex = -1;
        // Gate (@dd 20261105): der Akkord der Stelle klingt, solange der Finger liegt; beim Loslassen steht
        // die Begleitung dort. Wird daraus ein Wischen (Streifen scrollen), nur der Klang aus, kein Sprung.
        let an = false;
        b.addEventListener('pointerdown', e => {
            if (hilfe || e.button > 0) return;
            padAn(pos); an = true;
        });
        b.addEventListener('pointerup', () => {
            if (hilfe || !an) return;
            an = false;
            springenAuf(pos, false, false);
            padAus(false);
            zeigen();
        });
        ['pointercancel', 'pointerleave'].forEach(t => b.addEventListener(t, () => {
            if (an) padAus(true);
            an = false;
        }));
        s.appendChild(b);
    });
}
// selbst im Streifen wischen: das Mitführen hält kurz still
['pointerdown', 'wheel', 'touchstart'].forEach(t => $('streifen').addEventListener(t, () => { streifenAngefasst = jetzt(); }, { passive: true }));

/* ---------- Bildschirm wach halten ---------- */

let sperre = null;
async function wachhalten() {
    if (sperre || !navigator.wakeLock) return;
    try { sperre = await navigator.wakeLock.request('screen'); sperre.addEventListener('release', () => { sperre = null; }); }
    catch (e) { /* nur über https */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && U.laeuft) wachhalten(); });

/* ---------- Bedienung ---------- */

let hilfe = false;

function knopf(el, fn) {
    // Antippen löst schon beim Aufsetzen aus (schneller als click), Tastatur über click mit detail 0
    el.addEventListener('pointerdown', e => {
        if (hilfe || e.button > 0) return;
        e.preventDefault();
        el.classList.add('druck');
        fn(e.timeStamp / 1000);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => el.addEventListener(t, () => el.classList.remove('druck')));
    el.addEventListener('click', e => { if (!hilfe && e.detail === 0) fn(); });
}
knopf($('weiter'), tippen);
knopf($('selbstKnopf'), () => selbstUmschalten());
// Audiogerät schon bei der ersten Berührung irgendwo anlegen: sonst kostet das Anlaufen den ersten Ton
document.addEventListener('pointerdown', () => audioStart(), { capture: true, once: true });
knopf($('stoppKnopf'), zeit => { if (ctx && letzterTipp && !fertig) startStopp(zeit); else if (ctx) alleAus(ctx.currentTime, 0.3); });

function einstellungenAuf(auf) {
    $('einstellungen').hidden = !auf;
    if (auf) $('zu').focus(); else $('zahnrad').focus();
}
$('zahnrad').addEventListener('click', () => einstellungenAuf($('einstellungen').hidden));
$('zu').addEventListener('click', () => einstellungenAuf(false));

/* Anleitung: beim ersten Besuch von selbst, sonst über „So geht's“ in den Einstellungen */
function anleitungAuf(auf) {
    $('anleitung').hidden = !auf;
    if (auf) $('anleitungZu').focus();
    else { try { localStorage.setItem('begleitung-anleitung', '2'); } catch (e) { /* egal */ } }
}
$('anleitungKnopf').addEventListener('click', () => { einstellungenAuf(false); anleitungAuf(true); });
$('anleitungZu').addEventListener('click', () => anleitungAuf(false));
// neue Anleitung (Viertel, @dd 20261107): wer die alte gesehen hat, bekommt sie einmal wieder
try { if (localStorage.getItem('begleitung-anleitung') !== '2') anleitungAuf(true); } catch (e) { /* ohne Speicher nicht von selbst */ }

const REGLER = [];   // [id, feld] für „Klang zurücksetzen“
function regler(id, feld) {
    const r = $(id), out = r.parentElement.querySelector('output');
    REGLER.push([id, feld]);
    r.value = E[feld];
    out.textContent = r.value;
    r.addEventListener('input', () => { E[feld] = +r.value; out.textContent = r.value; sichern(); pegelSetzen(); });
}
regler('lautstaerke', 'lautstaerke');
regler('tiefbass', 'tiefbass');
regler('hoehen', 'hoehen');
regler('metroLaut', 'metroLaut');

// Tippen auf: DDs Stellen, jede Eins, Eins und Drei (@dd 20261105) oder jeder Schlag (@dd 20261107)
(() => {
    const zeile = $('moduswahl');
    for (const [key, name] of [['viertel', '1/4'], ['halbe', '2/4'], ['takte', 'Takt'], ['stellen', 'DDs']]) {
        const b = document.createElement('button');
        b.textContent = name;
        b.setAttribute('aria-pressed', String(E.modus === key));
        b.addEventListener('click', () => {
            E.modus = key; sichern();
            [...zeile.children].forEach(x => x.setAttribute('aria-pressed', String(x === b)));
            if (!A) return;
            if (ctx) alleAus(ctx.currentTime, 0.5);
            fertig = false; wirbel = null; akkordJetzt = '';
            ereignisseBilden();
            anfangStellen();
            streifenZeigen();
            zeigen();
        });
        zeile.appendChild(b);
    }
})();

// Meine Stimme: aus ihr kommen Text und Wörter auf den Pads (Alt singt in Takt 10 und 13-14 anderen Text)
// Spielt: Akkord mit Bass oder nur Bass
function wahlZeile(id, feld, optionen, nachher) {
    const zeile = $(id);
    for (const [key, name] of optionen) {
        const b = document.createElement('button');
        b.textContent = name;
        b.setAttribute('aria-pressed', String(E[feld] === key));
        b.addEventListener('click', () => {
            E[feld] = key; sichern();
            [...zeile.children].forEach(x => x.setAttribute('aria-pressed', String(x === b)));
            nachher();
        });
        zeile.appendChild(b);
    }
}
// zweimal: ausgeschrieben in den Einstellungen und klein, aber ständig sichtbar über dem Akkord (@dd 20261107)
function stimmwahlBauen() {
    if (!E.stimme) E.stimme = A.textstimme || P.stimmen[0];
    // kurz: Anfangsbuchstabe, außer zwei Stimmen teilen ihn (Sopran 1/2), dann der Name
    const kurz = n => (P.stimmen.filter(x => x.charAt(0).toUpperCase() === n.charAt(0).toUpperCase()).length > 1 ? n : n.charAt(0).toUpperCase());
    for (const [id, name] of [['stimmchips', kurz]]) {
        const zeile = $(id);
        zeile.innerHTML = '';
        for (const n of P.stimmen) {
            const b = document.createElement('button');
            b.textContent = name(n);
            b.dataset.stimme = n;
            b.title = n;
            b.setAttribute('aria-label', 'Meine Stimme: ' + n);
            b.setAttribute('aria-pressed', String(E.stimme === n));
            // stumm, nur die Wahl der eigenen Stimme (@dd 20261108); den Einstieg geben die Pads
            b.addEventListener('click', () => stimmeSetzen(n));
            zeile.appendChild(b);
        }
    }
}
function stimmeSetzen(n) {
    E.stimme = n; sichern();
    document.querySelectorAll('[data-stimme]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.stimme === n)));
    leitsilbenBilden(); streifenZeigen(); zeigen();
}
wahlZeile('stimmenwahl', 'stimmen', [4, 6, 8, 12].map(z => [z, String(z)]), () => stimmenKappen(MAX_STIMMEN()));
wahlZeile('spielwahl', 'spiel', [['akkord', 'Akkord'], ['bass', 'nur Bass']], () => {
    if (ctx && akkordJetzt && akkordJetzt !== '-') { const a = akkordJetzt; alleAus(ctx.currentTime, 0.2); akkordSpielen(a, ctx.currentTime, false); }
});
// Metronom an/aus; zum Hören beim Einschalten ein Klick
// Metronom: ein Knopf an/aus (@dd 20261107); beim Einschalten ein Klick zum Hören
function metroKnopfZeigen() {
    $('metroKnopf').setAttribute('aria-pressed', String(E.metronom === 'an'));
    $('metroKnopf').textContent = E.metronom === 'an' ? 'Metronom an' : 'Metronom aus';
}
metroKnopfZeigen();
$('metroKnopf').addEventListener('click', () => {
    E.metronom = E.metronom === 'an' ? 'aus' : 'an'; sichern(); metroKnopfZeigen();
    audioStart(); pegelSetzen();
    if (E.metronom === 'an') metroKlick(ctx.currentTime + 0.02, true);
});

// Klangfarbe: Orgel oder Strings
(() => {
    const zeile = $('klangwahl');
    for (const [key, name] of [['orgel', 'Orgel'], ['strings', 'Strings']]) {
        const b = document.createElement('button');
        b.textContent = name;
        b.setAttribute('aria-pressed', String(E.klang === key));
        b.addEventListener('click', () => {
            E.klang = key; sichern();
            [...zeile.children].forEach(x => x.setAttribute('aria-pressed', String(x === b)));
            // laufenden Akkord in der neuen Farbe neu anschlagen
            if (ctx && akkordJetzt && akkordJetzt !== '-') { const a = akkordJetzt; alleAus(ctx.currentTime, 0.2); akkordSpielen(a, ctx.currentTime, false); }
        });
        zeile.appendChild(b);
    }
})();

// Klang zurücksetzen: Klangfarbe, Regler und Metronom-Klang auf die Vorgabe (@dd 20261107); Metronom an/aus bleibt
$('klangReset').addEventListener('click', () => {
    for (const k of KLANG_FELDER) E[k] = VORGABE[k];
    sichern();
    for (const [id, feld] of REGLER) { $(id).value = E[feld]; $(id).parentElement.querySelector('output').textContent = E[feld]; }
    [...$('klangwahl').children].forEach((x, k) => x.setAttribute('aria-pressed', String(['orgel', 'strings'][k] === E.klang)));
    pegelSetzen();
    if (ctx && akkordJetzt && akkordJetzt !== '-') { const a = akkordJetzt; alleAus(ctx.currentTime, 0.2); akkordSpielen(a, ctx.currentTime, false); }
});

/** Leertaste: läuft die Begleitung, stoppt sie; steht sie, startet sie (am Anfang bzw. dort, wo gestoppt wurde). */
function startStopp(zeit) {
    if (!P) return;
    const t = zeit > 0 && zeit <= jetzt() ? zeit : jetzt();
    audioStart();
    if (letzterTipp && !fertig) {
        gestopptBei = SEG[segIndex(uhrPos(t))];
        schluss(t, 0.12);
        return;
    }
    tippen(t);
}
// in der Fangphase, damit kein Knopf und kein Haken mit Fokus die Leertaste bekommt
addEventListener('keydown', e => {
    if (e.key !== ' ') return;
    e.preventDefault(); e.stopPropagation();
    if (!hilfe && !e.repeat) startStopp(e.timeStamp / 1000);
}, true);
addEventListener('keyup', e => { if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); } }, true);

addEventListener('keyup', e => {
    if ((e.key === 'a' || e.key === 'A') && ctx) { stimmtonAus(ctx.currentTime); zeigen(); }
});
addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        e.preventDefault();
        if (!$('anleitung').hidden) anleitungAuf(false);
        else if (hilfe) hilfeModus(false);
        else if (!$('einstellungen').hidden) einstellungenAuf(false);
        else if (ctx) { if (letzterTipp && !fertig) gestopptBei = SEG[segIndex(uhrPos(jetzt()))]; schluss(jetzt(), 0.12); }
        return;
    }
    if (hilfe || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key)) { e.preventDefault(); tippen(e.timeStamp / 1000); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); zurueck(); }
    else if (e.key === 'a' || e.key === 'A') { e.preventDefault(); stimmton(); }
});

/* ---------- Hilfemodus ---------- */

function hilfeModus(an) {
    hilfe = an;
    document.body.classList.toggle('hilfemodus', an);
    $('hilfeKnopf').setAttribute('aria-pressed', String(an));
    if (!an) $('blase').hidden = true;
}
$('hilfeKnopf').addEventListener('click', e => { e.stopPropagation(); hilfeModus(!hilfe); });
document.addEventListener('click', e => {
    if (!hilfe || e.target.closest('#hilfeKnopf')) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.target.closest('[data-hilfe]');
    const blase = $('blase');
    if (!el) { blase.hidden = true; return; }
    blase.textContent = el.dataset.hilfe;
    blase.hidden = false;
    const r = el.getBoundingClientRect(), bw = blase.offsetWidth, bh = blase.offsetHeight;
    const links = Math.min(Math.max(12, r.left + r.width / 2 - bw / 2), innerWidth - bw - 12);
    const oben = r.top > bh + 20 ? r.top - bh - 10 : Math.min(r.bottom + 10, innerHeight - bh - 12);
    blase.style.left = links + 'px'; blase.style.top = oben + 'px';
}, true);

/* ---------- Fächer der Einstellungen: offen gemerkt, zu mit Kurzstand (@dd 20261107) ---------- */

const FAECHER = [...document.querySelectorAll('#einstellungen details.fach')];
(() => {
    let offen = ['tippen'];
    try { const x = JSON.parse(localStorage.getItem('begleitung.faecher')); if (Array.isArray(x)) offen = x; } catch (e) { /* Vorgabe */ }
    for (const d of FAECHER) {
        d.open = offen.includes(d.dataset.fach);
        d.addEventListener('toggle', () => {
            try { localStorage.setItem('begleitung.faecher', JSON.stringify(FAECHER.filter(x => x.open).map(x => x.dataset.fach))); } catch (e) { /* egal */ }
        });
    }
})();
const MODUSNAME = { viertel: '1/4', halbe: '2/4', takte: 'Takt', stellen: 'DDs' };
function kurzstand() {
    const r = document.documentElement;
    $('kurz_tippen').textContent = `${MODUSNAME[E.modus] || ''} · ${E.spiel === 'bass' ? 'nur Bass' : 'Akkord'}`;
    $('kurz_klang').textContent = `${E.klang === 'orgel' ? 'Orgel' : 'Strings'} · ${E.lautstaerke} · Tiefbass ${E.tiefbass} · Höhen ${E.hoehen} · ${MAX_STIMMEN()} Stimmen`;
    $('kurz_metronom').textContent = E.metronom === 'an' ? `an · ${E.metroLaut}` : 'aus';
    $('kurz_darstellung').textContent = (r.dataset.hell ? 'Hell' : 'Dunkel') + (r.dataset.kontrast ? ' · Lesbarkeit ' + (r.dataset.kontrast === 'max' ? 'Max' : 'Hoch') : '');
}
['input', 'click'].forEach(t => $('einstellungen').addEventListener(t, () => setTimeout(kurzstand)));

/* ---------- Darstellung: Hell/Dunkel und Kontrast (Baustein @dd 20261018), gesetzt am <html> ---------- */

function themaFarbe() {
    const m = document.querySelector('meta[name=theme-color]');
    if (m) m.content = getComputedStyle(document.documentElement).getPropertyValue('--grund').trim();
}
(() => {
    const r = document.documentElement;
    const seg = (id, optionen, aktiv, setzen) => {
        const z = $(id);
        for (const [key, name] of optionen) {
            const b = document.createElement('button');
            b.textContent = name;
            b.setAttribute('aria-pressed', String(aktiv() === key));
            b.addEventListener('click', () => {
                setzen(key);
                [...z.children].forEach((x, i) => x.setAttribute('aria-pressed', String(optionen[i][0] === aktiv())));
            });
            z.appendChild(b);
        }
    };
    seg('hellwahl', [['nein', 'Dunkel'], ['ja', 'Hell']], () => (r.dataset.hell ? 'ja' : 'nein'), k => {
        if (k === 'ja') r.dataset.hell = 'ja'; else delete r.dataset.hell;
        try { localStorage.setItem('begleitung.hell', k); } catch (e) { /* egal */ }
        themaFarbe();
    });
    seg('kontrastwahl', [['', 'Normal'], ['hoch', 'Hoch'], ['max', 'Max']], () => r.dataset.kontrast || '', k => {
        if (k) r.dataset.kontrast = k; else delete r.dataset.kontrast;
        try { if (k) localStorage.setItem('begleitung.kontrast', k); else localStorage.removeItem('begleitung.kontrast'); } catch (e) { /* egal */ }
    });
    themaFarbe();
    kurzstand();
})();

/* ---------- Ganz nach oben: Knopf erscheint, wenn man im Streifen schnell hochwischt (@dd 20261107) ---------- */

(() => {
    const s = $('streifen'), k = $('nachOben');
    let letzt = { top: 0, t: 0 }, weg = null;
    const verstecken = () => { k.hidden = true; };
    s.addEventListener('scroll', () => {
        const t = performance.now(), top = s.scrollTop;
        const v = (top - letzt.top) / Math.max(1, t - letzt.t) * 1000;   // Pixel je Sekunde, negativ = nach oben
        letzt = { top, t };
        if (top < 40) { verstecken(); return; }
        // nur wenn der Mensch wischt (nicht beim Mitführen), schnell nach oben und schon ein Stück unten
        if (v < -1500 && top > s.clientHeight && jetzt() - streifenAngefasst < 3) {
            k.style.top = (s.getBoundingClientRect().top + 10) + 'px';
            k.hidden = false;
            clearTimeout(weg);
            weg = setTimeout(verstecken, 2500);
        }
    }, { passive: true });
    // zum Anfang der eigenen Stimme (@dd 20261108): das Pad mit ihrem ersten Ton, in die Mitte
    k.addEventListener('click', () => {
        streifenAngefasst = jetzt();
        const si = stimmeIndex(E.stimme), erste = si >= 0 && P.noten[si] && P.noten[si][0];
        let i = 0;
        if (erste) while (i + 1 < SEG.length && SEG[i + 1] <= erste.t + 1e-6) i++;
        const b = s.children[i];
        const ziel = b ? s.scrollTop + b.getBoundingClientRect().top - s.getBoundingClientRect().top - s.clientHeight / 2 + b.offsetHeight / 2 : 0;
        s.scrollTo({ top: Math.max(0, ziel), behavior: 'smooth' });
        verstecken();
    });
})();

/* ---------- Zurück zu den Noten (@dd 20261108): Symbol oben links eine Sekunde drücken, wie der Weg hierher ---------- */

(() => {
    const el = $('marke');
    if (!el) return;
    // Gewechselt wird erst beim Loslassen (@dd 20261108: sonst landete das Loslassen auf der neuen, noch
    // ungestalteten Notenseite im Takt-Feld und öffnete die Zahlentastatur)
    let uhr = null, scharf = false;
    const ab = () => { clearTimeout(uhr); uhr = null; scharf = false; el.classList.remove('druck', 'scharf'); };
    el.addEventListener('pointerdown', e => {
        if (hilfe || e.button > 0) return;
        e.preventDefault();
        ab();
        el.classList.add('druck');
        uhr = setTimeout(() => { scharf = true; el.classList.add('scharf'); }, 1000);
    });
    el.addEventListener('pointerup', () => { const los = scharf; ab(); if (los) location.href = 'index.html'; });
    ['pointercancel', 'pointerleave'].forEach(t => el.addEventListener(t, ab));
    el.addEventListener('contextmenu', e => e.preventDefault());
})();

/* ---------- Start ---------- */

(async () => {
    const q = new URLSearchParams(location.search);
    const lied = q.get('lied') || 'Bereit.musicxml';
    const ablauf = q.get('ablauf') || lied.replace(/\.musicxml$/i, '.ablauf.json');
    try {
        const [rx, ra] = await Promise.all([fetch(lied, { cache: 'no-cache' }), fetch(ablauf, { cache: 'no-cache' })]);
        if (!rx.ok) throw new Error(lied + ': ' + rx.status);
        if (!ra.ok) throw new Error(ablauf + ': ' + ra.status);
        P = partiturLesen(await rx.text());
        A = await ra.json();
    } catch (e) {
        $('jetzt').textContent = 'nicht geladen';
        $('dann').textContent = e.message;
        return;
    }
    let titel = P.titel || lied.replace(/\.musicxml$/i, '');
    titel = titel.charAt(0).toUpperCase() + titel.slice(1);
    $('titel').textContent = titel;
    document.title = titel + ' · Begleitung';
    const st0 = stelleVon(A.anfang ? stellePos(A.anfang) : 0);
    $('startTakt').textContent = `Takt ${st0.takt}` + (st0.schlag > 1 ? `, Schlag ${st0.schlag}` : '');
    leitsilbenBilden();
    ereignisseBilden();
    anfangStellen();
    stimmwahlBauen();
    streifenZeigen();
    zeigen();
})();

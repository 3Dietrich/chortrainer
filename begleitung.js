/*
 * Begleitung: live begleiten mit einer Taste (@dd 20261104).
 *
 * Ablauf (Akkorde, Sonderstellen) steht in <Lied>.ablauf.json, Text und Takte kommen aus der MusicXML.
 * Plan von @dd (Stimme üben mit Akkorden):
 * - Taste A: alles stoppt, solange sie gedrückt ist klingt ein leiser Stimmton a, die Begleitung steht am Anfang.
 * - Anfang (z.B. 2:1 "Seele"): davor singen nur die Stimmen. Der erste Tipp startet den Klang, dann hört die
 *   Begleitung hin: der zweite Tipp gilt immer für die nächste Tippstelle (einen Takt bzw. 2/4 später), der Abstand
 *   gibt das Metrum. Das gilt nach jedem Start (Anfang, Pad, Stopp).
 * - Tippen auf: DDs (Stellen und Raster aus dem Ablauf), Takt (jede Eins), 2/4 (Eins und Drei).
 * - Nach einem Tipp laufen die Akkorde nur innerhalb desselben Taktes von selbst weiter. Kommt kein Tipp, bleibt
 *   es still; die Uhr schätzt weiter, wo der Chor ist, und der nächste Tipp rastet auf die nächstgelegene Stelle.
 * - Tempo: Mittel aus den Tipp-Abständen, dazu Faktoren aus dem Ablauf (Takt 18 zieht an, Schluss langsamer).
 *
 * Aufruf: begleitung.html?lied=Bereit.musicxml (Ablauf: Bereit.ablauf.json daneben).
 */
'use strict';

const $ = id => document.getElementById(id);

/* ---------- Einstellungen (nur Bequemlichkeit pro Gerät, alles geht auch ohne Speicher) ---------- */

const SPEICHER = 'begleitung-einstellungen';
// modus: 'stellen' = DDs Stellen aus dem Ablauf, 'takte' = jede Eins, 'halbe' = Eins und Drei (2/4)
// waerme = Stereo-Chorus, hoehen = Tiefpass (hieß früher Wärme)
const VORGABE = { klang: 'orgel', lautstaerke: 70, tiefbass: 50, waerme: 35, hoehen: 55, modus: 'stellen' };
let E = { ...VORGABE };
try {
    const alt = JSON.parse(localStorage.getItem(SPEICHER) || '{}');
    if (!('hoehen' in alt)) delete alt.waerme;   // alte Fassung: dort war waerme der Tiefpass
    Object.assign(E, alt);
    if (E.klang === 'flaeche') E.klang = 'strings';
} catch (e) { /* privat/gesperrt */ }
function sichern() { try { localStorage.setItem(SPEICHER, JSON.stringify(E)); } catch (e) { /* egal */ } }

/* ---------- MusicXML lesen (Text, Taktanfänge) ---------- */

const SCHRITT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function partiturLesen(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const titel = (doc.querySelector('work-title, movement-title')?.textContent || '').trim();
    const silben = [];
    let taktAnfaenge = [], ende = 0;
    [...doc.querySelectorAll('part')].forEach((teil, si) => {
        let div = 1, t = 0;
        const anfaenge = [];
        for (const takt of teil.querySelectorAll(':scope > measure')) {
            anfaenge.push(t);
            for (const e of takt.children) {
                const dauer = () => +(e.querySelector(':scope > duration')?.textContent || 0) / div;
                if (e.tagName === 'attributes') {
                    const d = e.querySelector('divisions');
                    if (d) div = +d.textContent;
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
                    t += d;
                }
            }
        }
        if (si === 0) taktAnfaenge = anfaenge;
        ende = Math.max(ende, t);
    });
    const stimmen = [...doc.querySelectorAll('part-list score-part')].map(sp => (sp.querySelector('part-name')?.textContent || '').trim());
    return { titel, silben, taktAnfaenge, ende, stimmen };
}

let P = null;        // Partitur
let LEIT = [];       // Leitsilben: je Zeitpunkt die Silbe der obersten Stimme mit Text

function leitsilbenBilden() {
    // Rang: zuerst die Textstimme aus dem Ablauf (für @dd der Tenor, er singt danach), dann von oben nach unten
    const bevorzugt = A && A.textstimme ? P.stimmen.findIndex(n => n.toLowerCase() === A.textstimme.toLowerCase()) : -1;
    const rang = s => (s.stimme === bevorzugt ? -1 : s.stimme);
    const jeZeit = new Map();
    for (const s of P.silben) {
        const k = s.t.toFixed(4);
        if (!jeZeit.has(k) || rang(jeZeit.get(k)) > rang(s)) jeZeit.set(k, s);
    }
    LEIT = [...jeZeit.values()].sort((a, b) => a.t - b.t);
}

/** Text der Leitstimme im Abschnitt, Silben eines Wortes zusammengezogen. */
/** Das ganze Wort, in dem die erste Silbe ab pos liegt (in ihrer eigenen Stimme), mit Silbenstrichen; die Silbe an pos fett. */
function wortAn(pos, bis, stimme = -1) {
    const x0 = stimme >= 0
        ? P.silben.filter(x => x.stimme === stimme && x.t >= pos - 1e-6).sort((a, b) => a.t - b.t)[0]
        : LEIT.find(x => x.t >= pos - 1e-6);
    if (!x0 || x0.t >= bis - 1e-6) return '';
    const eigene = P.silben.filter(x => x.stimme === x0.stimme).sort((a, b) => a.t - b.t);
    let i = eigene.indexOf(x0);
    const hier = i;
    while (i > 0 && (eigene[i].syl === 'middle' || eigene[i].syl === 'end')) i--;
    const teile = [];
    for (let k = i; k < eigene.length; k++) {
        const x = eigene[k], txt = x.text.replace(/[<>&]/g, '');
        teile.push(k === hier && x.syl !== 'single' ? `<b>${txt}</b>` : txt);
        if (x.syl === 'single' || x.syl === 'end' || k - i > 6) break;
    }
    return teile.join('-');
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
function lageFuer(sym) {
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
    if (a.toene.length === 1) beste = [55, 67].map(o => o + ((a.grund - o % 12 + 12) % 12));
    else durch(0, []);
    if (!beste) beste = a.toene.map(pc => 60 + ((pc - 0 + 12) % 12)).sort((x, y) => x - y);
    letzteLage = beste;
    return { bass, oben: beste };
}

/* ---------- Klangerzeugung (WebAudio, ohne Samples) ---------- */

let ctx = null, ausgang = null, lage = null, tonfilter = null, bassBus = null, wachQuelle = null, orgelWelle = null;
let chorusNass = null, vibrato = null;
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
    ausgang.connect(komp).connect(ctx.destination);
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
function tonAn(midi, art, wann, weich, anstieg = null) {
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const g = ctx.createGain();
    g.gain.value = 0;
    const oszis = [];
    const orgel = E.klang === 'orgel';
    if (art === 'sub') {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        o.connect(g); oszis.push(o);
        g.connect(bassBus);
    } else if (orgel) {
        const o = ctx.createOscillator(); o.setPeriodicWave(orgelWelle); o.frequency.value = f;
        o.connect(g); oszis.push(o);
        g.connect(tonfilter);
    } else {
        // Strings: zwei leicht verstimmte Sägezähne und ein Dreieck, weich gefiltert, mit Vibrato
        const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = Math.min(f * 4, 4000); nf.Q.value = 0.3;
        for (const [typ, cent, pegel] of [['sawtooth', -7, 0.5], ['sawtooth', 7, 0.5], ['triangle', 0, 0.8]]) {
            const o = ctx.createOscillator(), og = ctx.createGain();
            o.type = typ; o.frequency.value = f; o.detune.value = cent; og.gain.value = pegel;
            if (vibrato) vibrato.connect(o.detune);
            o.connect(og).connect(nf); oszis.push(o);
        }
        nf.connect(g);
        g.connect(tonfilter);
    }
    const ziel = art === 'sub' ? 0.5 : art === 'grund' ? 0.12 : 0.1;
    anstieg ??= weich ? 0.35 : (orgel || art === 'sub' ? 0.03 : 0.12);
    oszis.forEach(o => o.start(wann));
    g.gain.setTargetAtTime(ziel, wann, anstieg);
    return {
        /** neuer Akkord mit diesem Ton: wieder auf volle Stärke (er war vielleicht schon am Ausklingen) */
        frisch(wannNeu, weichNeu) {
            haltenAb(g.gain, wannNeu);
            g.gain.setTargetAtTime(ziel, wannNeu, weichNeu ? 0.35 : anstieg);
        },
        /** ab wannAus langsam ausklingen, Zeitkonstante tc */
        ausklingen(wannAus, tc) {
            g.gain.setTargetAtTime(0, wannAus, tc);
        },
        stop(wannAus, abkling) {
            haltenAb(g.gain, wannAus);
            g.gain.setTargetAtTime(0, wannAus, abkling / 3);
            oszis.forEach(o => o.stop(wannAus + abkling * 2 + 0.1));
        },
    };
}

let akkordJetzt = '';

/** Spielt ein Akkordsymbol. Töne, die schon klingen, klingen ohne Neuanschlag weiter. */
/**
 * dauer (Viertel): fester Notenwert, danach kurz ab. Ohne dauer klingt der Akkord nach zwei Vierteln langsam
 * aus und ist nach einem 4/4-Takt weg (@dd 20261105: "Noten halten ist blöd").
 */
function akkordSpielen(sym, wann, weich, dauer = null) {
    akkordJetzt = sym;
    const abkling = E.klang === 'orgel' ? 0.25 : 0.6;
    const viertel = 60 / U.bpm;
    if (sym === '-') { alleAus(wann, 0.4); return; }
    const l = lageFuer(sym);
    if (!l) return;
    const soll = new Map();
    soll.set('g:' + l.bass, [l.bass, 'grund']);
    soll.set('s:' + (l.bass - 12), [l.bass - 12, 'sub']);
    l.oben.forEach(m => soll.set('o:' + m, [m, 'oben']));
    for (const [k, ton] of klingend) if (!soll.has(k)) { ton.stop(wann, abkling); klingend.delete(k); }
    for (const [k, [m, art]] of soll) {
        if (klingend.has(k)) klingend.get(k).frisch(wann, weich);
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
    // vor dem Anfang singen nur die Stimmen; die erste Tippstelle danach gibt mit dem Starttipp das Metrum
    anfang = A.anfang ? stellePos(A.anfang) : 0;
    const anfangsTakt = stelleVon(anfang).takt;
    P.taktAnfaenge.forEach((p, i) => { ev(p).takt = i + 1; });
    for (const [s, sym, dauer] of A.akkorde) { const e = ev(stellePos(s)); e.akkord = sym; if (dauer) e.dauer = dauer; }
    // Tippstellen je Modus: DDs = Stellen und Raster aus dem Ablauf, Takt = jede Eins, 2/4 = Eins und Drei
    if (E.modus === 'takte') rasterStellen(anfangsTakt, 4).forEach(p => { ev(p).tippstelle = true; });
    else if (E.modus === 'halbe') rasterStellen(anfangsTakt, 2).forEach(p => { ev(p).tippstelle = true; });
    else {
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
    let vorige = anfang;
    for (const e of EV) if (e.tippstelle || e.warten) { e.luecke = Math.max(1, e.pos - vorige); vorige = e.pos; }
    // Abschnitte für Anzeige, Pads und zurück: von Tippstelle zu Tippstelle
    SEG = EV.filter(e => (e.tippstelle || e.warten) && !e.ende && e.pos >= anfang - 1e-6).map(e => e.pos);
}

// Die Uhr läuft in Echtzeit (performance.now), nicht in der Audiozeit: die steht beim ersten Tipp noch,
// bis das Audiogerät anläuft, und würde das erste Tempo verfälschen.
const jetzt = () => performance.now() / 1000;
const audioZeit = t => Math.max(ctx.currentTime, ctx.currentTime + (t - jetzt()));
const uhrPos = t => (U.laeuft ? U.s0 + (t - U.t0) * U.bpm / 60 : U.s0);
const zeitVon = pos => U.t0 + (pos - U.s0) * 60 / U.bpm;
const taktVon = pos => stelleVon(pos).takt;

function uhrSetzen(pos, t, bpm = U.bpm) { U.s0 = pos; U.t0 = t; U.bpm = bpm; }

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
    if (e.akkord) akkordSpielen(e.akkord, ta, false, e.dauer);
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
            if (e.warten) {
                if (uhrPos(t) < e.pos - 1e-6) break;
                if (e.ende) { schluss(t); break; }
                // anhalten: Uhr steht auf der Wartestelle, bis getippt wird
                uhrSetzen(e.pos, t);
                U.laeuft = false;
                zeigen();
                break;
            }
            const tz = Math.max(t, zeitVon(e.pos));
            if (letzterTipp && taktVon(e.pos) === taktVon(letzterTipp.pos)) ausfuehren(e, tz, false);
            if (e.tempo) uhrSetzen(e.pos, tz, U.basis * faktorBis(e.pos));
            ix++;
        }
    }
    wirbelPlanen(ctx.currentTime + 0.1);
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
                U.basis = Math.min(160, Math.max(40, gemessen));
            } else {
                // begrenzt auf einen Sprung von höchstens 0,6 bis 1,6; ein Takt zählt zu zwei Dritteln
                const neu = Math.min(U.basis * 1.6, Math.max(U.basis * 0.6, gemessen));
                const w = viertel <= 8 ? Math.min(0.65, Math.max(0.2, viertel / 6)) : 0.3;
                U.basis = U.basis * (1 - w) + neu * w;
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

function schluss(t) {
    wirbel = null; hinhoeren = false;
    alleAus(audioZeit(t), 3);
    U.laeuft = false;
    fertig = true;
    zeigen();
}

function neuAnfang() {
    springen(1);
}

/** Bereitstellen am Anfang ohne Klang (beim Laden, vor dem ersten Antippen). */
function anfangStellen() {
    ix = EV.findIndex(e => e.pos >= anfang - 1e-6);
    U.basis = A.tempo;
    uhrSetzen(anfang, jetzt(), U.basis * faktorBis(anfang));
    U.laeuft = false;
    letzterTipp = null;
    hinhoeren = false;
}

/** Taste A drücken: alles stoppen, zurück an den Anfang, leiser Stimmton a, solange gedrückt (Gate). */
function stimmton() {
    if (!P || stimmTon) return;
    audioStart();
    const ta = ctx.currentTime;
    springen(1);
    // a (A3), Tenor-Lage, Frauen hören es eine Oktave tiefer; sofort und mit kurzem Einschwingen (Gate)
    stimmTon = tonAn(57, 'oben', ta, false, 0.008);
    $('aKnopf').setAttribute('aria-pressed', 'true');
    zeigen();
}

function stimmtonAus(ta) {
    if (!stimmTon) return;
    stimmTon.stop(ta, 0.4);
    stimmTon = null;
    $('aKnopf').setAttribute('aria-pressed', 'false');
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
    fertig = false; wirbel = null; hinhoeren = false;
    const pos = Math.max(ziel, anfang);
    ix = EV.findIndex(e => e.pos >= pos - 1e-6);
    if (!tempoBehalten) U.basis = A.tempo;
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
    if (!U.laeuft || !letzterTipp) return false;
    const n = EV.find(e => (e.tippstelle || e.warten) && e.pos > letzterTipp.pos + 1e-6);
    return !!n && p > n.pos + 0.25;
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
    $('stelle').textContent = `Takt ${st.takt}` + (laeuft || st.schlag > 1 ? `, Schlag ${st.schlag}` : '');
    $('tempoAnz').textContent = `♩ ${Math.round(U.bpm)}`;
    let zustand = hinhoeren ? 'hört hin' : U.laeuft ? (schaetzt ? 'schätzt' : 'läuft') : 'wartet auf Tipp';
    if (fertig) zustand = 'Ende';
    if (!U.laeuft && !letzterTipp && Math.abs(U.s0 - anfang) < 1e-6) zustand = 'bereit';
    if (stimmTon) zustand = 'Stimmton a';
    if (bestaetigt > 0 && t - bestaetigt < 0.6) zustand = 'ja, weiter';
    $('zustand').textContent = zustand;
    $('zustand').dataset.art = schaetzt ? 'schaetzt' : (laeuft ? 'laeuft' : 'wartet');
    // geschätzt: der Akkord, der an der vermuteten Stelle gälte, blass (er klingt nicht)
    const ak = schaetzt ? akkordBei(p) : akkordJetzt;
    $('akkord').textContent = ak && ak !== '-' && !fertig ? anzeigeName(ak) : '';
    $('akkord').classList.toggle('blass', schaetzt);
    const i = segIndex(p);
    $('jetzt').textContent = textIn(SEG[i], segEnde(i));
    $('dann').innerHTML = i + 1 < SEG.length
        ? `dann <b>${segName(SEG[i + 1])}</b> <b class="ak">${akkordeIn(SEG[i + 1], segEnde(i + 1))}</b> ${textIn(SEG[i + 1], segEnde(i + 1))}` : 'Schluss';
    [...$('streifen').children].forEach((b, k) => b.classList.toggle('an', k === i));
    if (i !== zeigen.seg) {
        zeigen.seg = i;
        $('streifen').children[i]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}
setInterval(() => { if (U.laeuft) zeigen(); }, 100);

function streifenZeigen() {
    const s = $('streifen');
    s.innerHTML = '';
    SEG.forEach((pos, i) => {
        const b = document.createElement('button');
        const text = textIn(pos, segEnde(i)), ak = akkordeIn(pos, segEnde(i));
        // Taktmodus: Akkorde des Taktes; Stellenmodus: das erste Wort, auf das getippt wird
        // Pad: oben Stelle (im Stellenmodus mit Akkord), darunter das Wort mit fetter Tippsilbe bzw. die Akkorde
        // in jedem Modus mit Text (@dd 20261105); die Stimme des Wortes aus dem Ablauf, sonst die Textstimme
        const ev = EV.find(e => Math.abs(e.pos - pos) < 1e-6);
        const oben = segName(pos) + (ak ? ' · ' + ak : '');
        const unten = wortAn(pos, segEnde(i), ev && ev.stimme != null ? ev.stimme : -1) || '·';
        b.innerHTML = `<span class="t">${oben}</span><span class="w">${unten}</span>`;
        b.title = (ak ? ak + ': ' : '') + text;
        b.tabIndex = -1;
        // Gate (@dd 20261105): der Akkord der Stelle klingt, solange der Finger liegt; beim Loslassen steht
        // die Begleitung dort. Wird daraus ein Wischen (Streifen scrollen), nur der Klang aus, kein Sprung.
        let an = false;
        b.addEventListener('pointerdown', e => {
            if (hilfe || e.button > 0) return;
            audioStart();
            const a = akkordBei(pos);
            if (a) { akkordSpielen(a, ctx.currentTime, false, 64); an = true; }
        });
        b.addEventListener('pointerup', () => {
            if (hilfe) return;
            springenAuf(pos, false, false);
            if (ctx) alleAus(ctx.currentTime, 0.15);
            an = false;
        });
        ['pointercancel', 'pointerleave'].forEach(t => b.addEventListener(t, () => {
            if (an && ctx) alleAus(ctx.currentTime, 0.15);
            an = false;
        }));
        s.appendChild(b);
    });
}

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
// Audiogerät schon bei der ersten Berührung irgendwo anlegen: sonst kostet das Anlaufen den ersten Ton
document.addEventListener('pointerdown', () => audioStart(), { capture: true, once: true });
knopf($('stoppKnopf'), zeit => { if (ctx && letzterTipp && !fertig) startStopp(zeit); else if (ctx) alleAus(ctx.currentTime, 0.3); });
// A als Gate: Ton beim Aufsetzen an, beim Loslassen aus; der Finger darf dabei vom Knopf rutschen
$('aKnopf').addEventListener('pointerdown', e => {
    if (hilfe || e.button > 0) return;
    e.preventDefault();
    $('aKnopf').setPointerCapture?.(e.pointerId);
    stimmton();
});
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => $('aKnopf').addEventListener(t, () => {
    if (ctx) { stimmtonAus(ctx.currentTime); zeigen(); }
}));
// Tastatur (Enter/Leertaste auf dem fokussierten Knopf): kurzer Ton, ein Gate gibt es dort nicht
$('aKnopf').addEventListener('click', e => {
    if (hilfe || e.detail !== 0) return;
    stimmton();
    setTimeout(() => { if (ctx) { stimmtonAus(ctx.currentTime); zeigen(); } }, 1500);
});

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
    else { try { localStorage.setItem('begleitung-anleitung', '1'); } catch (e) { /* egal */ } }
}
$('anleitungKnopf').addEventListener('click', () => { einstellungenAuf(false); anleitungAuf(true); });
$('anleitungZu').addEventListener('click', () => anleitungAuf(false));
try { if (!localStorage.getItem('begleitung-anleitung')) anleitungAuf(true); } catch (e) { /* ohne Speicher nicht von selbst */ }

function regler(id, feld, anzeige = v => v) {
    const r = $(id), out = r.parentElement.querySelector('output');
    r.value = E[feld];
    out.textContent = anzeige(+r.value);
    r.addEventListener('input', () => { E[feld] = +r.value; out.textContent = anzeige(+r.value); sichern(); pegelSetzen(); });
}
regler('lautstaerke', 'lautstaerke');
regler('tiefbass', 'tiefbass');
regler('waerme', 'waerme');
regler('hoehen', 'hoehen');

// Tippen auf: DDs Stellen, jede Eins oder Eins und Drei (@dd 20261105)
(() => {
    const zeile = $('moduswahl');
    for (const [key, name] of [['stellen', 'DDs'], ['takte', 'Takt'], ['halbe', '2/4']]) {
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

/** Leertaste: läuft die Begleitung, stoppt sie; steht sie, startet sie (am Anfang bzw. dort, wo gestoppt wurde). */
function startStopp(zeit) {
    if (!P) return;
    const t = zeit > 0 && zeit <= jetzt() ? zeit : jetzt();
    audioStart();
    if (letzterTipp && !fertig) {
        gestopptBei = SEG[segIndex(uhrPos(t))];
        schluss(t);
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
        else if (ctx) schluss(jetzt());
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
    leitsilbenBilden();
    ereignisseBilden();
    anfangStellen();
    streifenZeigen();
    zeigen();
})();

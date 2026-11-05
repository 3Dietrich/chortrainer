/*
 * Begleitung: live begleiten mit einer Taste (@dd 20261104).
 *
 * Ablauf (Akkorde, Sonderstellen) steht in <Lied>.ablauf.json, Text und Takte kommen aus der MusicXML.
 * Plan von @dd:
 * - Jeden Takt "weiter" drücken. Akkorde mitten im Takt laufen im Tipp-Tempo von selbst.
 * - Tipp ausgelassen: der nächste Takt kommt weich herein und blendet bis zum nächsten Tipp aus (Nachhut).
 * - Tipp viel zu früh: kein echtes weiter, sondern "ja genau, mach weiter" (Nachhut wieder voll).
 * - Kommt wieder ein Tipp im Takt, geht es von dort normal weiter.
 * Tempo: Mittel aus den Tipp-Abständen, dazu Faktoren aus dem Ablauf (Takt 18 zieht an, Schluss langsamer).
 * Eine Uhr läuft im Tipp-Tempo mit; jeder Tipp rastet auf die nächste Tippstelle der Uhr ein.
 *
 * Aufruf: begleitung.html?lied=Bereit.musicxml (Ablauf: Bereit.ablauf.json daneben).
 */
'use strict';

const $ = id => document.getElementById(id);

/* ---------- Einstellungen (nur Bequemlichkeit pro Gerät, alles geht auch ohne Speicher) ---------- */

const SPEICHER = 'begleitung-einstellungen';
const VORGABE = { klang: 'orgel', lautstaerke: 70, tiefbass: 50, waerme: 45, tempo: 0, wach: true };
let E = { ...VORGABE };
try { Object.assign(E, JSON.parse(localStorage.getItem(SPEICHER) || '{}')); } catch (e) { /* privat/gesperrt */ }
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
    return { titel, silben, taktAnfaenge, ende };
}

let P = null;        // Partitur
let LEIT = [];       // Leitsilben: je Zeitpunkt die Silbe der obersten Stimme mit Text

function leitsilbenBilden() {
    const jeZeit = new Map();
    for (const s of P.silben) {
        const k = s.t.toFixed(4);
        if (!jeZeit.has(k) || jeZeit.get(k).stimme > s.stimme) jeZeit.set(k, s);
    }
    LEIT = [...jeZeit.values()].sort((a, b) => a.t - b.t);
}

/** Text der Leitstimme im Abschnitt, Silben eines Wortes zusammengezogen. */
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
    durch(0, []);
    if (!beste) beste = a.toene.map(pc => 60 + ((pc - 0 + 12) % 12)).sort((x, y) => x - y);
    letzteLage = beste;
    return { bass, oben: beste };
}

/* ---------- Klangerzeugung (WebAudio, ohne Samples) ---------- */

let ctx = null, ausgang = null, lage = null, tonfilter = null, bassBus = null, wachQuelle = null, orgelWelle = null;
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
    tonfilter.frequency.setTargetAtTime(500 * Math.pow(16, E.waerme / 100), jetzt, 0.05);
}

function wachSetzen() {
    if (!ctx) return;
    if (E.wach && !wachQuelle) {
        // Gleichanteil weit unter Hörbarkeit (wie Teufel DC): die Box bekommt nie reine Stille
        wachQuelle = ctx.createConstantSource();
        wachQuelle.offset.value = 0.00002;
        wachQuelle.connect(ctx.destination);
        wachQuelle.start();
    } else if (!E.wach && wachQuelle) {
        wachQuelle.stop(); wachQuelle.disconnect(); wachQuelle = null;
    }
}

function haltenAb(p, wann) {
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(wann);
    else { p.cancelScheduledValues(wann); p.setValueAtTime(p.value, wann); }
}

/** art: 'oben' | 'grund' (Bass-Grundton) | 'sub' (Tiefbass eine Oktave darunter) */
function tonAn(midi, art, wann, weich) {
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
        // Fläche: zwei leicht verstimmte Sägezähne und ein Dreieck, weich gefiltert
        const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = Math.min(f * 4, 4000); nf.Q.value = 0.3;
        for (const [typ, cent, pegel] of [['sawtooth', -7, 0.5], ['sawtooth', 7, 0.5], ['triangle', 0, 0.8]]) {
            const o = ctx.createOscillator(), og = ctx.createGain();
            o.type = typ; o.frequency.value = f; o.detune.value = cent; og.gain.value = pegel;
            o.connect(og).connect(nf); oszis.push(o);
        }
        nf.connect(g);
        g.connect(tonfilter);
    }
    const ziel = art === 'sub' ? 0.5 : art === 'grund' ? 0.12 : 0.1;
    const anstieg = weich ? 0.35 : (orgel || art === 'sub' ? 0.03 : 0.12);
    oszis.forEach(o => o.start(wann));
    g.gain.setTargetAtTime(ziel, wann, anstieg);
    return {
        stop(wannAus, abkling) {
            haltenAb(g.gain, wannAus);
            g.gain.setTargetAtTime(0, wannAus, abkling / 3);
            oszis.forEach(o => o.stop(wannAus + abkling * 2 + 0.1));
        },
    };
}

let akkordJetzt = '';

/** Spielt ein Akkordsymbol. Töne, die schon klingen, klingen ohne Neuanschlag weiter. */
function akkordSpielen(sym, wann, weich) {
    akkordJetzt = sym;
    const abkling = E.klang === 'orgel' ? 0.25 : 0.6;
    if (sym === '-') { alleAus(wann, 0.4); return; }
    const l = lageFuer(sym);
    if (!l) return;
    const soll = new Map();
    soll.set('g:' + l.bass, [l.bass, 'grund']);
    soll.set('s:' + (l.bass - 12), [l.bass - 12, 'sub']);
    l.oben.forEach(m => soll.set('o:' + m, [m, 'oben']));
    for (const [k, ton] of klingend) if (!soll.has(k)) { ton.stop(wann, abkling); klingend.delete(k); }
    for (const [k, [m, art]] of soll) if (!klingend.has(k)) klingend.set(k, tonAn(m, art, wann, weich));
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
let ix = 0;              // nächstes auszuführendes Ereignis
const U = { laeuft: false, s0: 0, t0: 0, bpm: 85 };   // Uhr: Position s0 (Viertel) zur Zeit t0 (ctx-Sekunden)
let letzterTipp = null;  // { pos, t }
let nachhut = false;
let fertig = false;

function ereignisseBilden() {
    const jePos = new Map();
    const ev = pos => {
        const k = pos.toFixed(4);
        if (!jePos.has(k)) jePos.set(k, { pos });
        return jePos.get(k);
    };
    P.taktAnfaenge.forEach((p, i) => { const e = ev(p); e.takt = i + 1; e.tippstelle = true; });
    for (const [s, sym] of A.akkorde) { const e = ev(stellePos(s)); e.akkord = sym; e.tippstelle = true; }
    for (const [s, o] of Object.entries(A.stellen || {})) {
        const e = ev(stellePos(s));
        if (o.warten) e.warten = true;
        if (o.tempo) e.tempo = o.tempo;
        if (o.pauke) { e.paukenSchlag = true; ev(stellePos(o.pauke)).wirbelAb = true; }
    }
    const schluss = ev(P.ende); schluss.ende = true; schluss.warten = true;
    EV = [...jePos.values()].sort((a, b) => a.pos - b.pos);
}

// Die Uhr läuft in Echtzeit (performance.now), nicht in der Audiozeit: die steht beim ersten Tipp noch,
// bis das Audiogerät anläuft, und würde das erste Tempo verfälschen.
const jetzt = () => performance.now() / 1000;
const audioZeit = t => Math.max(ctx.currentTime, ctx.currentTime + (t - jetzt()));
const uhrPos = t => (U.laeuft ? U.s0 + (t - U.t0) * U.bpm / 60 : U.s0);
const zeitVon = pos => U.t0 + (pos - U.s0) * 60 / U.bpm;

function uhrSetzen(pos, t, bpm = U.bpm) { U.s0 = pos; U.t0 = t; U.bpm = bpm; }

function lageVoll(t) {
    nachhut = false;
    haltenAb(lage.gain, t);
    lage.gain.setTargetAtTime(1, t, 0.03);
}

/** Nachhut: weich herein, dann bis zum nächsten Tipp ausblenden. */
function lageNachhut(t) {
    nachhut = true;
    const takt = 4 * 60 / U.bpm;
    haltenAb(lage.gain, t);
    lage.gain.setTargetAtTime(0.45, t, 0.25);
    lage.gain.setTargetAtTime(0.0, t + takt * 0.5, takt * 0.7);
}

/** Führt ein Ereignis zur Zeit t aus. weich = Nachhut (kein Tipp an dieser Stelle). */
function ausfuehren(e, t, weich) {
    const ta = audioZeit(t);
    if (e.tempo) { uhrSetzen(e.pos, t, U.bpm * e.tempo); }
    if (e.wirbelAb) wirbel = { ab: ta, naechster: ta, dauer: (zeitVon(naechstePos(e, 'paukenSchlag')) - t) };
    if (e.paukenSchlag && wirbel) { wirbel = null; paukenSchlag(ta, 0.9); }
    if (e.akkord) akkordSpielen(e.akkord, ta, weich);
    if (e.takt && weich) lageNachhut(ta);
}

function naechstePos(e, feld) {
    const f = EV.find(x => x.pos > e.pos && x[feld]);
    return f ? f.pos : e.pos + 2;
}

/** Läuft alle 20 ms: führt fällige Ereignisse aus, hält an Wartestellen. */
function takt() {
    if (!ctx) return;
    const t = jetzt();
    if (U.laeuft) {
        const horizont = uhrPos(t + 0.06);
        while (ix < EV.length && EV[ix].pos <= horizont + 1e-6) {
            const e = EV[ix];
            if (e.warten) {
                // anhalten: Uhr steht auf der Wartestelle, Akkord (und Wirbel) halten
                uhrSetzen(e.pos, t);
                U.laeuft = false;
                zeigen();
                break;
            }
            if (e.takt) {
                // Taktanfang ohne Tipp: noch kurz auf einen späten Tipp warten, dann weich als Nachhut
                const gnade = (A.fenster && A.fenster.gnade) ?? 0.5;
                if (horizont < e.pos + gnade - 1e-6) break;
                ausfuehren(e, Math.max(t, zeitVon(e.pos + gnade)), true);
            } else {
                ausfuehren(e, Math.max(t, zeitVon(e.pos)), nachhut);
            }
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
    if (fertig) { neuAnfang(); return; }
    if (!U.laeuft) {
        // Uhr steht (Anfang, Wartestelle, nach Sprung): Tipp startet genau hier
        const e = EV[ix];
        if (e && e.ende) { schluss(t); return; }
        einrasten(U.s0, t, false);
        return;
    }
    const p = uhrPos(t);
    const f = { frueh: 0.75, spaet: 1, ...A.fenster };
    let beste = null;
    for (const e of EV) {
        if (!e.tippstelle && !e.warten) continue;
        if (letzterTipp && e.pos <= letzterTipp.pos + 1e-6) continue;
        const d = e.pos - p;                  // > 0: Tipp kommt vor der Stelle
        if (d > f.frueh || -d > f.spaet) continue;
        if (!beste || Math.abs(d) < Math.abs(beste.pos - p)) beste = e;
    }
    TIPPS.push({ uhr: +p.toFixed(2), stelle: beste ? +beste.pos.toFixed(2) : null, bpm: Math.round(U.bpm) });
    if (beste) {
        if (beste.ende) { schluss(t); return; }
        einrasten(beste.pos, t, true);
    } else {
        // viel zu früh oder zwischen den Stellen: "ja genau, mach weiter"
        bestaetigt = t;
        if (nachhut) lageVoll(audioZeit(t));
    }
    zeigen();
}

let bestaetigt = -1;
const TIPPS = [];   // Protokoll zum Auswerten nach einer Probe: Uhrstand, Stelle, Tempo

/** Tipp gilt für die Stelle pos: Tempo nachführen, fällige Ereignisse sofort, Uhr neu ansetzen. */
function einrasten(pos, t, tempoMessen) {
    if (tempoMessen && letzterTipp) {
        const viertel = pos - letzterTipp.pos, sek = t - letzterTipp.t;
        if (viertel >= 0.9 && sek > 0.25) {
            const neu = viertel * 60 / sek;
            if (neu > U.bpm * 0.6 && neu < U.bpm * 1.6) {
                // musikalisches Mittel: ein ganzer Takt zählt halb, kurze Abstände (Wackeln) und lange Lücken weniger
                const w = viertel <= 8 ? Math.min(0.5, viertel / 8) : 0.25;
                U.bpm = U.bpm * (1 - w) + neu * w;
            }
        }
    }
    // übersprungene Ereignisse: nur ihr letzter Akkord zählt, Tempo-Faktoren gelten trotzdem
    let akkord = null;
    while (ix < EV.length && EV[ix].pos < pos - 1e-6) {
        const e = EV[ix++];
        if (e.akkord) akkord = e.akkord;
        if (e.tempo) U.bpm *= e.tempo;
        if (e.wirbelAb) wirbel = null;
    }
    uhrSetzen(pos, t);
    U.laeuft = true;
    const e = EV[ix];
    if (e && Math.abs(e.pos - pos) < 1e-6) {
        if (!e.akkord && akkord) akkordSpielen(akkord, audioZeit(t), false);
        ausfuehren(e, t, false);
        ix++;
    } else if (akkord) {
        akkordSpielen(akkord, audioZeit(t), false);
    }
    letzterTipp = { pos, t };
    lageVoll(audioZeit(t));
    zeigen();
}

function schluss(t) {
    wirbel = null;
    alleAus(audioZeit(t), 3);
    U.laeuft = false;
    fertig = true;
    zeigen();
}

function neuAnfang() {
    springen(1);
}

/** Zu Takt n springen: dort steht die Uhr, der Akkord an dieser Stelle klingt, der nächste Tipp startet. */
function springen(n, tempoBehalten = false) {
    if (!P) return;
    audioStart();
    const t = jetzt(), ta = ctx.currentTime;
    fertig = false; wirbel = null;
    const pos = taktBeginn(n);
    ix = EV.findIndex(e => e.pos >= pos - 1e-6);
    if (!tempoBehalten) {
        // Tempo bis hierher aus den Faktoren
        U.bpm = E.tempo || A.tempo;
        for (const e of EV) if (e.pos < pos - 1e-6 && e.tempo) U.bpm *= e.tempo;
    }
    const vorher = [...EV].reverse().find(e => e.pos <= pos + 1e-6 && e.akkord);
    if (vorher && vorher.akkord !== '-' && n > 1) akkordSpielen(vorher.akkord, ta, false); else alleAus(ta, 0.8);
    uhrSetzen(pos, t);
    U.laeuft = false;
    letzterTipp = null;
    lageVoll(ta);
    zeigen();
}

/** Zurück: an den Anfang des laufenden Taktes, ist der gerade erst begonnen, einen Takt davor. */
function zurueck() {
    if (!P) return;
    const p = uhrPos(jetzt());
    const n = stelleVon(p).takt;
    springen(p - taktBeginn(n) > 1 ? n : Math.max(1, n - 1), true);
}

/* ---------- Anzeige ---------- */

function akkordeImTakt(n) {
    const a = taktBeginn(n), b = taktEnde(n);
    return A.akkorde.filter(([s]) => { const p = stellePos(s); return p >= a - 1e-6 && p < b - 1e-6; })
        .map(([s, sym]) => (sym === '-' ? 'Pause' : sym)).join(' ');
}

function zeigen() {
    if (!P) return;
    const t = jetzt();
    const p = Math.min(uhrPos(t), P.ende - 1e-3);
    const st = stelleVon(p);
    $('stelle').textContent = `Takt ${st.takt}` + (U.laeuft ? `, Schlag ${st.schlag}` : '');
    $('tempoAnz').textContent = `♩ ${Math.round(U.bpm)}`;
    let zustand = U.laeuft ? (nachhut ? 'Nachhut' : 'läuft') : 'wartet auf Tipp';
    if (fertig) zustand = 'Ende';
    if (!ctx || (!U.laeuft && ix === 0)) zustand = 'bereit';
    if (bestaetigt > 0 && t - bestaetigt < 0.6) zustand = 'ja, weiter';
    $('zustand').textContent = zustand;
    $('zustand').dataset.art = nachhut ? 'nachhut' : (U.laeuft ? 'laeuft' : 'wartet');
    $('akkord').textContent = akkordJetzt && akkordJetzt !== '-' && !fertig ? akkordJetzt : '';
    $('jetzt').textContent = textIn(taktBeginn(st.takt), taktEnde(st.takt));
    const n = st.takt + 1;
    $('dann').innerHTML = n <= P.taktAnfaenge.length
        ? `dann <b>${n}</b> <b class="ak">${akkordeImTakt(n)}</b> ${textIn(taktBeginn(n), taktEnde(n))}` : 'Schluss';
    [...$('streifen').children].forEach((b, i) => b.classList.toggle('an', i === st.takt - 1));
    if (st.takt !== zeigen.takt) {
        zeigen.takt = st.takt;
        $('streifen').children[st.takt - 1]?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }
}
setInterval(() => { if (U.laeuft || nachhut) zeigen(); }, 100);

function streifenZeigen() {
    const s = $('streifen');
    s.innerHTML = '';
    P.taktAnfaenge.forEach((_, i) => {
        const b = document.createElement('button');
        b.innerHTML = `<span class="t">${i + 1}</span>${akkordeImTakt(i + 1) || '·'}`;
        b.title = textIn(taktBeginn(i + 1), taktEnde(i + 1));
        b.addEventListener('click', () => springen(i + 1));
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
knopf($('zurueck'), zurueck);
$('ausKnopf').addEventListener('click', () => { if (ctx) schluss(jetzt()); });

function einstellungenAuf(auf) {
    $('einstellungen').hidden = !auf;
    if (auf) $('lautstaerke').focus(); else $('zahnrad').focus();
}
$('zahnrad').addEventListener('click', () => einstellungenAuf($('einstellungen').hidden));
$('zu').addEventListener('click', () => einstellungenAuf(false));
$('vonVorn').addEventListener('click', () => { springen(1); einstellungenAuf(false); });

function regler(id, feld, anzeige = v => v) {
    const r = $(id), out = r.parentElement.querySelector('output');
    r.value = E[feld];
    out.textContent = anzeige(+r.value);
    r.addEventListener('input', () => { E[feld] = +r.value; out.textContent = anzeige(+r.value); sichern(); pegelSetzen(); });
}
regler('lautstaerke', 'lautstaerke');
regler('tiefbass', 'tiefbass');
regler('waerme', 'waerme');
$('wach').checked = E.wach;
$('wach').addEventListener('change', () => { E.wach = $('wach').checked; sichern(); wachSetzen(); });

// Klangfarbe: Orgel oder Fläche
(() => {
    const zeile = $('klangwahl');
    for (const [key, name] of [['orgel', 'Orgel'], ['flaeche', 'Fläche']]) {
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

addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        e.preventDefault();
        if (hilfe) hilfeModus(false);
        else if (!$('einstellungen').hidden) einstellungenAuf(false);
        else if (ctx) schluss(jetzt());
        return;
    }
    if (hilfe || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key)) { e.preventDefault(); tippen(e.timeStamp / 1000); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); zurueck(); }
    else if (e.key === ' ' && (document.activeElement === document.body || !document.activeElement)) { e.preventDefault(); tippen(e.timeStamp / 1000); }
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
    $('titel').textContent = titel + ' · Begleitung';
    document.title = titel + ' · Begleitung';
    leitsilbenBilden();
    ereignisseBilden();
    regler('tempo', 'tempo');
    if (!E.tempo) { E.tempo = A.tempo; $('tempo').value = A.tempo; $('tempo').parentElement.querySelector('output').textContent = A.tempo; }
    U.bpm = E.tempo;
    streifenZeigen();
    zeigen();
})();

/*
 * Auftritt: live begleiten mit zwei Tasten (@dd 20261103).
 *
 * Liest die MusicXML des Liedes (vierstimmiger Satz), macht daraus eine Folge von Klängen
 * und spielt bei jedem Tipp auf "weiter" den nächsten. Der Klang hält, bis wieder getippt
 * wird, so folgt die Begleitung dem Chor. Die Akkorde sind der Satz selbst: jede Stimme
 * trägt den Ton bei, der im Abschnitt am längsten klingt, der Bass bekommt eine Oktave
 * darunter dazu (Tiefbass).
 *
 * Tipp-Arten zum Ausprobieren: Klang, Halbtakt, Takt, Wort, Phrase (siehe ARTEN).
 * Aufruf: auftritt.html?lied=Bereit.musicxml (ohne Angabe: Bereit).
 */
'use strict';

const $ = id => document.getElementById(id);

/* ---------- Einstellungen (nur Bequemlichkeit pro Gerät, alles geht auch ohne Speicher) ---------- */

const SPEICHER = 'auftritt-einstellungen';
const VORGABE = { art: 'halbtakt', klang: 'orgel', lautstaerke: 70, tiefbass: 50, waerme: 45, tempo: 0, wach: true };
let E = { ...VORGABE };
try { Object.assign(E, JSON.parse(localStorage.getItem(SPEICHER) || '{}')); } catch (e) { /* privat/gesperrt */ }
function sichern() { try { localStorage.setItem(SPEICHER, JSON.stringify(E)); } catch (e) { /* egal */ } }

/* ---------- MusicXML lesen ---------- */

const SCHRITT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Liefert Stimmen (Noten mit Start/Ende in Vierteln), Textsilben, Taktanfänge, Tempo, Titel. */
function partiturLesen(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const titel = (doc.querySelector('work-title, movement-title')?.textContent || '').trim();
    const namen = [...doc.querySelectorAll('score-part part-name')].map(e => e.textContent.trim());
    let tempo = null;
    const stimmen = [], silben = [];
    let taktAnfaenge = [], ende = 0;

    [...doc.querySelectorAll('part')].forEach((teil, si) => {
        let div = 1, t = 0;
        const noten = [], anfaenge = [];
        for (const takt of teil.querySelectorAll(':scope > measure')) {
            anfaenge.push(t);
            for (const e of takt.children) {
                const dauer = () => +(e.querySelector(':scope > duration')?.textContent || 0) / div;
                if (e.tagName === 'attributes') {
                    const d = e.querySelector('divisions');
                    if (d) div = +d.textContent;
                } else if (e.tagName === 'direction' || e.tagName === 'sound') {
                    const s = e.tagName === 'sound' ? e : e.querySelector('sound[tempo]');
                    if (tempo == null && s?.getAttribute('tempo')) tempo = +s.getAttribute('tempo');
                    const pm = e.querySelector('per-minute');
                    if (tempo == null && pm && +pm.textContent) tempo = +pm.textContent;
                } else if (e.tagName === 'backup') {
                    t -= dauer();
                } else if (e.tagName === 'forward') {
                    t += dauer();
                } else if (e.tagName === 'note') {
                    if (e.querySelector(':scope > grace')) continue;
                    // Akkordnoten innerhalb einer Stimme (Divisi): nur die erste Note zählt
                    if (e.querySelector(':scope > chord')) continue;
                    const d = dauer();
                    const stimme = e.querySelector(':scope > voice')?.textContent.trim();
                    if (stimme && stimme !== '1') { t += d; continue; }
                    const p = e.querySelector(':scope > pitch');
                    if (p) {
                        const midi = 12 * (+p.querySelector('octave').textContent + 1)
                            + SCHRITT[p.querySelector('step').textContent.trim()]
                            + +(p.querySelector('alter')?.textContent || 0);
                        const ties = [...e.querySelectorAll(':scope > tie')].map(x => x.getAttribute('type'));
                        const vorige = noten[noten.length - 1];
                        if (ties.includes('stop') && vorige && vorige.midi === midi && Math.abs(vorige.ende - t) < 1e-6) {
                            vorige.ende = t + d;     // Haltebogen: Note verlängern
                        } else {
                            noten.push({ midi, start: t, ende: t + d });
                        }
                        const ly = e.querySelector(':scope > lyric');
                        const text = ly?.querySelector('text')?.textContent.trim();
                        if (text) silben.push({ t, stimme: si, text, syl: ly.querySelector('syllabic')?.textContent || 'single' });
                    }
                    t += d;
                }
            }
        }
        if (si === 0) { taktAnfaenge = anfaenge; ende = t; }
        ende = Math.max(ende, t);
        stimmen.push(noten);
    });
    return { titel, namen, stimmen, silben, taktAnfaenge, ende, tempo: tempo || 80 };
}

/* ---------- Klänge bilden ---------- */

let P = null;        // Partitur
let LEIT = [];       // Leitsilben: je Zeitpunkt die Silbe der obersten Stimme mit Text

/** Je Stimme der Ton, der im Abschnitt [a, b) am längsten klingt (oder null). */
function satzIn(a, b) {
    const schwelle = Math.min(0.5, (b - a) * 0.25);
    return P.stimmen.map(noten => {
        let best = null, bestDauer = 0;
        for (const n of noten) {
            if (n.ende <= a) continue;
            if (n.start >= b) break;
            const ueber = Math.min(b, n.ende) - Math.max(a, n.start);
            if (ueber > bestDauer) { bestDauer = ueber; best = n.midi; }
        }
        return bestDauer >= schwelle ? best : null;
    });
}

/** Grenzen → Abschnitte im Bereich [von, bis), gleiche Nachbarn zusammengelegt, Stille an den Vorgänger. */
function abschnitte(grenzen, von = 0, bis = P.ende) {
    const g = [...new Set(grenzen.filter(x => x >= von - 1e-6 && x < bis - 1e-6).map(x => +x.toFixed(4)))].sort((x, y) => x - y);
    if (!g.length || g[0] > von + 1e-6) g.unshift(von);
    const aus = [];
    for (let i = 0; i < g.length; i++) {
        const a = g[i], b = i + 1 < g.length ? g[i + 1] : bis;
        const satz = satzIn(a, b);
        if (satz.every(x => x == null)) { if (aus.length) aus[aus.length - 1].ende = b; continue; }
        const schluessel = satz.join(',');
        const vor = aus[aus.length - 1];
        if (vor && vor.schluessel === schluessel) { vor.ende = b; continue; }
        aus.push({ start: a, ende: b, satz, schluessel });
    }
    return aus;
}

function halbtaktGitter() {
    const g = [];
    P.taktAnfaenge.forEach((a, i) => {
        const b = i + 1 < P.taktAnfaenge.length ? P.taktAnfaenge[i + 1] : P.ende;
        g.push(a, a + (b - a) / 2);
    });
    return g;
}

const SATZZEICHEN = /[,.;:!?]$/;

const ARTEN = {
    klang: {
        name: 'Klang',
        bilden: () => abschnitte(P.stimmen.flat().flatMap(n => [n.start, n.ende])),
    },
    halbtakt: { name: 'Halbtakt', bilden: () => abschnitte(halbtaktGitter()) },
    takt: { name: 'Takt', bilden: () => abschnitte(P.taktAnfaenge) },
    wort: {
        name: 'Wort',
        bilden: () => abschnitte([0, ...LEIT.filter(s => s.syl === 'single' || s.syl === 'begin').map(s => s.t)]),
    },
    phrase: {
        name: 'Phrase',
        bilden: () => {
            // Phrase beginnt nach einem Satzzeichen; zu kurze Stücke (unter 2 Vierteln, z.B. „Herr,") hängen am nächsten
            const anfaenge = [0];
            LEIT.forEach((s, i) => { if (i > 0 && SATZZEICHEN.test(LEIT[i - 1].text)) anfaenge.push(s.t); });
            const gefiltert = anfaenge.filter((t, i) => i === 0 || t - anfaenge[i - 1] >= 2);
            const gitter = halbtaktGitter();
            const aus = [];
            gefiltert.forEach((a, i) => {
                const b = i + 1 < gefiltert.length ? gefiltert[i + 1] : P.ende;
                const teile = abschnitte([a, ...gitter], a, b);
                if (teile.length) aus.push({ start: teile[0].start, ende: b, satz: teile[0].satz, teile });
            });
            return aus;
        },
    },
};

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

function stelle(t) {
    let i = 0;
    while (i + 1 < P.taktAnfaenge.length && P.taktAnfaenge[i + 1] <= t + 1e-6) i++;
    const schlag = t - P.taktAnfaenge[i] + 1;
    return { takt: i + 1, schlag: Math.round(schlag * 2) / 2 };
}

/* ---------- Klangerzeugung (WebAudio, ohne Samples) ---------- */

let ctx = null, ausgang = null, tonfilter = null, bassBus = null, wachQuelle = null;
const klingend = new Map();          // Schlüssel "stimme:midi" → { stop }

function impuls(sek) {
    const len = Math.floor(ctx.sampleRate * sek), buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let k = 0; k < 2; k++) {
        const d = buf.getChannelData(k);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
}

let orgelWelle = null;
function audioStart() {
    if (ctx) { if (ctx.state !== 'running') ctx.resume(); return; }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* iOS < 17 */ }
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    const komp = ctx.createDynamicsCompressor();
    komp.threshold.value = -16; komp.ratio.value = 3; komp.attack.value = 0.02; komp.release.value = 0.3;
    ausgang = ctx.createGain();
    ausgang.connect(komp).connect(ctx.destination);
    tonfilter = ctx.createBiquadFilter();
    tonfilter.type = 'lowpass'; tonfilter.Q.value = 0.4;
    tonfilter.connect(ausgang);
    // etwas Raum, damit es nicht trocken aus der Box kommt
    const hall = ctx.createConvolver(), nass = ctx.createGain();
    hall.buffer = impuls(2.4); nass.gain.value = 0.28;
    tonfilter.connect(hall).connect(nass).connect(ausgang);
    bassBus = ctx.createGain();
    bassBus.connect(ausgang);
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

const STIMMPEGEL = [0.75, 1, 1, 1];   // Sopran etwas zurück, die Melodie singt der Chor

function tonAn(midi, stimme, wann) {
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const g = ctx.createGain();
    g.gain.value = 0;
    const oszis = [];
    const orgel = E.klang === 'orgel';
    if (stimme === 'bass') {
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
    const ziel = stimme === 'bass' ? 0.5 : 0.11 * STIMMPEGEL[stimme];
    const anstieg = orgel || stimme === 'bass' ? 0.04 : 0.15;
    oszis.forEach(o => o.start(wann));
    g.gain.setTargetAtTime(ziel, wann, anstieg);
    return {
        stop(wannAus, abkling) {
            const p = g.gain;
            if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(wannAus);
            else { p.cancelScheduledValues(wannAus); p.setValueAtTime(p.value, wannAus); }
            p.setTargetAtTime(0, wannAus, abkling / 3);
            oszis.forEach(o => o.stop(wannAus + abkling * 2 + 0.1));
        },
    };
}

/** Spielt einen Satz (Array je Stimme). Gleiche Töne derselben Stimme klingen ohne Neuanschlag weiter. */
function satzSpielen(satz, wann = ctx.currentTime) {
    const soll = new Map();
    satz.forEach((m, i) => { if (m != null) soll.set(i + ':' + m, [m, i]); });
    const tiefster = [...satz].reverse().find(m => m != null);
    if (tiefster != null) soll.set('bass:' + (tiefster - 12), [tiefster - 12, 'bass']);
    const abkling = E.klang === 'orgel' ? 0.25 : 0.6;
    for (const [k, ton] of klingend) if (!soll.has(k)) { ton.stop(wann, abkling); klingend.delete(k); }
    for (const [k, [m, s]] of soll) if (!klingend.has(k)) klingend.set(k, tonAn(m, s, wann));
}

function ausklingen(sek = 2.5) {
    zeitplanLeeren();
    if (!ctx) return;
    for (const ton of klingend.values()) ton.stop(ctx.currentTime, sek);
    klingend.clear();
}

/* ---------- Ablauf ---------- */

let liste = [];      // Klänge der gewählten Art
let pos = -1;        // Index des klingenden Klangs, -1 = vor dem Anfang
let still = true;    // nach "Aus" oder am Anfang
let zeitplan = [];

function zeitplanLeeren() { zeitplan.forEach(clearTimeout); zeitplan = []; }

function spielen(i) {
    if (i < 0 || i >= liste.length) return;
    audioStart();
    wachhalten();
    zeitplanLeeren();
    pos = i; still = false;
    const k = liste[i];
    satzSpielen(k.satz);
    if (k.teile) {
        // Phrase: Klänge darin im Tempo nachschieben, der letzte hält
        const spv = 60 / (E.tempo || P.tempo);
        k.teile.slice(1).forEach(teil => {
            zeitplan.push(setTimeout(() => satzSpielen(teil.satz), (teil.start - k.start) * spv * 1000));
        });
    }
    zeigen();
}

function weiter() {
    if (!liste.length) return;
    if (pos + 1 >= liste.length) { ausklingen(); still = true; zeigen('Ende'); return; }
    spielen(pos + 1);
}

function zurueck() {
    if (!liste.length) return;
    spielen(Math.max(0, pos - 1));
}

/* ---------- Anzeige ---------- */

function artenZeigen() {
    const nav = $('arten');
    nav.innerHTML = '';
    for (const [key, art] of Object.entries(ARTEN)) {
        const b = document.createElement('button');
        b.setAttribute('aria-pressed', String(E.art === key));
        b.innerHTML = `${art.name}<small>${art.liste.length} Tipps</small>`;
        b.addEventListener('click', () => artWaehlen(key));
        nav.appendChild(b);
    }
}

function artWaehlen(key) {
    // Stelle über den Wechsel retten: neuer Index = letzter Klang, der vor der jetzigen Stelle beginnt
    const t = pos >= 0 ? liste[pos].start : -1;
    E.art = key; sichern();
    liste = ARTEN[key].liste;
    pos = t < 0 ? -1 : liste.reduce((best, k, i) => (k.start <= t + 1e-6 ? i : best), 0);
    artenZeigen();
    streifenZeigen();
    zeigen();
}

function streifenZeigen() {
    const s = $('streifen');
    s.innerHTML = '';
    liste.forEach((k, i) => {
        const b = document.createElement('button');
        b.innerHTML = `<span class="t">${stelle(k.start).takt}</span>${textIn(k.start, k.ende) || '·'}`;
        b.addEventListener('click', () => spielen(i));
        s.appendChild(b);
    });
}

function zeigen(hinweis) {
    const k = liste[pos], n = liste[pos + 1];
    if (pos < 0) {
        $('stelle').textContent = 'bereit';
        $('jetzt').textContent = '';
    } else {
        const st = stelle(k.start);
        $('stelle').textContent = hinweis || (still ? 'ausgeklungen' : `Takt ${st.takt}` + (st.schlag > 1 ? `, Schlag ${st.schlag}` : ''));
        $('jetzt').textContent = textIn(k.start, k.ende) || '…';
    }
    $('zaehler').textContent = `${pos + 1} / ${liste.length}`;
    $('dann').innerHTML = n ? `dann <b>Takt ${stelle(n.start).takt}</b> ${textIn(n.start, n.ende)}` : (pos >= 0 ? 'Schluss' : '');
    [...$('streifen').children].forEach((b, i) => b.classList.toggle('an', i === pos));
    const an = $('streifen').children[Math.max(0, pos)];
    if (an) an.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

function meldung(text) {
    const m = $('meldung');
    m.textContent = text; m.hidden = false;
    setTimeout(() => { m.hidden = true; }, 2500);
}

/* ---------- Bildschirm wach halten ---------- */

let sperre = null;
async function wachhalten() {
    if (sperre || !navigator.wakeLock) return;
    try { sperre = await navigator.wakeLock.request('screen'); sperre.addEventListener('release', () => { sperre = null; }); }
    catch (e) { /* nur über https */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !still) wachhalten(); });

/* ---------- Bedienung ---------- */

let hilfe = false;

function knopf(el, fn) {
    // Antippen löst schon beim Aufsetzen aus (schneller als click), Tastatur über click mit detail 0
    el.addEventListener('pointerdown', e => {
        if (hilfe || e.button > 0) return;
        e.preventDefault();
        el.classList.add('druck');
        fn();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => el.addEventListener(t, () => el.classList.remove('druck')));
    el.addEventListener('click', e => { if (!hilfe && e.detail === 0) fn(); });
}
knopf($('weiter'), weiter);
knopf($('zurueck'), zurueck);
$('ausKnopf').addEventListener('click', () => { ausklingen(); still = true; zeigen(); });

function einstellungenAuf(auf) {
    $('einstellungen').hidden = !auf;
    if (auf) $('lautstaerke').focus(); else $('zahnrad').focus();
}
$('zahnrad').addEventListener('click', () => einstellungenAuf($('einstellungen').hidden));
$('zu').addEventListener('click', () => einstellungenAuf(false));
$('vonVorn').addEventListener('click', () => { ausklingen(0.8); pos = -1; still = true; zeigen(); einstellungenAuf(false); });

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

// Klangfarbe: Orgel oder Fläche, als Zeile in den Einstellungen
(() => {
    const zeile = document.createElement('div');
    zeile.className = 'zeile';
    zeile.dataset.hilfe = 'Klangfarbe. Orgel: Flötenregister, klarer Einsatz. Fläche: weicher Synthesizer-Teppich, setzt langsamer ein.';
    for (const [key, name] of [['orgel', 'Orgel'], ['flaeche', 'Fläche']]) {
        const b = document.createElement('button');
        b.textContent = name;
        b.setAttribute('aria-pressed', String(E.klang === key));
        b.addEventListener('click', () => {
            E.klang = key; sichern();
            [...zeile.children].forEach(x => x.setAttribute('aria-pressed', String(x === b)));
            // laufenden Klang in der neuen Farbe neu anschlagen
            if (ctx && !still && pos >= 0) { ausklingen(0.2); still = false; satzSpielen(liste[pos].satz); }
        });
        zeile.appendChild(b);
    }
    $('einstellungen').insertBefore(zeile, $('einstellungen').firstChild);
})();

addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        e.preventDefault();
        if (hilfe) hilfeModus(false);
        else if (!$('einstellungen').hidden) einstellungenAuf(false);
        else { ausklingen(); still = true; zeigen(); }
        return;
    }
    if (hilfe || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key)) { e.preventDefault(); weiter(); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); zurueck(); }
    else if (e.key === ' ' && (document.activeElement === document.body || !document.activeElement)) { e.preventDefault(); weiter(); }
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
    const lied = new URLSearchParams(location.search).get('lied') || 'Bereit.musicxml';
    try {
        const r = await fetch(lied);
        if (!r.ok) throw new Error(r.status);
        P = partiturLesen(await r.text());
    } catch (e) {
        $('jetzt').textContent = 'Noten nicht geladen';
        $('dann').textContent = lied + ' (' + e.message + ')';
        return;
    }
    let titel = P.titel || lied.replace(/\.musicxml$/i, '');
    titel = titel.charAt(0).toUpperCase() + titel.slice(1);
    $('titel').textContent = titel + ' · Auftritt';
    document.title = titel + ' · Auftritt';
    leitsilbenBilden();
    for (const art of Object.values(ARTEN)) art.liste = art.bilden();
    if (!ARTEN[E.art]) E.art = VORGABE.art;
    liste = ARTEN[E.art].liste;
    regler('tempo', 'tempo', v => v + '');
    if (!E.tempo) { E.tempo = P.tempo; $('tempo').value = P.tempo; $('tempo').parentElement.querySelector('output').textContent = P.tempo; }
    artenZeigen();
    streifenZeigen();
    zeigen();
})();

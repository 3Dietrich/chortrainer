/* Ablauf-Editor: zeigt den Text Takt für Takt (S/A/T/B) und lässt Tippstellen, Anfang und Raster setzen.
   Positionen wie begleitung.js: Vierteln ab Stückanfang; Stelle = "Takt:Schlag". Akkorde nur Anzeige.
   Gespeichert wird per POST /ablauf-speichern (hoerseite_mac.py), der Server schreibt und committet. */
'use strict';
const $ = id => document.getElementById(id);
const EPS = 1e-6;

/* ---------- MusicXML lesen (wie partiturLesen in begleitung.js) ---------- */

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

let P = null;          // Partitur
let A = null;          // Ablauf wie geladen (Felder, die wir nicht anfassen, bleiben so)
let DATEI = '';        // Name der Ablauf-Datei (ohne Pfad), für den Server
let T = [];            // Tippstellen: {pos, stimme: Name|null}  (null = Textstimme)
let ANFANG = '';       // Stelle als Text
let RASTER_AB = '';    // Takt als Text, leer = kein Raster
let RASTER_S = 4;
let stand = '';        // zuletzt gespeicherter Stand (JSON) zum Vergleich

const taktBeginn = n => P.taktAnfaenge[n - 1];
const taktEnde = n => (n < P.taktAnfaenge.length ? P.taktAnfaenge[n] : P.ende);

/** "18:3" → Position in Vierteln; ungültig → NaN */
function stellePos(s) {
    const m = /^\s*(\d+)\s*:\s*(\d+(?:[.,]\d+)?)\s*$/.exec(String(s));
    if (!m) return NaN;
    const takt = +m[1], schlag = +m[2].replace(',', '.');
    if (takt < 1 || takt > P.taktAnfaenge.length) return NaN;
    return taktBeginn(takt) + schlag - 1;
}
function taktVon(pos) {
    let i = 0;
    while (i + 1 < P.taktAnfaenge.length && P.taktAnfaenge[i + 1] <= pos + EPS) i++;
    return i + 1;
}
/** Position → "Takt:Schlag", Dezimalstellen nur wenn nötig */
function stelleText(pos) {
    const n = taktVon(pos);
    const schlag = Math.round((pos - taktBeginn(n) + 1) * 1000) / 1000;
    return n + ':' + schlag;
}

/* ---------- Zustand ---------- */

const textstimmeIdx = () => P.stimmen.findIndex(n => n.toLowerCase() === (A.textstimme || '').toLowerCase());
const stimmeVon = e => (e.stimme == null ? P.stimmen[textstimmeIdx()] : e.stimme);

function ablaufLesen() {
    T = [];
    for (const e of A.tippstellen || []) {
        const s = typeof e === 'string' ? e : e.stelle;
        const pos = stellePos(s);
        if (!isNaN(pos)) T.push({ pos, stimme: typeof e === 'string' ? null : (e.stimme ?? null) });
    }
    ANFANG = A.anfang || '';
    RASTER_AB = A.raster ? String(A.raster.ab) : '';
    RASTER_S = A.raster ? +A.raster.schlaege || 4 : 4;
}

/** Ablauf-Objekt für den Server: alle fremden Felder unverändert, nur anfang, tippstellen und raster ersetzt */
function ablaufBauen() {
    const o = { ...A };
    o.anfang = ANFANG.trim();
    o.tippstellen = [...T].sort((a, b) => a.pos - b.pos)
        .map(e => (e.stimme == null ? stelleText(e.pos) : { stelle: stelleText(e.pos), stimme: e.stimme }));
    const ab = parseInt(RASTER_AB, 10);
    if (ab >= 1) o.raster = { ab, schlaege: RASTER_S }; else delete o.raster;
    return o;
}
const zustandText = () => JSON.stringify(ablaufBauen());

function schmutzZeigen() {
    $('speichern').classList.toggle('schmutz', zustandText() !== stand);
}

/* ---------- Anzeige ---------- */

const kuerzel = n => (n || '?').trim().charAt(0).toUpperCase();
const silbenText = s => s.text + (s.syl === 'begin' || s.syl === 'middle' ? '-' : '');

/** Elemente einer Zeile mit Spalte; jedes spannt bis zur nächsten belegten Spalte (höchstens Taktende) */
function spannen(liste, n) {
    liste.sort((a, b) => a.col - b.col);
    let letzte = 0;
    for (const x of liste) { if (x.col <= letzte) x.col = letzte + 1; letzte = x.col; }   // Kollision: nächste freie Spalte
    liste.forEach((x, i) => { x.bis = i + 1 < liste.length ? liste[i + 1].col : n + 1; });
    return liste.filter(x => x.col <= n);
}

function aufbauen() {
    const wurzel = $('takte');
    const hatFokus = document.activeElement?.dataset?.pos;
    const fokusStimme = document.activeElement?.dataset?.stimme;
    wurzel.textContent = '';
    const aPos = stellePos(ANFANG);
    const abTakt = parseInt(RASTER_AB, 10);
    const akkorde = (A.akkorde || []).map(a => ({ pos: stellePos(a[0]), sym: a[1] })).filter(a => !isNaN(a.pos));
    const frag = document.createDocumentFragment();

    for (let n = 1; n <= P.taktAnfaenge.length; n++) {
        const b0 = taktBeginn(n), laenge = taktEnde(n) - b0;
        const spalten = Math.max(1, Math.ceil(laenge * 2 - EPS));   // Achtel
        const box = document.createElement('section');
        box.className = 'takt';
        const kopf = document.createElement('h2');
        kopf.innerHTML = `<b>${n}</b>`;
        if (!isNaN(aPos) && aPos >= b0 - EPS && aPos < b0 + laenge - EPS) {
            const m = document.createElement('span'); m.className = 'marke'; m.textContent = 'Anfang ' + stelleText(aPos); kopf.append(m);
        }
        box.append(kopf);
        const g = document.createElement('div');
        g.className = 'gitter';
        g.style.setProperty('--n', spalten);
        g.style.gridTemplateColumns = `2em repeat(${spalten}, minmax(70px, 1fr))`;

        // vier Stimmzeilen
        P.stimmen.forEach((name, si) => {
            const k = document.createElement('div');
            k.className = 'kuerzel'; k.textContent = kuerzel(name); k.title = name; k.style.gridRow = si + 1;
            g.append(k);
            const zeile = P.silben.filter(s => s.stimme === si && s.t >= b0 - EPS && s.t < b0 + laenge - EPS)
                .map(s => ({ s, col: Math.round((s.t - b0) * 2) + 1 }));
            for (const x of spannen(zeile, spalten)) {
                const eintrag = T.find(e => Math.abs(e.pos - x.s.t) < EPS && stimmeVon(e) === name);
                const btn = document.createElement('button');
                btn.className = 'silbe' + (eintrag ? ' an' : '') + (eintrag && !isNaN(aPos) && x.s.t < aPos - EPS ? ' vorAnfang' : '')
                    + (!isNaN(aPos) && Math.abs(x.s.t - aPos) < EPS ? ' anfangsort' : '');
                btn.style.gridRow = si + 1;
                btn.style.gridColumn = `${x.col + 1} / ${x.bis + 1}`;
                btn.dataset.pos = x.s.t; btn.dataset.stimme = si;
                btn.setAttribute('aria-pressed', String(!!eintrag));
                btn.setAttribute('aria-label', `${name}, ${stelleText(x.s.t)}, ${x.s.text}${eintrag ? ', Tippstelle' : ''}`);
                btn.title = stelleText(x.s.t);
                btn.textContent = silbenText(x.s);
                if (eintrag) { const st = document.createElement('span'); st.className = 'st'; st.textContent = stelleText(x.s.t); btn.append(st); }
                g.append(btn);
            }
        });

        // Akkordzeile
        const az = P.stimmen.length + 1;
        const k = document.createElement('div');
        k.className = 'kuerzel'; k.textContent = '♪'; k.title = 'Akkorde'; k.style.gridRow = az;
        g.append(k);
        const ak = akkorde.filter(a => a.pos >= b0 - EPS && a.pos < b0 + laenge - EPS).map(a => ({ a, col: Math.round((a.pos - b0) * 2) + 1 }));
        for (const x of spannen(ak, spalten)) {
            const d = document.createElement('div');
            d.className = 'akk'; d.textContent = x.a.sym; d.title = stelleText(x.a.pos);
            d.style.gridRow = az; d.style.gridColumn = `${x.col + 1} / ${x.bis + 1}`;
            g.append(d);
        }

        // Rasterstellen
        const s = RASTER_S;
        if (abTakt >= 1 && n >= abTakt) {
            for (let rel = 0; rel < laenge - EPS; rel += s) {
                const r = document.createElement('div');
                r.className = 'raster'; r.style.gridRow = `1 / ${az + 1}`; r.style.gridColumn = `${Math.round(rel * 2) + 2} / span 1`;
                r.title = 'Raster ' + stelleText(b0 + rel);
                g.append(r);
            }
        }
        box.append(g);
        frag.append(box);
    }
    wurzel.append(frag);
    ohneSilbeZeigen();
    if (hatFokus != null) wurzel.querySelector(`button[data-pos="${hatFokus}"][data-stimme="${fokusStimme}"]`)?.focus({ preventScroll: true });
}

/** Tippstellen, auf denen keine Silbe ihrer Stimme steht: als Knöpfe oben, Klick entfernt sie */
function ohneSilbeZeigen() {
    const kasten = $('ohne');
    const lose = T.filter(e => !P.silben.some(s => Math.abs(s.t - e.pos) < EPS && P.stimmen[s.stimme] === stimmeVon(e)));
    kasten.hidden = !lose.length;
    kasten.textContent = '';
    if (!lose.length) return;
    const l = document.createElement('span'); l.textContent = 'Stellen ohne Silbe (Klick entfernt):'; kasten.append(l);
    for (const e of lose) {
        const b = document.createElement('button');
        b.textContent = stelleText(e.pos) + ' ✕';
        b.addEventListener('click', () => { T = T.filter(x => x !== e); aenderung(); });
        kasten.append(b);
    }
}

function aenderung() { aufbauen(); schmutzZeigen(); }

/* ---------- Bedienung ---------- */

$('takte').addEventListener('click', e => {
    const b = e.target.closest('button.silbe');
    if (!b) return;
    const pos = +b.dataset.pos, si = +b.dataset.stimme, name = P.stimmen[si];
    if (e.altKey) {                       // Wahltaste: Anfang setzen
        ANFANG = stelleText(pos); $('anfang').value = ANFANG; aenderung(); return;
    }
    const vorhanden = T.find(x => Math.abs(x.pos - pos) < EPS);
    if (!vorhanden) T.push({ pos, stimme: si === textstimmeIdx() ? null : name });
    else if (stimmeVon(vorhanden) === name) T = T.filter(x => x !== vorhanden);
    else vorhanden.stimme = si === textstimmeIdx() ? null : name;
    aenderung();
});

$('anfang').addEventListener('input', e => { ANFANG = e.target.value; aenderung(); });
$('rasterAb').addEventListener('input', e => { RASTER_AB = e.target.value.replace(/\D/g, ''); aenderung(); });
$('raster').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    RASTER_S = +b.dataset.s; rasterKnoepfe(); aenderung();
});
function rasterKnoepfe() {
    for (const b of $('raster').children) b.setAttribute('aria-pressed', String(+b.dataset.s === RASTER_S));
}

function meldung(text, fehler, klein) {
    const m = $('meldung');
    m.className = fehler ? 'fehler' : '';
    m.textContent = text;
    if (klein) { const s = document.createElement('small'); s.textContent = klein; m.append(s); }
    m.hidden = false;
    clearTimeout(meldung.uhr);
    meldung.uhr = setTimeout(() => { m.hidden = true; }, fehler ? 15000 : 6000);
}

async function speichern() {
    if (ANFANG.trim() && isNaN(stellePos(ANFANG))) { meldung('Anfang ist keine Stelle (Takt:Schlag, z.B. 2:1)', true, 'Esc schließt'); return; }
    const knopf = $('speichern');
    knopf.disabled = true;
    const ablauf = ablaufBauen();
    try {
        const r = await fetch('/ablauf-speichern', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ datei: DATEI, ablauf }),
        });
        let antwort = {};
        try { antwort = await r.json(); } catch (e) { /* keine JSON-Antwort */ }
        if (!r.ok || !antwort.ok) throw new Error(antwort.fehler || (r.status === 404 ? 'Server kann nicht speichern (404). Läuft die Hörseite am Mac mit dem Endpunkt?' : 'Fehler ' + r.status));
        A = ablauf; stand = JSON.stringify(ablauf); schmutzZeigen();
        meldung(`gespeichert (Commit ${antwort.commit})`, false, 'Esc schließt');
    } catch (e) {
        meldung('Nicht gespeichert: ' + e.message, true, 'Esc schließt');
    } finally {
        knopf.disabled = false;
    }
}
$('speichern').addEventListener('click', speichern);

addEventListener('beforeunload', e => {
    if (A && zustandText() !== stand) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- Hilfemodus (wie in begleitung.html) ---------- */

let hilfe = false;
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
    blase.style.left = links + 'px'; blase.style.top = Math.max(8, oben) + 'px';
}, true);
addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (hilfe) hilfeModus(false);
    else if (!$('meldung').hidden) $('meldung').hidden = true;
});

/* ---------- Start ---------- */

(async () => {
    const q = new URLSearchParams(location.search);
    const lied = q.get('lied') || 'Bereit.musicxml';
    const ablauf = q.get('ablauf') || lied.replace(/\.musicxml$/i, '.ablauf.json');
    DATEI = ablauf.split('/').pop();
    try {
        const [rx, ra] = await Promise.all([fetch(lied, { cache: 'no-cache' }), fetch(ablauf, { cache: 'no-cache' })]);
        if (!rx.ok) throw new Error(lied + ': ' + rx.status);
        if (!ra.ok) throw new Error(ablauf + ': ' + ra.status);
        P = partiturLesen(await rx.text());
        A = await ra.json();
    } catch (e) {
        $('takte').textContent = 'nicht geladen: ' + e.message;
        return;
    }
    $('titel').textContent = 'Ablauf: ' + (P.titel || lied.replace(/\.musicxml$/i, ''));
    document.title = 'Ablauf-Editor ' + (P.titel || '');
    ablaufLesen();
    $('anfang').value = ANFANG; $('rasterAb').value = RASTER_AB; rasterKnoepfe();
    stand = zustandText();
    aufbauen();
    schmutzZeigen();
})();

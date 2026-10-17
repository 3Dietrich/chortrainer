/* ============================================================
   Chor-Trainer – Hauptlogik (trainer.js)
   ============================================================
   Enthält:
     1. Globale Variablen & Konstanten
     2. Settings-Persistenz (localStorage)
     3. AlphaTab API-Initialisierung
     4. Song-Laden & Voice-Splitting (MusicXML)
     5. UI-Steuerung (Buttons, Zoom, Text, Tempo …)
     6. Startup-Sequenz
   ============================================================ */


/* ====================
   1. GLOBALE VARIABLEN
   ==================== */

const el = document.getElementById('alphaTab');  // Notenbereich-Container

let activeTracks = new Set();   // Aktuell hervorgehobene Stimmen (Indizes)
let currentDb = -20;         // Hintergrund-Lautstärke in dB
const DB_STEP = 2;           // Schritt der Lautstärke "Andere Stimmen" in dB
const MIN_DB = -40;
const MAX_DB = 0;

let isLooping = false;  // Loop-Modus aktiv?
let metronomLaut = 1.5;    // Lautstärke des Metronoms (Mix-Faktor, 0.25 – 3), wenn es an ist
let isCountIn = true;   // vor jedem Start einzählen? (Standard: an, 2 × ¼)
let countInArt = '2v';    // 'takt' = ein ganzer Takt, '2v' = zwei Viertel
let baseTempo = 110;    // Originaltempo aus dem Score
let aktuellesTempo = 110; // Notiertes Tempo an der Spielposition (Tempowechsel im Stück)
let tempoJeTakt = [];   // notiertes Tempo je Takt
let currentTempoFactor = 1.0;  // Tempo-Multiplikator (bis 24 BPM – 2.0)
let currentScale = 0.8;   // Noten-Zoom (0.4 – 2.5)
let currentTextSize = 16;    // Text-/Lyricsgröße in px
let taktOffset = 0;          // Taktnummer des ersten Takts minus 1 (aus der MusicXML)

let isSoloView = true;         // Nur gewählte Stimme zeigen (Standard an; ohne Auswahl alle)
let scrollTopAfterRender = false;  // nach dem Laden eines Songs einmal nach oben
let lastLoadedFile = null;     // zuletzt geladene MusicXML (gleicher Song = nur Klang gewechselt)
let pendingResume = null;      // {tick, play}: nach dem Neuladen hier weitermachen
let taktWahl = null;           // gewählter Takt (Tipp in die Noten, roter Rahmen), null = keiner
let bereich = null;            // Abspielbereich { start, ende } in Ticks (dazu von, bis, vonAb, bisBis), null = keiner
let bereichVorschau = null;    // Bereich beim Ziehen, noch nicht gesetzt
const BEREICH_LOOP_START = true;   // neuer Bereich: Loop-Knopf neben Play zuerst an?
let bereichLoop = BEREICH_LOOP_START;
let trackMap = {              // Mapping der musikalischen Tracks
    soloToMaster: new Map(),
    masterToSolos: new Map(),
    isSoloTrack: new Set()
};


/* ==============================
   2. SETTINGS-PERSISTENZ
   ============================== */

const STORAGE_KEY = 'chorTrainerSettings';

/** Alle aktuellen Toolbar-Einstellungen in localStorage speichern. */
function saveSettings() {
    const currentSong = document.getElementById('songSelect').value;

    // Bestehende Stimmen-Auswahl pro Song beibehalten
    const existingRaw = localStorage.getItem(STORAGE_KEY);
    let voices = {};
    if (existingRaw) {
        try {
            const existing = JSON.parse(existingRaw);
            voices = existing.voices || {};
        } catch (e) { }
    }
    voices[currentSong] = Array.from(activeTracks);

    const settings = {
        song: currentSong,
        sound: document.getElementById('soundSelect').value,
        volume: currentDb,
        looping: isLooping,
        countIn: isCountIn,
        countInArt: countInArt,
        tempoFactor: currentTempoFactor,
        textSize: currentTextSize,
        zoomScale: currentScale,
        soloView: isSoloView,
        metronome: document.getElementById('metronomeBtn').classList.contains('active'),
        metronomLaut: metronomLaut,
        voices: voices
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** Gespeicherte Einstellungen laden und auf UI-Elemente anwenden. */
function loadSavedSettings() {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return;
    try {
        const s = JSON.parse(data);

        // Dropdowns wiederherstellen
        if (s.song) document.getElementById('songSelect').value = s.song;
        if (s.sound) document.getElementById('soundSelect').value = s.sound;
        // Klang aus der alten, längeren Liste → Standard "Stimme"
        if (!document.getElementById('soundSelect').value) document.getElementById('soundSelect').value = '54';

        // Globale Variablen wiederherstellen
        if (s.volume !== undefined) currentDb = s.volume;
        if (s.looping !== undefined) isLooping = s.looping;
        if (s.countIn !== undefined) isCountIn = s.countIn;
        if (s.countInArt === 'takt' || s.countInArt === '2v') countInArt = s.countInArt;
        if (s.tempoFactor !== undefined) currentTempoFactor = s.tempoFactor;
        if (s.textSize !== undefined) currentTextSize = s.textSize;
        if (s.zoomScale !== undefined) currentScale = s.zoomScale;
        if (s.soloView !== undefined) isSoloView = s.soloView;

        // Button-Zustände visuell setzen
        const loopBtn = document.getElementById('loopBtn');
        if (loopBtn) loopBtn.classList.toggle('active', !!isLooping);

        const soloBtn = document.getElementById('soloBtn');
        if (soloBtn) soloBtn.classList.toggle('active', !!isSoloView);

        const metronomeBtn = document.getElementById('metronomeBtn');
        if (metronomeBtn) {
            metronomeBtn.classList.toggle('active', !!s.metronome);
        }
        if (s.metronomLaut > 0) metronomLaut = s.metronomLaut;

    } catch (e) { console.error("Load settings failed", e); }
}

/** Song-spezifische Stimmenauswahl nach Score-Load wiederherstellen. */
function loadSavedSettingsForSong() {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return;
    try {
        const s = JSON.parse(data);
        const currentSong = document.getElementById('songSelect').value;
        if (s.voices && s.voices[currentSong]) {
            activeTracks = new Set(s.voices[currentSong]);
        } else {
            activeTracks.clear();
        }
    } catch (e) { console.error("Load song settings failed", e); }
}


/* ==============================
   3. ALPHATAB API
   ============================== */

/* Rand um die Noten: auf großen Bildschirmen alphaTabs Standard (35 px), auf
   Handys schmal, damit mehr Noten auf den Bildschirm passen.
   [links, oben, rechts, unten] in Bildschirmpixeln. */
function notenRand() {
    return innerWidth < 600 ? [10, 20, 10, 20] : [35, 35, 35, 35];
}

const api = new alphaTab.AlphaTabApi(el, {
    core: {
        // Rendern im Hauptthread: nur dort sieht alphaTab globalThis.tvTaktOffset
        useWorkers: false,
        // Alles sofort zeichnen: beim Nachladen blieben Teile nach Größenänderung leer,
        // bis man scrollte. Die Chorsätze sind klein genug.
        enableLazyLoading: false,
        // Notenköpfe einzeln treffbar: Tipp auf eine Note lässt sie erklingen
        includeNoteBounds: true
    },
    player: {
        enablePlayer: true,
        soundFont: "sonivox.sf2",
        metronomeChannel: 15,
        // Tipps in die Noten regelt der Trainer selbst (siehe „Tipps in die Noten“)
        enableUserInteraction: false
    },
    display: {
        layoutMode: 'page',
        scale: 0.8,
        padding: notenRand(),
        fontDirectory: 'font/',
        resources: {
            elementFonts: { effectLyrics: '18px Arial, sans-serif' }
        }
    }
});


/* ==============================
   4. SONG-LADEN & VOICE-SPLITTING
   ============================== */

/**
 * Notenbereich an die festen Leisten anpassen: oben die Kopfzeile, unten der
 * Spieler (nur auf dem Handy unten). Im Vollbild gelten die Werte aus style.css.
 * Der Scroll-Versatz sorgt dafür, dass alphaTab den aktuellen Takt beim
 * Mitscrollen nicht unter die Kopfzeile schiebt.
 */
function adjustContentPadding() {
    if (document.body.classList.contains('vollbild')) {
        el.style.paddingTop = '';
        el.style.paddingBottom = '';
        document.getElementById('pageFoot').style.paddingBottom = '';
        api.settings.player.scrollOffsetY = -10;
        neuTakteMarkieren();   // Abstand oben geändert: „neu“ mitrücken
        return;
    }
    const headerHeight = document.getElementById('toolbar-root').offsetHeight;
    // Einstellungsfeld (breiter Bildschirm) hängt unter der Leiste, egal ob ein- oder zweizeilig
    document.documentElement.style.setProperty('--bar-h', headerHeight + 'px');
    const player = document.getElementById('player');
    const playerUnten = getComputedStyle(player).position === 'fixed';
    const hp = document.getElementById('hoerprobe');
    hp.style.top = (headerHeight + 8) + 'px';
    const hpHoehe = hp.hidden ? 0 : hp.offsetHeight + 6;
    el.style.paddingTop = (headerHeight + 8 + hpHoehe) + 'px';
    el.style.paddingBottom = '10px';
    document.getElementById('pageFoot').style.paddingBottom = ((playerUnten ? player.offsetHeight : 0) + 24) + 'px';
    // Knopf "Aufnahme anhören" mitrechnen, sonst rollt alphaTab den ersten Takt
    // so hoch, dass der Knopf unter der Kopfzeile verschwindet
    api.settings.player.scrollOffsetY = -(headerHeight + 10 + hpHoehe);
    neuTakteMarkieren();   // Abstand oben geändert: „neu“ mitrücken
}

/**
 * Gewählten Song laden, XML verarbeiten (Voice-Splitting),
 * und an AlphaTab übergeben.
 */
async function loadSelectedSong() {
    // Bereich und Taktwahl gehören zum alten Lied
    anker = null;
    taktWahl = null;
    if (bereich) bereichAufheben();
    // Eintrag "Chor-Login" in der Songauswahl: Auswahl zurücksetzen, zur Anmeldung
    const auswahl = document.getElementById('songSelect');
    if (auswahl.value === LOGIN_WERT) {
        if (lastLoadedFile) auswahl.value = lastLoadedFile;
        location.href = 'login.php';
        return;
    }

    // Gespeicherte Stimmen für diesen Song laden
    const data = localStorage.getItem(STORAGE_KEY);
    let savedVoices = null;
    if (data) {
        try {
            const s = JSON.parse(data);
            const currentSong = document.getElementById('songSelect').value;
            if (s.voices && s.voices[currentSong]) {
                savedVoices = s.voices[currentSong];
            }
        } catch (e) { }
    }

    // State zurücksetzen
    if (savedVoices) {
        activeTracks = new Set(savedVoices);
    } else {
        activeTracks.clear();
    }
    trackMap = { soloToMaster: new Map(), masterToSolos: new Map(), isSoloTrack: new Set() };

    const file = document.getElementById('songSelect').value;
    const soundId = document.getElementById('soundSelect').value;
    saveSettings();

    // Läuft gerade die Wiedergabe, erst anhalten: Neuladen während des Abspielens
    // bringt die Audio-Ausgabe durcheinander. Beim Klangwechsel (gleicher Song)
    // geht es danach an derselben Stelle weiter.
    updateHoerprobe();
    const warAn = api.playerState === 1;
    if (warAn) api.pause();
    pendingResume = (file === lastLoadedFile && api.score)
        ? { tick: api.tickPosition, play: warAn }
        : null;
    lastLoadedFile = file;

    try {
        const response = await fetch(file);
        // Gesperrtes Lied ohne gültiges Cookie: zur Anmeldung
        if (response.status === 401) { location.href = 'login.php'; return; }
        const xmlText = await response.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");

        // Taktnummern wie in MuseScore: alphaTab zählt immer ab 1, deshalb den
        // Versatz aus der Nummer des ersten Takts übernehmen (z.B. 4 bei weggelassenem
        // Vorspiel, 0 bei Auftakt). alphaTab_v1_8_1.js liest ihn aus globalThis.tvTaktOffset.
        const ersterTakt = parseInt(xmlDoc.querySelector('part > measure')?.getAttribute('number'), 10);
        taktOffset = Number.isNaN(ersterTakt) ? 0 : ersterTakt - 1;
        globalThis.tvTaktOffset = taktOffset;
        document.getElementById('taktNummer').value = 1 + taktOffset;
        scrollTopAfterRender = !pendingResume;

        // Voice-Splitting: Jede Stimme/Staff-Kombination → eigener Track
        createSoloAudioTracks(xmlDoc, soundId);

        const blob = new Blob(
            [new XMLSerializer().serializeToString(xmlDoc)],
            { type: 'application/vnd.recordare.musicxml+xml' }
        );
        api.load(URL.createObjectURL(blob));

    } catch (e) {
        console.error("XML Processing failed, falling back to raw file", e);
        api.load(file);
    }
}

/**
 * MusicXML aufteilen: Mehrstimmige Parts → einzelne Solo-Parts.
 * Sortiert nach SATB, weist jedem Part einen eigenen MIDI-Kanal zu.
 *
 * @param {Document} xmlDoc  – Das geparste MusicXML-Dokument
 * @param {string}   soundId – MIDI-Programm-Nummer für das Instrument
 */
function createSoloAudioTracks(xmlDoc, soundId) {
    const parts = Array.from(xmlDoc.querySelectorAll('part'));
    const partList = xmlDoc.querySelector('part-list');
    const scoreRoot = xmlDoc.documentElement;

    // Sortier-Priorität: Sopran → Alt → Tenor → Bass → Rest
    const getRank = (name) => {
        const n = name.toLowerCase();
        if (n.includes('sopran')) return 1;
        if (n.includes('alt')) return 2;
        if (n.includes('tenor')) return 3;
        if (n.includes('bass')) return 4;
        return 99;
    };

    const processedParts = [];

    parts.forEach((part, pIdx) => {
        const partId = part.getAttribute('id');
        const scorePart = xmlDoc.querySelector(`score-part[id="${partId}"]`);
        if (!scorePart) return;

        const partName = scorePart.querySelector('part-name').textContent;

        // Alle Stimme/Staff-Kombinationen ermitteln
        const voiceKeys = new Set();
        part.querySelectorAll('note').forEach(n => {
            const v = n.querySelector('voice')?.textContent || "1";
            const s = n.querySelector('staff')?.textContent || "1";
            voiceKeys.add(`${s}-${v}`);
        });

        if (voiceKeys.size > 1) {
            // Mehrstimmig → in einzelne Parts aufteilen
            const sortedKeys = Array.from(voiceKeys).sort();
            sortedKeys.forEach((key, kIdx) => {
                const [staffId, voiceId] = key.split('-');
                const soloId = `${partId}_s${staffId}_v${voiceId}`;
                const soloName = `${partName} ${kIdx + 1}`;

                // Score-Part klonen & umbenennen
                const soloScorePart = scorePart.cloneNode(true);
                soloScorePart.setAttribute('id', soloId);
                soloScorePart.querySelector('part-name').textContent = soloName;
                if (soloScorePart.querySelector('part-abbreviation'))
                    soloScorePart.querySelector('part-abbreviation').textContent = soloName.charAt(0);

                const instrument = soloScorePart.querySelector('score-instrument');
                if (instrument) instrument.setAttribute('id', soloId + "-I1");

                // Part-Daten klonen & fremde Noten entfernen
                const soloPart = part.cloneNode(true);
                soloPart.setAttribute('id', soloId);
                soloPart.querySelectorAll('measure').forEach(m => {
                    m.querySelectorAll('note').forEach(n => {
                        const v = n.querySelector('voice')?.textContent || "1";
                        const s = n.querySelector('staff')?.textContent || "1";
                        if (v !== voiceId || s !== staffId) n.remove();
                    });
                });

                processedParts.push({
                    scorePart: soloScorePart, part: soloPart,
                    rank: getRank(soloName), name: soloName,
                    originalIdx: pIdx * 100 + kIdx
                });
            });
            // Original-Part entfernen
            scorePart.remove();
            part.remove();
        } else {
            // Einstimmig → direkt übernehmen
            processedParts.push({
                scorePart, part,
                rank: getRank(partName), name: partName,
                originalIdx: pIdx * 100
            });
        }
    });

    // Nach SATB sortieren
    processedParts.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return a.originalIdx - b.originalIdx;
    });

    // Part-Liste neu aufbauen & MIDI-Instrument setzen
    partList.innerHTML = '';
    processedParts.forEach(p => {
        const sp = p.scorePart;
        const pt = p.part;

        // Alte MIDI-Tags entfernen
        sp.querySelectorAll('midi-instrument, midi-device').forEach(el => el.remove());

        const instrId = (sp.querySelector('score-instrument')?.getAttribute('id')) || (sp.getAttribute('id') + "-I1");
        const midiInstr = xmlDoc.createElement('midi-instrument');
        midiInstr.setAttribute('id', instrId);
        const midiChan = xmlDoc.createElement('midi-channel');
        midiInstr.appendChild(midiChan);
        const midiProg = xmlDoc.createElement('midi-program');
        midiProg.textContent = soundId;
        midiInstr.appendChild(midiProg);
        sp.appendChild(midiInstr);

        partList.appendChild(sp);
        scoreRoot.appendChild(pt);
    });

    // Eindeutige MIDI-Kanäle vergeben (Kanal 10 = Drums überspringen)
    let nextCh = 1;
    xmlDoc.querySelectorAll('score-part').forEach(sp => {
        if (nextCh === 10) nextCh++;
        if (nextCh === 16) nextCh++;
        const mc = sp.querySelector('midi-channel');
        if (mc) mc.textContent = nextCh++;
    });
}


/* ==============================
   5. UI-STEUERUNG
   ============================== */

/**
 * Kopfzeile unter dem Titel: „Text: …“ links, „Musik: …“ rechts, in einer Zeile.
 * alphaTab legt den Komponisten aus MusicXML unter „artist“ ab (zentriert) und
 * beschriftet Text/Musik englisch. Die Vorsätze aus den MuseScore-Credits
 * („Text:“, „Musik:“) fallen weg, die Vorlage setzt sie wieder.
 */
function kopfzeileSetzen(score) {
    const ohneVorsatz = (s, v) => (s || '').replace(new RegExp('^\\s*' + v + '\\s*:\\s*', 'i'), '');
    score.words = ohneVorsatz(score.words, 'Text');
    if (score.artist && !score.music) {
        score.music = ohneVorsatz(score.artist, 'Musik');
        score.artist = '';
    }
    const M = alphaTab.model;
    if (!score.style) score.style = new M.ScoreStyle();
    // ScoreSubElement: Words 4, Music 5, WordsAndMusic 6 · TextAlign: Left 0, Right 2
    score.style.headerAndFooter.set(4, new M.HeaderFooterStyle('Text: %WORDS%', undefined, 0));
    score.style.headerAndFooter.set(5, new M.HeaderFooterStyle('Musik: %MUSIC%', undefined, 2));
    score.style.headerAndFooter.set(6, new M.HeaderFooterStyle('Text und Musik: %MUSIC%', undefined, 2));
}

/* --- Score geladen: Buttons erzeugen, Tracks konfigurieren --- */
api.scoreLoaded.on(score => {
    kopfzeileSetzen(score);
    baseTempo = score.tempo || 120;
    // Tempowechsel: der %-Regler wirkt als Faktor auf jedes notierte Tempo, die
    // BPM-Anzeige zeigt das Tempo des Takts, in dem die Wiedergabe gerade steht
    let t = baseTempo;
    tempoJeTakt = score.masterBars.map(m => (t = m.tempoAutomations.length ? m.tempoAutomations[m.tempoAutomations.length - 1].value : t));
    aktuellesTempo = baseTempo;
    updateBpmDisplay();

    // Musikalische Tracks filtern (Ghost-Track "Conductor" bei Index 0 ignorieren)
    const musicalTracks = score.tracks.filter(t => t.name && t.staves.length > 0);
    trackMap = {
        allMusicalTracks: musicalTracks,
        trackToIndex: new Map(musicalTracks.map(t => [t, score.tracks.indexOf(t)]))
    };
    console.log("Musical Tracks found:", musicalTracks.map(t => t.name));

    systemTexteSammeln(musicalTracks);
    loadSavedSettingsForSong();
    generateVoiceButtons(score);
    varianteLaden(score);
    updateTrackButtons();
    updateTrackVolumes();
    updateView();

    setTimeout(adjustContentPadding, 100);
    if (pendingResume) setTimeout(resumeWhenReady, 400);
});

/** Nach dem Neuladen (Klangwechsel) Position wiederherstellen und ggf. weiterspielen. */
function resumeWhenReady(versuch = 0) {
    if (!pendingResume) return;
    if (!api.isReadyForPlayback) {
        if (versuch < 50) setTimeout(() => resumeWhenReady(versuch + 1), 100);
        else pendingResume = null;
        return;
    }
    const r = pendingResume;
    pendingResume = null;
    api.tickPosition = r.tick;
    if (r.play) api.play();
}

/** Stimmen-Buttons (Alle, Sopran, Alt, Tenor, Bass …) dynamisch erzeugen. */
function generateVoiceButtons(score) {
    const container = document.getElementById('voiceControls');
    container.innerHTML = '';

    // "Alle"-Button
    const allBtn = document.createElement('button');
    allBtn.className = 'v-btn all';
    allBtn.id = 'voice-btn-all';
    allBtn.innerText = 'Alle';
    allBtn.onclick = () => resetVoices();
    container.appendChild(allBtn);

    // Stimmname normalisieren (z.B. "Sopran 1" → "Sopran")
    const normalize = (name) => {
        const low = name.toLowerCase();
        if (low.includes('sopran')) return 'Sopran';
        if (low.includes('alt')) return 'Alt';
        if (low.includes('tenor')) return 'Tenor';
        if (low.includes('bass')) return 'Bass';
        return name;
    };

    // Button-Daten zusammenstellen
    let items = [];
    trackMap.allMusicalTracks.forEach(t => {
        const originalIndex = trackMap.trackToIndex.get(t);
        items.push({ index: originalIndex, name: t.name, normName: normalize(t.name) });
    });

    // SATB-Sortierung
    const voiceRank = { 'Sopran': 1, 'Alt': 2, 'Tenor': 3, 'Bass': 4 };
    items.sort((a, b) => {
        const rankA = voiceRank[a.normName] || 99;
        const rankB = voiceRank[b.normName] || 99;
        if (rankA !== rankB) return rankA - rankB;
        return a.index - b.index;
    });

    // Buttons erzeugen
    items.forEach(item => {
        const btn = document.createElement('button');
        btn.className = 'v-btn toggle-voice-btn';
        btn.id = 'voice-btn-' + item.index;

        // Kurzlabel: S1, A, T2 …
        let shortLabel = item.normName.charAt(0).toUpperCase();
        const numMatch = item.name.match(/\d+/);
        if (numMatch) shortLabel += numMatch[0];

        const spanShort = document.createElement('span');
        spanShort.className = 'btn-short-text';
        spanShort.innerText = shortLabel;

        const spanLong = document.createElement('span');
        spanLong.className = 'btn-long-text';
        spanLong.innerText = item.name;

        btn.appendChild(spanShort);
        btn.appendChild(spanLong);
        btn.onclick = () => toggleTrack(item.index);
        container.appendChild(btn);
    });
}

/** Einzelne Stimme an-/abwählen. */
function toggleTrack(index) {
    if (activeTracks.has(index)) {
        activeTracks.delete(index);
    } else {
        activeTracks.add(index);
    }
    updateTrackButtons();
    updateTrackVolumes();
    if (isSoloView) updateView();
    saveSettings();
}

/** Alle Stimmen zurücksetzen (keine hervorgehoben). */
function resetVoices() {
    activeTracks.clear();
    updateTrackButtons();
    updateTrackVolumes();
    if (isSoloView) updateView();
    saveSettings();
}

/** Button-Styling an activeTracks anpassen, Beschriftung von "Nur …" mitführen. */
function updateTrackButtons() {
    const names = [];
    document.querySelectorAll('.toggle-voice-btn').forEach(btn => {
        const idx = parseInt(btn.id.replace('voice-btn-', ''));
        const on = activeTracks.has(idx);
        btn.classList.toggle('active', on);
        if (on) names.push(btn.querySelector('.btn-long-text').innerText);
    });
    const allBtn = document.getElementById('voice-btn-all');
    if (allBtn) allBtn.classList.toggle('active', activeTracks.size === 0);

    const label = document.getElementById('soloLabel');
    // „ zeigen“ steht daneben (index.html) und fällt auf schmalen Bildschirmen weg
    if (label) label.innerText = names.length === 1 ? 'Nur ' + names[0] : 'Nur gewählte';
    nurKnopfZeigen();
}

/** Knopf „nur gewählte zeigen“ in der Stimmenleiste: bei „Alle“ ausgegraut. */
function nurKnopfZeigen() {
    const nur = document.getElementById('nurBtn');
    if (!nur) return;
    nur.disabled = activeTracks.size === 0;
    // „Andere Stimmen“ wirkt nur, wenn eine Stimme gewählt ist: sonst blass
    const chor = document.getElementById('chorRegler');
    if (chor) chor.classList.toggle('blass', activeTracks.size === 0);
    nur.classList.toggle('active', isSoloView);
    nur.setAttribute('aria-pressed', isSoloView);
}

/** Lautstärke pro Track setzen: Vordergrund = 100%, Hintergrund = currentDb. */
function updateTrackVolumes() {
    const bgAmp = bgAmplitude();
    const allActive = (activeTracks.size === 0);

    api.score.tracks.forEach((t, i) => {
        // Ghost-Track stumm schalten
        if (!t.name || t.staves.length === 0) {
            api.changeTrackVolume([t], 0);
            return;
        }
        if (allActive) {
            api.changeTrackVolume([t], 1.0);
        } else if (activeTracks.has(i)) {
            api.changeTrackVolume([t], 1.0);     // Vordergrund
        } else {
            api.changeTrackVolume([t], bgAmp);   // Hintergrund
        }
    });
}

/** Ansicht aktualisieren (alle Stimmen oder nur die ausgewählten). */
function updateView() {
    if (!api.score) return;

    const btn = document.getElementById('soloBtn');
    btn.classList.toggle('active', isSoloView);
    nurKnopfZeigen();

    let tracksToRender = trackMap.allMusicalTracks;
    if (isSoloView && activeTracks.size > 0) {
        tracksToRender = tracksToRender.filter(t =>
            activeTracks.has(trackMap.trackToIndex.get(t))
        );
    }
    systemTexteVerteilen(tracksToRender[0]);
    api.renderTracks(tracksToRender);
    setTimeout(adjustContentPadding, 50);
}

/* Systemtexte ("flehend", "strahlend"): MuseScore druckt sie nur über der obersten
   Zeile, alphaTab hängt sie deshalb nur an die oberste Stimme (Markierung
   tvSystemText aus der alphaTab-Anpassung). Je Systemtext merken, welcher Schlag in
   jeder Stimme an derselben Stelle steht, damit er immer über der obersten
   angezeigten Stimme erscheint. */
let systemTexte = [];

function systemTexteSammeln(tracks) {
    systemTexte = [];
    if (!tracks.length) return;
    const quelle = tracks[0];
    quelle.staves[0].bars.forEach((bar, takt) => bar.voices[0].beats.forEach(schlag => {
        if (!schlag.tvSystemText || !schlag.text) return;
        const ziele = new Map();
        for (const t of tracks) {
            const beats = t.staves[0].bars[takt]?.voices[0]?.beats || [];
            // Schlag, der an dieser Stelle klingt (oder zuletzt davor begann)
            let ziel = null;
            for (const b of beats) if (b.playbackStart <= schlag.playbackStart) ziel = b;
            if (ziel) ziele.set(t, { schlag: ziel, eigen: t === quelle ? null : ziel.text });
        }
        systemTexte.push({ text: schlag.text, ziele });
    }));
}

function systemTexteVerteilen(obersteSpur) {
    for (const { text, ziele } of systemTexte) {
        for (const [t, z] of ziele) {
            z.schlag.text = t === obersteSpur ? (z.eigen ? z.eigen + ' ' + text : text) : z.eigen;
        }
    }
}

/* Neue Fassung („neu“): Zu einem Lied kann eine geänderte Fassung als eigene Datei
   liegen (index.html: data-neu an der Option, die Datei steht nicht in der Songwahl).
   Der Trainer lädt sie im Hintergrund, vergleicht Ton für Ton und tauscht beim
   Umschalten nur Tonhöhen und Vorzeichen aus: kein Neuladen, Position und
   Einstellungen bleiben. In den Noten steht über dem ersten geänderten Takt ein „neu“
   zum Umschalten, geänderte Takte bekommen bei neuer Fassung einen gelben Hauch.
   Takte mit anderem Rhythmus werden nicht getauscht (Hinweis in der Konsole). */
const NEU_KEY = 'chorTrainerNeu';
let variante = null;      // { tausch: [{ note, alt, neu }], takte: [{ track, index }], spuren: Set }
let varianteAn = false;

function neuGespeichert(song, an) {
    try {
        const m = JSON.parse(localStorage.getItem(NEU_KEY) || '{}');
        if (an === undefined) return !!m[song];
        m[song] = an;
        localStorage.setItem(NEU_KEY, JSON.stringify(m));
    } catch (e) { return false; }
}

async function varianteLaden(score) {
    variante = null;
    varianteAn = false;
    neuTakteMarkieren();
    const opt = document.getElementById('songSelect').selectedOptions[0];
    const datei = opt && opt.dataset.neu;
    // Neue Fassungen nur mit Chor-Login: ohne Login antwortet der Server mit der
    // Passwortabfrage, und die erscheint dann ungefragt beim Start
    if (!datei || !hatZugang) return;
    try {
        const antwort = await fetch(datei);
        if (!antwort.ok) return;
        // Gleiche Vorbereitung wie beim Lied selbst, damit die Stimmen zueinander passen
        const doc = new DOMParser().parseFromString(await antwort.text(), 'text/xml');
        createSoloAudioTracks(doc, document.getElementById('soundSelect').value);
        const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(doc));
        const neu = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, api.settings);
        if (api.score !== score) return;   // inzwischen ein anderes Lied
        variante = fassungenVergleichen(score, neu);
    } catch (e) {
        console.warn('Neue Fassung nicht lesbar:', datei, e);
        return;
    }
    if (!variante.tausch.length) { variante = null; return; }
    // Neue Fassung einmal layouten, damit tvHoehe den Überstand beider Fassungen kennt.
    // alphaTab layoutet ohne Worker synchron: das nächste render() ersetzt das Bild,
    // bevor der Browser zeichnet, es flackert also nichts.
    for (const x of variante.tausch) Object.assign(x.note, x.neu);
    api.render();
    for (const x of variante.tausch) Object.assign(x.note, x.alt);
    // neu zeichnen: reservierter Vorzeichen-Platz (tvPlatz) und Schildchen
    if (neuGespeichert(opt.value)) varianteUmschalten(true, false);
    else api.render();
}

function fassungenVergleichen(score, neu) {
    const ton = n => ({ octave: n.octave, tone: n.tone, accidentalMode: n.accidentalMode });
    const tausch = [], takte = [], spuren = new Set();
    score.tracks.forEach((t, ti) => {
        const nt = neu.tracks.find(x => x.name === t.name);
        if (!nt) return;
        t.staves.forEach((st, si) => st.bars.forEach((bar, bi) => {
            const nbar = nt.staves[si] && nt.staves[si].bars[bi];
            if (!nbar) return;
            const liste = [];
            let passt = true;
            bar.voices.forEach((v, vi) => {
                const nv = nbar.voices[vi];
                if (!nv || nv.beats.length !== v.beats.length) { passt = false; return; }
                v.beats.forEach((b, i) => {
                    const nb = nv.beats[i];
                    if (nb.duration !== b.duration || nb.dots !== b.dots || nb.notes.length !== b.notes.length) { passt = false; return; }
                    b.notes.forEach((n, k) => {
                        const nn = nb.notes[k];
                        if (nn.octave !== n.octave || nn.tone !== n.tone || nn.accidentalMode !== n.accidentalMode)
                            liste.push({ note: n, alt: ton(n), neu: ton(nn) });
                    });
                });
            });
            if (!passt) { console.warn('Neue Fassung: anderer Rhythmus, nicht getauscht:', t.name, 'Takt', bi + 1 + taktOffset); return; }
            if (!liste.length) return;
            tausch.push(...liste);
            takte.push({ track: t, index: bi });
            spuren.add(ti);
        }));
    });
    // In den geänderten Takten reserviert jeder Schlag aller Stimmen Platz für ein
    // Vorzeichen (alphaTab-Anpassung tvPlatz), damit beim Umschalten nichts verrutscht
    const indizes = new Set(takte.map(k => k.index));
    for (const t of score.tracks) for (const st of t.staves) for (const i of indizes) {
        const bar = st.bars[i];
        if (!bar) continue;
        for (const v of bar.voices) for (const b of v.beats) b.tvPlatz = true;
        bar.tvHoehe = { top: 0, bottom: 0 };   // Zeilenhöhe: größter Überstand beider Fassungen
    }
    return { tausch, takte, spuren };
}

function varianteUmschalten(an = !varianteAn, merken = true) {
    if (!variante) return;
    varianteAn = an;
    for (const x of variante.tausch) Object.assign(x.note, an ? x.neu : x.alt);
    neuTakteMarkieren();
    if (merken) neuGespeichert(document.getElementById('songSelect').value, an);
    // Wiedergabe mit den getauschten Tönen neu aufbauen, an derselben Stelle weiter
    const warAn = api.playerState === 1;
    const tick = api.tickPosition;
    if (warAn) api.pause();
    api.loadMidiForScore();
    updateTrackVolumes();
    api.tickPosition = tick;
    if (warAn) setTimeout(() => api.play(), 50);
    // Neu zeichnen leert kurz die Notenfläche, der Browser scrollt dann nach oben:
    // Scrollposition halten, damit man am Takt bleibt und wiederholt vergleichen kann
    const y = window.scrollY;
    api.render();
    window.scrollTo(0, y);
    requestAnimationFrame(() => window.scrollTo(0, y));
}

/** „neu“ über dem ersten Takt jeder geänderten Stelle und (bei neuer Fassung) gelb
    hinterlegte Takte; nach jedem Zeichnen und nach jedem Umschalten. */
function neuTakteMarkieren() {
    taktWahlZeigen();   // gewählter Takt: gleiche Anlässe zum Neusetzen
    const box = document.getElementById('alphaTab');
    box.querySelectorAll('.neu-takt, .neu-marke').forEach(e => e.remove());
    const lookup = api.renderer && api.renderer.boundsLookup;
    const flaeche = box.querySelector('.at-surface');
    if (!variante || !lookup || !flaeche) return;
    const ab = box.getBoundingClientRect(), fb = flaeche.getBoundingClientRect();
    const dx = fb.left - ab.left, dy = fb.top - ab.top;
    const indizes = new Set(variante.takte.map(k => k.index));
    for (const sys of lookup.staffSystems) for (const mb of sys.bars) {
        const i = mb.index;
        if (!indizes.has(i)) continue;
        // Schildchen am Anfang jeder zusammenhängenden Stelle (und am Zeilenanfang)
        if (!indizes.has(i - 1) || mb === sys.bars[0]) {
            const r = mb.realBounds;
            const marke = document.createElement('span');
            marke.className = 'neu-marke' + (varianteAn ? ' an' : '');
            marke.textContent = 'neu';
            marke.setAttribute('role', 'button');
            marke.setAttribute('aria-pressed', varianteAn);
            marke.title = varianteAn ? 'Neue Fassung (antippen: alte Fassung)' : 'Alte Fassung (antippen: neue Fassung)';
            // rechts neben der Taktnummer: über dem ersten Schlag (Zeilenanfang: hinter dem Schlüssel)
            const erster = mb.bars[0] && mb.bars[0].beats[0];
            marke.style.left = (dx + (erster ? erster.realBounds.x : r.x + 30)) + 'px';
            marke.style.top = (dy + r.y - 12) + 'px';
            // Antippen schaltet nur um: kein Positionssprung, Einstellungen bleiben offen
            ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend']
                .forEach(t => marke.addEventListener(t, e => e.stopPropagation()));
            marke.addEventListener('click', e => { e.stopPropagation(); varianteUmschalten(); });
            box.appendChild(marke);
        }
        if (!varianteAn) continue;
        for (const bb of mb.bars) {
            if (!variante.takte.some(k => k.track === bb.bar.staff.track && k.index === bb.bar.index)) continue;
            const r = bb.realBounds;
            const d = document.createElement('div');
            d.className = 'neu-takt';
            d.style.cssText = `left:${dx + r.x}px;top:${dy + r.y}px;width:${r.w}px;height:${r.h}px`;
            box.appendChild(d);
        }
    }
}

/** Solo-Ansicht (1 Zeile) umschalten. */
function toggleSoloView() {
    isSoloView = !isSoloView;
    updateView();
    saveSettings();
}

/* --- Hintergrund-Lautstärke (Schieber "Andere Stimmen") --- */

/** Lautstärke der anderen Stimmen als Faktor; ganz links (MIN_DB) = stumm. */
function bgAmplitude() {
    return currentDb <= MIN_DB ? 0 : Math.pow(10, currentDb / 20);
}

function setBgVolume(db) {
    currentDb = Math.max(MIN_DB, Math.min(MAX_DB, Number(db)));
    updateBgDisplay();
    updateTrackVolumes();
    saveSettings();
}

function updateBgDisplay() {
    const amp = bgAmplitude();
    const text = amp > 0 ? Math.round(amp * 100) + ' %' : 'stumm';
    document.getElementById('volDisplay').innerText = text;
    // Chor-Regler: Mitsänger wachsen mit der dB-Stellung von Punkten (stumm) bis zur
    // Größe der eigenen Stimme (alle gleich laut); Wert in der Blase beim Ziehen
    const chor = document.getElementById('chorRegler');
    if (chor) {
        const pegel = (currentDb - MIN_DB) / (MAX_DB - MIN_DB);
        const s = 0.18 + 0.82 * pegel;
        chor.querySelectorAll('.mit').forEach(g => {
            const x = Number(g.dataset.x);
            g.setAttribute('transform', `translate(${x} 31) scale(${s}) translate(${-x} -31)`);
            g.style.opacity = 0.45 + 0.55 * pegel;
        });
        chor.setAttribute('aria-valuetext', text);
        document.getElementById('chorWert').innerText = 'Andere ' + text;
    }
}

/* --- Loop (nutzt AlphaTab's native isLooping-Property) --- */
function toggleLoop() {
    isLooping = !isLooping;
    loopAnwenden();
    document.getElementById('loopBtn').classList.toggle('active', isLooping);
    saveSettings();
}

/* --- Einzählen: alphaTab spielt vor jedem Start Metronom-Klicks ---
   Ein Takt oder zwei Viertel. Art und Startschlag reisen über die Lautstärke in den
   Audio-Worker (alphaTab_v1_8_1.js, TotalVokal-Anpassung): 0.8 + 0.1 bei zwei Vierteln
   + (Startschlag + 20 × Sechzehntel nach dem Schlag)/1000; dort wird mit voller
   Lautstärke gespielt. Liegt der Start zwischen zwei Schlägen (Ruhe: „3 und“), klickt
   das Metronom den Schlag davor noch mit. Startschlag und Teil setzt
   einzaehlVorbereiten() direkt vor dem Start. */
function einzaehlCode(startSchlag, teil = 0) {
    return 0.8 + (countInArt === '2v' ? 0.1 : 0) + (Math.min(startSchlag, 15) + 20 * teil) / 1000;
}

function countInAnwenden() {
    api.countInVolume = isCountIn ? einzaehlCode(0) : 0;
    const gewaehlt = isCountIn ? countInArt : 'aus';
    document.querySelectorAll('#countInSeg button').forEach(b => {
        b.classList.toggle('active', b.dataset.art === gewaehlt);
        b.setAttribute('aria-checked', b.dataset.art === gewaehlt);
    });
}

// 'aus' schaltet Einzählen ab, 'takt' oder '2v' schaltet es mit dieser Länge ein
function setCountInArt(art) {
    isCountIn = art !== 'aus';
    if (isCountIn) countInArt = art;
    countInAnwenden();
    saveSettings();
}

/* --- Einzählen sichtbar: Strich bleibt am Taktanfang, große Zahl zählt vor ---
   Eigener Cursor-Handler wie alphaTabs Standard (Strich gleitet zum nächsten Schlag),
   nur hält er die Bewegung zurück, solange eingezählt wird, und startet sie mit dem
   ersten Ton. Die Einzähl-Klicks kommen als Metronom-Ereignisse (midiEventsPlayed,
   mit Schlagnummer). positionChanged meldet alphaTab erst, wenn das Lied selbst läuft:
   daran ist das Ende des Einzählens zu erkennen. Anzeige: 1 Takt im 4/4 = 1 2 3 4 ►,
   2 × ¼ = 3 4 ► (die letzten zwei Schläge vor dem Einsatz), danach nichts. */
const ZUM_NAECHSTEN_SCHLAG = 1;   // alphaTab: MidiTickLookupFindBeatResultCursorMode.ToNextBext
let einzaehlPhase = false;
let einzaehlRest = null;          // zurückgehaltene Bewegung: [beatCursor, x, dauer]
let einzaehlTaktart = 4;          // Schläge pro Takt beim Start (Dauer für den Zeitgeber)

api.customCursorHandler = {
    onAttach() { },
    onDetach() { },
    placeBarCursor(barCursor, beatBounds) {
        const b = beatBounds.barBounds.masterBarBounds.visualBounds;
        barCursor.setBounds(b.x, b.y, b.w, b.h);
    },
    placeBeatCursor(beatCursor, beatBounds, startBeatX) {
        const b = beatBounds.barBounds.masterBarBounds.visualBounds;
        beatCursor.transitionToX(0, startBeatX);
        beatCursor.setBounds(startBeatX, b.y, 1, b.h);
    },
    transitionBeatCursor(beatCursor, beatBounds, startBeatX, nextBeatX, duration, cursorMode) {
        // Wie alphaTab: zum doppelten Abstand in doppelter Zeit, damit der Strich nicht hängt
        const f = cursorMode === ZUM_NAECHSTEN_SCHLAG ? 2 : 1;
        const ziel = startBeatX + (nextBeatX - startBeatX) * f;
        if (einzaehlPhase) einzaehlRest = [beatCursor, ziel, duration * f];
        else beatCursor.transitionToX(duration * f, ziel);
    }
};

api.midiEventsPlayedFilter = [alphaTab.midi.MidiEventType.AlphaTabMetronome];

// Kreis links über dem Startpunkt (Strich), schwarze Zahl.
// text '' = ausblenden (mit Ausblenden, wenn ausblenden gesetzt)
let einzaehlOrt = null;          // [x, y] des Kreises, beim Start des Einzählens festgelegt
let einzaehlZeit = null;         // Sicherheits-Zeitgeber für das Ende des Einzählens
function einzaehlZahl(text, ausblenden = false) {
    let el = document.getElementById('einzaehlZahl');
    if (!text) {
        if (!el) return;
        if (ausblenden) { el.classList.add('weg'); setTimeout(() => { if (el.classList.contains('weg')) el.hidden = true; }, 700); }
        else el.hidden = true;
        return;
    }
    if (!el) {
        el = document.createElement('div');
        el.id = 'einzaehlZahl';
        el.setAttribute('aria-live', 'assertive');
        document.body.appendChild(el);
    }
    if (!einzaehlOrt) {
        const strich = document.querySelector('.at-cursor-beat');
        const takt = document.querySelector('.at-cursor-bar');
        const s = strich ? strich.getBoundingClientRect() : null;
        const t = takt ? takt.getBoundingClientRect() : null;
        const x = s && s.height ? s.left : innerWidth / 2;
        const y = t && t.height ? t.top : (s && s.height ? s.top : innerHeight / 3);
        const kopf = document.querySelector('.topbar').getBoundingClientRect().bottom;
        einzaehlOrt = [Math.max(4, x - 64), Math.max(kopf + 4, y - 64)];
    }
    el.style.left = einzaehlOrt[0] + 'px';
    el.style.top = einzaehlOrt[1] + 'px';
    el.textContent = text;
    el.classList.remove('weg');
    el.hidden = false;
}

function einzaehlEnde() {
    einzaehlPhase = false;
    clearTimeout(einzaehlZeit);
    if (einzaehlRest) {
        const [cursor, x, dauer] = einzaehlRest;
        einzaehlRest = null;
        cursor.transitionToX(dauer, x);
    }
}

// Länge eines Viertels in ms beim aktuellen Tempo
function viertelMs() {
    return 60000 / ((aktuellesTempo || 120) * (api.playbackSpeed || 1));
}

api.playerStateChanged.on(args => {
    if (args.state === 1 && isCountIn) {
        einzaehlPhase = true;
        einzaehlRest = null;
        einzaehlOrt = null;
        const start = startSchlagBerechnen();
        einzaehlTaktart = start.taktart;
        // Startstelle ins Bild holen (der Strich bewegt sich ja noch nicht, alphaTab scrollt sonst erst später)
        api.scrollToCursor();
        // Falls das Signal "Lied läuft" ausbleibt: Strich nach der Einzähl-Dauer trotzdem freigeben
        const schlaege = (countInArt === '2v' ? 2 : einzaehlTaktart) + (start.teil ? 1 : 0);
        clearTimeout(einzaehlZeit);
        einzaehlZeit = setTimeout(() => { if (einzaehlPhase) einzaehlEnde(); }, schlaege * viertelMs() + 800);
    } else if (args.state !== 1) {
        einzaehlPhase = false;
        einzaehlRest = null;
        clearTimeout(einzaehlZeit);
        einzaehlZahl('');
    }
});

api.midiEventsPlayed.on(args => {
    if (!einzaehlPhase) return;
    for (const e of args.events) {
        if (e.type !== alphaTab.midi.MidiEventType.AlphaTabMetronome) continue;
        // Jeder Klick trägt den Schlag, auf den er fällt (alphaTab-Anpassung): Start auf 3
        // mit 2 × ¼ = „1 2“, mit 1 Takt = „3 4 1 2“; Start auf 1 mit 2 × ¼ = „3 4“
        einzaehlZahl(String(e.metronomeNumerator + 1));
    }
});

// BPM-Anzeige folgt Tempowechseln im Stück
api.playerPositionChanged.on(e => {
    const mb = api.tickCache && api.tickCache.masterBars.find(m => m.start <= e.currentTick && e.currentTick < m.end);
    const t = mb ? tempoJeTakt[mb.masterBar.index] : undefined;
    if (t && t !== aktuellesTempo) {
        aktuellesTempo = t;
        updateBpmDisplay();
    }
});

// Erster Ton: ► einen Schlag lang stehen lassen, dann ausblenden
api.playerPositionChanged.on(() => {
    if (!einzaehlPhase) return;
    einzaehlEnde();
    einzaehlZahl('►');
    setTimeout(() => { if (!einzaehlPhase) einzaehlZahl('', true); }, viertelMs());
});

/* --- Vollbild: nur Noten, Leisten weg --- */
function toggleVollbild(an) {
    const on = document.body.classList.toggle('vollbild', an);
    toggleSheet(false);
    // Echtes Vollbild, wo der Browser es kann (Android, Desktop); iPhone blendet nur die Leisten aus
    try {
        if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => { });
        } else if (!on && document.fullscreenElement) {
            document.exitFullscreen().catch(() => { });
        }
    } catch (e) { }
    setTimeout(adjustContentPadding, 50);
}

// Vollbild per Browser verlassen (Esc, Zurück-Geste) → Leisten wieder zeigen
document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('vollbild')) toggleVollbild(false);
});

/* --- Einstellungsblatt --- */
function toggleSheet(an) {
    const offen = document.body.classList.toggle('sheet-open', an);
    if (offen) {
        const sheet = document.getElementById('sheet');
        sheet.classList.toggle('scrollt', sheet.scrollHeight > sheet.clientHeight + 2);
    }
}

/*
 * Blatt per Griff bewegen (Handy):
 * - Strich oben am Blatt (oder Überschrift) nach unten ziehen → Blatt folgt dem
 *   Finger und schließt ab 60px; weniger federt zurück.
 * - Griff oben an der Spielerleiste nach oben ziehen oder antippen → Blatt öffnet.
 */
(() => {
    const sheet = document.getElementById('sheet');
    let start = null;
    /* Finger (wie die Blätter von iOS): Das Blatt scrollt überall selbst (touch-action
       pan-y). Steht es ganz oben und zieht man nach unten, folgt es dem Finger und
       schließt ab 60px, egal wo man ansetzt. Klang-Leiste und Eingabefelder ausgenommen. */
    let t = null;
    sheet.addEventListener('touchstart', e => {
        t = null;
        if (e.touches.length !== 1 || e.target.closest('.chips, input')) return;
        const p = e.touches[0];
        t = { x: p.clientX, y: p.clientY, dy: 0, aktiv: false,
              oben: sheet.scrollTop <= 0 || !!e.target.closest('.grab, .sheet-head') };
    }, { passive: true });
    sheet.addEventListener('touchmove', e => {
        if (!t) return;
        const p = e.touches[0], dy = p.clientY - t.y, dx = p.clientX - t.x;
        if (!t.aktiv) {
            if (Math.hypot(dx, dy) < 8) return;
            if (!(t.oben && dy > 0 && Math.abs(dy) > Math.abs(dx))) { t = null; return; }   // normal scrollen
            t.aktiv = true;
            sheet.style.transition = 'none';
        }
        e.preventDefault();
        t.dy = Math.max(0, dy);
        sheet.style.transform = 'translateY(' + t.dy + 'px)';
    }, { passive: false });
    const touchEnde = () => {
        if (!t) return;
        const war = t.aktiv, zu = t.dy > 60;
        t = null;
        if (!war) return;
        sheet.style.transition = '';
        sheet.style.transform = '';
        if (zu) toggleSheet(false);
    };
    sheet.addEventListener('touchend', touchEnde);
    sheet.addEventListener('touchcancel', touchEnde);

    // Maus/Stift: Ziehen auf freier Fläche (Finger siehe oben)
    sheet.addEventListener('pointerdown', e => {
        if (e.pointerType === 'touch') return;
        if (e.target.closest('button, .swipe-box, .chips, a, input')) return;
        if (sheet.classList.contains('scrollt') && !e.target.closest('.grab, .sheet-head')) return;
        start = { y: e.clientY, dy: 0 };
        sheet.setPointerCapture(e.pointerId);
        sheet.style.transition = 'none';
    });
    sheet.addEventListener('pointermove', e => {
        if (!start) return;
        start.dy = Math.max(0, e.clientY - start.y);
        sheet.style.transform = 'translateY(' + start.dy + 'px)';
    });
    const ende = () => {
        if (!start) return;
        const zu = start.dy > 60;
        start = null;
        sheet.style.transition = '';
        sheet.style.transform = '';
        if (zu) toggleSheet(false);
    };
    sheet.addEventListener('pointerup', ende);
    sheet.addEventListener('pointercancel', ende);

    /* Ganze Spielerleiste: nach oben wischen öffnet das Blatt. Die Leiste hat
       touch-action:none, die Geste geht also nie an die Noten weiter. Kein
       PointerCapture, damit Tipps auf Knöpfe normal ankommen. Tempo-Feld und
       Takt-Feld haben eigene Gesten und sind ausgenommen. */
    const player = document.getElementById('player');
    let w = null;
    player.addEventListener('pointerdown', e => {
        if (e.target.closest('.swipe-box, input, #playerGrab, #metronomeBtn')) return;
        w = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointermove', e => {
        if (!w) return;
        const hoch = w.y - e.clientY;
        if (hoch > 30 && hoch > Math.abs(e.clientX - w.x)) { w = null; klickSperre = true; toggleSheet(true); }
    });
    window.addEventListener('pointerup', () => { w = null; });
    // Endet das Wischen auf einem Knopf, soll der nicht auch noch auslösen
    let klickSperre = false;
    window.addEventListener('click', e => {
        if (!klickSperre) return;
        klickSperre = false;
        if (player.contains(e.target)) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    window.addEventListener('pointerdown', () => { klickSperre = false; }, true);
    window.addEventListener('pointercancel', () => { w = null; });

    const griff = document.getElementById('playerGrab');
    let g = null;
    griff.addEventListener('pointerdown', e => {
        g = { y: e.clientY, offen: false };
        griff.setPointerCapture(e.pointerId);
    });
    griff.addEventListener('pointermove', e => {
        if (g && !g.offen && g.y - e.clientY > 25) { g.offen = true; toggleSheet(true); }
    });
    griff.addEventListener('pointerup', e => {
        if (g && !g.offen && Math.abs(g.y - e.clientY) < 10) toggleSheet(true);  // antippen
        g = null;
    });
    griff.addEventListener('pointercancel', () => { g = null; });
})();

/* --- Beispielaufnahme (data-mp3 am Song) --- */

/** Knopf zeigen/verstecken je nach Song; beim Songwechsel Aufnahme stoppen und zuklappen. */
function updateHoerprobe() {
    const opt = document.getElementById('songSelect').selectedOptions[0];
    const mp3 = opt && opt.dataset.mp3;
    const box = document.getElementById('hoerprobe');
    const audio = document.getElementById('hpAudio');
    audio.pause();
    box.classList.remove('offen');
    document.getElementById('hpText').innerText = 'Aufnahme anhören';
    box.hidden = !mp3;
    if (mp3 && !audio.src.endsWith('/' + mp3)) audio.src = mp3;
    if (mp3) {
        // Gespeicherter Dateiname nach dem Songtitel, z.B. "Bereit.mp3"
        const dl = document.getElementById('hpDl');
        dl.href = mp3;
        dl.download = opt.text.replace(/^🔒\s*/, '').trim() + '.mp3';
    }
    setTimeout(adjustContentPadding, 0);
}

/** Player auf- und zuklappen; beim Aufklappen gleich abspielen. */
function toggleHoerprobe() {
    const box = document.getElementById('hoerprobe');
    const audio = document.getElementById('hpAudio');
    const offen = box.classList.toggle('offen');
    document.getElementById('hpText').innerText = offen ? 'Aufnahme schließen' : 'Aufnahme anhören';
    if (offen) audio.play().catch(() => { });
    else audio.pause();
    setTimeout(adjustContentPadding, 0);
}

// Aufnahme und Trainer spielen nie gleichzeitig
document.getElementById('hpAudio').addEventListener('play', () => {
    if (api.playerState === 1) api.pause();
});

/* --- Klang-Chips aus dem (versteckten) Auswahlfeld aufbauen --- */
function buildSoundChips() {
    const select = document.getElementById('soundSelect');
    const box = document.getElementById('soundChips');
    box.innerHTML = '';
    Array.from(select.options).forEach(o => {
        const chip = document.createElement('button');
        chip.className = 'chip' + (o.value === select.value ? ' active' : '');
        chip.innerText = o.text;
        chip.onclick = () => {
            if (select.value === o.value) return;
            select.value = o.value;
            box.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
            loadSelectedSong();
        };
        box.appendChild(chip);
    });
}

/* --- Metronom --- */
function toggleMetronome(btn) {
    const isOn = btn.classList.toggle('active');
    api.metronomeVolume = isOn ? metronomLaut : 0;
    saveSettings();
}

const METRO_MIN = 0.25, METRO_MAX = 3;   // Lautstärke-Grenzen (Faktor; 3 kurz vor Übersteuern), Schritt × 1,25 ≈ 2 dB

function metroWertZeigen() {
    document.getElementById('metroWert').innerText = 'Metronom ' + Math.round(metronomLaut * 100) + ' %';
}

// Ein Klick zum Vorhören (Lied steht): Taktart plus ein Ereignis eine Achtel später,
// der Sequencer setzt daraus genau einen Metronomschlag (bei kürzerem Ende spielt er nichts)
function metroKlick() {
    try {
        const m = alphaTab.midi;
        const datei = new m.MidiFile();
        datei.addEvent(new m.TimeSignatureEvent(0, 0, 4, 2, 24, 8));
        datei.addEvent(new m.AlphaTabRestEvent(0, 480, 0));
        api.player.playOneTimeMidiFile(datei);
    } catch (e) { console.warn('Metronom-Vorhören', e); }
}

/* Metronom-Knopf: kurz tippen = an/aus. Halten (0,35 s), bis die Blase erscheint, dann
   hoch/runter ziehen = lauter/leiser (12 px je Schritt). Dabei ist es an und zu hören:
   läuft das Lied, mit dem Lied, sonst klickt es im Tempo zur Probe. */
(() => {
    const knopf = document.getElementById('metronomeBtn');
    let g = null;
    const ende = () => {
        if (!g) return;
        clearTimeout(g.zeit);
        clearInterval(g.takt);
        knopf.classList.remove('dragging');
        g = null;
    };
    knopf.addEventListener('pointerdown', e => {
        g = { x: e.clientX, y: e.clientY, halten: false, laut: metronomLaut };
        knopf.setPointerCapture(e.pointerId);
        g.zeit = setTimeout(() => {
            if (!g) return;
            g.halten = true;
            g.laut = metronomLaut;
            g.y = g.yJetzt !== undefined ? g.yJetzt : g.y;
            knopf.classList.add('dragging', 'active');
            audioBereit();
            api.metronomeVolume = metronomLaut;
            saveSettings();
            if (api.playerState !== 1) {
                metroKlick();
                g.takt = setInterval(metroKlick, viertelMs());
            }
        }, 350);
    });
    knopf.addEventListener('pointermove', e => {
        if (!g) return;
        g.yJetzt = e.clientY;
        if (!g.halten) {
            // Vor dem Halten bewegt: kein Tipp und kein Regeln
            if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > 10) { clearTimeout(g.zeit); g.bewegt = true; }
            return;
        }
        const n = Math.round((g.y - e.clientY) / 12);
        const neu = Math.max(METRO_MIN, Math.min(METRO_MAX, Math.round(g.laut * Math.pow(1.25, n) * 100) / 100));
        if (neu === metronomLaut) return;
        metronomLaut = neu;
        api.metronomeVolume = metronomLaut;
        metroWertZeigen();
        saveSettings();
    });
    knopf.addEventListener('pointerup', () => {
        if (g && !g.halten && !g.bewegt) toggleMetronome(knopf);
        ende();
    });
    knopf.addEventListener('pointercancel', ende);
    // Tastatur (Enter/Leertaste): an/aus
    knopf.addEventListener('click', e => { if (e.detail === 0) toggleMetronome(knopf); });
})();

/* --- Tempo --- */
const MIN_BPM = 24;      // langsamstes Übetempo in BPM

const MIN_FACTOR = 0.25;  // Tempo geht von 25 % …
const MAX_FACTOR = 1.5;   // … bis 150 %

function adjustTempo(delta) {
    setTempoFactor(currentTempoFactor + delta);
}

function setTempoFactor(f) {
    // Untergrenze zusätzlich 24 BPM, damit langsame Stücke nicht zum Stillstand kommen
    const minFactor = Math.max(MIN_FACTOR, Math.min(0.5, MIN_BPM / baseTempo));
    currentTempoFactor = Math.round(Math.max(minFactor, Math.min(MAX_FACTOR, f)) * 100) / 100;
    api.playbackSpeed = currentTempoFactor;
    updateBpmDisplay();
    saveSettings();
}

/**
 * Wischfläche: nach rechts oder oben mehr, nach links oder unten weniger,
 * je `px` Pixel ein Schritt. Antippen von ‹ oder › (data-step) = ein Schritt.
 * Am Rechner Pfeiltasten.
 * apply(startwert, schritte) setzt den neuen Wert, getValue() liefert den aktuellen.
 */
function makeSwipe(box, getValue, apply, px = 18) {
    if (!box) return;
    // Im Einstellungsblatt nur waagerecht: senkrechtes Wischen scrollt das Blatt
    // (CSS touch-action: pan-y), damit beim Scrollen kein Wert verstellt wird
    const nurWaagerecht = !!box.closest('#sheet');
    if (nurWaagerecht) px = Math.max(px, 30);
    let start = null;
    box.addEventListener('pointerdown', e => {
        const chev = e.target.closest('[data-step]');
        start = { x: e.clientX, y: e.clientY, v: getValue(), moved: false,
                  step: chev ? Number(chev.dataset.step) : 0 };
        box.setPointerCapture(e.pointerId);
        box.classList.add('dragging');
    });
    box.addEventListener('pointermove', e => {
        if (!start) return;
        // Im Blatt entscheidet die erste Bewegung: senkrecht = scrollen, der Regler bleibt
        if (nurWaagerecht && !start.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8
            && Math.abs(e.clientY - start.y) > Math.abs(e.clientX - start.x)) {
            start = null; box.classList.remove('dragging'); return;
        }
        const d = nurWaagerecht ? e.clientX - start.x : (e.clientX - start.x) - (e.clientY - start.y);
        if (Math.abs(d) > 6) start.moved = true;
        if (start.moved) apply(start.v, Math.round(d / px));
    });
    const ende = () => { start = null; box.classList.remove('dragging'); };
    box.addEventListener('pointerup', () => {
        if (start && !start.moved && start.step) apply(getValue(), start.step);
        ende();
    });
    box.addEventListener('pointercancel', ende);
    box.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { apply(getValue(), 1); e.preventDefault(); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { apply(getValue(), -1); e.preventDefault(); }
    });
}

// Tempo: 5-%-Schritte
makeSwipe(document.getElementById('tempoBox'), () => currentTempoFactor, (f0, n) => {
    const ziel = Math.round((f0 + n * 0.05) * 100) / 100;
    if (ziel !== currentTempoFactor) setTempoFactor(ziel);
});

// Tempo direkt eingeben: zweimal schnell auf die Tempo-Zahl tippen (nicht auf ‹ ›)
// öffnet ein Feld für BPM als ganze Zahl. Enter oder daneben tippen übernimmt, Esc bricht ab.
(() => {
    const box = document.getElementById('tempoBox');
    let letzt = 0, start = null;
    box.addEventListener('pointerdown', e => {
        start = e.target.closest('[data-step], .tempo-eingabe') ? null : { x: e.clientX, y: e.clientY };
    });
    box.addEventListener('pointerup', e => {
        if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) { letzt = 0; return; }
        const jetzt = Date.now();
        if (jetzt - letzt < 450) { letzt = 0; tempoEingeben(); } else letzt = jetzt;
    });
})();

function tempoEingeben() {
    const box = document.getElementById('tempoBox');
    if (box.querySelector('.tempo-eingabe')) return;
    const feld = document.createElement('input');
    feld.className = 'tempo-eingabe';
    feld.type = 'text';
    feld.inputMode = 'numeric';
    feld.pattern = '[0-9]*';
    feld.autocomplete = 'off';
    feld.setAttribute('aria-label', 'Tempo in BPM');
    feld.value = Math.round(aktuellesTempo * currentTempoFactor);
    let fertig = false;
    const schliessen = uebernehmen => {
        if (fertig) return;
        fertig = true;
        const bpm = parseInt(feld.value, 10);
        // Grenzen (24 BPM bzw. 25-150 %) setzt setTempoFactor
        if (uebernehmen && bpm > 0) setTempoFactor(bpm / aktuellesTempo);
        feld.remove();
    };
    // Tasten und Tipps im Feld nicht an Leertaste-Play, Pfeil-Regler oder Wischen weitergeben
    feld.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') schliessen(true);
        if (e.key === 'Escape') schliessen(false);
    });
    feld.addEventListener('pointerdown', e => e.stopPropagation());
    feld.addEventListener('blur', () => schliessen(true));
    box.appendChild(feld);
    feld.focus();
    feld.select();
}

// Andere Stimmen: feine 2-dB-Schritte, ganz links stumm
/* Andere Stimmen als Chor-Regler, bedient wie das Metronom: nur das Symbol.
   Tippen = stumm bzw. zurück auf die vorige Lautstärke. Ziehen (rechts/oben lauter,
   links/unten leiser, 10 px je 2-dB-Schritt, ganzer Weg 200 px): die Mitsänger im
   Symbol wachsen und schrumpfen mit, der Wert steht dabei in einer Blase. */
(() => {
    const knopf = document.getElementById('chorRegler');
    let vorher = -20;     // Lautstärke vor dem Stummschalten
    let g = null;
    knopf.addEventListener('pointerdown', e => {
        g = { x: e.clientX, y: e.clientY, db: currentDb, zieht: false };
        knopf.setPointerCapture(e.pointerId);
    });
    knopf.addEventListener('pointermove', e => {
        if (!g) return;
        const d = (e.clientX - g.x) - (e.clientY - g.y);
        if (!g.zieht && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 6) return;
        g.zieht = true;
        knopf.classList.add('dragging');
        const ziel = Math.max(MIN_DB, Math.min(MAX_DB, g.db + Math.round(d / 10) * DB_STEP));
        if (ziel !== currentDb) setBgVolume(ziel);
    });
    const ende = () => { g = null; knopf.classList.remove('dragging'); };
    knopf.addEventListener('pointerup', () => {
        if (g && !g.zieht) {
            if (currentDb > MIN_DB) { vorher = currentDb; setBgVolume(MIN_DB); }
            else setBgVolume(vorher);
        }
        ende();
    });
    knopf.addEventListener('pointercancel', ende);
    knopf.addEventListener('keydown', e => {
        const n = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (!n) return;
        setBgVolume(Math.max(MIN_DB, Math.min(MAX_DB, currentDb + n * DB_STEP)));
        e.preventDefault();
    });
})();

makeSwipe(document.getElementById('volBox'), () => currentDb, (d0, n) => {
    const ziel = Math.max(MIN_DB, Math.min(MAX_DB, d0 + n * DB_STEP));
    if (ziel !== currentDb) setBgVolume(ziel);
}, 24);

// Notengröße: 10-%-Schritte
makeSwipe(document.getElementById('zoomBox'), () => currentScale, (z0, n) => {
    const ziel = Math.round(Math.max(0.4, Math.min(2.5, z0 + n * 0.1)) * 10) / 10;
    if (ziel !== currentScale) setZoom(ziel);
}, 30);

// Liedtext: 2er-Schritte
makeSwipe(document.getElementById('textBox'), () => currentTextSize, (t0, n) => {
    const ziel = Math.max(8, Math.min(40, t0 + n * 2));
    if (ziel !== currentTextSize) setTextSize(ziel);
}, 30);

function updateBpmDisplay() {
    const pct = Math.round(currentTempoFactor * 100);
    const bpm = Math.round(aktuellesTempo * currentTempoFactor);
    document.getElementById('tempoShort').innerText = pct + ' %';
    document.getElementById('bpmDisplay').innerText = bpm + ' BPM';
}

/* --- Text-/Lyrics-Größe anpassen --- */
let renderTimer = null;

/** Neu zeichnen, aber erst wenn 250ms lang keine weitere Änderung kam (Wischen). */
function renderBald() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
        api.settings.display.scale = currentScale;
        applyTextFont();
        api.updateSettings();
        api.render();
        saveSettings();
    }, 250);
}

function setTextSize(px) {
    currentTextSize = Math.max(8, Math.min(40, px));
    document.getElementById('textSizeDisplay').innerText = currentTextSize;
    renderBald();
}

function adjustTextSize(delta) {
    setTextSize(currentTextSize + delta);
}

/**
 * Font-Objekt für Lyrics und Directions setzen, Vortragstexte im Verhältnis dazu.
 * Prüft, welche NotationElements in dieser alphaTab-Version verfügbar sind.
 */
function applyTextFont() {
    try {
        const font = new alphaTab.model.Font('Arial', currentTextSize);
        const fonts = api.settings.display.resources.elementFonts;
        if (fonts.set) {
            fonts.set(alphaTab.NotationElement.EffectLyrics, font);
            if (alphaTab.NotationElement.EffectDirections !== undefined)
                fonts.set(alphaTab.NotationElement.EffectDirections, font);
            if (alphaTab.NotationElement.EffectWords !== undefined)
                fonts.set(alphaTab.NotationElement.EffectWords, font);
            // Vortragstexte (flehend, strahlend): etwas größer als der Liedtext, kursiv
            fonts.set(alphaTab.NotationElement.EffectText, new alphaTab.model.Font(
                'Georgia, serif', Math.round(currentTextSize * 1.15),
                alphaTab.model.FontStyle.Italic, alphaTab.model.FontWeight.Bold));
        } else {
            const fontStr = currentTextSize + 'px Arial, sans-serif';
            fonts.effectLyrics = fontStr;
            fonts.effectWords = fontStr;
            fonts.effectDirections = fontStr;
        }
    } catch (e) { console.error("Font adjustment failed", e); }
}

/* --- Noten-Zoom anpassen --- */
function setZoom(scale) {
    currentScale = Math.max(0.4, Math.min(2.5, scale));
    document.getElementById('zoomDisplay').innerText = Math.round(currentScale * 100) + "%";
    renderBald();
}

function adjustZoom(delta) {
    setZoom(currentScale + delta);
}

/* --- Takt-Sprung --- */
/* „Go“ wirkt wie ein Tipp auf den Takt in den Noten: einmal = Takt wählen (läuft das
   Lied, geht es am nächsten Taktstrich dort weiter), zweimal schnell = ab dort spielen,
   mit Einzählen nach Einstellung. Enter im Feld zählt wie ein einfacher Klick. */
let goZeit = 0;
function jumpTo() {
    // Eingabe ist die angezeigte Taktnummer, Index = Nummer - Versatz - 1
    const idx = parseInt(document.getElementById('taktNummer').value) - taktOffset - 1;
    if (!api.score || !api.tickCache || !(idx >= 0 && idx < api.score.masterBars.length)) return;
    const jetzt = Date.now();
    const doppelt = jetzt - goZeit < 450;
    goZeit = doppelt ? 0 : jetzt;
    anker = idx;
    if (bereich) bereichAufheben();
    if (doppelt) abTaktSpielen(idx);
    else taktWaehlen(idx, null);
    toggleSheet(false);
}

/* --- Play/Pause mit AudioContext-Workaround --- */

// Stimmen-Lautstärken gelten erst, wenn der Player die Noten geladen hat. Beim
// Seitenaufruf ist er oft noch nicht so weit, deshalb hier noch einmal setzen.
api.playerReady.on(() => {
    if (api.score) updateTrackVolumes();
});

/* --- Einzählen auf den Einsatz ---
   Beginnt der Starttakt ab der Startposition mit Pausen, rückt der Start auf den ersten
   Toneinsatz im selben Takt vor, und das Einzählen führt auf diesen Punkt hin
   (Bereit, Takt 1: Tenor ab Schlag 3, mit 2 × ¼ also „1 2 ►“). Gezählt werden die
   hörbaren Stimmen; sind die übrigen ganz stumm gestellt, nur die gewählten. Übergebundene
   Noten aus dem Vortakt sind kein Einsatz. Ohne Einsatz im Takt bleibt alles, wie es ist. */
// Takt und Schlag (0 = erster) an der aktuellen Position, Wiederholungen eingerechnet
function startSchlagBerechnen() {
    const tick = api.tickPosition;
    const lk = api.tickCache ? api.tickCache.masterBars.find(m => m.start <= tick && tick < m.end) : null;
    const mb = lk ? lk.masterBar : (api.score ? api.score.masterBars[0] : null);
    const n = mb ? mb.timeSignatureNumerator : 4;
    const schlagTicks = 960 * 4 / (mb ? mb.timeSignatureDenominator : 4);
    if (!lk) return { taktart: n, schlag: 0, teil: 0 };
    // Schlag und Rest in Sechzehnteln des Schlags (0 = auf dem Schlag, 2 = „und“)
    const pos = (tick - lk.start) / schlagTicks;
    let schlag = Math.floor(pos + 0.01), teil = Math.round((pos - schlag) * 4);
    if (teil >= 4) { schlag++; teil = 0; }
    return { taktart: n, schlag: schlag % n, teil };
}

// Direkt vor dem Start: auf den Einsatz vorrücken, Startschlag an den Audio-Worker geben
function einzaehlVorbereiten() {
    if (!isCountIn || api.playerState === 1) return;
    einsatzVorruecken();
    const s = startSchlagBerechnen();
    api.countInVolume = einzaehlCode(s.schlag, s.teil);
}

function einsatzVorruecken() {
    if (!isCountIn || !api.score || !api.tickCache || api.playerState === 1) return;
    const tick = api.tickPosition;
    const lk = api.tickCache.masterBars.find(m => m.start <= tick && tick < m.end);
    if (!lk) return;
    const ab = tick - lk.start;                 // Position im Takt
    const idx = lk.masterBar.index;
    const nurGewaehlte = activeTracks.size > 0 && bgAmplitude() === 0;
    let erster = Infinity;
    for (const t of trackMap.allMusicalTracks) {
        if (nurGewaehlte && !activeTracks.has(trackMap.trackToIndex.get(t))) continue;
        for (const st of t.staves) {
            const bar = st.bars[idx];
            if (!bar) continue;
            for (const v of bar.voices) {
                for (const b of v.beats) {
                    if (b.isRest || !b.notes.length || b.notes.every(n => n.isTieDestination)) continue;
                    if (b.playbackStart >= ab - 1 && b.playbackStart < erster) erster = b.playbackStart;
                }
            }
        }
    }
    if (erster !== Infinity && erster > ab) api.tickPosition = lk.start + erster;
}

// Audio freischalten; nur aus einem Tipp/Klick heraus aufrufen (Browser-Regel)
function audioBereit() {
    // iPhone/iPad: Web-Audio wie eine Musik-App ausgeben, damit der Lautlos-Schalter
    // (bzw. die Aktionstaste) den Trainer nicht stumm schaltet (Safari ab iOS 17)
    try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch (e) { }
    if (api.player && typeof api.player.ensureContext === 'function') {
        api.player.ensureContext();
    } else if (api.player && api.player.main) {
        api.player.main.ensureContext();
    }
}

// abHier: an der gesetzten Stelle starten (Doppeltipp auf eine Note), nicht am Taktanfang
function handlePlayClick(abHier = false) {
    // Jeder Start beginnt am Taktanfang: mitten im Takt angehalten, geht es von der Eins
    // dieses Takts los (mit Einzählen auf den ersten Einsatz, wenn eingestellt)
    if (api.playerState !== 1 && api.tickCache) {
        const t = api.tickPosition;
        const lk = api.tickCache.masterBars.find(m => m.start <= t && t < m.end);
        if (abHier !== true && lk && t > lk.start) api.tickPosition = lk.start;
        // Mit Bereich nie davor oder dahinter: ein verschobener Bereich beginnt mitten im Takt
        if (bereich && (api.tickPosition < bereich.start || api.tickPosition >= bereich.ende))
            api.tickPosition = bereich.start;
    }
    if (api.score) updateTrackVolumes();
    document.getElementById('hpAudio').pause();
    audioBereit();
    einzaehlVorbereiten();
    setTimeout(() => api.playPause(), 50);
}

/* --- Play-Button Highlight bei Wiedergabe --- */
api.playerStateChanged.on(args => {
    ['playBtn', 'fsPlay', 'sheetPlay'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.toggle('active', args.state === 1);
    });
});

/* --- Takt-Feld: beim Antippen ist die alte Zahl markiert, Tippen ersetzt sie
       (sonst wird aus 7 schnell 47). iOS setzt die Einfügemarke erst nach dem
       Fokus, deshalb kurz verzögert markieren. --- */
(() => {
    const feld = document.getElementById('taktNummer');
    const alles = () => setTimeout(() => feld.setSelectionRange(0, feld.value.length), 0);
    feld.addEventListener('focus', alles);
    feld.addEventListener('pointerup', e => { if (document.activeElement === feld) alles(); });
})();

/* --- Tipps in die Noten ---
   alphaTabs eigene Auswahl ist aus (enableUserInteraction: false), sie springt beim
   Loslassen sofort. Der Trainer regelt es selbst:
   - Tipp irgendwo in einen Takt: der Takt ist gewählt (roter Rahmen). Steht das Lied,
     steht der Strich danach am Taktanfang. Läuft es, blendet der Klang aus, und am
     nächsten Taktstrich geht es im selben Schlag mit dem gewählten Takt weiter.
   - Tipp auf eine Note bei stehendem Lied: nur die Note erklingt (auch aus einer
     stummen Stimme), Takt und Strich bleiben, wo sie sind.
   - Doppeltipp: ab Anfang dieses Takts abspielen, auf eine Note ab dieser Note, mit
     Einzählen nach Einstellung, auch wenn das Lied schon läuft. Die Nummer kommt außerdem ins Takt-Feld (für „Go“).
   - Bereich: Takt antippen, dann Shift-Klick auf einen anderen Takt, oder mit der Maus
     von einem Takt zum anderen ziehen. Diese Takte werden der Abspielbereich (Rahmen),
     neben Play erscheint ein Loop-Knopf. Ein einfacher Tipp hebt den Bereich auf. */
let tippBeat = null;
let tippOrt = null;         // [x, y] des letzten Tipps auf der Notenfläche
let tippShift = false;      // Shift beim letzten Tipp gedrückt (Bereich bis hier)
let anker = null;           // zuletzt angetippter Takt: Anfang für Shift-Klick
let letzterTipp = null;     // { t, idx } des letzten Tipps, für den Doppeltipp
let sprung = null;          // anstehender Sprung im Audio-Worker: { ziel, zeit }
let noteZeit = null;
let neustartLaeuft = false;

// Ort merken, bevor alphaTab den Tipp bekommt (Erfassungsphase)
el.addEventListener('pointerdown', e => {
    const f = el.querySelector('.at-surface');
    if (!f) return;
    const r = f.getBoundingClientRect();
    tippOrt = [e.clientX - r.left, e.clientY - r.top];
    tippShift = e.shiftKey;
}, true);
// Maus: keine Textauswahl und kein Bild-Ziehen beim Klicken und Ziehen in den Noten
// (sonst bricht der Browser das Ziehen ab, und Shift-Klick markiert Liedtext)
el.addEventListener('mousedown', e => {
    if (e.button === 0 && e.target.closest('.at-surface')) e.preventDefault();
}, true);
api.beatMouseDown.on(beat => { tippBeat = beat; });
// Beim Ziehen den Bereich schon zeigen
api.beatMouseMove.on(beat => {
    if (!tippBeat || !beat || (zug && zug.aktiv)) return;
    const a = tippBeat.voice.bar.index, b = beat.voice.bar.index;
    bereichVorschau = a === b ? null : { von: Math.min(a, b), bis: Math.max(a, b) };
    taktWahlZeigen();
});
api.beatMouseUp.on(beat => {
    const start = tippBeat;
    tippBeat = null;
    bereichVorschau = null;
    if (!start || !beat || !api.score || !api.tickCache) { taktWahlZeigen(); return; }
    const a = start.voice.bar.index, b = beat.voice.bar.index;
    if (a !== b) { anker = a; bereichSetzen(Math.min(a, b), Math.max(a, b)); return; }
    if (tippShift) {
        const von = anker !== null ? anker : aktuellerTakt();
        if (von !== a) { bereichSetzen(Math.min(von, a), Math.max(von, a)); return; }
    }
    anker = a;
    const jetzt = Date.now();
    const doppelt = letzterTipp && jetzt - letzterTipp.t < 450 && letzterTipp.idx === a;
    letzterTipp = doppelt ? null : { t: jetzt, idx: a };
    if (bereich) bereichAufheben();
    if (doppelt) {
        taktFeldSetzen(a);
        abTaktSpielen(a, tippOrt && noteAmOrt(a, ...tippOrt));
    } else {
        taktWaehlen(a, tippOrt && noteAmOrt(a, ...tippOrt));
    }
});

/* Notenkopf am Tipp-Ort, in allen Stimmen des Takts. alphaTabs eigene Suche
   (noteMouseDown) kennt nur die oberste Notenzeile. Trefferfläche großzügig:
   der nächste Kopf im Umkreis von 14 px (bei 100 % Notengröße) zählt. */
function noteAmOrt(idx, x, y) {
    const lookup = api.renderer && api.renderer.boundsLookup;
    if (!lookup) return null;
    const radius = 14 * currentScale / 0.8;
    let beste = null, abstand = radius;
    for (const sys of lookup.staffSystems) for (const mb of sys.bars) {
        if (mb.index !== idx) continue;
        for (const bb of mb.bars) for (const b of bb.beats) for (const nb of (b.notes || [])) {
            const r = nb.noteHeadBounds;
            const dx = Math.max(r.x - x, 0, x - (r.x + r.w)), dy = Math.max(r.y - y, 0, y - (r.y + r.h));
            const d = Math.hypot(dx, dy);
            if (d <= abstand) { abstand = d; beste = nb.note; }
        }
    }
    return beste;
}

// Anfang eines Takts in Ticks (beim ersten Durchlauf, Wiederholungen eingerechnet)
function taktStart(idx) {
    return api.tickCache.getMasterBarStart(api.score.masterBars[idx]);
}

function taktFeldSetzen(idx) {
    const feld = document.getElementById('taktNummer');
    feld.value = idx + 1 + taktOffset;
    feld.classList.remove('flash');
    void feld.offsetWidth;          // Animation neu starten
    feld.classList.add('flash');
}

function taktWaehlen(idx, note) {
    // Steht das Lied, erklingt eine angetippte Note nur; Takt und Strich bleiben
    if (note && api.playerState !== 1) { noteSpielen(note); return; }
    const ziel = taktStart(idx);
    taktWahl = idx;
    taktWahlZeigen();
    if (api.playerState === 1) {
        // Während des Einzählens gibt es noch keinen Takt, in dem man bleiben könnte
        if (einzaehlPhase) { sprungAbbrechen(); neuStarten(ziel); }
        else sprungPlanen(ziel);
        return;
    }
    sprungAbbrechen();
    api.tickPosition = ziel;
}

// Doppeltipp: ab Taktanfang spielen, auf eine Note ab dieser Note; Einzählen nach Einstellung
function abTaktSpielen(idx, note = null) {
    const ziel = taktStart(idx) + (note ? note.beat.playbackStart : 0);
    sprungAbbrechen();
    taktWahl = null;
    taktWahlZeigen();
    if (api.playerState !== 1) {
        api.tickPosition = ziel;
        handlePlayClick(!!note);
    } else if (isCountIn) {
        neuStarten(ziel);
    } else {
        api.tickPosition = ziel;
    }
}

// Läuft das Lied: anhalten, setzen, mit Einzählen neu starten
function neuStarten(ziel) {
    if (neustartLaeuft) return;
    neustartLaeuft = true;
    const weiter = args => {
        if (args.state !== 0) return;
        api.playerStateChanged.off(weiter);
        api.tickPosition = ziel;
        einzaehlVorbereiten();
        api.play();
        neustartLaeuft = false;
    };
    api.playerStateChanged.on(weiter);
    api.pause();
}

/* Sprung am nächsten Taktstrich macht der Audio-Worker auf das Sample genau
   (alphaTab-Anpassung tvSprung): ab dem Tipp keine neuen Töne, das Metronom tickt im
   Takt weiter, am Taktstrich geht es im Zieltakt weiter. Kommt der Tipp für diesen
   Taktstrich zu spät (der Worker rechnet dem Gehörten voraus), nimmt er den nächsten:
   ein Takt Metronom wie Einzählen. Ist der gewählte Takt ohnehin der nächste, läuft
   alles normal weiter. */
function sprungPlanen(ziel) {
    const tick = api.tickPosition;
    const takte = api.tickCache.masterBars;
    const i = takte.findIndex(m => m.start <= tick && tick < m.end);
    if (i < 0) { sprungAbbrechen(); api.tickPosition = ziel; return; }
    if (ziel === takte[i].end) { sprungAbbrechen(); return; }
    const worker = api.player && api.player.instance;
    if (!worker || !worker.tvSprung) { sprungAbbrechen(); api.tickPosition = ziel; return; }
    if (sprung) clearTimeout(sprung.zeit);
    sprung = { ziel, vonLk: takte[i], tick };
    worker.tvSprung({ abTicks: takte.slice(i, i + 3).map(m => m.end), zuTick: ziel, klick: metronomLaut });
    // Falls der Sprung ausbleibt (z.B. Liedende davor): Merker nach drei Takten freigeben
    const ms = (takte[Math.min(i + 2, takte.length - 1)].end - tick) / 960 * viertelMs();
    sprung.zeit = setTimeout(() => { sprung = null; }, ms + 1000);
}

// Anstehenden Sprung verwerfen; bei angehaltenem Lied trotzdem auf den Zieltakt
function sprungAbbrechen(anZiel = false) {
    const s = sprung;
    if (!s) return;
    sprung = null;
    clearTimeout(s.zeit);
    const worker = api.player && api.player.instance;
    if (worker && worker.tvSprung) worker.tvSprung(null);
    if (anZiel) api.tickPosition = s.ziel;
}

// Note anspielen; ihre Stimme dafür kurz auf volle Lautstärke (auch wenn sie stumm ist)
function noteSpielen(note) {
    audioBereit();
    document.getElementById('hpAudio').pause();
    api.changeTrackVolume([note.beat.voice.bar.staff.track], 1);
    api.playNote(note);
    clearTimeout(noteZeit);
    noteZeit = setTimeout(() => { if (api.playerState !== 1) updateTrackVolumes(); }, 4000);
}

/* Handy/Tablet: Bereich aufziehen. Lange (0,45 s) auf einen Takt drücken, bis der
   Rahmen erscheint, dann mit dem Finger zum letzten Takt ziehen und loslassen. Nur
   lange drücken und loslassen ergibt einen Ein-Takt-Bereich. Bewegt sich der Finger
   vorher, scrollt die Seite wie gewohnt. */
(() => {
    let lp = null;
    const taktAm = (cx, cy) => {
        const f = el.querySelector('.at-surface');
        const lookup = api.renderer && api.renderer.boundsLookup;
        if (!f || !lookup) return null;
        const r = f.getBoundingClientRect();
        const beat = lookup.getBeatAtPos(cx - r.left, cy - r.top);
        return beat ? beat.voice.bar.index : null;
    };
    el.addEventListener('touchstart', e => {
        if (lp) clearTimeout(lp.zeit);
        lp = null;
        if (e.touches.length !== 1 || !api.score || !api.tickCache) return;
        const t = e.touches[0];
        lp = { x: t.clientX, y: t.clientY, aktiv: false };
        lp.zeit = setTimeout(() => {
            const idx = taktAm(lp.x, lp.y);
            if (idx === null) { lp = null; return; }
            lp.aktiv = true;
            lp.von = idx;
            bereichVorschau = { von: idx, bis: idx };
            taktWahlZeigen();
            try { navigator.vibrate && navigator.vibrate(15); } catch (err) { }
        }, 450);
    }, { passive: true });
    el.addEventListener('touchmove', e => {
        if (!lp) return;
        const t = e.touches[0];
        if (!lp.aktiv) {
            if (Math.hypot(t.clientX - lp.x, t.clientY - lp.y) > 10) { clearTimeout(lp.zeit); lp = null; }
            return;
        }
        e.preventDefault();   // Finger zieht den Bereich, die Seite bleibt stehen
        const idx = taktAm(t.clientX, t.clientY);
        if (idx === null) return;
        bereichVorschau = { von: Math.min(lp.von, idx), bis: Math.max(lp.von, idx) };
        taktWahlZeigen();
    }, { passive: false });
    const ende = e => {
        if (!lp) return;
        clearTimeout(lp.zeit);
        const war = lp.aktiv && bereichVorschau;
        const b = bereichVorschau;
        lp = null;
        if (!war) return;
        // Kein Tipp hinterher: sonst hebt alphaTabs Klick den Bereich gleich wieder auf
        if (e.cancelable) e.preventDefault();
        bereichVorschau = null;
        anker = b.von;
        bereichSetzen(b.von, b.bis);
    };
    el.addEventListener('touchend', ende, { passive: false });
    el.addEventListener('touchcancel', () => {
        if (lp) clearTimeout(lp.zeit);
        lp = null;
        if (bereichVorschau) { bereichVorschau = null; taktWahlZeigen(); }
    });
})();

// Takt an der Spielposition (Index), 0 wenn unbekannt
function aktuellerTakt() {
    const t = api.tickPosition;
    const lk = api.tickCache && api.tickCache.masterBars.find(m => m.start <= t && t < m.end);
    return lk ? lk.masterBar.index : 0;
}

/* Abspielbereich von Anfang bis Ende der Takte von..bis. Steht das Lied, steht der
   Strich danach am Bereichsanfang. Läuft es außerhalb, geht es am nächsten Taktstrich
   mit dem Bereichsanfang weiter (wie beim Tipp auf einen Takt). */
function bereichSetzen(von, bis) {
    sprungAbbrechen();
    taktWahl = null;
    const neu = !bereich;
    bereich = { start: taktStart(von), ende: taktStart(bis) + api.score.masterBars[bis].calculateDuration() };
    bereichAnwenden();
    if (neu) bereichLoop = BEREICH_LOOP_START;
    loopAnwenden();
    const takt = aktuellerTakt();
    if (api.playerState !== 1) api.tickPosition = bereich.start;
    else if (takt < bereich.von || takt > bereich.bis) sprungPlanen(bereich.start);
}

/* Bereich { start, ende } in Ticks an alphaTab geben und daraus ableiten, was das
   Zeichnen braucht: erster und letzter Takt (von, bis) und die Stellen darin
   (vonAb, bisBis in Ticks ab Taktanfang). Nach dem Verschieben liegen Anfang und Ende
   auch mitten im Takt. */
function bereichAnwenden() {
    const lkBei = t => api.tickCache.masterBars.find(m => m.start <= t && t < m.end);
    const a = lkBei(bereich.start), e = lkBei(bereich.ende - 1);
    bereich.von = a.masterBar.index;
    bereich.vonAb = bereich.start - a.start;
    bereich.bis = e.masterBar.index;
    bereich.bisBis = bereich.ende - e.start;
    const range = new alphaTab.synth.PlaybackRange();
    range.startTick = bereich.start;
    range.endTick = bereich.ende - 50;
    api.playbackRange = range;
    el.classList.add('mit-bereich');
    taktWahlZeigen();
}

/* Bereich verschieben, die Länge bleibt: in Vierteln (Ziehen im Rahmen, Pfeiltasten
   ← →). So rückt z.B. ein Auftakt mit hinein. Steht das Lied, steht der Strich danach
   am neuen Anfang; läuft es, gilt der neue Bereich ab dem nächsten Durchgang (oder
   sofort, wenn das Ende schon vorbei ist). */
const BEREICH_SCHRITT = 960;   // Ticks: ein Viertel
function bereichVerschieben(schritte) {
    if (bereich && api.tickCache) bereichAuf(bereich.start + schritte * BEREICH_SCHRITT);
}

// Bereich mit gleicher Länge auf diesen Anfang (Ticks) legen, innerhalb des Lieds
function bereichAuf(start) {
    const takte = api.tickCache.masterBars;
    const laenge = bereich.ende - bereich.start;
    start = Math.max(0, Math.min(takte[takte.length - 1].end - laenge, start));
    if (start === bereich.start) return;
    bereich.start = start;
    bereich.ende = start + laenge;
    bereichAnwenden();
    if (api.playerState !== 1) api.tickPosition = bereich.start;
}

function bereichAufheben() {
    bereich = null;
    el.classList.remove('mit-bereich', 'bereich-greifbar');
    api.playbackRange = null;
    loopAnwenden();
    taktWahlZeigen();
}

// Loop: mit Bereich gilt der Knopf neben Play, sonst der Schalter in den Einstellungen
// Der Knopf neben Play bleibt immer da: ohne Bereich blass und ohne Wirkung, mit
// Bereich deutlich (aus: hell, an: rot). Die Wiederholungszeichen folgen dem Zustand.
function loopAnwenden() {
    api.isLooping = bereich ? bereichLoop : isLooping;
    const knopf = document.getElementById('bereichLoopBtn');
    if (knopf) {
        knopf.classList.toggle('blass', !bereich);
        knopf.setAttribute('aria-disabled', !bereich);
        knopf.classList.toggle('active', !!bereich && bereichLoop);
        knopf.setAttribute('aria-pressed', !!bereich && bereichLoop);
    }
    document.querySelectorAll('.wdh-zeichen').forEach(e => e.classList.toggle('an', bereichLoop));
}

function toggleBereichLoop() {
    if (!bereich) {
        // Handy: der blasse Knopf liegt halb auf Play, dort zählt er als Play
        const knopf = document.getElementById('bereichLoopBtn');
        if (knopf && getComputedStyle(knopf).position === 'absolute') handlePlayClick();
        return;
    }
    bereichLoop = !bereichLoop;
    loopAnwenden();
}

/* Rotes Wiederholungszeichen im Notenstil als Overlay: Anfang ‖: am Bereichsanfang,
   Ende :‖ am Bereichsende. Dicker und dünner Strich über alle Notenzeilen, je Notenzeile
   zwei Punkte in den mittleren Zwischenräumen. Antippen schaltet den Loop um. */
// Breite des Zeichens bei Linienabstand sp (Maße wie in wdhZeichen)
function wdhBreite(sp) {
    return sp * 0.55 + sp * 0.35 + Math.max(1.2, sp * 0.16) + sp * 0.35 + 2 * sp * 0.27 + 2;
}

function wdhZeichen(box, dx, dy, sys, x, ende) {
    const zeilen = sys.bars[0].bars.map(bb => bb.realBounds);   // Notenzeilen (5 Linien)
    if (!zeilen.length) return;
    const sp = zeilen[0].h / 4;                                  // Linienabstand
    const oben = zeilen[0].y, unten = zeilen[zeilen.length - 1].y + zeilen[zeilen.length - 1].h;
    const dick = sp * 0.55, luft = sp * 0.35, duenn = Math.max(1.2, sp * 0.16), r = sp * 0.27;
    const breite = wdhBreite(sp);
    // Ende: Zeichen endet am Taktstrich; Anfang: beginnt dort
    const links = ende ? x - breite : x;
    const teile = [];
    const xs = ende ? [breite - dick, breite - dick - luft - duenn, 1 + r] : [0, dick + luft, dick + luft + duenn + luft + r];
    teile.push(`<rect x="${xs[0]}" y="0" width="${dick}" height="${unten - oben}"/>`);
    teile.push(`<rect x="${xs[1]}" y="0" width="${duenn}" height="${unten - oben}"/>`);
    for (const z of zeilen) for (const k of [1.5, 2.5])
        teile.push(`<circle cx="${xs[2]}" cy="${z.y - oben + k * sp}" r="${r}"/>`);
    const d = document.createElement('div');
    d.className = 'wdh-zeichen' + (bereichLoop ? ' an' : '');
    d.setAttribute('role', 'button');
    d.title = 'Bereich wiederholen an/aus';
    d.style.cssText = `left:${dx + links}px;top:${dy + oben}px;width:${breite}px;height:${unten - oben}px`;
    d.innerHTML = `<svg width="${breite}" height="${unten - oben}" viewBox="0 0 ${breite} ${unten - oben}">${teile.join('')}</svg>`;
    // Antippen schaltet nur um: kein Takt-Tipp darunter
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend']
        .forEach(t => d.addEventListener(t, e => e.stopPropagation()));
    d.addEventListener('click', e => { e.stopPropagation(); toggleBereichLoop(); });
    box.appendChild(d);
}

// Rahmen um den gewählten Takt bzw. den Bereich (über alle Stimmen, je Notenzeile
// ein Rahmen); nach jedem Zeichnen neu setzen
function taktWahlZeigen() {
    const box = document.getElementById('alphaTab');
    box.querySelectorAll('.takt-wahl, .wdh-zeichen').forEach(e => e.remove());
    const lookup = api.renderer && api.renderer.boundsLookup;
    const flaeche = box.querySelector('.at-surface');
    const b = bereichVorschau || bereich || (taktWahl !== null ? { von: taktWahl, bis: taktWahl } : null);
    if (!b || !lookup || !flaeche) return;
    const ab = box.getBoundingClientRect(), fb = flaeche.getBoundingClientRect();
    const dx = fb.left - ab.left, dy = fb.top - ab.top;
    for (const sys of lookup.staffSystems) {
        const takte = sys.bars.filter(mb => mb.index >= b.von && mb.index <= b.bis);
        if (!takte.length) continue;
        const erst = takte[0], letzt = takte[takte.length - 1];
        const r0 = erst.realBounds, r1 = letzt.realBounds;
        const sp = erst.bars[0].realBounds.h / 4;
        // Verschobener Bereich: Anfang und Ende mitten im Takt, vor der jeweiligen Note,
        // am Anfang mit Platz für das Wiederholungszeichen
        let x0 = r0.x, x1 = r1.x + r1.w;
        if (b === bereich && erst.index === b.von && b.vonAb > 0)
            x0 = xImTakt(erst, b.vonAb) - wdhBreite(sp) - 3;
        if (b === bereich && letzt.index === b.bis && b.bisBis < api.score.masterBars[b.bis].calculateDuration())
            x1 = xImTakt(letzt, b.bisBis) - 3;
        const d = document.createElement('div');
        d.className = 'takt-wahl' + (b === bereich || b === bereichVorschau ? ' bereich' : '');
        d.style.cssText = `left:${dx + x0}px;top:${dy + r0.y}px;width:${x1 - x0}px;height:${r0.h}px`;
        box.appendChild(d);
        // Wiederholungszeichen am gesetzten Bereich (nicht beim Ziehen)
        if (b !== bereich) continue;
        if (erst.index === b.von) {
            // Am Zeilenanfang hinter Schlüssel und Vorzeichen, sonst am Taktstrich
            const erster = !b.vonAb && erst === sys.bars[0] && erst.bars[0].beats[0];
            const x = erster ? Math.max(r0.x, erster.realBounds.x - sp * 3) : x0;
            wdhZeichen(box, dx, dy, sys, x, false);
        }
        if (letzt.index === b.bis)
            wdhZeichen(box, dx, dy, sys, x1, true);
    }
}

/* Stützpunkte eines Takts auf der Notenfläche: [Ticks ab Taktanfang, x], je Schlag der
   linke Rand (über alle Stimmen der früheste), dazu Taktanfang und Taktende */
function taktPunkte(mb) {
    const pkt = [];
    for (const bb of mb.bars) for (const be of bb.beats) pkt.push([be.beat.playbackStart, be.realBounds.x]);
    pkt.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    pkt.unshift([0, mb.realBounds.x]);
    pkt.push([api.score.masterBars[mb.index].calculateDuration(), mb.realBounds.x + mb.realBounds.w]);
    return pkt;
}

// x einer Stelle im Takt (Ticks ab Taktanfang); zwischen zwei Schlägen anteilig
function xImTakt(mb, ab) {
    const pkt = taktPunkte(mb);
    for (let i = 1; i < pkt.length; i++) {
        const [t0, x0] = pkt[i - 1], [t1, x1] = pkt[i];
        if (t1 < ab) continue;
        if (t1 === ab || t1 === t0) return x1;
        return x0 + (x1 - x0) * (ab - t0) / (t1 - t0);
    }
    return mb.realBounds.x + mb.realBounds.w;
}

// umgekehrt: Ticks ab Taktanfang an der Stelle x
function tickImTakt(mb, x) {
    const pkt = taktPunkte(mb);
    for (let i = 1; i < pkt.length; i++) {
        const [t0, x0] = pkt[i - 1], [t1, x1] = pkt[i];
        if (x > x1) continue;
        if (x1 <= x0 || t1 === t0) return t1;
        return t0 + (t1 - t0) * Math.max(0, x - x0) / (x1 - x0);
    }
    return pkt[pkt.length - 1][0];
}

/* Stelle im Lied (Ticks, erster Durchgang) am Ort x, y der Notenfläche. y wählt die
   Notenzeile; links oder rechts außerhalb geht es im Maß des Randtakts weiter, damit
   man über das Zeilenende hinaus ziehen kann. */
function tickAmOrt(x, y) {
    const lookup = api.renderer && api.renderer.boundsLookup;
    if (!lookup || !api.tickCache) return null;
    const sys = lookup.staffSystems.find(s => y >= s.realBounds.y && y < s.realBounds.y + s.realBounds.h);
    if (!sys || !sys.bars.length) return null;
    const erst = sys.bars[0], letzt = sys.bars[sys.bars.length - 1];
    const proPx = mb => api.score.masterBars[mb.index].calculateDuration() / mb.realBounds.w;
    if (x < erst.realBounds.x)
        return { idx: erst.index, tick: taktStart(erst.index) - (erst.realBounds.x - x) * proPx(erst) };
    const rechts = letzt.realBounds.x + letzt.realBounds.w;
    if (x >= rechts)
        return { idx: letzt.index, tick: taktStart(letzt.index) + api.score.masterBars[letzt.index].calculateDuration() + (x - rechts) * proPx(letzt) };
    const mb = sys.bars.find(b => x < b.realBounds.x + b.realBounds.w);
    return { idx: mb.index, tick: taktStart(mb.index) + tickImTakt(mb, x) };
}

/* --- Bereich ziehen ---
   Im Rahmen auf freier Fläche (nicht auf einer Note) oder an seinen Rändern waagrecht
   ziehen verschiebt den Bereich; er rastet pro Viertel ein, die Länge bleibt. Nur die
   waagrechte Bewegung zählt. Erst ab 6 px wird gezogen, vorher bleibt es ein normaler
   Tipp (Takt wählen, Doppeltipp). Auf dem Handy scrollt senkrechtes Wischen weiter die
   Seite (touch-action pan-y, solange ein Bereich besteht). */
let zug = null;        // { x0, y, tick0, start0, aktiv, id }
let zugEndeZeit = 0;   // Ende des letzten Ziehens: der Klick danach zählt nicht

// Liegt der Punkt (Bildschirm) im Bereichsrahmen oder dicht an seinen Rändern?
function imBereichRahmen(cx, cy) {
    for (const r of document.querySelectorAll('.takt-wahl.bereich')) {
        const b = r.getBoundingClientRect();
        if (cx >= b.left - 14 && cx <= b.right + 14 && cy >= b.top && cy <= b.bottom) return true;
    }
    return false;
}

el.addEventListener('pointerdown', e => {
    zug = null;
    if (!bereich || e.button > 0 || !e.isPrimary || !imBereichRahmen(e.clientX, e.clientY)) return;
    const f = el.querySelector('.at-surface');
    if (!f) return;
    const r = f.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const ort = tickAmOrt(x, y);
    if (!ort) return;
    // Auf einer Note bleibt es beim Anspielen
    if (!e.target.closest('.wdh-zeichen') && noteAmOrt(ort.idx, x, y)) return;
    zug = { x0: e.clientX, y, tick0: ort.tick, start0: bereich.start, aktiv: false, id: e.pointerId };
}, true);

window.addEventListener('pointermove', e => {
    if (!zug || e.pointerId !== zug.id) return;
    if (!zug.aktiv) {
        if (Math.abs(e.clientX - zug.x0) < 6) return;
        zug.aktiv = true;
        // kein Takt-Tipp und keine Bereichsauswahl aus dieser Bewegung
        tippBeat = null;
        bereichVorschau = null;
        document.body.classList.add('bereich-zieht');
    }
    const f = el.querySelector('.at-surface');
    if (!f) return;
    const ort = tickAmOrt(e.clientX - f.getBoundingClientRect().left, zug.y);
    if (!ort) return;
    bereichAuf(zug.start0 + Math.round((ort.tick - zug.tick0) / BEREICH_SCHRITT) * BEREICH_SCHRITT);
}, true);

function zugEnde() {
    if (zug && zug.aktiv) {
        zugEndeZeit = Date.now();
        document.body.classList.remove('bereich-zieht');
    }
    zug = null;
}
window.addEventListener('pointerup', zugEnde, true);
window.addEventListener('pointercancel', zugEnde, true);
// Nach dem Ziehen kein Klick (das Wiederholungszeichen schaltete sonst den Loop um)
el.addEventListener('click', e => {
    if (Date.now() - zugEndeZeit < 300) { e.stopPropagation(); e.preventDefault(); }
}, true);
// Maus über dem Bereich: Hand zeigt, dass man ihn ziehen kann
el.addEventListener('mousemove', e => {
    if (zug) return;
    el.classList.toggle('bereich-greifbar', !!bereich && imBereichRahmen(e.clientX, e.clientY));
});

// Sprung erledigt und Rahmen weg, sobald die Wiedergabe im gewählten Takt angekommen ist
api.playerPositionChanged.on(e => {
    if (api.playerState !== 1 || einzaehlPhase || !api.tickCache) return;
    const lk = api.tickCache.masterBars.find(m => m.start <= e.currentTick && e.currentTick < m.end);
    if (!lk) return;
    if (sprung) {
        // angekommen: im Zieltakt, und nicht bloß noch im Takt des Tipps (gleicher Takt
        // als Ziel zählt erst, wenn die Position zurückgesprungen ist)
        if (lk.start !== sprung.ziel || (lk === sprung.vonLk && e.currentTick >= sprung.tick)) return;
        clearTimeout(sprung.zeit);
        sprung = null;
    }
    if (taktWahl !== null && lk.masterBar.index === taktWahl) { taktWahl = null; taktWahlZeigen(); }
});

// Angehalten oder zu Ende, während ein Sprung ansteht: gleich auf den Zieltakt
api.playerStateChanged.on(args => {
    if (args.state !== 1) sprungAbbrechen(true);
});

/* --- Tipp in die Noten schließt die Einstellungen ---
   Nur ein echter Tipp (kaum bewegt, kurz). Wischen und Scrollen lassen das Blatt offen,
   damit man beim Verstellen von Noten- und Textgröße weiter zusehen kann. Beim Scrollen
   per Finger übernimmt der Browser und meldet pointercancel, das zählt nicht als Tipp. */
(() => {
    const noten = document.getElementById('alphaTab');
    let start = null;
    noten.addEventListener('pointerdown', e => { start = { x: e.clientX, y: e.clientY, t: Date.now() }; });
    noten.addEventListener('pointerup', e => {
        if (!start) return;
        const tipp = Math.hypot(e.clientX - start.x, e.clientY - start.y) < 10 && Date.now() - start.t < 500;
        start = null;
        if (tipp && document.body.classList.contains('sheet-open')) toggleSheet(false);
    });
    noten.addEventListener('pointercancel', () => { start = null; });
})();

/* --- Nach dem Laden eines Songs oben beginnen (Titel sichtbar) --- */
api.renderFinished.on(() => {
    neuTakteMarkieren();
    if (!scrollTopAfterRender) return;
    scrollTopAfterRender = false;
    window.scrollTo(0, 0);
});


/* ==============================
   6. EVENT-LISTENER & STARTUP
   ============================== */

// Leertaste → Play/Pause (außer in Textfeldern)
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        const activeEl = document.activeElement;
        if (activeEl && ['INPUT', 'TEXTAREA'].includes(activeEl.tagName)) return;
        e.preventDefault();
        handlePlayClick();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && bereich && !e.defaultPrevented) {
        // Pfeiltasten verschieben den Bereich um ein Viertel (außer in Feldern und Reglern)
        const activeEl = document.activeElement;
        if (activeEl && (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName) || activeEl.getAttribute('role') === 'slider')) return;
        e.preventDefault();
        bereichVerschieben(e.key === 'ArrowLeft' ? -1 : 1);
    } else if (e.key === 'Escape') {
        toggleSheet(false);
        if (document.body.classList.contains('vollbild')) toggleVollbild(false);
    }
});

// Fenstergrößen-Änderung → Padding anpassen
window.addEventListener('resize', adjustContentPadding);

/**
 * Song aus der Adresse uebernehmen, z.B. /trainer/?song=Ruhe (QR-Code, geteilter Link).
 * Passt auf Dateinamen ohne .musicxml oder auf den angezeigten Namen, ohne Gross/Klein.
 * Der Parameter wird danach aus der Adresse entfernt, damit ein Lesezeichen
 * nicht dauerhaft auf diesen Song festgelegt ist.
 */
function applySongFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const wanted = (params.get('song') || '').trim().toLowerCase();
    if (!wanted) return;
    const select = document.getElementById('songSelect');
    const match = Array.from(select.options).find(o =>
        o.value.replace(/\.musicxml$/i, '').toLowerCase() === wanted ||
        o.text.trim().toLowerCase() === wanted);
    if (match) select.value = match.value;
    params.delete('song');
    const rest = params.toString();
    history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash);
}

/* --- Zugang: freie Lieder (data-frei) für alle, die übrigen nach Chor-Login ---
   status.php sagt, ob das Cookie vom QR-Code bzw. von login.php gilt. Ohne Zugang
   bleiben die übrigen Titel ausgegraut mit Schloss sichtbar, darunter der Login-Eintrag.
   MIT_LOGIN: nur wenn index.html gesperrte Lieder (ohne data-frei) listet, gibt es
   einen Chor-Login. Sind alle frei (öffentliche Fassung, z.B. pankd.de/noten/), entfallen
   Login-Eintrag, Schlösser, Rückmeldung und die Begrüßung. */
const LOGIN_WERT = '__login';
const MIT_LOGIN = !!document.querySelector('#songSelect option:not([data-frei])');
let hatZugang = false;

async function zugangPruefen() {
    if (!MIT_LOGIN) { hatZugang = false; return; }
    try {
        const res = await fetch('status.php', { cache: 'no-store' });
        hatZugang = !!(await res.json()).zugang;
    } catch (e) {
        hatZugang = false;
    }
}

function zugangAnwenden() {
    document.body.classList.toggle('zugang', hatZugang);
    if (hatZugang || !MIT_LOGIN) return;
    const select = document.getElementById('songSelect');
    // Freie Lieder nach oben, darunter die gesperrten
    Array.from(select.querySelectorAll('option[data-frei]')).reverse().forEach(o => select.prepend(o));
    Array.from(select.options).forEach(o => {
        if (o.dataset.frei === undefined) {
            o.disabled = true;
            o.text = '🔒 ' + o.text;
        }
    });
    select.add(new Option('🔑 Alle Lieder: Chor-Login', LOGIN_WERT));
    // Gespeicherter oder per Link gewählter Song gesperrt: ersten freien nehmen
    if (!select.selectedOptions[0] || select.selectedOptions[0].disabled) {
        select.value = select.querySelector('option[data-frei]').value;
    }
    // Statt "alte Ansicht" (gesperrt) unten den Login anbieten
    const fuss = document.querySelector('#pageFoot a');
    fuss.href = 'login.php';
    fuss.textContent = 'Chor-Login: alle Lieder freischalten';
}

/* --- Offline: Service Worker (sw.js) fragt zuerst das Netz, ohne Netz den Speicher ---
   Einmal am Tag und immer, wenn etwas fehlt, alle freigegebenen Lieder abrufen, damit
   sie offline bereitliegen. Die Zeile "Offline" in den Einstellungen zeigt den Stand
   ("5 von 6 Liedern gespeichert") und speichert auf Knopfdruck sofort. */
let offlineLaeuft = false;

function offlineMoeglich() {
    return 'serviceWorker' in navigator && 'caches' in window;
}

// Was der Trainer selbst braucht (wie GRUNDAUSSTATTUNG in sw.js), Adressen wie im Dokument
function offlineProgrammDateien() {
    return ['./', document.querySelector('link[rel=stylesheet]').getAttribute('href'),
        ...Array.from(document.scripts, s => s.getAttribute('src')).filter(Boolean),
        'sonivox.sf2', 'font/Bravura.woff2', 'font/Bravura.woff'];
}

// Freigegebene Lieder mit ihren Dateien (gesperrte zählen ohne Login nicht mit)
function offlineLieder() {
    return Array.from(document.getElementById('songSelect').options)
        .filter(o => o.value.endsWith('.musicxml') && !o.disabled)
        .map(o => [o.value, o.dataset.mp3, hatZugang && o.dataset.neu].filter(Boolean));
}

// Erst exakt, dann ohne ?v=… (der Service Worker behält nur eine Fassung je Datei)
async function istGespeichert(f) {
    const url = new URL(f, location.href).href;
    return !!((await caches.match(url)) || (await caches.match(url, { ignoreSearch: true })));
}

async function offlineStatus() {
    const programm = (await Promise.all(offlineProgrammDateien().map(istGespeichert))).every(Boolean);
    const lieder = offlineLieder();
    let da = 0;
    for (const dateien of lieder) {
        if ((await Promise.all(dateien.map(istGespeichert))).every(Boolean)) da++;
    }
    return { programm, da, gesamt: lieder.length, fertig: programm && da === lieder.length };
}

// Zeile in den Einstellungen füllen. fortschritt: Text während des Speicherns;
// hinweis: steht einmal vor dem Stand (z.B. wenn das Speichern abbrach)
async function offlineStatusZeigen(fortschritt, hinweis = '') {
    const zeile = document.getElementById('offlineRow');
    const info = document.getElementById('offlineInfo');
    const knopf = document.getElementById('offlineBtn');
    if (!offlineMoeglich()) {
        info.textContent = 'Dieser Browser kann den Trainer nicht offline speichern.';
        knopf.hidden = true;
        return null;
    }
    zeile.classList.toggle('laeuft', offlineLaeuft);
    if (fortschritt) {
        zeile.classList.remove('fertig');
        info.textContent = fortschritt;
        return null;
    }
    const s = await offlineStatus();
    zeile.classList.toggle('fertig', s.fertig);
    const lieder = s.gesamt === 1 ? '1 Lied' : `alle ${s.gesamt} Lieder`;
    const text = s.fertig
        ? `${lieder[0].toUpperCase() + lieder.slice(1)} gespeichert, Netz kann aus.`
        : `${s.da} von ${s.gesamt} Liedern gespeichert${s.programm ? '' : ', Programm fehlt noch'}.`;
    info.textContent = hinweis + text;
    if (!hatZugang && MIT_LOGIN) {
        const mehr = document.createElement('span');
        mehr.className = 'offline-mehr';
        mehr.textContent = 'Weitere Lieder nach dem Chor-Login.';
        info.append(mehr);
    }
    knopf.textContent = s.fertig ? 'Auffrischen' : 'Jetzt speichern';
    return s;
}

// Alle Dateien einmal abrufen; der Service Worker legt jede Antwort in seinen Speicher
async function offlineSpeichern() {
    if (offlineLaeuft) return;
    offlineLaeuft = true;
    try {
        const sw = navigator.serviceWorker;
        await sw.ready;
        // Erst wenn der Service Worker die Seite steuert, landen die Abrufe in seinem Speicher
        if (!sw.controller) {
            await Promise.race([
                new Promise(r => sw.addEventListener('controllerchange', r, { once: true })),
                new Promise(r => setTimeout(r, 5000))
            ]);
        }
        const dateien = [...offlineProgrammDateien(), ...offlineLieder().flat()];
        for (let i = 0; i < dateien.length; i++) {
            offlineStatusZeigen(`Speichere ${i + 1} von ${dateien.length} …`);
            const res = await fetch(dateien[i], { cache: 'no-cache' });
            if (!res.ok) throw new Error(dateien[i] + ': ' + res.status);
            await res.arrayBuffer();   // ganz laden, sonst ist die Antwort noch nicht gespeichert
        }
        try { localStorage.setItem('trainerVorgeladen', new Date().toISOString().slice(0, 10)); } catch (e) { }
    } finally {
        offlineLaeuft = false;
    }
    // Der Service Worker schreibt kurz nach der Antwort in den Speicher: kurz auf ihn warten
    for (let i = 0; i < 8 && !(await offlineStatus()).fertig; i++) {
        await new Promise(r => setTimeout(r, 400));
    }
}

// Knopf "Jetzt speichern" / "Auffrischen" (die ganze Zeile)
async function offlineJetztSpeichern() {
    if (offlineLaeuft || !offlineMoeglich()) return;
    let hinweis = '';
    try { await offlineSpeichern(); }
    catch (e) { console.warn('Offline speichern:', e); hinweis = 'Abgebrochen, kein Netz? '; }
    offlineStatusZeigen(null, hinweis);
}

async function offlineEinrichten() {
    if (!offlineMoeglich()) { offlineStatusZeigen(); return; }
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service Worker:', e));
    const s = await offlineStatusZeigen();
    // Selbst vorladen: wenn etwas fehlt oder heute noch nicht aufgefrischt wurde
    let heute = false;
    try { heute = localStorage.getItem('trainerVorgeladen') === new Date().toISOString().slice(0, 10); } catch (e) { }
    if (!navigator.onLine || (s.fertig && heute)) return;
    try { await offlineSpeichern(); } catch (e) { console.warn('Offline vorladen:', e); }
    offlineStatusZeigen();
}

/* --- Hilfe (?) in einfachem Deutsch ---
   Tipp-Modus: "?" schaltet ihn ein. Alle erklärten Knöpfe bekommen einen gestrichelten
   Rahmen, eine Karte in der größten freien Lücke sagt "auf einen Knopf tippen". Ein Tipp
   löst den Knopf nicht aus, sondern zeigt in der Karte, was er macht. Eine durchsichtige
   Fangfläche über allem nimmt die Tipps an, so reagiert kein Knopf, kein Regler und
   kein Auswahlfeld. "Alles auf einen Blick" öffnet die So-geht's-Seite (alle Knöpfe
   mit Bild, nach Gruppen). "Fertig" oder Esc beendet die Hilfe.
   HILFE: [Gruppe auf der Seite ('' = nur im Tipp-Modus), Wahl (CSS), Knopfbild, Text].
   Im Knopfbild steht {svg:Wahl} für das echte Symbol aus dem Knopf. */
const HILFE = [
    ['Lied hören', '.songwrap', '<span class="k">Lied ⌄</span>',
        'Lied auswählen: antippen und das Lied aus der Liste wählen.' + (MIT_LOGIN ? ' Lieder mit Schloss gibt es nach dem Chor-Login.' : '')],
    ['Lied hören', '#playBtn, #sheetPlay, .fs-float .play', '<span class="k rund hell">{svg:#playBtn .i-play}</span>',
        'Abspielen und Anhalten. Am Rechner geht das auch mit der Leertaste.'],
    ['Lied hören', '.neu-marke', '<span class="k"><span class="neu-marke-bild">neu</span></span>',
        'Neue Fassung: An dieser Stelle gibt es geänderte Töne. „neu“ antippen schaltet zwischen alter und neuer Fassung um, in den Noten und beim Abspielen. Bei der neuen Fassung ist „neu“ gelb und die geänderten Takte sind gelb hinterlegt.'],
    ['Lied hören', '#voiceControls', '<span class="k rot">Alle</span><span class="k">S</span><span class="k">A</span><span class="k">T</span><span class="k">B</span>',
        'Stimmen: die eigene Stimme antippen (S = Sopran, A = Alt, T = Tenor, B = Bass). Sie klingt dann laut, die anderen leiser. „Alle“ spielt wieder alle gleich laut.'],
    ['Lied hören', '#hpBtn', '<span class="k">{svg:#hpBtn} Aufnahme</span>',
        'Aufnahme anhören: spielt eine echte Aufnahme des Liedes. Noch einmal tippen schließt sie. Gibt es nicht bei jedem Lied.'],
    ['Lied hören', '#hpDl', '<span class="k">{svg:#hpDl} MP3</span>',
        'MP3: speichert die Aufnahme auf dem Gerät, zum Anhören auch ohne Trainer.'],
    ['Üben', '.takt-box', '<span class="k hell">12</span><span class="k rot">Go</span>',
        'Takt: Nummer eintippen und „Go“ drücken, das wirkt wie ein Tipp auf diesen Takt in den Noten. Steht das Lied, geht es beim Abspielen dort los; läuft es, geht es am nächsten Taktstrich dort weiter. Zweimal schnell „Go“ spielt ab diesem Takt, mit Einzählen, wenn es eingestellt ist.'],
    ['Üben', '#tempoBox', '<span class="k">‹ 100 % ›</span>',
        'Tempo: ‹ macht langsamer, › schneller. 100 % ist das Originaltempo, darunter steht es in Schlägen pro Minute (BPM). Zweimal schnell auf die Zahl tippen: Tempo in BPM direkt eintippen.'],
    ['Üben', '#bereichLoopBtn', '<span class="k">{svg:#bereichLoopBtn}</span>',
        'Loop für den markierten Bereich: an (rot) springt es am Ende des Bereichs wieder an seinen Anfang, aus hört es dort auf. Die roten Wiederholungszeichen in den Noten schalten das ebenso. Ohne markierten Bereich ist der Knopf blass. Auf dem Handy: lange auf einen Takt drücken, bis der Rahmen erscheint, dann zum letzten Takt ziehen. Im Rahmen (nicht auf einer Note) oder an seinem Rand waagrecht ziehen verschiebt den Bereich, er rastet pro Viertel ein, die Länge bleibt. Ebenso die Pfeiltasten. So kommt z.B. ein Auftakt mit hinein.'],
    ['Lied hören', '#chorRegler', '<span class="k">{svg:#chorRegler}</span>',
        'Andere Stimmen: wie laut die übrigen Stimmen neben der eigenen (rot) klingen. Antippen schaltet sie stumm und wieder zurück. Nach rechts oder oben ziehen macht sie lauter, nach links oder unten leiser. Ganz klein (Punkte) sind sie stumm, gleich groß klingen alle gleich laut. Bei „Alle“ blass.'],
    ['Üben', '#metronomeBtn', '<span class="k">{svg:#metronomeBtn}</span>',
        'Metronom: tickt im Takt mit. Antippen schaltet es ein und aus. Gedrückt halten, bis die Zahl erscheint, dann hoch- oder runterziehen: lauter oder leiser. Dabei ist es zu hören, steht das Lied, klickt es zur Probe.'],
    ['Üben', '#alphaTab', '<span class="k hell">♩ ♪</span>',
        'In den Noten: auf einen Takt tippen wählt ihn (roter Rahmen). Mehrere Takte: ersten Takt antippen, dann mit Shift auf den letzten klicken, oder mit der Maus vom ersten zum letzten ziehen. Auf dem Handy lange auf den ersten Takt drücken, bis der Rahmen erscheint, dann mit dem Finger zum letzten ziehen. Dann spielt nur dieser Bereich, und neben Play erscheint ein Loop-Knopf. Ein einfacher Tipp hebt den Bereich auf. Steht das Lied, geht es dort beim Abspielen los. Eine angetippte Note erklingt nur, der Takt bleibt dabei, wie er ist. Läuft das Lied, wird es kurz still, und am nächsten Taktstrich geht es im selben Schlag mit dem gewählten Takt weiter. Zweimal schnell auf einen Takt tippen spielt ab seinem Anfang, zweimal auf eine Note ab dieser Note, mit Einzählen, wenn es eingestellt ist, und trägt die Taktnummer bei „Takt“ ein. Offene Einstellungen gehen dabei zu.'],
    ['Ansicht', '#fsBtn', '<span class="k hell">{svg:#fsBtn} Vollbild</span>',
        'Vollbild: nur noch die Noten, groß und ohne Knöpfe. Zurück geht es mit dem kleinen Knopf unten rechts.'],
    ['', '.fs-exit', '', 'Vollbild verlassen: die Knöpfe kommen wieder.'],
    ['Ansicht', '#setBtn', '<span class="k rund">{svg:#setBtn}</span>',
        'Einstellungen: Notengröße, Schriftgröße, Lautstärke der anderen Stimmen, Klang und Offline.'],
    ['', '#playerGrab', '', 'Griff: nach oben ziehen oder antippen öffnet die Einstellungen.'],
    ['Ansicht', '.hilfe-btn', '<span class="k rund">?</span>',
        'Hilfe: einmal tippen schaltet sie ein, dann auf einen Knopf tippen: es erscheint, was er macht. Noch einmal auf „?“ tippen schaltet sie wieder aus.'],
    ['', '#sheetClose', '', 'Schließt die Einstellungen. Nach unten ziehen geht auch.'],
    ['Einstellungen (Zahnrad)', '#zoomBox', '<span class="k hell">‹ 80% ›</span>',
        'Noten: macht die Noten größer oder kleiner. ‹ und › antippen oder darauf wischen.'],
    ['Einstellungen (Zahnrad)', '#textBox', '<span class="k hell">‹ 16 ›</span>',
        'Liedtext: macht den Text unter den Noten größer oder kleiner.'],
    ['Einstellungen (Zahnrad)', '#volBox', '<span class="k hell">‹ 10 % ›</span>',
        'Andere Stimmen: wie laut die übrigen Stimmen neben der eigenen klingen. Ganz links sind sie stumm. Wirkt, sobald eine Stimme gewählt ist.'],
    ['Lied hören', '#nurBtn', '<span class="k">{svg:#nurBtn}</span>',
        'Nur gewählte zeigen: blendet die Noten der anderen Stimmen aus, dann steht nur die eigene Stimme da. Noch einmal tippen zeigt wieder alle. Bei „Alle“ ausgegraut, weil dann keine Stimme gewählt ist.'],
    ['Einstellungen (Zahnrad)', '#soloBtn', '<span class="k hell">an <i class="k-sw"></i></span>',
        'Nur gewählte zeigen: blendet die Noten der anderen Stimmen aus. Dann steht nur die eigene Stimme da.'],
    ['Einstellungen (Zahnrad)', '#loopRow', '<span class="k hell">Loop <i class="k-sw aus"></i></span>',
        'Loop: am Ende fängt das Lied von selbst wieder von vorn an.'],
    ['Einstellungen (Zahnrad)', '#countInRow', '<span class="k hell">Aus</span><span class="k">1 Takt</span><span class="k hell">2 × ¼</span>',
        'Einzählen: vor dem Start klickt es, dann setzen alle gemeinsam ein. „1 Takt“ zählt einen ganzen Takt ein, „2 × ¼“ nur zwei Viertel, „Aus“ startet sofort. Beginnt der Takt mit Pausen, wird auf den ersten Einsatz hin gezählt. Beim Einzählen steht der Strich still, eine Zahl zählt mit (z.B. 3, 4, ►). Gilt für Abspielen und für das zweimalige Tippen auf einen Takt oder eine Note.'],
    ['Einstellungen (Zahnrad)', '#soundChips', '<span class="k">Stimme</span><span class="k hell">Orgel</span>',
        'Klang: womit die Noten gespielt werden, zum Beispiel Stimme, Chor oder Orgel.'],
    ['Einstellungen (Zahnrad)', '#offlineRow', '<span class="k hell">Offline</span>',
        'Offline: speichert alle Lieder auf dem Gerät. Steht dort „Netz kann aus“, läuft der Trainer auch ohne Internet.'],
    ['Einstellungen (Zahnrad)', '#homescreenRow', '<span class="k hell">Auf den Startbildschirm</span>',
        'Auf den Startbildschirm (iPhone: Home-Bildschirm, Rechner: Lesezeichen): zeigt, wie man den Trainer dort ablegt. Dann ist er mit einem Tipp da, wie eine App, und man muss ihn nicht mehr suchen.'],
    ['Einstellungen (Zahnrad)', '#feedbackRow', '<span class="k hell">Rückmeldung</span>',
        'Rückmeldung: schickt eine Nachricht mit Bildschirmfoto an den Trainer-Betreuer. Im Bild kann man rot markieren, was gemeint ist, und Persönliches schwärzen. Nur mit Chor-Login.']
];
const HILFE_START = 'Auf einen Knopf tippen: hier steht dann, was er macht. Der Knopf selbst wird dabei nicht ausgelöst. Noch einmal „?“ tippen beendet die Hilfe.';

function hilfeSichtbar(e) {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
}

// Alle sichtbaren erklärten Stellen: [Element, Eintrag]
// Nur Stellen, die zu sehen und nicht verdeckt sind (z.B. vom Einstellungsblatt):
// zuoberst in ihrer Mitte liegt sie selbst oder etwas aus ihr. Der Notenbereich zählt immer.
function hilfeStellen() {
    const modus = document.getElementById('hilfeModus');
    const oben = e => {
        const r = e.getBoundingClientRect();
        const x = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).find(t => !modus || !modus.contains(t));
        return x && (x === e || e.contains(x));
    };
    const liste = [];
    for (const eintrag of HILFE) {
        document.querySelectorAll(eintrag[1]).forEach(e => {
            if (hilfeSichtbar(e) && (e.id === 'alphaTab' || oben(e))) liste.push([e, eintrag]);
        });
    }
    return liste;
}

function hilfeZeigen() {
    if (document.getElementById('hilfeModus')) { hilfeEnde(); return; }
    hilfeGewaehlt = null;
    const modus = document.createElement('div');
    modus.id = 'hilfeModus';
    modus.innerHTML = '<div class="hm-fang"></div><svg class="hm-rahmen"></svg>' +
        '<div class="hm-karte" role="dialog" aria-live="polite"><div class="hm-text"></div>' +
        '<div class="hm-knoepfe"><button class="hm-alles" type="button">Alles auf einen Blick</button>' +
        '<button class="hm-fertig" type="button">Fertig</button></div></div>';
    document.documentElement.appendChild(modus);
    document.body.classList.add('hilfe-an');
    modus.querySelector('.hm-text').textContent = HILFE_START;
    modus.querySelector('.hm-fertig').onclick = hilfeEnde;
    modus.querySelector('.hm-alles').onclick = soGehtsZeigen;
    modus.querySelector('.hm-fang').addEventListener('click', e => hilfeTipp(e.clientX, e.clientY));
    hilfeZeichnen();
    window.addEventListener('scroll', hilfeZeichnen, true);
    window.addEventListener('resize', hilfeZeichnen);
}

function hilfeEnde() {
    document.body.classList.remove('hilfe-an');
    const m = document.getElementById('hilfeModus');
    if (m) m.remove();
    const s = document.getElementById('sogehts');
    if (s) s.remove();
    window.removeEventListener('scroll', hilfeZeichnen, true);
    window.removeEventListener('resize', hilfeZeichnen);
}

let hilfeGewaehlt = null;   // zuletzt angetipptes Element (fester Rahmen)

// Rahmen um alle erklärten Stellen, die Karte in die größte freie Lücke
function hilfeZeichnen() {
    const modus = document.getElementById('hilfeModus');
    if (!modus) return;
    const W = innerWidth, H = innerHeight;
    const stellen = hilfeStellen();
    let svg = '';
    // Notenbereich: erklärbar, aber ohne Rahmen (der ginge um die ganze Seite)
    for (const [e] of stellen.filter(([e]) => e.id !== 'alphaTab')) {
        const r = e.getBoundingClientRect();
        const x0 = Math.max(2, r.left - 3), x1 = Math.min(W - 2, r.right + 3);
        const fest = e === hilfeGewaehlt;
        svg += `<rect x="${x0}" y="${r.top - 3}" width="${x1 - x0}" height="${r.height + 6}" rx="10" ` +
            (fest ? 'class="fest"' : '') + '/>';
    }
    const rahmen = modus.querySelector('.hm-rahmen');
    rahmen.setAttribute('viewBox', `0 0 ${W} ${H}`);
    rahmen.setAttribute('width', W);
    rahmen.setAttribute('height', H);
    rahmen.innerHTML = svg;

    // Karte: bei offenem Einstellungsfeld rechts (Rechner) links daneben, sonst über die Breite
    const karte = modus.querySelector('.hm-karte');
    const blatt = document.body.classList.contains('sheet-open') ? document.getElementById('sheet').getBoundingClientRect() : null;
    let links = 12, rechts = W - 12;
    if (blatt && blatt.left > 320) rechts = blatt.left - 12;
    const breite = Math.min(520, rechts - links);
    links = links + (rechts - links - breite) / 2;
    karte.style.left = links + 'px';
    karte.style.width = breite + 'px';
    // Hindernisse: erklärte Stellen (ohne Notenbereich) und das Einstellungsblatt im Band der Karte
    const spannen = stellen.map(([e]) => e).filter(e => e.id !== 'alphaTab')
        .map(e => e.getBoundingClientRect()).concat(blatt ? [blatt] : [])
        .filter(r => r.right > links && r.left < links + breite)
        .map(r => [Math.max(0, r.top - 4), Math.min(H, r.bottom + 4)]).sort((a, b) => a[0] - b[0]);
    let luecke = [0, 0], bis = 0;
    for (const [von, ende] of [...spannen, [H, H]]) {
        if (von - bis > luecke[1] - luecke[0]) luecke = [bis, von];
        bis = Math.max(bis, ende);
    }
    const hoehe = luecke[1] - luecke[0];
    karte.style.maxHeight = Math.max(150, hoehe - 20) + 'px';
    // In der Lücke mittig, notfalls (zu klein) oben unter dem Rand
    const kh = Math.min(karte.offsetHeight, Math.max(150, hoehe - 20));
    karte.style.top = (hoehe >= 170 ? luecke[0] + Math.max(10, (hoehe - kh) / 2) : 10) + 'px';
}

// Tipp im Hilfe-Modus: Element unter dem Finger suchen (die Fangfläche liegt darüber)
function hilfeTipp(x, y) {
    const modus = document.getElementById('hilfeModus');
    const unter = document.elementsFromPoint(x, y).filter(e => !modus.contains(e));
    let treffer = null;
    for (const e of unter) {
        const eintrag = HILFE.find(h => e.closest(h[1]));
        if (eintrag) { treffer = [e.closest(eintrag[1]), eintrag]; break; }
    }
    // „?“ ist ein Schalter: noch einmal antippen beendet die Hilfe
    if (treffer && treffer[0].matches('.hilfe-btn')) { hilfeEnde(); return; }
    const text = modus.querySelector('.hm-text');
    if (treffer) {
        hilfeGewaehlt = treffer[0];
        text.textContent = treffer[1][3];
    } else {
        hilfeGewaehlt = null;
        text.textContent = 'Hier ist kein Knopf. ' + HILFE_START;
    }
    hilfeZeichnen();
}

// So-geht's-Seite: alle Knöpfe mit Bild, nach Gruppen
function soGehtsZeigen() {
    if (document.getElementById('sogehts')) return;
    const seite = document.createElement('div');
    seite.id = 'sogehts';
    seite.setAttribute('role', 'dialog');
    const bild = html => html.replace(/\{svg:([^}]+)\}/g, (_, wahl) => {
        const s = document.querySelector(wahl.includes('svg') || wahl.includes('.i-') ? wahl : wahl + ' svg');
        return s ? s.outerHTML : '';
    });
    let inhalt = '<div class="sg-kopf"><h2>So geht\'s</h2><button class="hm-fertig" type="button">Fertig</button></div><div class="sg-inhalt">';
    let gruppe = null;
    // Ohne Chor-Login keine Einträge zu Funktionen, die es dann nicht gibt
    const zeigen = h => h[0] && (hatZugang || !document.querySelector(h[1])?.closest('.nur-zugang'));
    for (const [g, , b, text] of HILFE.filter(zeigen)) {
        if (g !== gruppe) { inhalt += (gruppe ? '</div>' : '') + `<h3>${g}</h3><div class="sg-gruppe">`; gruppe = g; }
        inhalt += `<div class="sg-zeile"><div class="sg-bild">${bild(b)}</div><div class="sg-text"></div></div>`;
    }
    inhalt += '</div><p class="sg-fuss">Tipp: „?“ antippen und dann auf einen Knopf tippen, dann steht seine Erklärung direkt da.</p></div>';
    seite.innerHTML = inhalt;
    // Texte als Text einsetzen (nicht als HTML)
    const texte = HILFE.filter(zeigen).map(h => h[3]);
    seite.querySelectorAll('.sg-text').forEach((t, i) => { t.textContent = texte[i]; });
    seite.querySelector('.hm-fertig').onclick = hilfeEnde;
    document.documentElement.appendChild(seite);
}

document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('rueckmeldung')) { rueckmeldungEnde(); return; }
    const s = document.getElementById('sogehts');
    if (s) s.remove(); else hilfeEnde();
});

/* --- Rückmeldung: Nachricht + Bildschirmfoto per Mail (feedback.php) ---
   Nur mit Chor-Login. Ablauf: Einstellungen und Hilfe zu, kurz warten, dann das
   sichtbare Bild mit html-to-image (lokal, wird erst hier geladen) abfotografieren.
   Im Editor markiert man mit dem Finger rot („das hier“) oder zieht Rechtecke über
   Persönliches, die schwarz übermalt werden, bevor das Bild das Gerät verlässt.
   Name ist freiwillig. */
const RM_BIBLIOTHEK = 'html-to-image_1_11_11.js';
let rmBild = null;        // Bildschirmfoto (HTMLImageElement)
let rmAktionen = [];      // Schritte in Bildpunkten: {art:'schwarz', r:[x,y,b,h]} oder {art:'stift', p:[[x,y],…]}
let rmWerkzeug = 'stift'; // 'stift' = rot markieren, 'schwarz' = Rechteck schwärzen

function rmBibliothekLaden() {
    if (window.htmlToImage) return Promise.resolve();
    return new Promise((ok, fehler) => {
        const s = document.createElement('script');
        s.src = RM_BIBLIOTHEK;
        s.onload = ok;
        s.onerror = () => fehler(new Error('Bibliothek nicht geladen'));
        document.head.appendChild(s);
    });
}

// Sichtbaren Ausschnitt abfotografieren. Die mitscrollenden Teile (Noten, Fußzeile)
// werden dafür kurz um die Scrollhöhe verschoben, weil Safari einen Versatz des
// Wurzelelements im Bild nicht übernimmt. Noten außerhalb des Bildes bleiben weg (schneller).
async function rmFotografieren() {
    await rmBibliothekLaden();
    const y = scrollY;
    const fluss = Array.from(document.body.children).filter(e =>
        e.tagName !== 'SCRIPT' && !['fixed', 'sticky'].includes(getComputedStyle(e).position));
    fluss.forEach(e => { e.style.transform = `translateY(${-y}px)`; });
    try {
        const url = await htmlToImage.toJpeg(document.body, {
            width: innerWidth, height: innerHeight, quality: 0.8, backgroundColor: '#ffffff',
            pixelRatio: Math.min(2, devicePixelRatio || 1),
            filter: n => {
                if (n instanceof Element && n.id === 'einzaehlZahl') return false;   // Einzähl-Kreis nie ins Foto
                if (!(n instanceof Element) || !n.parentElement || !n.parentElement.classList.contains('at-surface')) return true;
                const r = n.getBoundingClientRect();
                return r.bottom > -y && r.top < innerHeight - y;
            }
        });
        const bild = new Image();
        await new Promise((ok, fehler) => { bild.onload = ok; bild.onerror = fehler; bild.src = url; });
        return bild;
    } finally {
        fluss.forEach(e => { e.style.transform = ''; });
    }
}

async function rueckmeldungStarten() {
    if (!hatZugang || document.getElementById('rueckmeldung')) return;
    toggleSheet(false);
    hilfeEnde();
    await new Promise(r => setTimeout(r, 350));   // Blatt ist weggeglitten
    const seite = document.createElement('div');
    seite.id = 'rueckmeldung';
    seite.setAttribute('role', 'dialog');
    seite.innerHTML = `<div class="rm-innen">
        <h2>Rückmeldung senden</h2>
        <p class="rm-hinweis">Geht an den Trainer-Betreuer. Was funktioniert nicht, was fehlt, was ist unklar?</p>
        <label for="rmText">Nachricht</label>
        <textarea id="rmText" maxlength="3000" placeholder="Zum Beispiel: Beim Lied „Ruhe“ springt Takt 12 …"></textarea>
        <label for="rmName">Name oder Kontakt (freiwillig, für Rückfragen)</label>
        <input type="text" id="rmName" maxlength="100" autocomplete="name">
        <div class="rm-bildzeile"><input type="checkbox" id="rmMitBild" checked><label for="rmMitBild" style="margin:0">Bildschirmfoto mitsenden</label></div>
        <div class="rm-werkzeuge rm-bildhinweis">
            <button type="button" class="chip active" data-werkzeug="stift">✎ Rot markieren</button>
            <button type="button" class="chip" data-werkzeug="schwarz">■ Schwärzen</button>
        </div>
        <p class="rm-hinweis rm-bildhinweis rm-werkzeugtext"></p>
        <div class="rm-bild"><div class="rm-warten">Bildschirmfoto wird gemacht …</div></div>
        <div class="hm-knoepfe">
            <button type="button" class="rm-zurueck">Letzten Schritt zurück</button>
            <button type="button" class="rm-abbrechen">Abbrechen</button>
            <button type="button" class="hm-fertig rm-senden">Senden</button>
        </div>
        <div class="rm-status" aria-live="polite"></div>
    </div>`;
    document.documentElement.appendChild(seite);
    seite.querySelector('.rm-abbrechen').onclick = rueckmeldungEnde;
    seite.querySelector('.rm-zurueck').onclick = () => { rmAktionen.pop(); rmZeichnen(); };
    seite.querySelectorAll('[data-werkzeug]').forEach(k => { k.onclick = () => rmWerkzeugWaehlen(k.dataset.werkzeug); });
    rmWerkzeugWaehlen('stift');
    seite.querySelector('.rm-senden').onclick = rueckmeldungSenden;
    seite.querySelector('#rmMitBild').onchange = e => {
        seite.querySelector('.rm-bild').hidden = !e.target.checked;
        seite.querySelectorAll('.rm-bildhinweis').forEach(h => { h.hidden = !e.target.checked; });
        seite.querySelector('.rm-zurueck').hidden = !e.target.checked;
    };
    rmBild = null;
    rmAktionen = [];
    // Foto entsteht unter der Rückmelde-Seite: sie hängt nicht im body und ist daher nicht im Bild
    try {
        rmBild = await rmFotografieren();
        const leinwand = document.createElement('canvas');
        leinwand.width = rmBild.naturalWidth;
        leinwand.height = rmBild.naturalHeight;
        seite.querySelector('.rm-bild').replaceChildren(leinwand);
        rmSchwaerzenEinrichten(leinwand);
        rmZeichnen();
    } catch (e) {
        console.warn('Bildschirmfoto:', e);
        seite.querySelector('.rm-bild').innerHTML = '<div class="rm-warten">Bildschirmfoto ging hier leider nicht. Die Nachricht lässt sich trotzdem senden.</div>';
        seite.querySelector('#rmMitBild').checked = false;
    }
    seite.querySelector('#rmText').focus();
}

function rmWerkzeugWaehlen(w) {
    rmWerkzeug = w;
    document.querySelectorAll('#rueckmeldung [data-werkzeug]').forEach(k => k.classList.toggle('active', k.dataset.werkzeug === w));
    const t = document.querySelector('#rueckmeldung .rm-werkzeugtext');
    if (t) t.textContent = w === 'stift'
        ? 'Mit dem Finger einkreisen, unterstreichen oder einen Pfeil malen: „das hier“.'
        : 'Persönliches? Ein Rechteck darüberziehen, dann wird es geschwärzt.';
}

// Bild neu malen: Foto, dann alle Schritte; vorschau = Schritt, der gerade gezogen wird
function rmZeichnen(vorschau) {
    const leinwand = document.querySelector('#rueckmeldung canvas');
    if (!leinwand || !rmBild) return;
    const g = leinwand.getContext('2d');
    g.drawImage(rmBild, 0, 0);
    const strich = Math.max(3, leinwand.width / 130);
    for (const a of vorschau ? [...rmAktionen, vorschau] : rmAktionen) {
        if (a.art === 'schwarz') {
            g.fillStyle = a === vorschau ? 'rgba(0,0,0,0.55)' : '#000';
            g.fillRect(...a.r);
        } else if (a.p.length > 1) {
            g.strokeStyle = '#e53935';
            g.lineWidth = strich;
            g.lineCap = 'round';
            g.lineJoin = 'round';
            g.beginPath();
            g.moveTo(...a.p[0]);
            for (const q of a.p.slice(1)) g.lineTo(...q);
            g.stroke();
        }
    }
}

// Finger oder Maus: Rechteck (Schwärzen) oder Linie (Markieren), in Bildpunkte umgerechnet
function rmSchwaerzenEinrichten(leinwand) {
    let aktuell = null, start = null;
    const punkt = e => {
        const r = leinwand.getBoundingClientRect();
        return [(e.clientX - r.left) * leinwand.width / r.width, (e.clientY - r.top) * leinwand.height / r.height];
    };
    const rechteck = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])];
    leinwand.addEventListener('pointerdown', e => {
        start = punkt(e);
        aktuell = rmWerkzeug === 'stift' ? { art: 'stift', p: [start] } : { art: 'schwarz', r: [...start, 0, 0] };
        leinwand.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    leinwand.addEventListener('pointermove', e => {
        if (!aktuell) return;
        if (aktuell.art === 'stift') aktuell.p.push(punkt(e));
        else aktuell.r = rechteck(start, punkt(e));
        rmZeichnen(aktuell);
    });
    leinwand.addEventListener('pointerup', () => {
        if (!aktuell) return;
        // Kleiner Tipp ohne Ziehen: kein Schritt
        const gross = aktuell.art === 'stift' ? aktuell.p.length > 2 : aktuell.r[2] > 8 && aktuell.r[3] > 8;
        if (gross) rmAktionen.push(aktuell);
        aktuell = null;
        rmZeichnen();
    });
    leinwand.addEventListener('pointercancel', () => { aktuell = null; rmZeichnen(); });
}

function rueckmeldungEnde() {
    const s = document.getElementById('rueckmeldung');
    if (s) s.remove();
    rmBild = null;
    rmAktionen = [];
}

async function rueckmeldungSenden() {
    const seite = document.getElementById('rueckmeldung');
    const status = seite.querySelector('.rm-status');
    const knopf = seite.querySelector('.rm-senden');
    const text = seite.querySelector('#rmText').value.trim();
    if (!text) {
        status.className = 'rm-status schlecht';
        status.textContent = 'Bitte zuerst eine Nachricht schreiben.';
        seite.querySelector('#rmText').focus();
        return;
    }
    const leinwand = seite.querySelector('canvas');
    const mitBild = seite.querySelector('#rmMitBild').checked && leinwand && rmBild;
    if (mitBild) rmZeichnen();   // ohne Vorschau, nur die festen Schritte
    const meta = document.querySelector('meta[name="trainer-version"]');
    const sel = document.getElementById('songSelect');
    const daten = {
        text,
        name: seite.querySelector('#rmName').value.trim(),
        bild: mitBild ? leinwand.toDataURL('image/jpeg', 0.8) : '',
        lied: sel.selectedOptions[0] ? sel.selectedOptions[0].text : '',
        version: meta ? meta.content : '',
        geraet: navigator.userAgent,
        groesse: innerWidth + '×' + innerHeight
    };
    knopf.disabled = true;
    status.className = 'rm-status';
    status.textContent = 'Wird gesendet …';
    try {
        const res = await fetch('feedback.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(daten)
        });
        const antwort = await res.json().catch(() => ({ ok: false, fehler: 'Antwort unlesbar (' + res.status + ')' }));
        if (!antwort.ok) throw new Error(antwort.fehler || 'Fehler ' + res.status);
        status.className = 'rm-status gut';
        status.textContent = 'Danke! Die Rückmeldung ist angekommen.';
        setTimeout(rueckmeldungEnde, 2200);
    } catch (e) {
        knopf.disabled = false;
        status.className = 'rm-status schlecht';
        status.textContent = (navigator.onLine === false ? 'Kein Internet. ' : '') + 'Nicht gesendet: ' + e.message + '. Der Text bleibt stehen, bitte später noch einmal.';
    }
}

/* --- Versionsnummer aus <meta name="trainer-version"> anzeigen --- */
function versionZeigen() {
    const meta = document.querySelector('meta[name="trainer-version"]');
    const v = meta ? meta.content : '';
    document.querySelectorAll('[data-version]').forEach(e => { e.textContent = v ? 'Version ' + v : ''; });
}

/* --- Homescreen: Begrüßung mit Anleitung, damit man den Trainer wiederfindet ---
   Beim Öffnen im Browser (nicht vom Homescreen aus) erscheint eine kurze Anleitung
   für das erkannte Gerät (iPhone/iPad, Android, Samsung-Browser, Rechner). Beim ersten
   Mal nur „Okay“, ab dem zweiten Mal auch „Nicht mehr anzeigen“. Dieselbe Anleitung
   steht jederzeit in den Einstellungen (Zeile „Homescreen“). */
const HS_KEY = 'chorTrainerHomescreen';

function vomHomescreen() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function geraetErkennen() {
    const ua = navigator.userAgent;
    // iPad meldet sich seit iPadOS 13 als Mac, hat aber einen Touchscreen
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ipad';
    if (/iPhone|iPod/.test(ua)) return 'iphone';
    if (/SamsungBrowser/.test(ua)) return 'samsung';
    if (/Android/.test(ua)) return 'android';
    return /Mac/.test(ua) ? 'mac' : 'pc';
}

const HS_TEILEN = '<svg viewBox="0 0 24 24" class="hs-sym"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M6 11H5v10h14V11h-1"/></svg>';
const HS_ANLEITUNG = {
    iphone: ['Auf den Home-Bildschirm legen', [
        `In Safari unten auf das Teilen-Symbol ${HS_TEILEN} tippen. Bei neuerem iOS erst auf „•••“ unten rechts, dann auf „Teilen“.`,
        '„Zum Home-Bildschirm“ wählen. Falls nicht zu sehen: etwas nach oben wischen.',
        'Oben rechts auf „Hinzufügen“ tippen.']],
    ipad: ['Auf den Home-Bildschirm legen', [
        `In Safari oben rechts auf das Teilen-Symbol ${HS_TEILEN} tippen.`,
        '„Zum Home-Bildschirm“ wählen. Falls nicht zu sehen: etwas nach oben wischen.',
        'Oben rechts auf „Hinzufügen“ tippen.']],
    android: ['Auf den Startbildschirm legen', [
        'Oben rechts auf die drei Punkte <b class="hs-taste">⋮</b> tippen.',
        '„App installieren“ oder „Zum Startbildschirm hinzufügen“ wählen.',
        'Auf „Hinzufügen“ tippen (manchmal zweimal).']],
    samsung: ['Auf den Startbildschirm legen', [
        'Unten rechts auf das Menü <b class="hs-taste">≡</b> tippen.',
        '„Seite hinzufügen zu“ wählen, dann „Startbildschirm“.',
        'Auf „Hinzufügen“ tippen.']],
    mac: ['Als Lesezeichen speichern', [
        'Die Tasten <b class="hs-taste">⌘</b> und <b class="hs-taste">D</b> zusammen drücken, dann „Hinzufügen“.',
        'In Safari geht auch: Menü „Ablage“, dann „Zum Dock hinzufügen“. Dann liegt der Trainer unten im Dock.']],
    pc: ['Als Lesezeichen speichern', [
        'Die Tasten <b class="hs-taste">Strg</b> und <b class="hs-taste">D</b> zusammen drücken.',
        'Auf „Fertig“ oder „Hinzufügen“ klicken.']]
};

function hsStand() {
    try { return JSON.parse(localStorage.getItem(HS_KEY) || '{}'); } catch (e) { return {}; }
}
function hsMerken(stand) {
    try { localStorage.setItem(HS_KEY, JSON.stringify(stand)); } catch (e) { }
}

/** Anleitung zeigen. begruessung = true: Begrüßung beim Öffnen (mit Zähler). */
function homescreenZeigen(begruessung) {
    if (document.getElementById('homescreen')) return;
    if (!begruessung) toggleSheet(false);
    const geraet = geraetErkennen();
    const [, schritte] = HS_ANLEITUNG[geraet];
    const stand = hsStand();
    const mitAus = begruessung && (stand.gezeigt || 0) >= 1;
    const handy = !['mac', 'pc'].includes(geraet);
    const el = document.createElement('div');
    el.id = 'homescreen';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    const apple = geraet === 'iphone' || geraet === 'ipad';
    // Blickfang: so sieht es danach aus (Handy: Home-Bildschirm, Rechner: Lesezeichenleiste)
    const bild = handy
        ? `<div class="hs-bild hs-handy" aria-hidden="true">${'<i></i>'.repeat(5)}<span class="hs-app"><img src="apple-touch-icon.png" alt=""><em>Chor-Trainer</em></span>${'<i></i>'.repeat(2)}</div>`
        : `<div class="hs-bild hs-leiste" aria-hidden="true"><i></i><i></i><span class="hs-lz"><img src="favicon-32.png" alt="">Chor-Trainer</span><i></i></div>`;
    // Begrüßung: Grund, Hinweis auf die Einstellungen und „Okay“ zuerst, die Anleitung
    // darunter. Beim ersten Mal steht „Nicht mehr anzeigen“ ganz unten, danach neben
    // „Okay“. Aus den Einstellungen: Anleitung, „Okay“ am Ende.
    const knopfOk = '<button type="button" class="hs-ok">Okay</button>';
    const knopfAus = '<button type="button" class="hs-aus">Nicht mehr anzeigen</button>';
    const anleitung = `<h3>So geht’s</h3><ol>${schritte.map(t => `<li>${t}</li>`).join('')}</ol>`
        + (handy ? '<p class="hs-klein">Fehlt das Menü (zum Beispiel aus WhatsApp geöffnet)? Dann die Seite zuerst im Browser öffnen.</p>' : '');
    el.innerHTML = `<div class="hs-karte">
        ${bild}
        <h2>${handy
            ? `Chor‑Trainer auf den ${apple ? 'Home-Bildschirm' : 'Startbildschirm'} legen`
            : 'Chor‑Trainer als Lesezeichen speichern'}</h2>
        <p class="hs-wichtig">Damit man ihn mit einem ${handy ? 'Tipp' : 'Klick'} wiederfindet.</p>
        ${begruessung
            ? `<p class="hs-klein">Die Anleitung steht auch in den Einstellungen (Zahnrad) unter „${hsZeilenName(geraet)}“.</p>
               <div class="hs-knoepfe">${mitAus ? knopfAus : ''}${knopfOk}</div>
               ${anleitung}
               ${mitAus ? '' : `<div class="hs-knoepfe hs-unten">${knopfAus}</div>`}`
            : `${anleitung}<div class="hs-knoepfe">${knopfOk}</div>`}
        </div>`;
    const zu = () => { el.remove(); document.removeEventListener('keydown', taste, true); };
    const taste = e => { if (e.key === 'Escape') { e.stopPropagation(); zu(); } };
    document.addEventListener('keydown', taste, true);
    el.querySelector('.hs-ok').onclick = zu;
    const aus = el.querySelector('.hs-aus');
    if (aus) aus.onclick = () => { hsMerken({ ...hsStand(), aus: true }); zu(); };
    if (begruessung) hsMerken({ ...stand, gezeigt: (stand.gezeigt || 0) + 1 });
    document.documentElement.appendChild(el);
}

/** Name der Einstellungs-Zeile: das Wort, das auch im Menü des Geräts steht. */
function hsZeilenName(geraet) {
    if (geraet === 'iphone' || geraet === 'ipad') return 'Auf den Home-Bildschirm';
    if (geraet === 'mac' || geraet === 'pc') return 'Lesezeichen setzen';
    return 'Auf den Startbildschirm';
}

/** Beim Öffnen begrüßen, außer vom Homescreen aus oder nach „Nicht mehr anzeigen“. */
function homescreenBegruessen() {
    const geraet = geraetErkennen();
    const titel = document.getElementById('homescreenTitel');
    const info = document.getElementById('homescreenInfo');
    if (titel) titel.textContent = hsZeilenName(geraet);
    if (info && (geraet === 'mac' || geraet === 'pc')) info.textContent = 'Chor-Trainer mit einem Klick wiederfinden';
    if (vomHomescreen()) {
        if (info) info.textContent = 'Liegt schon dort ✓';
        return;
    }
    // Ungefragt nur im Chor-Trainer: Mitglieder sollen ihn auf den Startbildschirm legen,
    // die öffentliche Fassung drängt sich Besuchern nicht auf
    if (hsStand().aus || !MIT_LOGIN) return;
    setTimeout(() => homescreenZeigen(true), 1200);
}

/* --- Keine Tastatur von selbst ---
   Als Web-App vom Homescreen gestartet wählt iOS teils von selbst ein Eingabefeld
   an (Taktnummer), dann geht die Zahlentastatur auf. In den ersten Sekunden nach dem
   Start wird ein Feld deshalb wieder abgewählt, wenn niemand getippt oder eine Taste
   gedrückt hat. */
(() => {
    let letzteEingabe = -Infinity;
    const merken = () => { letzteEingabe = performance.now(); };
    ['pointerdown', 'touchstart', 'mousedown', 'keydown'].forEach(t => document.addEventListener(t, merken, true));
    const pruefen = e => {
        const feld = e && e.target && e.target.matches ? e.target : document.activeElement;
        if (!feld || !feld.matches('input, textarea, select')) return;
        if (performance.now() - letzteEingabe > 1000) feld.blur();
    };
    document.addEventListener('focusin', pruefen, true);
    // auch beim Zurückkehren in die App (iOS stellt den Fokus wieder her)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(pruefen, 50); });
    window.addEventListener('pageshow', () => setTimeout(pruefen, 50));
    setTimeout(() => document.removeEventListener('focusin', pruefen, true), 8000);
})();

// Rand beim Drehen oder Ändern der Fenstergröße anpassen (nur wenn er sich ändert)
window.addEventListener('resize', () => {
    const rand = notenRand();
    if (String(rand) === String(api.settings.display.padding)) return;
    api.settings.display.padding = rand;
    api.updateSettings();
    api.render();
});

/* --- Startup-Sequenz --- */

// 0. Versionsnummer
versionZeigen();

// 1. Gespeicherte Einstellungen laden
loadSavedSettings();

// 1b. Song aus der Adresse hat Vorrang vor dem zuletzt gewaehlten
applySongFromUrl();

// 1c. Bedienelemente auf die geladenen Werte setzen
buildSoundChips();
updateBgDisplay();
updateBpmDisplay();
document.getElementById('textSizeDisplay').innerText = currentTextSize;
document.getElementById('zoomDisplay').innerText = Math.round(currentScale * 100) + "%";
adjustContentPadding();

// 2. Einstellungen auf die API anwenden
api.playbackSpeed = currentTempoFactor;
api.settings.display.scale = currentScale;
api.metronomeVolume = document.getElementById('metronomeBtn').classList.contains('active') ? metronomLaut : 0;
metroWertZeigen();
api.isLooping = isLooping;  // native AlphaTab-Loop aktivieren
countInAnwenden();
applyTextFont();
api.updateSettings();
api.render();

// 3. Zugang klären, dann Song laden und Offline-Speicher einrichten
(async () => {
    await zugangPruefen();
    zugangAnwenden();
    loadSelectedSong();
    offlineEinrichten();
    homescreenBegruessen();
})();

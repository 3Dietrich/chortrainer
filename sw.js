/* Service Worker: Trainer auch ohne Netz.
   Jede Anfrage geht zuerst ins Netz (no-cache: der Server wird immer gefragt,
   unveränderte Dateien kommen als kurzes 304). Klappt das, wird die Antwort
   gespeichert. Kein Netz, Fehler oder länger als WARTEN_MS ohne Antwort:
   dann der gespeicherte Stand. Gesperrte Lieder (401) werden nicht gespeichert.
   login.php und zugang.php laufen am Service Worker vorbei, damit der Browser
   die Passwortabfrage bzw. das Cookie selbst abwickelt. */

const CACHE = 'trainer-v1';
const WARTEN_MS = 4000;

// Grundausstattung beim ersten Besuch: damit startet der Trainer offline mit "Bereit".
// Die übrigen Lieder speichert trainer.js nach dem Chor-Login (vorladenFuerOffline).
const GRUNDAUSSTATTUNG = [
    './', 'style.css', 'trainer.js', 'alphaTab_v1_8_1.js', 'sonivox.sf2',
    'font/Bravura.woff2', 'font/Bravura.woff', 'Bereit.musicxml', 'bereit.mp3',
    'icon-192.png', 'favicon-32.png', 'apple-touch-icon.png'
];

self.addEventListener('install', event => {
    self.skipWaiting();
    // Einzeln, damit eine fehlende Datei nicht die ganze Installation verhindert
    event.waitUntil(caches.open(CACHE).then(c =>
        Promise.allSettled(GRUNDAUSSTATTUNG.map(u => c.add(new Request(u, { cache: 'no-cache' }))))));
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const req = event.request;
    const url = new URL(req.url);
    if (req.method !== 'GET' || url.origin !== location.origin) return;
    if (!url.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;
    if (/\/(login|zugang)\.php$/.test(url.pathname)) return;

    if (req.headers.has('range')) event.respondWith(bereich(req));
    else event.respondWith(netzZuerst(event));
});

// Seitenaufrufe (auch mit ?song=…) unter einem Schlüssel speichern
function schluessel(req) {
    return req.mode === 'navigate' ? new URL('./', self.registration.scope).href : req.url;
}

async function ausSpeicher(req) {
    const c = await caches.open(CACHE);
    // Erst exakt, dann ohne ?v=… (style.css?v=… liegt evtl. als style.css vor)
    return (await c.match(schluessel(req))) || (await c.match(schluessel(req), { ignoreSearch: true }));
}

async function speichern(req, res) {
    if (!res.ok || res.type !== 'basic' || res.status !== 200) return;
    const c = await caches.open(CACHE);
    const key = schluessel(req);
    // Ältere Fassungen derselben Datei (anderes ?v=) entfernen
    for (const alt of await c.keys(key, { ignoreSearch: true })) {
        if (alt.url !== key) await c.delete(alt);
    }
    await c.put(key, res);
}

async function netzZuerst(event) {
    const req = event.request;
    const netz = fetch(req, { cache: 'no-cache' });
    // Speichern läuft weiter, auch wenn nach WARTEN_MS schon der Speicher geantwortet hat
    event.waitUntil(netz.then(res => speichern(req, res.clone())).catch(() => {}));
    let zeitUm;
    const frist = new Promise(r => { zeitUm = setTimeout(r, WARTEN_MS); });
    try {
        // Langsames Netz: nach WARTEN_MS den Speicher nehmen, falls dort etwas liegt
        const erstes = await Promise.race([netz, frist.then(() => null)]);
        if (erstes) return erstes;
        const gespeichert = await ausSpeicher(req);
        return gespeichert || await netz;
    } catch (e) {
        const gespeichert = await ausSpeicher(req);
        if (gespeichert) return gespeichert;
        throw e;
    } finally {
        clearTimeout(zeitUm);
    }
}

// Audio (bereit.mp3) fragt in Stücken an (Range). Online direkt durchreichen,
// offline das gespeicherte Stück herausschneiden (Safari verlangt 206).
async function bereich(req) {
    try {
        return await fetch(req);
    } catch (e) {
        const gespeichert = await ausSpeicher(new Request(req.url));
        if (!gespeichert) throw e;
        const daten = await gespeichert.arrayBuffer();
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
        const start = m && m[1] ? parseInt(m[1], 10) : 0;
        const ende = m && m[2] ? Math.min(parseInt(m[2], 10), daten.byteLength - 1) : daten.byteLength - 1;
        return new Response(daten.slice(start, ende + 1), {
            status: 206,
            headers: {
                'Content-Type': gespeichert.headers.get('Content-Type') || 'audio/mpeg',
                'Content-Range': `bytes ${start}-${ende}/${daten.byteLength}`,
                'Content-Length': String(ende - start + 1),
                'Accept-Ranges': 'bytes'
            }
        });
    }
}

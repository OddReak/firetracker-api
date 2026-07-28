import express from 'express';
import axios from 'axios';
import * as turf from '@turf/turf';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const NASA_API_KEY = process.env.NASA_API_KEY;

app.use(express.static('public'));

let cacheFeux = {}; 
const CACHE_DURATION = 30 * 60 * 1000; 

// --- ROUTE : FEUX ---
app.get('/api/feux', async (req, res) => {
    const { w, s, e, n } = req.query;
    if (!w || !s || !e || !n) return res.status(400).json({ error: "Coordonnées manquantes" });
    if (!NASA_API_KEY) return res.status(500).json({ error: "Clé API manquante" });

    const cacheKey = `${w},${s},${e},${n}`;
    if (cacheFeux[cacheKey] && (Date.now() - cacheFeux[cacheKey].lastFetch < CACHE_DURATION)) {
        return res.json(cacheFeux[cacheKey].data);
    }

    const sources = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'MODIS_NRT'];
    const startTime = Date.now() - (73 * 60 * 60 * 1000);
    let allPoints = [];

    try {
        const fetchPromises = sources.map(source => 
            axios.get(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${NASA_API_KEY}/${source}/${w},${s},${e},${n}/4`)
        );
        const results = await Promise.all(fetchPromises);
        
        results.forEach(response => {
            const lines = response.data.split(/\r?\n/);
            if (lines.length < 2) return;
            const headers = lines[0].split(',');
            const latIdx = headers.indexOf('latitude');
            const lonIdx = headers.indexOf('longitude');
            const dateIdx = headers.indexOf('acq_date');
            const timeIdx = headers.indexOf('acq_time');

            for (let i = 1; i < lines.length; i++) {
                if (!lines[i].trim()) continue;
                const cols = lines[i].split(',');
                const lat = parseFloat(cols[latIdx]);
                const lon = parseFloat(cols[lonIdx]);
                const timeStr = cols[timeIdx].padStart(4, '0');
                const timestamp = new Date(`${cols[dateIdx]}T${timeStr.substring(0,2)}:${timeStr.substring(2,4)}:00Z`).getTime();

                if (!isNaN(lat) && !isNaN(lon) && timestamp >= startTime) {
                    allPoints.push({ lat, lon, ts: timestamp });
                }
            }
        });

        cacheFeux[cacheKey] = { data: { points: allPoints }, lastFetch: Date.now() };
        res.json(cacheFeux[cacheKey].data);
    } catch (error) {
        res.status(500).json({ error: "Erreur NASA" });
    }
});

// --- ROUTE : RADAR AVIONS ---
app.get('/api/avions', async (req, res) => {
    const { w, s, e, n } = req.query;
    if (!w || !s || !e || !n) return res.json([]);

    try {
        const response = await axios.get(`https://opensky-network.org/api/states/all?lamin=${s}&lomin=${w}&lamax=${n}&lomax=${e}`);
        const states = response.data.states || [];
        
        const firePlanes = states.filter(state => {
            const callsign = (state[1] || '').trim().toUpperCase();
            return callsign.includes('PELICAN') || callsign.includes('MILAN') || callsign.includes('BENGAL');
        }).map(state => ({
            id: state[0],
            callsign: (state[1] || '').trim(),
            lon: state[5],
            lat: state[6],
            alt: state[7],
            velocity: state[9],
            heading: state[10]
        }));
        
        res.json(firePlanes);
    } catch (error) {
        res.status(500).json({ error: "Impossible de récupérer les vols" });
    }
});

// --- ROUTE : MÉTÉO (CHAMP DE VENT DYNAMIQUE) ---
app.get('/api/vent', async (req, res) => {
    const { w, s, e, n } = req.query;
    if (!w || !s || !e || !n) return res.json(null);
    
    try {
        const lats = [];
        const lons = [];
        
        // 1. Point central (pour le widget texte en bas)
        const centerLat = (parseFloat(s) + parseFloat(n)) / 2;
        const centerLon = (parseFloat(w) + parseFloat(e)) / 2;
        lats.push(centerLat.toFixed(2));
        lons.push(centerLon.toFixed(2));
        
        // 2. Grille de 25 points (5x5) pour les particules d'animation
        const latStep = (parseFloat(n) - parseFloat(s)) / 4;
        const lonStep = (parseFloat(e) - parseFloat(w)) / 4;
        for(let i = 0; i <= 4; i++) {
            for(let j = 0; j <= 4; j++) {
                lats.push((parseFloat(s) + i*latStep).toFixed(2));
                lons.push((parseFloat(w) + j*lonStep).toFixed(2));
            }
        }
        
        // Open-Meteo permet d'envoyer un tableau de coordonnées en une seule requête
        const response = await axios.get(`https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&current_weather=true`);
        const results = response.data;
        
        if (Array.isArray(results)) {
            const centerWeather = results[0].current_weather;
            const grid = results.slice(1).map((r, idx) => ({
                lat: lats[idx+1],
                lon: lons[idx+1],
                weather: r.current_weather
            }));
            res.json({ center: centerWeather, grid: grid });
        } else {
            // Sécurité si une seule coordonnée est exceptionnellement renvoyée
            res.json({ center: results.current_weather, grid: [] });
        }
    } catch (error) {
        res.status(500).json({ error: "Erreur météo" });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Serveur prêt sur le port ${PORT}`));

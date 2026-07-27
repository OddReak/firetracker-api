const express = require('express');
const axios = require('axios');
const cors = require('cors');
const turf = require('@turf/turf');

const app = express();
app.use(cors()); // Autorise votre application mobile à interroger ce serveur

const PORT = process.env.PORT || 3000;
const NASA_API_KEY = process.env.NASA_API_KEY;

// Mémoire locale du serveur
let cache = {
    data: { points: [], polygons: [] },
    lastFetch: 0
};

// Limite de validité du cache (30 minutes)
const CACHE_DURATION = 30 * 60 * 1000; 

app.get('/api/feux-en-direct', async (req, res) => {
    // 1. SI LE CACHE EST RÉCENT, ON RÉPOND INSTANTANÉMENT
    if (Date.now() - cache.lastFetch < CACHE_DURATION && cache.data.points.length > 0) {
        console.log("Données servies depuis le cache !");
        return res.json(cache.data);
    }

    // 2. SINON, ON CALCULE TOUT (Prend quelques secondes)
    console.log("Cache expiré, téléchargement depuis la NASA...");
    if (!NASA_API_KEY) {
        return res.status(500).json({ error: "Clé API NASA manquante sur le serveur." });
    }

    // Coordonnées de l'Europe/Afrique du Nord (À modifier si vous voulez le monde entier, mais attention à la limite 100x100 de la NASA)
    const w = -20, s = 30, e = 30, n = 60; 
    const sources = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'MODIS_NRT'];
    const MS_PER_HOUR = 60 * 60 * 1000;
    const now = Date.now();
    const startTime = now - (72 * MS_PER_HOUR); // 72 heures
    
    let allPoints = [];

    try {
        const fetchPromises = sources.map(source => 
            axios.get(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${NASA_API_KEY}/${source}/${w},${s},${e},${n}/3`)
        );
        
        const results = await Promise.all(fetchPromises);
        
        // Parse CSV
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
                const timestamp = new Date(`${cols[dateIdx]}T${cols[timeIdx].padStart(4, '0').substring(0,2)}:${cols[timeIdx].padStart(4, '0').substring(2,4)}:00Z`).getTime();

                if (!isNaN(lat) && !isNaN(lon) && timestamp >= startTime && timestamp <= now) {
                    allPoints.push({ lat, lon, timestamp });
                }
            }
        });

        // Calcul lourd Turf.js
        let polygons = [];
        if (allPoints.length > 0) {
            const turfPoints = allPoints.map(pt => turf.point([pt.lon, pt.lat]));
            const featureCollection = turf.featureCollection(turfPoints);
            const clustered = turf.clustersDbscan(featureCollection, 8, {units: 'kilometers', minPoints: 2});
            
            let clusterGroups = {};
            turf.featureEach(clustered, function (feature) {
                const clusterId = feature.properties.cluster;
                if (clusterId !== undefined) {
                    if (!clusterGroups[clusterId]) clusterGroups[clusterId] = [];
                    clusterGroups[clusterId].push(feature);
                }
            });

            for (let id in clusterGroups) {
                const fc = turf.featureCollection(clusterGroups[id]);
                const hull = turf.convex(fc);
                if (hull) polygons.push(hull);
            }
        }

        // 3. MISE À JOUR DU CACHE ET RÉPONSE
        cache.data = { points: allPoints, polygons: polygons };
        cache.lastFetch = Date.now();
        
        res.json(cache.data);

    } catch (error) {
        console.error("Erreur serveur :", error.message);
        res.status(500).json({ error: "Erreur lors de la récupération des données NASA." });
    }
});

app.listen(PORT, () => console.log(`Serveur prêt sur le port ${PORT}`));
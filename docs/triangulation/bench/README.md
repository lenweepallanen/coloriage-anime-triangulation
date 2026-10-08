# Banc « Zones auto » (worker OpenCV, hors app)

Teste `autoZonesDetect` (`apps/admin/public/opencv-worker.js`, message `auto-zones`) sur des PNG de coloriages sans passer par l'admin.
Le worker réel est servi avec l'`opencv.js` local (`apps/admin/public/opencv.js`) à la place du CDN.

```bash
mkdir -p docs/triangulation/bench/img docs/triangulation/bench/out   # (ignorés par git)
cp ~/Downloads/.../01_sparkle.png docs/triangulation/bench/img/
node docs/triangulation/bench/server.mjs &          # port 8777
node docs/triangulation/bench/run.mjs 01_sparkle.png 02_skye.png
```

Sortie par image : `out/<nom>.png` (zones colorées + libellés + coupe du cou en pointillés) et `out/<nom>.json` (polygones bruts).
`run.mjs` utilise playwright-core et le chrome-headless-shell installés sur le Mac de Nicolas (chemins en tête de fichier).

Résultats du 08/10/2026 sur le livre LICORNE : Sparkle, Skye, Pip = OK (4 pattes, tête trouvée sauf Pip) ; Pearl, Lily, Twinkle,
Rose, Zoe (personnages debout) et Ember (dragon) = refusés par le garde-fou « ≥ 3 pattes hautes » → zones à la main.

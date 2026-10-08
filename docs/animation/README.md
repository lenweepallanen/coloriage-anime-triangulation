# Pipeline « animation par vidéo » (CoTracker + Bones) piloté depuis l'admin

Procédure suivie le 09/10/2026 sur « Licorne Animation TEST » (copie de la licorne triangulée) : vidéo idle générée par IA,
puis animation `cotracker-bones` créée et calculée **dans l'admin en prod** (Playwright + écritures Firestore ciblées).

## Pré-requis
- `~/.picopop-keys.env` (XAI_API_KEY, PLAY_SERVICE_ACCOUNT_FILE) et `~/.picopop-keys/admin-test/` : `fbconfig.json` (config web
  Firebase, celle de `apps/admin/src/db/firebase.ts`) + `custom-token.txt` (jeton personnalisé de l'admin de test, régénéré par `auth.py`
  à partir du compte de service ; `ADMIN_UID` dans l'env pour la 1ʳᵉ génération).
- playwright-core + chrome-headless-shell (chemins en tête des scripts `.mjs`).

## Étapes
1. **Copie du projet** : `node tools/duplicate.mjs <dossier clés> "<nom source>"` → id de la copie, puis renommer (PATCH Firestore `name`).
2. **Vidéo idle** : `python3 licorne/gen_idle.py <sortie> n=3 duration=5 res=720p ar=1:1` (xAI grok-imagine-video-1.5, image-to-video
   depuis `referenceImage.png` aplatie sur blanc ; carré accepté → 960×960, 121 images à 24 ips ; frame 0 = image source à 2,4/255 près).
   Planche de contrôle + écart frame 0 ; faire valider la vidéo.
3. **Animation** : `node tools/anim-create.mjs <clés> <pid> Idle <mp4>` (prompt du nom accepté automatiquement) puis
   `node tools/anim-video.mjs <clés> <pid> Idle <mp4>` (→ Loop, envoi de la vidéo à l'étape Vidéo).
4. **Points + squelette** : `python3 licorne/points2.py <dossier>` écrit `points2.json` (CoTrackerPoint[], coords VIDÉO) et
   `skeleton2.json` ; `auth.set_animation_mesh(pid, 'Idle', {cotrackerPoints, cotrackerSkeleton})` les pose dans l'animation.
   Règles (retour Nicolas) : beaucoup de points, aux extrémités et le long des courbes naturelles (corne, crinière, queue, pattes),
   et des points qui serviront de joints. 93 points sur la licorne : corne 5, tête 12, crinière 18, cou 3, corps 13, queue 26, pattes 4×4.
   Squelette : chaîne corps → queue (12 joints, polyligne continue jusqu'au bout de la queue), 4 chaînes pattes (hanche, genou,
   cheville, sabot), 1 chaîne TETE (cou → gorge → tête → oreille → bord externe de la crinière → bout). **Une seule chaîne par zone**
   (le LBS indexe par zoneId).
5. **Tracking** : `node tools/anim-step.mjs <clés> <pid> Idle CoTracker3 cotracker-run` (≈ 2 min en natif 960).
6. **Bones** : `… Bones "click:Valider le squelette;expect:Squelette validé"`.
7. **LBS** : `… LBS "click:Calculer & Preview;expect:Valider;click:^Valider$;expect:validé"` (mode lbs-arap par défaut, 15 s).
8. **Calcul** : `… Calcul "click#2:^Appliquer$;click#2:^Valider$"` (lissage maillage 4 Hz = ce que lit le player).
   ⚠ Le lissage des BONES ne peut pas être validé depuis une session ultérieure : `cotrackerBodyJointFrames`/`cotrackerLegBoneFrames`
   ne sont pas persistés par `projectsStore` (disponibles seulement en mémoire juste après le calcul LBS).
9. **Preview** : `… Preview "wait:6000;shots:8:400"` → 8 captures du canvas.

`anim-step.mjs` : actions `click:<regex>`, `click#N:`, `expect:<regex>`, `wait:<ms>`, `shots:N:ms`, `cotracker-run`, enchaînées par `;`.

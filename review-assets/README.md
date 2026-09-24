# Assets pour la review App Store / Google Play

Ces fichiers ne sont **pas** embarqués dans l'app. Ils servent uniquement à fournir
au réviseur de quoi tester sans matériel physique.

## Contenu

- **TEST-COLORING-REVIEW-T-REX.png** — page de coloriage T-Rex **pré-coloriée**, avec
  les 4 **viseurs** (motif QR, 12 mm) dans les coins de l'image (contrat `pdfLayout`,
  depuis la version 1.0.1 — les anciens repères en L ne sont plus reconnus). Le réviseur
  l'importe dans l'app pour déclencher l'animation (aucune impression ni caméra nécessaire).

## Flux réviseur (à mettre dans les notes de review)

1. Onglet **SCAN** (la caméra s'ouvre directement, aucun choix à faire), viser le
   **QR du livre « TEST BOOK (REVIEW) »** : le livre s'ajoute tout seul, retour au menu
   avec un anneau de téléchargement sur sa carte.
   > Le livre est publié mais **non listé** : invisible du public, ajoutable seulement par ce QR.
2. Quand l'anneau atteint 100 %, ouvrir **TEST BOOK (REVIEW)** → le coloriage
   **« TEST COLORING (REVIEW) - T REX »**. (Raccourci : SCAN → viser le QR du coloriage :
   le livre s'ajoute automatiquement et l'écran de scan s'ouvre.)
3. Écran de scan → **« Importer une image »** → choisir **TEST-COLORING-REVIEW-T-REX.png**.
4. Les 4 viseurs sont détectés → le dessin colorié **s'anime en petit film**.

À joindre aux notes : ce PNG + le QR du livre TEST (image) + éventuellement une courte vidéo.

# Charte graphique & UX — App PLAY (PicoPop)

**À lire et respecter AVANT d'ajouter ou modifier le moindre élément d'interface côté play**
(pages `apps/play/src`, mais aussi les composants partagés rendus dans l'app play :
`apps/admin/src/components/scan/*`, HUD du ScenePlayer, écrans de scan).

Principe n° 1 : **ne jamais inventer un style custom**. Chaque nouvel élément doit être
composé à partir des classes et tokens existants de `apps/play/src/styles/play-theme.css`.
Si un pattern manque vraiment, l'ajouter DANS le thème (scopé `body.play-app`), avec les
tokens ci-dessous — jamais de valeurs en dur improvisées ni de styles inline.

## 1. Identité

Univers : « livre de coloriage animé pour enfant » — doux, pastel, arrondi, effet
« sticker » (blanc + ombre douce colorée). Aucun angle vif, aucun gris neutre, aucun
noir pur, aucune bordure fine sombre.

## 2. Palette (tokens CSS définis sur `body.play-app`)

| Token | Hex | Usage |
|---|---|---|
| `--cream` | `#fff2de` | Fond de page (uni). Le shell pose aussi `bg-meadow.webp` en fond illustré fixe |
| `--paper` | `#ffffff` | Surfaces : cartes, pills, boutons blancs |
| `--ink` | `#2e2a5e` | Texte principal (encre marine, JAMAIS de noir) |
| `--ink-soft` | `#6f6a92` | Texte secondaire (dates, sous-textes, hints) |
| `--accent-violet` | `#8b7cf0` | **Couleur d'action principale** : boutons scan, pills actives, icônes, menu ☰ |
| `--accent-mint` | `#57c8a3` | Validation / « Go » / états réussis (badge scanné `#34c98e`) |
| `--accent-sun` | `#ffcf3f` | Photo/flash, étoiles, spinner (texte associé `#7a5b00`) |
| `--accent-rose` | `#ff8fae` | Annuler / retirer (danger doux), ✦ décoratives |
| `--accent-sky` | `#5bb8e8` | Accent secondaire (galerie, ✦ variantes) |
| `--accent-orange` | `#ff9b3d` | Accent ponctuel |
| Violet titres | `#7a52c7` | Réservé aux titres `.section-title` |
| Lavande | `#cfc0f1` / `#e6ddfa` / `#f3eefe` / `#e9e2fb` | Tabbar, anneaux, fonds actifs discrets |

Ombres (toujours teintées violet-gris, jamais noires) :
- `--sticker-shadow` : `0 4px 12px rgba(90, 80, 140, 0.2)`
- `--sticker-shadow-lg` : `0 8px 20px rgba(90, 80, 140, 0.24)`
- Boutons pleins : ombre de LEUR couleur à ~45 % (ex. `0 5px 14px rgba(139,124,240,0.45)`)

## 3. Typographie

Deux fontes auto-hébergées, aucune autre :
- **Fredoka** (400-700) : titres, boutons, labels, tout ce qui est « voix de l'app »
- **Andika** (400/700) : corps de texte, descriptions, dates

Tailles TOUJOURS en `clamp()` pour le responsive :
- Titre de page : `clamp(1.55rem, 6.5vw, 2.1rem)` (`.section-title`)
- Titre écran scan/livre : `clamp(1.5rem, 5.6vw, 1.9-2rem)`
- Sous-titre : `clamp(0.95rem, 3.4vw, 1.15-1.2rem)`, Fredoka 600, `line-height: 1.4`
- Bouton : `1.05rem` Fredoka 600 ; petit label : `0.92-0.98rem`
- `letter-spacing: 2px` sur les grands titres, `0.5px` sur h1-h3

## 4. Titres de page — UN SEUL pattern

Tout écran de premier niveau utilise **`.section-title`** : Fredoka 700 violet `#7a52c7`,
centré, MAJUSCULES, encadré des deux ✦ (`::before`/`::after`, rose `#ff8fae`, rotation
±12°). Variante `--other` : ✦ bleu ciel. Marges : `22px 0 18px`.
Sous-titre centré en dessous : Fredoka 600, `--ink`, 1-2 lignes max.

Écrans secondaires (livre, étapes scan) : `.book-title` / `.scan-header-title` — même
squelette (Fredoka 700, ✦ de part et d'autre) en couleur `--ink`.

**Interdit** : créer un nouveau style de titre, un titre aligné à gauche, un titre sans ✦.

## 5. Surfaces (cartes, panneaux, popups)

- Carte standard : **`.soft-card`** — blanc, `border-radius: 24px`, ombre
  `0 8px 24px rgba(90,80,140,0.16)`, AUCUNE bordure.
- Variante : `.paper-card` (radius 24, `--sticker-shadow-lg`).
- Image/photo/caméra encadrée : bordure **blanche épaisse 6px** + radius 20-22 + ombre
  (pattern « polaroïd » : `.book-card`, `.camera-square`, `.book-cover-hero`).
- Zone d'ajout / vide : bordure **pointillée** `4px dashed #c9bdf2` sur blanc translucide.
- Radius : 24px cartes, 22px cartes internes, 12-14px éléments imbriqués (vignettes,
  items de menu), `999px` pour tout ce qui est pilule. Jamais moins de 12px.

## 6. Boutons

Base : **pilule** (`border-radius: 999px`), Fredoka 600, `padding: 0.7em 1.5em` (ou
`12px 28px`), sans bordure, ombre sticker. Couleur PAR FONCTION :

| Fonction | Fond | Texte |
|---|---|---|
| Action principale / scan | `--accent-violet` | blanc |
| Validation / « c'est parti » | `--accent-mint` | blanc |
| Photo / flash actif | `--accent-sun` | `#7a5b00` |
| Annuler / danger doux | blanc | `--accent-rose` |
| Neutre / secondaire | blanc | `--accent-violet` |

États : `:active` → `scale(0.96)` + ombre réduite ; `:hover` (desktop) →
`translateY(-1px)` + ombre lg ; `:disabled` → `opacity: 0.55`.
Boutons ronds icône : cercle blanc (icône violette) ou cercle violet (icône blanche),
52-56px, ombre sticker — cf. `.shell-menu-btn`, `.book-dl-circle`, `.colo-card-badge`.
Lien discret (ex. « retirer le livre ») : texte Fredoka rose souligné, sans fond.
Bouton retour : `.book-home-btn` (pilule blanche « ← Retour », texte violet) ou
`.scan-back-bar` (barre pleine largeur) — ne pas en inventer un troisième.

## 7. Layout & espacements

- Page : `padding` horizontal **16-18px**, contenu centré `max-width` 560px (formulaires,
  scan) à 680-760px (grilles), `margin: 0 auto`.
- Haut de page : TOUJOURS `calc(Npx + env(safe-area-inset-top))` (64px pages scan,
  20px accueil). Bas : réserver la tabbar → le shell pose déjà
  `padding-bottom: calc(112px + env(safe-area-inset-bottom))` ; pages longues : ~120px.
- Gaps : 16px entre cartes (`gap: 14-16px` grilles), 12px entre éléments proches,
  22px entre groupes. Grilles : 2 colonnes mobile, 3 à partir de 700px.
- Les écrans caméra/scan partagent `--scan-square` (taille unique du carré).

## 8. Décorations & motifs signature

- ✦ étincelles rotées ±12° autour des titres (rose/ciel/soleil).
- Effet sticker sur texte hero : `text-shadow` contour blanc 8 directions + ombre douce
  (cf. `.wordmark` — dont les lettres alternent rose/mint/violet/soleil/rouge).
- Vague SVG lavande au-dessus de la tabbar ; bouton SCANNER central : grand cercle
  blanc surélevé avec anneau lavande.
- Fond illustré prairie (`bg-meadow.webp`) posé par le shell — les pages restent
  transparentes dessus.
- Pointillés décoratifs : `dashed` lavande (séparateurs de menu : `2px dashed`).

## 9. Micro-interactions & mouvement

- Transitions courtes : `0.1-0.12s ease` (transform/shadow). Rien au-delà de 0.5s
  hors animations d'apparition.
- Appui tactile = retour visuel `scale(0.94-0.98)` sur TOUT élément cliquable.
- Apparitions : fade + `translateY(8px)`, 0.5s, délais en cascade (cf. boot).
- Toujours prévoir `@media (prefers-reduced-motion: reduce)`.
- Ne jamais dépendre du hover (mobile first) : le hover est un bonus desktop.

## 10. Ton rédactionnel

Français, **tutoiement enfant**, phrases courtes et positives (« Retrouve tous tes
coloriages qui ont pris vie ! », « Que veux-tu faire ? »). Exclamations bienvenues,
jargon technique interdit à l'écran. Textes passant par `i18n.tsx` quand la page
est déjà internationalisée.

## 11. Pièges iOS connus (ne pas « corriger » ces choix)

- PAS de `background-attachment: fixed` (casse la compo GPU → `<video>` blanches).
- PAS de `filter` sur la vague de la tabbar (seam de couleur).
- Ne pas clipper une `<video>` via conteneur `overflow: hidden` + radius (vidéo
  blanche) : arrondir la vidéo elle-même.
- `z-index` explicites autour de la tabbar (les drop-shadows SVG créent des contextes
  d'empilement).

## 12. Checklist avant d'ajouter un écran / composant

1. Un pattern existant couvre-t-il le besoin ? → réutiliser la classe telle quelle.
2. Sinon, composer avec les tokens (couleurs, ombres, radius, fontes) — zéro valeur
   inventée, zéro style inline.
3. Sélecteurs scopés `body.play-app`, dans `play-theme.css`, dans la section du
   fichier correspondant à l'écran.
4. Titre au bon pattern (§4), boutons à la bonne couleur fonctionnelle (§6).
5. Safe areas haut/bas + place pour la tabbar (§7).
6. Retour visuel `:active` + reduced-motion (§9).
7. Vérifier le rendu aux deux extrêmes du `clamp()` (petit iPhone / grand écran).

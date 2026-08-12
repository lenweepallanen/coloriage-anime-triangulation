# PicoPop — TODO avant soumission App Store + Google Play

_Catégorie **générale** (pas « Enfants »). Éditeur affiché visé : **2RK**._
_Dernière mise à jour : 2026-08-11._

---

## ✅ Déjà fait
- [x] TUTO + À PROPOS remplis (FR/EN), éditeur **2RK**, version 1.0.0, contact **hello@picopop.app**, lien confidentialité
- [x] Vie privée : le scan **ne quitte plus l'appareil** ; capture caméra grisée sans les 4 repères ; **import d'image avec détection des repères** (refus si aucun)
- [x] `PrivacyInfo.xcprivacy` (créé + référencé dans le projet Xcode)
- [x] Versionnage 1.0.0 (package / iOS `MARKETING_VERSION` / Android `versionName`)
- [x] `index.html` title « Picopop » + `manifest.webmanifest` corrigé
- [x] Règles Firebase `scans/*` durcies + **déployées** (Firestore + Storage)
- [x] Android `allowBackup=false`, `console.log` retirés du build play, 92 doublons « … 2 » supprimés
- [x] Langue par défaut = langue de l'appareil (EN si non-français) → réviseur EN auto
- [x] **Testabilité réviseur** : livre **TEST BOOK (REVIEW)** publié + **non listé** (flag `unlisted`) + coloriage **TEST COLORING (REVIEW) - T REX**
- [x] **Guide réviseur** : PDF (`~/Downloads/PicoPop-App-Review-Guide.pdf`) + page **https://picopop.app/review** (QR + image test téléchargeable)
- [x] Politique de confidentialité à jour + en ligne : **https://picopop.app/confidentialite**
- [x] Comptes **Apple Developer** + **Google Play** créés

---

## ✅ FAIT — Migration Firebase perso → 2RK (`picopop-app`)
_Projet 2RK : **`picopop-app`** (compte `2rkpublishing@gmail.com`), base Firestore **`coloriages`**._
- [x] Firestore/Storage/Auth (Email/Password) créés ; app Web enregistrée ; config dans `firebase.ts`
- [x] **Données migrées** : Firestore `projects` (49) + `books` (4) ; **Storage** 1434 objets (~3,1 Go), 0 échec. Ignorés : `scans`/`auditLog`/`loginHistory`/`admins`.
- [x] **Règles + index** déployés sur `picopop-app` ; `.firebaserc` → `picopop-app`
- [x] **Compte admin** recréé (`admins/{uid}` pour `lenweepallanen@gmail.com`) ; testé admin + iPhone
- [x] **Cloud Functions** LaMa + SAM2 redéployées sous `picopop-app` (URLs `…-vasshazrla-ew.a.run.app`, publiques, HTTP 200)
- [ ] _(quand tout est validé)_ supprimer l'ancien projet `coloriage-anime-prod` + révoquer les clés de service + retirer l'accès Éditeur/Owner de `nicolas.rocher38@gmail.com`

---

## 🟢 Faisable MAINTENANT (sans Firebase)

**Code — 2 correctifs Info.plist (Claude, rapide)**
- [x] `ITSAppUsesNonExemptEncryption = false` (évite la question export à chaque envoi)
- [x] `NSPhotoLibraryUsageDescription` (l'import ouvre la photothèque) — _`NSCameraUsageDescription` + Motion déjà présents_

**Assets (Nicolas)**
- [ ] **Captures d'écran** : iPhone 6.7″ + 6.5″, Android téléphone + tablette (accueil, film animé, galerie, partage)
- [ ] Vérifier l'**icône 1024px** dans le catalogue d'assets
- [ ] **hello@picopop.app** : boîte mail active

**Textes de fiche (Claude peut rédiger)**
- [x] Nom, sous-titre, description, mots-clés, texte promo (FR + EN) → `store-listing.md`

---

## 📤 Remplir les consoles (après migration + build)

**App Store Connect (Apple)**
- [ ] Créer la fiche *Picopop* — catégorie **Divertissement**, **PAS** « Made for Kids »
- [ ] Métadonnées + URLs (support `picopop.app`, confidentialité `picopop.app/confidentialite`)
- [ ] **App Privacy** = « aucune donnée collectée »
- [ ] **Classification d'âge** 4+
- [ ] **App Review Information** : coller les notes + **joindre le PDF**
- [ ] Sélectionner la build → **Submit for Review**

**Google Play Console**
- [ ] Créer l'app + fiche (mêmes textes/visuels)
- [ ] **Data safety** = aucune donnée collectée · **Content rating** (IARC) · **Target audience = adultes**
- [ ] URL confidentialité + **instructions de test = lien `picopop.app/review`**
- [ ] Upload **AAB signé** → envoyer en review

---

## 📎 Références utiles
- Guide réviseur (source) : `review-assets/` · PDF : `~/Downloads/PicoPop-App-Review-Guide.pdf`
- **Règle de re-review** : nouveau **binaire** app = review ; **contenu servi par Firebase** (animations via admin) = **pas** de review ; **admin panel** (app web séparée) = **jamais** de review.
- **Déploiement site** `picopop.app` : `npx vercel --prod` (CLI), **pas** git push. Les apps admin/play s'auto-déploient depuis `main`.

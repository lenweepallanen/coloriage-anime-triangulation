/**
 * i18n minimal pour les COMPOSANTS PARTAGÉS rendus dans l'app play (ScanPage,
 * CameraView, ScenePlayer…). L'i18n React de apps/play ne leur est pas
 * accessible : on lit la même langue persistée (localStorage 'picopop-lang')
 * avec un petit dictionnaire local. Défaut FR — l'admin (pas de clé stockée)
 * reste donc en français, inchangé.
 */

type PlayLang = 'fr' | 'en'

const DICT: Record<PlayLang, Record<string, string>> = {
  fr: {
    'scan.back': 'Retour',
    'scan.title.scanning': 'Scan en cours…',
    'scan.title.ready': 'Prêt à scanner !',
    'scan.title.success': 'Scan réussi !',
    'scan.sub.keepFrame': 'Garde ton coloriage bien dans le cadre.',
    'scan.sub.ready': 'Ton coloriage est prêt à prendre vie ✨',
    'scan.progress': 'Tiens bon ! On détecte les couleurs et les formes de ton coloriage…',
    'scan.error': 'Oups, ça n’a pas marché.',
    'scan.retry': 'Réessayer',
    'scan.notReady': 'Ce coloriage n’est pas encore prêt. Reviens bientôt !',
    'scan.loading': 'Cela peut prendre quelques instants…',
    'validate.q': 'Ton coloriage a bien été reconnu. Veux-tu le voir s’animer ?',
    'validate.see': 'Voir l’animation',
    'validate.retry': 'Recommencer',
    'validate.loading': 'Chargement…',
    'rotate.title': 'Tourne ton téléphone !',
    'rotate.sub': 'Ton coloriage s’anime en mode paysage.',
    'pause.title': 'Pause',
    'pause.continue': 'Continuer',
    'pause.backColorings': 'Revenir aux coloriages',
    'pause.quit': 'Quitter',
    'film.bravo': 'Bravo !',
    'film.subtitle': 'Ton coloriage prend vie !',
    'film.replaceQ': 'Remplacer la vidéo précédente ?',
    'film.replaceYes': 'Oui, remplacer',
    'film.replaceNo': 'Non, garder l’ancienne',
    'film.replay': 'Revoir',
    'film.share': 'Partager la vidéo',
    'film.back': 'Retour',
    'camera.open': 'Ouvrir la caméra',
    'camera.import': 'Importer une image',
    'camera.capture': 'Capturer',
    'camera.aimMarkers': 'Vise les 4 repères',
    'camera.holdFlat': 'Tiens le téléphone bien à plat',
    'camera.needMarkers': "On ne reconnaît pas de coloriage. Vise bien les 4 repères aux coins de la page.",
    'camera.cancel': 'Annuler',
    'camera.idle.text': 'Nous ouvrons la caméra\npour scanner ton coloriage.',
    'camera.idle.sub': 'Assure-toi que ton coloriage est bien à plat et entièrement visible.',
    'camera.tip.title': 'Conseil',
    'camera.tip.text': 'Bonne lumière et plan stable pour un meilleur résultat !',
    'camera.status.loading': 'Préparation de la caméra…',
    'camera.status.ready': '✓ Prêt — appuie pour prendre la photo !',
    'camera.status.corners': 'coins trouvés…',
    'camera.status.cornersOk': 'Coins OK',
    'camera.status.align': 'Aligne les coins du coloriage avec les guides',
    'camera.error': 'La caméra ne veut pas s’ouvrir. Autorise la caméra dans les réglages !',
    'camera.issue.tooDark': 'Il fait un peu sombre — ajoute de la lumière !',
    'camera.issue.tooBright': 'Trop de lumière — éloigne un peu la lampe',
    'camera.issue.glare': 'Il y a un reflet — penche un peu le téléphone',
    'camera.issue.blurry': 'C’est flou — ne bouge plus !',
    'camera.issue.lowContrast': 'On voit mal les coins — ajoute de la lumière',
  },
  en: {
    'scan.back': 'Back',
    'scan.title.scanning': 'Scanning…',
    'scan.title.ready': 'Ready to scan!',
    'scan.title.success': 'Scan successful!',
    'scan.sub.keepFrame': 'Keep your coloring inside the frame.',
    'scan.sub.ready': 'Your coloring is ready to come to life ✨',
    'scan.progress': 'Hold on! We are detecting the colors and shapes of your coloring…',
    'scan.error': 'Oops, that didn’t work.',
    'scan.retry': 'Try again',
    'scan.notReady': 'This coloring is not ready yet. Come back soon!',
    'scan.loading': 'This can take a few moments…',
    'validate.q': 'Your coloring was recognized. Do you want to see it come to life?',
    'validate.see': 'See the animation',
    'validate.retry': 'Start over',
    'validate.loading': 'Loading…',
    'rotate.title': 'Turn your phone!',
    'rotate.sub': 'Your coloring comes to life in landscape.',
    'pause.title': 'Pause',
    'pause.continue': 'Continue',
    'pause.backColorings': 'Back to the colorings',
    'pause.quit': 'Quit',
    'film.bravo': 'Well done!',
    'film.subtitle': 'Your coloring comes to life!',
    'film.replaceQ': 'Replace the previous video?',
    'film.replaceYes': 'Yes, replace it',
    'film.replaceNo': 'No, keep the old one',
    'film.replay': 'Watch again',
    'film.share': 'Share the video',
    'film.back': 'Back',
    'camera.open': 'Open the camera',
    'camera.import': 'Import a picture',
    'camera.capture': 'Capture',
    'camera.aimMarkers': 'Aim at the 4 markers',
    'camera.holdFlat': 'Hold the phone flat',
    'camera.needMarkers': "We can't recognize a coloring page. Line up the 4 corner markers.",
    'camera.cancel': 'Cancel',
    'camera.idle.text': 'We are opening the camera\nto scan your coloring.',
    'camera.idle.sub': 'Make sure your coloring is flat and fully visible.',
    'camera.tip.title': 'Tip',
    'camera.tip.text': 'Good light and a steady hand for the best result!',
    'camera.status.loading': 'Getting the camera ready…',
    'camera.status.ready': '✓ Ready — tap to take the photo!',
    'camera.status.corners': 'corners found…',
    'camera.status.cornersOk': 'Corners OK',
    'camera.status.align': 'Line up the corners of your coloring with the guides',
    'camera.error': 'The camera won’t open. Allow the camera in your settings!',
    'camera.issue.tooDark': 'It’s a bit dark — add some light!',
    'camera.issue.tooBright': 'Too much light — move the lamp away a little',
    'camera.issue.glare': 'There’s a glare — tilt your phone a little',
    'camera.issue.blurry': 'It’s blurry — hold still!',
    'camera.issue.lowContrast': 'The corners are hard to see — add some light',
  },
}

function currentLang(): PlayLang {
  try {
    const v = localStorage.getItem('picopop-lang')
    if (v === 'en') return 'en'
    if (v === 'fr') return 'fr'
    // Pas de préférence stockée → langue de l'appareil (français si l'appareil
    // est en français, anglais sinon). Un réviseur sur un appareil anglophone
    // obtient donc l'anglais automatiquement.
    const list = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]) || []
    for (const l of list) if (l && l.toLowerCase().startsWith('fr')) return 'fr'
    return 'en'
  } catch {
    return 'en'
  }
}

/** Traduction d'une chaîne partagée play (fallback : FR, puis la clé). */
export function playT(key: string): string {
  const lang = currentLang()
  return DICT[lang][key] ?? DICT.fr[key] ?? key
}

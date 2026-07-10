import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * i18n minimal FR/EN pour les écrans PLAY (accueil, onglets, menu, pages).
 * Les textes de l'écran scan/animation (@shared) restent en français pour
 * l'instant. Langue persistée dans localStorage('picopop-lang'), défaut FR.
 */

export type Lang = 'fr' | 'en'

const DICT: Record<Lang, Record<string, string>> = {
  fr: {
    'loading': 'Chargement…',
    'tagline.line1': 'Colorie. Scanne.',
    'tagline.line2.pre': 'Ton coloriage ',
    'tagline.line2.hl': 'prend vie',
    'tagline.line2.post': ' !',
    'home.myBooks': 'MES LIVRES',
    'home.otherBooks': 'LES AUTRES LIVRES',
    'home.firstBook': 'Ajoute ton premier livre.',
    'home.download': 'Téléchargement',
    'home.discover': 'Découvrir',
    'home.empty1': 'Aucun livre disponible pour le moment.',
    'home.empty2': 'Reviens bientôt !',
    'home.error1': 'Impossible de charger les livres.',
    'home.error2': 'Vérifie ta connexion internet.',
    'home.retry': 'Réessayer',
    'tabs.home': 'Accueil',
    'tabs.scanner': 'Scanner',
    'tabs.gallery': 'Galerie',
    'menu.tuto': 'Tuto',
    'menu.about': 'À propos',
    'menu.language': 'Langue',
    'scanner.choice.title': 'Que veux-tu faire ?',
    'scanner.choice.book': 'Ajouter un livre',
    'scanner.choice.book.sub': 'Scanne le QR code au début de ton livre',
    'scanner.choice.coloring': 'Scanner un coloriage',
    'scanner.choice.coloring.sub': 'Scanne le QR code à côté de ton coloriage',
    'scanner.camera.book': 'Vise le QR code de ton livre',
    'scanner.camera.coloring': 'Vise le QR code de ton coloriage',
    'scanner.camera.error': "La caméra n'est pas disponible.\nAutorise la caméra dans les réglages.",
    'scanner.unknown': 'QR code non reconnu',
    'scanner.book.notfound': "Ce livre n'est pas disponible.",
    'scanner.book.already': 'Livre déjà ajouté !',
    'scanner.book.adding': 'Ajout du livre…',
    'scanner.back': 'Retour',
    'gallery.soon.title': 'Galerie',
    'gallery.soon.text': 'Tes vidéos apparaîtront ici bientôt !',
    'tuto.title': 'Tuto',
    'tuto.text': 'Le tutoriel arrive bientôt !',
    'about.title': 'À propos',
    'about.text': 'Picopop — les cahiers de coloriage animés.\nColorie. Scanne. Ton coloriage prend vie !',
    'book.back': 'Tous les livres',
    'book.subtitle': "Clique sur l'un des coloriages pour le scanner et le voir s'animer !",
    'book.empty': 'Aucun coloriage disponible dans ce livre pour le moment.',
    'book.unavailable.title': 'Livre indisponible',
    'book.unavailable.text': "Ce livre n'existe pas ou n'est pas publié.",
    'book.collection': 'Dans la même collection',
    'book.bonus': 'TÉLÉCHARGER BONUS',
  },
  en: {
    'loading': 'Loading…',
    'tagline.line1': 'Color. Scan.',
    'tagline.line2.pre': 'Your coloring ',
    'tagline.line2.hl': 'comes to life',
    'tagline.line2.post': '!',
    'home.myBooks': 'MY BOOKS',
    'home.otherBooks': 'MORE BOOKS',
    'home.firstBook': 'Add your first book.',
    'home.download': 'Download',
    'home.discover': 'Discover',
    'home.empty1': 'No books available yet.',
    'home.empty2': 'Come back soon!',
    'home.error1': 'Could not load the books.',
    'home.error2': 'Check your internet connection.',
    'home.retry': 'Retry',
    'tabs.home': 'Home',
    'tabs.scanner': 'Scan',
    'tabs.gallery': 'Gallery',
    'menu.tuto': 'Tutorial',
    'menu.about': 'About',
    'menu.language': 'Language',
    'scanner.choice.title': 'What do you want to do?',
    'scanner.choice.book': 'Add a book',
    'scanner.choice.book.sub': 'Scan the QR code at the start of your book',
    'scanner.choice.coloring': 'Scan a coloring page',
    'scanner.choice.coloring.sub': 'Scan the QR code next to your coloring page',
    'scanner.camera.book': 'Point at your book QR code',
    'scanner.camera.coloring': 'Point at your coloring page QR code',
    'scanner.camera.error': 'Camera is not available.\nAllow camera access in settings.',
    'scanner.unknown': 'QR code not recognized',
    'scanner.book.notfound': 'This book is not available.',
    'scanner.book.already': 'Book already added!',
    'scanner.book.adding': 'Adding book…',
    'scanner.back': 'Back',
    'gallery.soon.title': 'Gallery',
    'gallery.soon.text': 'Your videos will appear here soon!',
    'tuto.title': 'Tutorial',
    'tuto.text': 'The tutorial is coming soon!',
    'about.title': 'About',
    'about.text': 'Picopop — animated coloring books.\nColor. Scan. Your coloring comes to life!',
    'book.back': 'All books',
    'book.subtitle': 'Tap one of the coloring pages to scan it and watch it come alive!',
    'book.empty': 'No coloring pages available in this book yet.',
    'book.unavailable.title': 'Book unavailable',
    'book.unavailable.text': 'This book does not exist or is not published.',
    'book.collection': 'From the same collection',
    'book.bonus': 'DOWNLOAD BONUS',
  },
}

interface I18nValue {
  lang: Lang
  setLang: (l: Lang) => void
  t: (key: string) => string
}

const I18nContext = createContext<I18nValue>({
  lang: 'fr',
  setLang: () => {},
  t: k => DICT.fr[k] ?? k,
})

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const v = localStorage.getItem('picopop-lang')
      if (v === 'fr' || v === 'en') return v
    } catch { /* stockage indisponible */ }
    return 'fr'
  })

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try { localStorage.setItem('picopop-lang', l) } catch { /* best-effort */ }
  }, [])

  const t = useCallback((key: string) => DICT[lang][key] ?? DICT.fr[key] ?? key, [lang])

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useI18n(): I18nValue {
  return useContext(I18nContext)
}

import { useEffect, useRef, useState } from 'react'
import { subscribeGaze } from './mascotGaze'
import './mascot.css'

/**
 * Mascotte PicoPop — l'étoile kawaii du logo, redessinée en SVG et animée.
 * UNE seule mascotte visible par écran (règle charte). Remplace partout le PNG
 * du logo, le caractère ⭐ et les emojis d'état.
 *
 * - `mood`   : expression (bouche/pommettes/paupières)
 * - `gaze`   : 'pointer' = les yeux suivent le doigt/scroll (moteur partagé rAF),
 *              'ring' = regard circulaire synchronisé sur l'anneau de chargement,
 *              'scan' = balayage gauche-droite (recherche), 'none' = regard fixe
 * - `halo`   : petits confettis du logo autour de l'étoile (pop à l'apparition)
 * - Tap sur la mascotte : petit bond joyeux (easter egg)
 * - `prefers-reduced-motion` : toutes les animations sont coupées (CSS)
 */
export interface MascotProps {
  size?: number
  mood?: 'normal' | 'happy' | 'excited' | 'sleepy' | 'oops'
  gaze?: 'pointer' | 'ring' | 'scan' | 'none'
  animated?: boolean
  halo?: boolean
  className?: string
}

/** Silhouette EXACTE de l'étoile du logo (vectorisée depuis picopop-logo.png,
 *  coords pixels de l'image source — rendue via un groupe translate+scale). */
const BODY_PATH =
  'M 619 87.583 C 558.465 98.433, 522.341 149.812, 459.847 313.947 C 448.378 344.068, 444.672 350.261, 434.655 356.044 C 424.982 361.627, 424.708 361.671, 369.500 366.510 C 191.707 382.094, 125.739 409.106, 119.196 469 C 115.262 505.013, 136.158 543.318, 187.943 595.021 C 209.194 616.239, 221.075 626.906, 266.400 665.470 C 306.002 699.164, 306.734 702.573, 289.380 772.500 C 259.422 893.216, 258.639 955.038, 286.522 998.140 C 325.639 1058.609, 405.836 1048.104, 542 964.674 C 596.479 931.294, 601.461 928.754, 617.803 926.022 C 641.117 922.125, 652.658 926.458, 705.427 958.924 C 796.184 1014.762, 848.519 1036.023, 895.128 1035.992 C 964.503 1035.946, 998.602 980.162, 988.952 882.500 C 985.939 852.005, 980.010 822.029, 966.032 766.628 C 949.544 701.275, 950.361 698.539, 998.500 657.979 C 1111.583 562.700, 1148.161 508.344, 1133.879 456.805 C 1119.154 403.668, 1056.482 381.914, 869.499 365.033 C 815.674 360.174, 813.851 358.937, 798.010 316.533 C 741.393 164.975, 702.630 105.635, 650.348 90.484 C 641.906 88.037, 625.128 86.485, 619 87.583'
/** Transform image source (1254 px) → viewBox 120 (étoile ~100 unités de haut, centrée). */
const BODY_SCALE = 0.0949
const BODY_TX = 0.5
const BODY_TY = 2.7

/* Confettis du logo : petits bâtonnets colorés autour de l'étoile. */
const HALO_STICKS: Array<{ x: number; y: number; r: number; c: string }> = [
  { x: 24, y: 16, r: -40, c: '#35c3df' },
  { x: 96, y: 13, r: 35, c: '#f66' },
  { x: 9, y: 58, r: -15, c: '#a78bfa' },
  { x: 111, y: 52, r: 20, c: '#57c8a3' },
  { x: 20, y: 96, r: 30, c: '#ff9b3d' },
  { x: 62, y: 108, r: 0, c: '#5b9df0' },
  { x: 102, y: 94, r: -30, c: '#ff8ac4' },
]

export default function Mascot({
  size = 64,
  mood = 'normal',
  gaze = 'none',
  animated = true,
  halo = false,
  className,
}: MascotProps) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const [cheer, setCheer] = useState(false)
  // Délai de clignement aléatoire par instance (désynchronise plusieurs mascottes
  // au fil de la session — une seule étant visible par écran).
  const [blinkDelay] = useState(() => `${(Math.random() * 3.5).toFixed(2)}s`)

  useEffect(() => {
    if (!animated || gaze !== 'pointer' || !rootRef.current) return
    return subscribeGaze(rootRef.current)
  }, [animated, gaze])

  const cheerTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(cheerTimer.current), [])
  const handleTap = () => {
    if (!animated) return
    setCheer(true)
    window.clearTimeout(cheerTimer.current)
    cheerTimer.current = window.setTimeout(() => setCheer(false), 750)
  }

  const classes = [
    'pp-mascot',
    `pp-mascot--${mood}`,
    animated ? 'pp-mascot--animated' : '',
    animated && gaze === 'ring' ? 'pp-mascot--gaze-ring' : '',
    animated && gaze === 'scan' ? 'pp-mascot--gaze-scan' : '',
    cheer ? 'pp-mascot--cheer' : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  return (
    <span
      ref={rootRef}
      className={classes}
      style={{ width: size, height: size, ['--pp-blink-delay' as string]: blinkDelay }}
      onPointerDown={handleTap}
      aria-hidden="true"
    >
      <svg viewBox="0 0 120 120" width={size} height={size}>
        {halo && (
          <g className="pp-mascot-halo">
            {HALO_STICKS.map((s, i) => (
              <rect
                key={i}
                className="pp-mascot-halo-stick"
                x={s.x - 2.4}
                y={s.y - 6.5}
                width="4.8"
                height="13"
                rx="2.4"
                fill={s.c}
                transform={`rotate(${s.r} ${s.x} ${s.y})`}
                style={{ ['--pp-halo-i' as string]: String(i) }}
              />
            ))}
          </g>
        )}
        <g className="pp-mascot-breath">
          {/* Corps = silhouette exacte du logo ; contour sticker par stroke blanc */}
          <g transform={`translate(${BODY_TX} ${BODY_TY}) scale(${BODY_SCALE})`}>
            <path d={BODY_PATH} fill="#ffffff" stroke="#ffffff" strokeWidth="84" strokeLinejoin="round" />
            <path d={BODY_PATH} fill="#ffc738" />
          </g>

          <g className="pp-mascot-face">
            {/* Pommettes (positions/tailles mesurées sur le logo) */}
            <ellipse className="pp-mascot-cheek" cx="40.4" cy="67.2" rx="4.6" ry="4" fill="#f8756c" />
            <ellipse className="pp-mascot-cheek" cx="79.8" cy="67.2" rx="4.6" ry="4" fill="#f8756c" />

            {/* Yeux : l'ensemble suit légèrement le regard, et la pupille
                blanche bouge EN PLUS à l'intérieur de l'ellipse noire (c'est
                elle qui porte la direction du regard). Clignement : scaleY. */}
            <g className="pp-mascot-gaze">
              <g className="pp-mascot-eye">
                <ellipse cx="45.2" cy="57" rx="3.5" ry="4.65" fill="#38281c" />
                <circle className="pp-mascot-pupil" cx="44.5" cy="55.8" r="1.25" fill="#ffffff" />
              </g>
              <g className="pp-mascot-eye">
                <ellipse cx="75" cy="57" rx="3.5" ry="4.65" fill="#38281c" />
                <circle className="pp-mascot-pupil" cx="74.3" cy="55.8" r="1.25" fill="#ffffff" />
              </g>
            </g>

            {/* Bouche FIXE (ne suit pas le regard), selon l'humeur */}
            {mood === 'oops' ? (
              <ellipse cx="60.1" cy="68" rx="2.5" ry="3.2" fill="#38281c" />
            ) : mood === 'sleepy' ? (
              <path d="M53.8 65.4 Q60.1 67.9 66.4 65.4" fill="none" stroke="#38281c" strokeWidth="2.5" strokeLinecap="round" />
            ) : mood === 'happy' || mood === 'excited' ? (
              <path d="M52.3 63.9 Q60.1 72.4 67.9 63.9" fill="none" stroke="#38281c" strokeWidth="2.6" strokeLinecap="round" />
            ) : (
              <path d="M53.3 64.4 Q60.1 70.4 66.9 64.4" fill="none" stroke="#38281c" strokeWidth="2.5" strokeLinecap="round" />
            )}
          </g>
        </g>
      </svg>
    </span>
  )
}

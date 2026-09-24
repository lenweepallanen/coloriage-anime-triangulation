#!/usr/bin/env python3
"""Génère les vidéos de décor d'un film PicoPop avec xAI grok-imagine-video-1.5 (image-to-video).
Bibliothèque standard uniquement (urllib).

Usage : python3 gen_videos.py <dossier_sortie> [plans=P1,P3] [res=720p] [model=grok-imagine-video-1.5]
Clé lue dans ~/.picopop-keys.env (XAI_API_KEY).
Chaque plan = (image de départ JPEG, durée s, prompt de mouvement). Sorties : <dossier_sortie>/<plan>.mp4 + .json"""
import base64, json, os, sys, time, urllib.request, urllib.error, concurrent.futures as cf

OUT = sys.argv[1]
opts = dict(a.split('=', 1) for a in sys.argv[2:] if '=' in a)
ONLY = set(opts['plans'].split(',')) if 'plans' in opts else None
RES = opts.get('res', '720p')
MODEL = opts.get('model', 'grok-imagine-video-1.5')
IMG_DIR = opts.get('images', os.path.join(OUT, 'start-frames'))

keys = {}
for line in open(os.path.expanduser('~/.picopop-keys.env')):
    if '=' in line:
        k, v = line.strip().split('=', 1); keys[k] = v
HDR = {'Authorization': 'Bearer ' + keys['XAI_API_KEY'], 'Content-Type': 'application/json'}

STYLE = ("Keep exactly the look of the starting image for the whole clip: children's colored-pencil and wax-crayon "
         "illustration, visible crayon strokes, bold black outlines, bright saturated colors, simple shapes. "
         "No style drift, no photorealism, no text, no watermark. Static camera unless stated otherwise. "
         "The center of the frame must stay free of any new large creature (a character will be composited there).")

# Film Plesiosaurus — prompts de mouvement du script (docs/films/plesiosaurus-script.md)
PLANS = {
    'P1_coral_reef': (12,
        "Soft light shimmers, sea fans and small corals sway slightly, the schools of reef fish drift slowly, the "
        "ammonite drifts a little to the left, the two ichthyosaurs in the far background glide slowly from right to "
        "left across the whole clip. Calm, gentle, loopable."),
    'P2_open_deep_ocean': (14,
        "Marine snow drifts slowly downward, a few bubbles rise. From 1 s to 6 s the large ichthyosaur silhouette on "
        "the left glides slowly further left and fades into the distance; from 4 s to 9 s the giant ray-like silhouette "
        "drifts slowly to the right lower down; the school of silver fish shimmers. At 10 s a large mosasaur (realistic "
        "prehistoric marine reptile, dark grey-blue, big head, open jaws, dazed surprised expression rather than "
        "menacing, drawn in the same crayon style) enters from the right edge and grows until its head fills the right "
        "half of the frame at 12 s, then stays there with its mouth open until the end."),
    'P3_rock_tunnel': (10,
        "TRAVELLING shot: the camera travels steadily to the right through the tunnel, so the whole rock ceiling, floor "
        "and boulders scroll continuously from right to left at a constant speed for the entire clip, the tunnel going "
        "on endlessly. At 1 s a large mosasaur (realistic, dark grey-blue, open jaws, not menacing, same crayon style) "
        "enters from the left edge and swims along at the same speed in the lower-left part of the frame, snapping its "
        "jaws shut at 3 s and at 5 s. At 6.5 s a thick rock pillar scrolls in from the right; at 7 s the mosasaur bumps "
        "its snout into it, stops dazed with a cloud of bubbles, and is carried out of the frame on the left by the "
        "scrolling. Bubbles and small fish stream past."),
    # v2 de la pleine eau : même mise en scène, mais le monstre = le mosasaure « crocodile préhistorique » du
    # tunnel v3 (cohérence entre les plans 2 et 3), et non le mosasaure « ahuri » de la v1.
    'P2_open_deep_ocean_v2': (14,
        "Marine snow drifts slowly downward, a few bubbles rise. From 1 s to 6 s the large ichthyosaur silhouette on "
        "the left glides slowly further left and fades into the distance; from 4 s to 9 s the giant ray-like silhouette "
        "drifts slowly to the right lower down; the school of silver fish shimmers. At 10 s a big prehistoric MARINE "
        "REPTILE, a mosasaur (NOT a shark: long crocodile-like head with a wide mouth full of long pointed teeth, small "
        "dark eyes, four paddle-shaped flippers, long thick tail, scaly dark blue-grey skin with a paler belly, no "
        "dorsal fin), drawn in the same crayon style, enters from the right edge seen from three-quarter front with "
        "its jaws open, and grows until its head fills the right half of the frame at 12 s, then stays there showing "
        "its teeth until the end. The left half of the frame stays free of creatures from 10 s on.", 'P2_open_deep_ocean'),
    # v2 du tunnel (retours Nicolas) : prédateur plus effrayant (requin préhistorique, gueule pleine de dents, vu de
    # 3/4 face), cantonné au TIERS GAUCHE (le héros sera composité à droite), et une SORTIE : un trou dans la roche
    # qui arrive de la droite à 7 s pour que le héros se faufile.
    'P3_rock_tunnel_v2': (10,
        "TRAVELLING shot: the camera travels steadily to the right through the tunnel, so the whole rock ceiling, floor "
        "and boulders scroll continuously from right to left at a constant speed for the entire clip, the tunnel going "
        "on endlessly. At 1 s a big scary prehistoric shark-like sea predator (huge head seen from three-quarter front, "
        "wide open mouth full of long white pointed teeth, dark blue-grey skin, small black eyes, drawn in the same "
        "crayon style) enters from the left edge and chases along in the LEFT THIRD of the frame only, never crossing "
        "the center of the frame, snapping its jaws shut at 3 s and at 5 s. At 6.5 s a rock pillar scrolls in from the "
        "right; at 7 s the predator bumps its snout into it, stops dazed with a cloud of bubbles, and is carried out of "
        "the frame on the left by the scrolling. From 7 s to 10 s a small round opening in the rock wall on the right "
        "side of the frame, with light shining through it, scrolls in from the right and stays visible in the right "
        "third until the end: an escape hole just big enough for a small creature. The center and right of the frame "
        "stay free of creatures.", 'P3_rock_tunnel'),
    # v3 du tunnel : même mise en scène que v2, mais le prédateur est un REPTILE MARIN PRÉHISTORIQUE (mosasaure /
    # pliosaure, réf. CleanShot 15.30) et non un requin : longue tête de crocodile, gueule pleine de dents, 4 nageoires
    # en pagaie, longue queue, peau écailleuse bleu-gris, pas d'aileron dorsal ni de queue de requin.
    'P3_rock_tunnel_v3': (10,
        "TRAVELLING shot: the camera travels steadily to the right through the tunnel, so the whole rock ceiling, floor "
        "and boulders scroll continuously from right to left at a constant speed for the entire clip, the tunnel going "
        "on endlessly. At 1 s a big scary prehistoric MARINE REPTILE, a mosasaur (NOT a shark: long crocodile-like head "
        "with a wide mouth full of long pointed teeth, small dark eyes, four paddle-shaped flippers, long thick tail, "
        "scaly dark blue-grey skin with a paler belly, no dorsal fin), drawn in the same crayon style, enters from the "
        "left edge seen from three-quarter front and chases along in the LEFT THIRD of the frame only, never crossing "
        "the center of the frame, snapping its jaws shut at 3 s and at 5 s. At 6.5 s a rock pillar scrolls in from the "
        "right; at 7 s the mosasaur bumps its snout into it, stops dazed with a cloud of bubbles, and is carried out of "
        "the frame on the left by the scrolling. From 7 s to 10 s a small round opening in the rock on the right side of "
        "the frame, with light shining through it, scrolls in from the right and stays visible in the right third until "
        "the end: an escape hole just big enough for a small creature. The center and right of the frame stay free of "
        "creatures.", 'P3_rock_tunnel'),
    # v4 du tunnel : même prédateur que v3 (mosasaure, validé) mais COLLÉ AU BORD GAUCHE, corps partiellement hors
    # champ, museau jamais au-delà du tiers gauche (en v3 il traversait tout le cadre).
    'P3_rock_tunnel_v4': (10,
        "TRAVELLING shot: the camera travels steadily to the right through the tunnel, so the whole rock ceiling, floor "
        "and boulders scroll continuously from right to left at a constant speed for the entire clip, the tunnel going "
        "on endlessly. At 1 s a scary prehistoric MARINE REPTILE, a mosasaur (NOT a shark: crocodile-like head with a "
        "wide mouth full of long pointed teeth, small dark eyes, paddle-shaped flippers, scaly dark blue-grey skin, no "
        "dorsal fin), drawn in the same crayon style, pokes in from the LEFT EDGE of the frame, seen from three-quarter "
        "front: only its head, its front flippers and the front of its body are visible, the rest of its body stays out "
        "of frame on the left. It stays glued to the left edge for the whole chase, its snout NEVER going further right "
        "than one third of the frame width, straining forward and snapping its jaws shut at 3 s and at 5 s but never "
        "catching up. At 6.5 s a rock pillar scrolls in from the right; at 7 s, when the pillar reaches the left third, "
        "the mosasaur bumps its snout into it, stops dazed with a cloud of bubbles and is carried out of the frame on "
        "the left by the scrolling. From 7 s to 10 s a small round opening in the rock on the right side of the frame, "
        "with light shining through it, scrolls in from the right and stays visible in the right third until the end: "
        "an escape hole just big enough for a small creature. The center and right two thirds of the frame stay free of "
        "creatures for the whole clip.", 'P3_rock_tunnel'),
    # v5 du tunnel : NOUVELLE image de départ de Nicolas (mosasaure à DROITE, face à gauche → la poursuite va vers la
    # GAUCHE, le héros composité à gauche). Fin : une petite ouverture dans la roche arrive par la gauche, le monstre
    # s'y cogne le museau (trop gros pour passer), des bulles entrent dans l'ouverture = le héros vient d'y passer.
    # 3 variantes (a : base · b : monstre cantonné au tiers droit + vue de côté stricte · c : 12 s, cognement à 8,5 s).
    'P3_rock_tunnel_v5a': (10,
        "TRAVELLING shot: the camera travels steadily to the LEFT through the tunnel, so the rock ceiling with its "
        "hanging seaweed, the rock floor and the corals scroll continuously from left to right at a constant speed "
        "for the entire clip, the tunnel going on endlessly. The big mosasaur on the right (long crocodile-like head, "
        "teeth, paddle flippers, same crayon style) chases toward the left, swimming hard but staying in the RIGHT "
        "half of the frame, jaws open, snapping them shut at 3 s and at 5 s, never reaching the left part of the "
        "frame; small fish and bubbles stream past. At 6.5 s a rock wall with a SMALL round opening in it (a hole "
        "just big enough for a small creature) scrolls in from the LEFT edge and stops in the left third. At 7 s the "
        "mosasaur lunges forward at the hole and bumps its snout hard against the rock around the opening, far too "
        "big to fit: it stops, dazed, with a big cloud of bubbles. A thin trail of small bubbles streams INTO the "
        "hole, as if a small creature had just slipped through it. From 7.5 s to 10 s the hole stays visible with "
        "bubbles drifting into it while the mosasaur backs off a little, grumpy, still on the right. The left and "
        "center of the frame stay free of creatures until the hole arrives.", 'P3_rock_tunnel_new'),
    'P3_rock_tunnel_v5b': (10,
        "STRICT SIDE VIEW, no perspective change, no camera tilt. TRAVELLING: the camera travels steadily to the LEFT "
        "through the tunnel, so the rock ceiling with hanging seaweed, the rock floor and the corals scroll "
        "continuously from left to right at a constant speed for the whole clip, the tunnel going on endlessly. The "
        "mosasaur (long crocodile-like head, teeth, paddle flippers, same crayon style) stays glued to the RIGHT edge "
        "of the frame, only its head and front flippers in view, its snout never going further left than one third "
        "of the frame width from the right edge; it strains forward, snapping its jaws shut at 3 s and at 5 s; small "
        "fish and bubbles stream past to the right. At 6.5 s a rock wall with a SMALL round opening (a hole just big "
        "enough for a small creature) scrolls in from the LEFT edge and stops in the left third. At 7 s the mosasaur "
        "darts forward and bumps its snout against the rock around the opening, far too big to fit, and stops dazed "
        "with a big cloud of bubbles. A thin trail of small bubbles streams INTO the hole, as if a small creature had "
        "just slipped through it. From 7.5 s to 10 s the hole stays visible with bubbles drifting into it while the "
        "mosasaur backs off, grumpy. Nothing else enters the left and center of the frame.", 'P3_rock_tunnel_new'),
    'P3_rock_tunnel_v5c': (12,
        "TRAVELLING shot: the camera travels steadily to the LEFT through the tunnel, so the rock ceiling with its "
        "hanging seaweed, the rock floor and the corals scroll continuously from left to right at a constant speed, "
        "the tunnel going on endlessly. The big mosasaur on the right (long crocodile-like head, teeth, paddle "
        "flippers, same crayon style) chases toward the left, staying in the RIGHT half of the frame, jaws open, "
        "snapping them shut at 3 s, 5 s and 7 s, never reaching the left part of the frame; small fish and bubbles "
        "stream past. At 8 s a rock wall with a SMALL round opening in it (a hole just big enough for a small "
        "creature) scrolls in from the LEFT edge and stops in the left third. At 8.5 s the mosasaur lunges at the "
        "hole and bumps its snout hard against the rock around the opening, far too big to fit: it stops, dazed, "
        "with a big cloud of bubbles. A thin trail of small bubbles streams INTO the hole, as if a small creature had "
        "just slipped through it. From 9 s to 12 s the hole stays visible with bubbles drifting into it while the "
        "mosasaur shakes its head and backs off, grumpy, still on the right.", 'P3_rock_tunnel_new'),
    # v6 du tunnel : base image « bleu profond » de Nicolas (tunnel_v6_base.png), même mise en scène que v5
    # (poursuite vers la GAUCHE, trou à gauche, cognement, bulles qui entrent dans le trou). 2 variantes.
    'P3_rock_tunnel_v6a': (10,
        "TRAVELLING shot: the camera travels steadily to the LEFT through the deep-blue rock tunnel, so the rock "
        "ceiling with its hanging seaweed, the rock floor and the corals scroll continuously from left to right at a "
        "constant speed for the entire clip, the tunnel going on endlessly, always seen strictly from the side. The "
        "big mosasaur on the right (long crocodile-like head, teeth, paddle flippers, same crayon style) chases toward "
        "the left, swimming hard but staying in the RIGHT half of the frame, jaws open, snapping them shut at 3 s and "
        "at 5 s, never reaching the left part of the frame; the small fish and bubbles stream past to the right. At "
        "6.5 s a rock wall with a SMALL round opening in it (a hole just big enough for a small creature) scrolls in "
        "from the LEFT edge and stops in the left third. At 7 s the mosasaur lunges forward at the hole and bumps its "
        "snout hard against the rock around the opening, far too big to fit: it stops, dazed, with a big cloud of "
        "bubbles. A thin trail of small bubbles streams INTO the hole, as if a small creature had just slipped "
        "through it. From 7.5 s to 10 s the hole stays visible with bubbles drifting into it while the mosasaur backs "
        "off a little, grumpy, still on the right. The left and center of the frame stay free of creatures until the "
        "hole arrives.", 'P3_rock_tunnel_v6'),
    'P3_rock_tunnel_v6b': (10,
        "STRICT SIDE VIEW, no perspective change, no camera tilt, the tunnel never turns into a corridor seen from the "
        "front. TRAVELLING: the camera travels steadily to the LEFT through the deep-blue rock tunnel, so the rock "
        "ceiling with hanging seaweed, the rock floor and the corals scroll continuously from left to right at a "
        "constant speed for the whole clip, the tunnel going on endlessly. The mosasaur (long crocodile-like head, "
        "teeth, paddle flippers, same crayon style) stays glued to the RIGHT edge of the frame, only its head and "
        "front flippers in view, its snout never going further left than one third of the frame width from the right "
        "edge; it strains forward, snapping its jaws shut at 3 s and at 5 s; small fish and bubbles stream past to the "
        "right. At 6.5 s a rock wall with a SMALL round opening (a hole just big enough for a small creature) scrolls "
        "in from the LEFT edge and stops in the left third. At 7 s the mosasaur darts forward and bumps its snout "
        "against the rock around the opening, far too big to fit, and stops dazed with a big cloud of bubbles. A thin "
        "trail of small bubbles streams INTO the hole, as if a small creature had just slipped through it. From 7.5 s "
        "to 10 s the hole stays visible with bubbles drifting into it while the mosasaur backs off, grumpy. Nothing "
        "else enters the left and center of the frame.", 'P3_rock_tunnel_v6'),
    # v7 du tunnel : retours Nicolas sur v6 → (1) le monstre ne mange AUCUN poisson (les poissons sortent du cadre
    # dès la 1re seconde), (2) pas de second tunnel / couloir qui s'enfonce vers le fond : la paroi du fond reste
    # PLATE, vue de côté, avec juste un petit trou rond, (3) le monstre nage VITE (coups de queue, traînée de bulles).
    'P3_rock_tunnel_v7a': (10,
        "Fast chase, TRAVELLING to the LEFT: the camera moves steadily to the left, so the rock ceiling with hanging "
        "seaweed, the rock floor and the corals scroll continuously from left to right at a brisk constant speed, "
        "the tunnel going on endlessly. The tunnel is ALWAYS seen strictly from the side: the background between "
        "the ceiling band and the floor band is FLAT deep-blue water and flat rock, there is NO corridor, NO second "
        "tunnel and NOTHING receding into the distance at any moment. In the first second the small fish dart away "
        "out of the left edge and NEVER come back; there are no fish for the rest of the clip and the mosasaur never "
        "eats anything, its open jaws stay empty. The big mosasaur on the right (long crocodile-like head, teeth, "
        "paddle flippers, same crayon style) swims FAST toward the left with strong tail strokes and a trail of "
        "bubbles behind it, staying in the RIGHT half of the frame, snapping its empty jaws shut at 3 s and at 5 s. "
        "At 6.5 s a flat rock wall with ONE small dark round hole in it (a hole just big enough for a small creature, "
        "nothing visible inside it, no fish in it) scrolls in from the LEFT edge and stops in the left third. At 7 s "
        "the mosasaur lunges at the hole and bumps its snout hard against the rock around it, far too big to fit: it "
        "stops, dazed, with a big cloud of bubbles. A thin trail of small bubbles streams INTO the hole as if a small "
        "creature had just slipped through it. From 7.5 s to 10 s the hole stays visible with bubbles drifting into "
        "it while the mosasaur backs off, grumpy, on the right.", 'P3_rock_tunnel_v6'),
    'P3_rock_tunnel_v7b': (10,
        "Fast chase, TRAVELLING to the LEFT: the camera moves steadily to the left, so the rock ceiling with hanging "
        "seaweed, the rock floor and the corals scroll continuously from left to right at a brisk constant speed, "
        "the tunnel going on endlessly. STRICT SIDE VIEW for the whole clip: flat deep-blue water between the ceiling "
        "band and the floor band, NO corridor, NO second tunnel, NO perspective, nothing receding into the distance. "
        "NO FISH: the small fish leave through the left edge within the first second and never reappear; the "
        "mosasaur never catches or eats anything, its jaws stay empty. The mosasaur (long crocodile-like head, teeth, "
        "paddle flippers, same crayon style) stays glued to the RIGHT edge, only its head, front flippers and front "
        "body in view, swimming FAST with a trail of bubbles, its snout never further left than one third of the "
        "frame width from the right edge, snapping its empty jaws shut at 3 s and at 5 s. At 6.5 s a flat rock wall "
        "with ONE small dark round hole (just big enough for a small creature, nothing inside it) scrolls in from the "
        "LEFT edge and stops in the left third. At 7 s the mosasaur darts forward and bumps its snout against the "
        "rock around the hole, far too big to fit, and stops dazed with a big cloud of bubbles. A thin trail of small "
        "bubbles streams INTO the hole as if a small creature had just slipped through it. From 7.5 s to 10 s the "
        "hole stays visible with bubbles drifting into it while the mosasaur backs off, grumpy.", 'P3_rock_tunnel_v6'),
    'P4_kelp_forest': (11,
        "The kelp stalks sway slowly, the greenish-golden light shimmers. At 4.5 s the school of silver and yellow fish "
        "hiding in the crevice on the right bursts out all at once and darts upward out of the frame in a panicked "
        "cloud; at 8 s they come back and slip into the crevice, heads peeking out. Nothing else moves."),
    # v2 du kelp (retour Nicolas) : les poissons PARTENT et ne reviennent pas ; la caméra les SUIT en
    # travelling vertical vers le haut (le cou qui s'étire = on monte avec lui). 2 variantes.
    'P4_kelp_forest_v2a': (11,
        "Static camera for the first 4.5 s: the kelp stalks sway slowly, the greenish-golden light shimmers, the small "
        "school of silver and yellow fish stays hidden in the crevice on the right. At 4.5 s the fish burst out of the "
        "crevice all at once and swim straight UP in a tight group. From 4.5 s to the end the camera TILTS UP and "
        "travels upward steadily, following the fish: the rocks and the crevice slide down out of the frame, the tall "
        "kelp stalks scroll downward past the camera, the water gets brighter and lighter toward the top with sun rays, "
        "the fish stay near the middle of the frame, still swimming up. The camera never comes back down; the fish "
        "never return. No new creature appears. The center of the frame stays free.", 'P4_kelp_forest'),
    'P4_kelp_forest_v2b': (11,
        "Static camera for the first 4.5 s: the kelp stalks sway slowly, the greenish-golden light shimmers, the small "
        "school of silver and yellow fish stays hidden in the crevice on the right. At 4.5 s the fish burst out of the "
        "crevice all at once and dart UP toward the surface in a panicked cloud. From 4.5 s to the end the camera "
        "rises with them in a smooth continuous vertical TRAVELLING (pure upward pan, no zoom): the rocky shelf and the "
        "crevice disappear below, the kelp blades keep scrolling down past the frame, the light grows brighter with "
        "long sun rays near the top, the fish stay slightly above the center and keep going up, a few bubbles rise. "
        "The camera keeps rising until the last second; the fish never come back. No new creature appears.",
        'P4_kelp_forest'),
    # PLAN 6 (nouveau, retour Nicolas) : on SUIT la tortue — travelling vers la DROITE, la tortue nage vers la droite
    # dans la moitié droite du cadre, le héros composité la suit depuis la gauche. 15 s = max API. 2 variantes.
    'P6_turtle_follow_a': (15,
        "TRAVELLING to the RIGHT for the whole clip: the green sea turtle swims steadily to the right, flapping its "
        "front flippers slowly, and the camera follows it at the same speed, so the seagrass, the pale rocks and the "
        "shells scroll continuously from right to left, new seagrass and rocks keep entering from the right edge, the "
        "wavy surface sparkles above. In the first 2 s the turtle glides from the left-center to the RIGHT half of the "
        "frame, then stays in the right half at mid-height for the rest of the clip, always seen from the side, facing "
        "right. The LEFT half of the frame stays free of creatures (a character will be composited there, following "
        "the turtle). No other animal appears, no fish. Calm, gentle, sunny.", 'P5_seagrass_meadow'),
    'P6_turtle_follow_b': (15,
        "Slow TRAVELLING to the RIGHT for the whole clip, strict side view: the green sea turtle swims to the right "
        "with slow flipper strokes, gently rising and sinking a little, and the camera follows it, so the seagrass "
        "meadow, the pale rocks and the shells scroll continuously from right to left while new ones enter from the "
        "right; light caustics dance on the seagrass, the surface ripples at the top, a few bubbles rise. During the "
        "first 2 s the turtle moves from the left-center to the RIGHT third of the frame and stays there at mid-height "
        "until the end, facing right. At 12 s it turns its head briefly toward the left (as if checking on a "
        "follower), then keeps swimming. The left half of the frame stays free of creatures; no fish, no other "
        "animal.", 'P5_seagrass_meadow'),
    'P5_seagrass_meadow': (12,
        "Seagrass sways gently, the surface ripples and the light caustics dance. The green sea turtle swims very slowly "
        "from the left-center to the right across the middle of the frame from 2 s to 10 s, flapping its front flippers "
        "in slow motion; at 9 s it turns its head back toward the left, curious. Small fish drift."),
}


# Film PTERANODON — prompts de mouvement du script (docs/films/pteranodon-script.md)
PTERO_PLANS = {
    'P1_sea_cliff': (12,
        "Soft clouds drift slowly to the right, small waves roll far below, grass tufts on the ledges sway in the wind, "
        "the two or three tiny pteranodon silhouettes far away glide slowly across the sky. Calm, loopable."),
    'P2_dino_plain_aerial': (14,
        "TRAVELLING shot from the air: the camera flies steadily to the right, so the whole landscape below (grassland, "
        "river, herds, hills) scrolls continuously from right to left at a constant speed for the entire clip, the "
        "plain going on endlessly; the sky and the distant volcano move much slower (parallax). At 2.5 s one long-neck "
        "sauropod below lifts its head and looks up at the sky. The herds walk slowly. The upper-center of the frame "
        "stays free."),
    # v2 du survol (retour Nicolas) : travelling AU-DESSUS des dinosaures étendu à 15 s (max API), latéral et régulier,
    # sans créature qui grossit au premier plan (défaut de la v1).
    'P2_dino_plain_aerial_v2': (15,
        "Long aerial TRAVELLING for the entire 15 s: the camera flies steadily to the RIGHT high above the plain, so "
        "the whole landscape below (grassland, fern clumps, the winding river, the small herds) scrolls continuously "
        "from right to left at a constant speed, the plain going on endlessly with new herds, rivers and fern patches "
        "entering from the right; the distant volcano and mountains move much slower (parallax), the clouds drift. "
        "The dinosaurs stay SMALL and far below the camera: herds of long-neck sauropods and triceratops walking "
        "slowly, seen from above; at 5 s one sauropod lifts its head and looks up at the sky, at 11 s a small group of "
        "triceratops crosses the river. NO animal ever comes close to the camera or grows large in the foreground. "
        "The sky band in the upper part of the frame stays completely free (a flying character will be composited "
        "there).", 'P2_dino_plain_aerial'),
    'P3_beach_red_car': (14,
        "Gentle waves roll onto the beach, the palm-like trees sway, a few clouds drift. The red car stays parked; at "
        "3.2 s its headlights flash twice (a honk) and a tiny puff of exhaust appears. Nothing else moves. The sky "
        "above the car stays free."),
    'P4_jungle_trex': (10,
        "Leaves and ferns sway gently. The T-Rex standing at the lower center-right looks up at the sky. At 4 s it "
        "suddenly leaps straight up with its jaws wide open, reaching the middle of the frame, snaps its jaws shut on "
        "nothing and lands back at 5 s with a small dust cloud; it shakes its head, growls, then jumps again at 7 s "
        "(a little lower), snaps, lands at 8 s and stays standing, looking up, frustrated, until the end. The upper "
        "third of the frame stays completely free."),
    # PLAN 5 (nouveau, retour Nicolas) : « Vers l'océan » — travelling le long de la côte vers la mer au couchant,
    # juste le temps de « I spent lots of time near the ocean. I used my long beak to catch fish! » avant la pêche.
    'P5_flight_to_ocean': (10,
        "Aerial TRAVELLING to the RIGHT for the whole clip: the camera flies steadily along the coast toward the sun, "
        "so the beach, the low cliffs and the trees below scroll continuously from right to left at a constant speed, "
        "new coastline entering from the right; the sea in the middle band moves slower (parallax), gentle waves roll "
        "onto the beach, the low sun sparkles on the water and the clouds drift slowly; the sky gets a little warmer "
        "toward the end. No animal appears. The upper part of the frame stays free (a flying character will be "
        "composited there)."),
    'P5_sunset_ocean': (12,
        "Gentle swell, the low sun sparkles on the water, clouds drift slowly. At 2 s a small fish jumps out of the "
        "water at the lower left. At 6.5 s a fish leaps out of the water at the lower center with a big splash of "
        "white droplets, then ripples spread. The sky stays free."),
}
FILM = opts.get('film', 'plesio')
if FILM == 'ptero':
    PLANS = PTERO_PLANS


def http(method, url, body=None, timeout=300):
    req = urllib.request.Request(url, data=body, headers=HDR, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def submit(name, duration, prompt, image_name=None):
    img_path = os.path.join(IMG_DIR, (image_name or name) + '.jpg')
    b64 = base64.b64encode(open(img_path, 'rb').read()).decode()
    data_uri = 'data:image/jpeg;base64,' + b64
    base = {'model': MODEL, 'prompt': STYLE + "\n\nMotion: " + prompt,
            'duration': duration, 'aspect_ratio': '16:9', 'resolution': RES}
    # 1er essai : objet image_url (même forme que /images/edits) ; 2e essai : chaîne data URI.
    # Une erreur transitoire (5xx / 429) sur l'objet est retentée 3 fois avant le fallback.
    errors = []
    for image_field in ({'url': data_uri, 'type': 'image_url'}, data_uri):
        body = dict(base, image=image_field)
        for attempt in range(3):
            status, raw = http('POST', 'https://api.x.ai/v1/videos/generations', json.dumps(body).encode())
            if status == 200:
                return json.loads(raw), None
            errors.append(f"HTTP {status} {raw[:200]!r}")
            if status in (400, 401, 403, 404, 422):
                break  # erreur de format / droits : inutile de réessayer ce format
            time.sleep(5 * (attempt + 1))
    return None, ' | '.join(errors)


def wait(request_id, name, max_s=1500):
    t0 = time.time()
    while time.time() - t0 < max_s:
        status, raw = http('GET', f'https://api.x.ai/v1/videos/{request_id}')
        if status != 200:
            time.sleep(10); continue
        d = json.loads(raw)
        st = d.get('status')
        if st == 'done':
            return d
        if st in ('failed', 'expired'):
            raise RuntimeError(f"{name}: {st} {json.dumps(d)[:300]}")
        time.sleep(10)
    raise TimeoutError(f"{name}: timeout après {max_s}s")


def run(name):
    spec = PLANS[name]
    duration, prompt = spec[0], spec[1]
    image_name = spec[2] if len(spec) > 2 else None
    r, err = submit(name, duration, prompt, image_name)
    if r is None:
        return f"{name}: submit KO {err}"
    rid = r.get('request_id') or r.get('id')
    d = wait(rid, name)
    url = d['video']['url']
    os.makedirs(OUT, exist_ok=True)
    dest = os.path.join(OUT, name + '.mp4')
    with urllib.request.urlopen(url, timeout=300) as resp:
        open(dest, 'wb').write(resp.read())
    json.dump({'request_id': rid, 'model': MODEL, 'duration': duration, 'resolution': RES, 'prompt': prompt,
               'response': d}, open(os.path.join(OUT, name + '.json'), 'w'), indent=1)
    return f"{name}: OK {os.path.getsize(dest)//1024} KB (durée annoncée {d['video'].get('duration')}s)"


if __name__ == '__main__':
    names = [n for n in PLANS if not ONLY or n in ONLY]
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        for f in cf.as_completed([ex.submit(run, n) for n in names]):
            try:
                print(f.result(), flush=True)
            except Exception as e:
                print("ERR", repr(e), flush=True)

#!/usr/bin/env python3
"""Construit le dossier Drive « VOIX » du livre dinosaure pour la traduction (ES, IT, DE) :

  VOIX/
    LISEZ-MOI (traduction ES-IT-DE).txt
    Voix ElevenLabs de chaque dinosaure.txt
    Voix EN/<NN - Dino>/NN - plan P.mp3 … + Transcript EN.txt     (+ Transcript EN - tous les dinosaures.txt)
    Voix FR/<NN - Dino>/NN - plan P.mp3 … + Transcript FR.txt     (+ Transcript FR - tous les dinosaures.txt)

Sources : dossier local « PICOPOP - Dinosaur Coloring BOOK/LIVRE DINOSAURE » (voix EN des films, voix FR finales,
« Textes français (version finale).txt » = EN relu + FR). Les durées viennent de ffprobe.

  python3 build_voix_folder.py [dossier de sortie]
"""
import os, re, shutil, subprocess, sys

SRC = os.path.expanduser('~/Downloads/PICOPOP - Dinosaur Coloring BOOK/LIVRE DINOSAURE')
FILMS, TRAD = f'{SRC}/02 - Films', f'{SRC}/06 - Traduction française'
FR_VOIX = f'{TRAD}/Voix françaises (version finale)'
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/Library/CloudStorage/GoogleDrive-2rkpublishing@gmail.com/Mon Drive/Picopop/Livres Admin Picopop/LE PLUS RECENT (FINAL)/VOIX')

DINOS = [  # (dossier EN, dossier FR, nom EN, nom FR)
    ('00 - T-Rex', '00 - T-Rex', 'T-Rex', 'T-Rex'), ('01 - Pteranodon', '01 - Ptéranodon', 'Pteranodon', 'Ptéranodon'),
    ('02 - Plesiosaurus', '02 - Plésiosaure', 'Plesiosaurus', 'Plésiosaure'), ('03 - Triceratops', '03 - Tricératops', 'Triceratops', 'Tricératops'),
    ('04 - Brachiosaurus', '04 - Brachiosaure', 'Brachiosaurus', 'Brachiosaure'), ('05 - Ankylosaurus', '05 - Ankylosaure', 'Ankylosaurus', 'Ankylosaure'),
    ('06 - Spinosaurus', '06 - Spinosaure', 'Spinosaurus', 'Spinosaure'), ('07 - Velociraptor', '07 - Vélociraptor', 'Velociraptor', 'Vélociraptor'),
    ('08 - Dilophosaurus', '08 - Dilophosaure', 'Dilophosaurus', 'Dilophosaure'), ('09 - Stegosaurus', '09 - Stégosaure', 'Stegosaurus', 'Stégosaure'),
]


def dur(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], capture_output=True, text=True)
    return float(out.stdout.strip())


def parse_texts():
    """{index dino: {fichier: (EN, FR)}} depuis « Textes français (version finale).txt »."""
    txt = open(f'{TRAD}/Textes français (version finale).txt', encoding='utf-8').read()
    blocks = re.split(r'^===== .*? =====$', txt, flags=re.M)[1:]
    res = {}
    for i, b in enumerate(blocks):
        d = {}
        for m in re.finditer(r'^(\d\d - plan \d+\.mp3)\s*\([^)]*\)\s*\n\s*EN : (.*?)\n\s*FR : (.*?)\n', b, flags=re.M | re.S):
            d[m.group(1)] = (m.group(2).strip(), m.group(3).strip())
        res[i] = d
    return res


def mp3s(folder):
    return sorted(f for f in os.listdir(folder) if f.lower().endswith('.mp3'))


def build():
    texts = parse_texts()
    os.makedirs(OUT, exist_ok=True)
    all_en, all_fr = [], []
    for i, (den, dfr, nen, nfr) in enumerate(DINOS):
        src_en, src_fr = f'{FILMS}/{den}/Voix', f'{FR_VOIX}/{dfr}'
        fen, ffr = mp3s(src_en), mp3s(src_fr)
        if fen != ffr: sys.exit(f'{den} : fichiers EN {fen} ≠ FR {ffr}')
        if set(fen) != set(texts[i]): sys.exit(f'{den} : textes {sorted(texts[i])} ≠ fichiers {fen}')
        for lang, src, folder, name, acc in (('EN', src_en, f'{OUT}/Voix EN/{den}', nen, all_en), ('FR', src_fr, f'{OUT}/Voix FR/{dfr}', nfr, all_fr)):
            os.makedirs(folder, exist_ok=True)
            lines = [f'{name.upper()} — voix du film ({lang}), dans l’ordre où on les entend', 'Un fichier = une réplique jouée dans le film. « plan N » = le plan du film où elle est entendue.', '']
            for f in fen:
                shutil.copy2(f'{src}/{f}', f'{folder}/{f}')
                en, fr = texts[i][f]; d = dur(f'{folder}/{f}')
                lines += [f'{f}   ({d:.1f} s)', f'   {en if lang == "EN" else fr}', '']
            open(f'{folder}/Transcript {lang}.txt', 'w', encoding='utf-8').write('\n'.join(lines))
            acc += lines + ['', '']
            print(f'{lang} {den}: {len(fen)} fichiers')
    open(f'{OUT}/Voix EN/Transcript EN - tous les dinosaures.txt', 'w', encoding='utf-8').write('\n'.join(all_en))
    open(f'{OUT}/Voix FR/Transcript FR - tous les dinosaures.txt', 'w', encoding='utf-8').write('\n'.join(all_fr))
    shutil.copy2(f'{TRAD}/Voix ElevenLabs de chaque dinosaure.txt', f'{OUT}/Voix ElevenLabs de chaque dinosaure.txt')
    open(f'{OUT}/LISEZ-MOI (traduction ES-IT-DE).txt', 'w', encoding='utf-8').write(README)
    print('dossier :', OUT)


README = """VOIX DU LIVRE DINOSAURE — kit pour la traduction (espagnol, italien, allemand)

CE QU'IL Y A ICI
  Voix EN/   les 63 répliques anglaises des 10 films, un dossier par dinosaure, + « Transcript EN.txt » par dinosaure
             (et « Transcript EN - tous les dinosaures.txt » qui regroupe tout).
  Voix FR/   la même chose en français (version finale, en ligne dans l'app) : utile comme 2e référence de ton et de longueur.
  Voix ElevenLabs de chaque dinosaure.txt   la voix ElevenLabs utilisée pour chaque dinosaure (nom + identifiant), le modèle
             (Eleven v3) et les astuces d'écriture (« T-Rex » envoyé comme « Tyrex », « ... » en fin de texte pour ne pas couper la fin).

COMMENT LIRE LES NOMS DE FICHIERS
  « 03 - plan 2.mp3 » = 3e réplique entendue dans le film, jouée pendant le plan 2.
  L'ordre des numéros est l'ordre du film. Les plans sont ceux de l'éditeur FILM de l'admin PicoPop.

CE QU'ON ATTEND POUR CHAQUE LANGUE (ES, IT, DE)
  1. Un dossier par dinosaure, avec EXACTEMENT les mêmes noms de fichiers qu'en EN/FR (« 01 - plan 1.mp3 », …), en MP3.
     → c'est ce qui permet d'injecter les voix dans les films automatiquement, sans retouche de montage.
  2. Un fichier « Transcript XX.txt » par dinosaure sur le même modèle (nom du fichier, durée, texte).
  3. Même voix ElevenLabs qu'en anglais (voir la liste), sauf si elle a un accent dans la langue cible : dans ce cas
     choisir une voix native de la bibliothèque et le noter dans le transcript.
  4. Durées : rester PROCHE de la durée EN (± 15 %). Le film ne s'allonge pas : une réplique trop longue déborde sur le
     plan suivant (ex. T-Rex « 04 - plan 4 » est déjà à la limite : 13,0 s pour un plan de 11,4 s). Si la traduction est
     plus longue, raccourcir le texte plutôt que d'accélérer la voix.
  5. Garder le ton de chaque réplique (présentation, blague, défi « attrape-moi si tu peux », cri) : le dinosaure parle
     à un enfant de 4-8 ans, phrases courtes, vocabulaire simple ; les faits scientifiques doivent rester exacts.
  6. Les noms des dinosaures se traduisent (Pteranodon → Pteranodonte en IT, Flugsaurier NON : garder Pteranodon en DE…),
     vérifier l'usage courant dans la langue.

LIVRAISON
  Déposer les dossiers « Voix ES », « Voix IT », « Voix DE » à côté de « Voix EN » et « Voix FR » dans ce dossier VOIX.
  Les versions ES/IT/DE des films sont ensuite créées côté admin PicoPop (copie du film + remplacement des voix).
"""

if __name__ == '__main__':
    build()

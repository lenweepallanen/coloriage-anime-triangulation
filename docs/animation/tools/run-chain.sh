#!/bin/zsh
# Enchaîne les animations l'une après l'autre (une seule sauvegarde de projet à la fois). Journaux : log-<nom>.txt
setopt nullglob
W="/Users/nicolasrocher/Documents/claude code projects/PicoPop/docs/animation/_work"; cd "$W/studio"; P=9f819082-bf93-4f2f-977e-018d312cf64b
MARCHE="click:Calculer et sauvegarder;wait:3000;step:LBS;click:Calculer & Preview;expect:Valider;click:^Valider$;wait:4000;step:Calcul;click#1:^Appliquer$;click#1:^Valider$;click#2:^Appliquer$;click#2:^Valider$;wait:3000;step:Preview;wait:5000;shots:8:250"
for n in "${@:-Trot Galop}"; do
  node anim-step.mjs "$W/studio" $P "$n" "Params" "$MARCHE" > "log-$n.txt" 2>&1; echo "$n : code $?"
  for f in anim-Params-*-s[0-9].png; do mv "$f" "${f/anim-Params-/anim-$n-}"; done; for f in anim-Params-*.png; do mv "$f" "anim-$n-final.png"; done
done
if [ "$CABRE" = "1" ]; then
node anim-step.mjs "$W/studio" $P "Cabré" "CoTracker3" "cotracker-run:CoTracker Optimisé;step:Bones;click:Valider le squelette;expect:Squelette validé;step:LBS;click:Calculer & Preview;expect:Valider;click:^Valider$;wait:4000;step:Calcul;click#1:^Appliquer$;click#1:^Valider$;click#2:^Appliquer$;click#2:^Valider$;wait:3000;step:Preview;wait:5000;shots:10:300" > "log-cabre.txt" 2>&1; echo "Cabré : code $?"
for f in anim-CoTracker3-*-s[0-9].png; do mv "$f" "${f/anim-CoTracker3-/anim-Cabre-}"; done; for f in anim-CoTracker3-*.png; do mv "$f" "anim-Cabre-final.png"; done
fi
echo FIN

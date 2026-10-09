#!/bin/zsh
# Points v3 (flanc densifié, hanches dans le flanc) : Idle (re-tracking) → Trot → Galop → Cabré (re-tracking optimisé). Séquentiel.
setopt nullglob
W="/Users/nicolasrocher/Documents/claude code projects/PicoPop/docs/animation/_work"; cd "$W/studio"; P=9f819082-bf93-4f2f-977e-018d312cf64b
python3 -c "import auth; auth.custom_token()"
python3 apply_points3.py "$W" || exit 1
TAIL="step:Bones;click:Valider le squelette;expect:Squelette validé;step:LBS;click:^Valider$;wait:3000;step:Calcul;click#1:^Valider$;click#2:^Valider$;wait:2000;step:Preview;wait:5000;shots:8:250"
node anim-step.mjs "$W/studio" $P "Idle" "CoTracker3" "cotracker-run;$TAIL" > log-Idle.txt 2>&1; echo "Idle : code $?"
i=0; for f in anim-CoTracker3-*-s[0-9].png; do mv "$f" "v3-Idle-$i.png"; i=$((i+1)); done; rm -f anim-CoTracker3-*.png
MARCHE="click:Calculer et sauvegarder;wait:2000;step:LBS;click:^Valider$;wait:3000;step:Calcul;click#1:^Valider$;click#2:^Valider$;wait:2000;step:Preview;wait:5000;shots:8:250"
for n in Trot Galop; do
  node anim-step.mjs "$W/studio" $P "$n" "Params" "$MARCHE" > "log-$n.txt" 2>&1; echo "$n : code $?"
  i=0; for f in anim-Params-*-s[0-9].png; do mv "$f" "v3-$n-$i.png"; i=$((i+1)); done; rm -f anim-Params-*.png
done
node anim-step.mjs "$W/studio" $P "Cabré" "CoTracker3" "cotracker-run:CoTracker Optimisé;$TAIL" > log-cabre.txt 2>&1; echo "Cabré : code $?"
i=0; for f in anim-CoTracker3-*-s[0-9].png; do mv "$f" "v3-Cabre-$i.png"; i=$((i+1)); done; rm -f anim-CoTracker3-*.png
python3 -I - "$W/studio" <<'PY'
import sys, glob
from PIL import Image
W=sys.argv[1]
for n in ('Idle','Trot','Galop','Cabre'):
    files=sorted(glob.glob(f'{W}/v3-{n}-*.png'), key=lambda f:int(f.rsplit('-',1)[1][:-4]))
    if not files: print(n,'aucune capture'); continue
    ims=[Image.open(f).convert('RGB') for f in files]; w,h=ims[0].size; k=420/h; cols=4; rows=(len(ims)+cols-1)//cols
    sheet=Image.new('RGB',(int(w*k)*cols,int(h*k)*rows),'white')
    for i,im in enumerate(ims): sheet.paste(im.resize((int(w*k),int(h*k))),((i%cols)*int(w*k),(i//cols)*int(h*k)))
    sheet.save(f'{W}/v3-{n.lower()}-sheet.png'); print(n, len(ims))
PY
echo FIN

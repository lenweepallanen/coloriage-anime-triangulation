#!/bin/zsh
# Licorne V2 : Idle (vidéo idle-1, points v4) → Trot → Galop → Cabré, tout dans l'admin. Journaux log2-*.txt, captures v2-*.png
setopt nullglob
W="/Users/nicolasrocher/Documents/claude code projects/PicoPop/docs/animation/_work"; cd "$W/studio"; P=161adc29-ab40-4422-b629-e4e1a490e2fe
python3 -c "import auth; auth.custom_token()"
PTS="$W/licorne2/points4.json"; SK="$W/licorne2/skeleton4.json"
node anim-create2.mjs "$W/studio" $P "Idle" "Animation par Vidéo" > log2-create-idle.txt 2>&1; echo "Idle créée : $?"
node anim-video.mjs "$W/studio" $P "Idle" "$W/licorne/out1/idle-1.mp4" > log2-video-idle.txt 2>&1; echo "vidéo Idle : $?"
python3 apply_points.py $P Idle "$PTS" "$SK" || exit 1
TAIL="step:Bones;click:Valider le squelette;expect:Squelette validé;step:LBS;click:^Valider$;wait:3000;step:Calcul;click#1:^Valider$;click#2:^Valider$;wait:2000;step:Preview;wait:5000;shots:8:250"
node anim-step.mjs "$W/studio" $P "Idle" "CoTracker3" "cotracker-run;$TAIL" > log2-Idle.txt 2>&1; echo "Idle : code $?"
i=0; for f in anim-CoTracker3-*-s[0-9].png; do mv "$f" "v2-Idle-$i.png"; i=$((i+1)); done; rm -f anim-CoTracker3-*.png
MARCHE="click:Calculer et sauvegarder;wait:2000;step:LBS;click:^Valider$;wait:3000;step:Calcul;click#1:^Valider$;click#2:^Valider$;wait:2000;step:Preview;wait:5000;shots:8:250"
for n in Trot Galop; do
  node anim-create2.mjs "$W/studio" $P "$n" "Animation Marche" > "log2-create-$n.txt" 2>&1; echo "$n créée : $?"
  python3 setup_marche.py $P "$n" "$PTS" || exit 1
  node anim-step.mjs "$W/studio" $P "$n" "Params" "$MARCHE" > "log2-$n.txt" 2>&1; echo "$n : code $?"
  i=0; for f in anim-Params-*-s[0-9].png; do mv "$f" "v2-$n-$i.png"; i=$((i+1)); done; rm -f anim-Params-*.png
done
node anim-create2.mjs "$W/studio" $P "Cabré" "Animation par Vidéo" "Idle" > log2-create-cabre.txt 2>&1; echo "Cabré créée : $?"
node anim-video.mjs "$W/studio" $P "Cabré" "$W/licorne/out-cabre/idle-2.mp4" noloop > log2-video-cabre.txt 2>&1; echo "vidéo Cabré : $?"
node anim-step.mjs "$W/studio" $P "Cabré" "CoTracker3" "cotracker-run:CoTracker Optimisé;$TAIL" > log2-cabre.txt 2>&1; echo "Cabré : code $?"
i=0; for f in anim-CoTracker3-*-s[0-9].png; do mv "$f" "v2-Cabre-$i.png"; i=$((i+1)); done; rm -f anim-CoTracker3-*.png
python3 -I - "$W/studio" <<'PY'
import sys, glob
from PIL import Image
W=sys.argv[1]
for n in ('Idle','Trot','Galop','Cabre'):
    files=sorted(glob.glob(f'{W}/v2-{n}-*.png'), key=lambda f:int(f.rsplit('-',1)[1][:-4]))
    if not files: print(n,'aucune capture'); continue
    ims=[Image.open(f).convert('RGB') for f in files]; w,h=ims[0].size; k=420/h; cols=4; rows=(len(ims)+cols-1)//cols
    sheet=Image.new('RGB',(int(w*k)*cols,int(h*k)*rows),'white')
    for i,im in enumerate(ims): sheet.paste(im.resize((int(w*k),int(h*k))),((i%cols)*int(w*k),(i//cols)*int(h*k)))
    sheet.save(f'{W}/v2-{n.lower()}-sheet.png'); print(n, len(ims))
PY
echo FIN

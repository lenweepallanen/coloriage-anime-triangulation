#!/bin/zsh
# Après retriangulation : recalcule LBS + lissages (+ Params pour les Marche) des 4 animations de Licorne V2
setopt nullglob
W="/Users/nicolasrocher/Documents/claude code projects/PicoPop/docs/animation/_work"; cd "$W/studio"; P=161adc29-ab40-4422-b629-e4e1a490e2fe
python3 -c "import auth; auth.custom_token()"
TAIL="step:LBS;click:^Valider$;wait:3000;step:Calcul;click#1:^Valider$;click#2:^Valider$;wait:2000;step:Preview;wait:5000;shots:8:250"
for n in Idle Cabré; do node anim-step.mjs "$W/studio" $P "$n" "Bones" "click:Valider le squelette;expect:Squelette validé;$TAIL" > "log3-$n.txt" 2>&1; echo "$n : code $?"; i=0; for f in anim-Bones-*-s[0-9].png; do mv "$f" "v3-$n-$i.png"; i=$((i+1)); done; rm -f anim-Bones-*.png; done
for n in Trot Galop; do node anim-step.mjs "$W/studio" $P "$n" "Params" "click:Calculer et sauvegarder;wait:2000;$TAIL" > "log3-$n.txt" 2>&1; echo "$n : code $?"; i=0; for f in anim-Params-*-s[0-9].png; do mv "$f" "v3-$n-$i.png"; i=$((i+1)); done; rm -f anim-Params-*.png; done
python3 -I - "$W/studio" <<'PY'
import sys, glob
from PIL import Image
W=sys.argv[1]
for n in ('Idle','Trot','Galop','Cabré'):
    files=sorted(glob.glob(f'{W}/v3-{n}-*.png'), key=lambda f:int(f.rsplit('-',1)[1][:-4]))
    if not files: print(n,'aucune capture'); continue
    ims=[Image.open(f).convert('RGB') for f in files]; w,h=ims[0].size; k=420/h; cols=4; rows=(len(ims)+cols-1)//cols
    sheet=Image.new('RGB',(int(w*k)*cols,int(h*k)*rows),'white')
    for i,im in enumerate(ims): sheet.paste(im.resize((int(w*k),int(h*k))),((i%cols)*int(w*k),(i//cols)*int(h*k)))
    sheet.save(f'{W}/v3-{n.lower()}-sheet.png'); print(n, len(ims))
PY
echo FIN

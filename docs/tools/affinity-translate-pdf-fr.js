const { Application } = require('/application.js');
const { DocumentCommand } = require('/commands.js');
const { Selection, TextSelection } = require('/selections.js');
const doc = Application.documents.current;
if (doc.title !== 'PDF Gratuit T-Rex FR') throw new Error('document courant inattendu : ' + doc.title);
// Remplacements : [texte EN exact (sous-chaîne), texte FR]. Sous-chaînes → la mise en forme des autres runs est conservée.
const MAP = [
  ['Start Here', 'Commencez ici'],
  ['Need a hand?', "Besoin d'aide ?"],
  ['Install the PicoPop app', "Installez l'appli PicoPop"],
  ['Scan the QR code below.', 'Scannez le QR code ci-dessous.'],
  ['Print the T-Rex page.', 'Imprimez la page du T-Rex.'],
  ['Print the next page.', 'Imprimez la page suivante.'],
  ["We're here to help at ", 'On est là pour vous aider : '],
  ['This is a free sample of the PicoPop Dinosaur Coloring Book, available soon on Amazon.', 'Ceci est un extrait gratuit du livre de coloriage Dinosaure PicoPop, bientôt disponible sur Amazon.'],
  ['The T-Rex', 'Le T-Rex'],
  ['1. Your child colors the T-Rex below.', '1. Votre enfant colorie le T-Rex ci-dessous.'],
  ['2. Tap the SCAN button in PicoPop app and scan this QR code.', "2. Appuyez sur SCAN dans l'appli PicoPop et scannez ce QR code."],
  ['3. Point the camera at the colored T-Rex: it comes to life!', '3. Pointez la caméra vers le T-Rex colorié : il prend vie !'],
];
let done = 0;
for (const spread of doc.spreads) {
  if (doc.currentSpread?.handle !== spread.handle) doc.executeCommand(DocumentCommand.createSetCurrentSpread(spread));
  for (const n of spread.layers.all) {
    if (!n.isTextNode) continue;
    for (const [en, fr] of MAP) {
      const si = n.storyInterface; const text = si.text; const idx = text.indexOf(en);
      if (idx < 0) continue;
      const base = si.storyRange.begin;
      const sel = Selection.createEmpty(doc); sel.addNode(n);
      sel.addSubSelectionForNode(n, TextSelection.create([{ begin: base + idx, end: base + idx + en.length }]));
      doc.executeCommand(DocumentCommand.createSetSelection(sel));
      doc.executeCommand(DocumentCommand.createSetText(sel, fr));
      done++; console.log('OK', JSON.stringify(en), '→', JSON.stringify(n.storyInterface.text.slice(0, 120)));
    }
  }
}
console.log('remplacements :', done);

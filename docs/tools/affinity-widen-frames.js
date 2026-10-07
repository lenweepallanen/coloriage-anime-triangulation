const { Application } = require('/application.js');
const { DocumentCommand } = require('/commands.js');
const { Selection, TextSelection } = require('/selections.js');
const { Transform } = require('/geometry.js');
const doc = Application.documents.current;
if (doc.title !== 'PDF Gratuit T-Rex FR') throw new Error('document courant inattendu : ' + doc.title);
const sp = doc.spreads.first;
if (doc.currentSpread?.handle !== sp.handle) doc.executeCommand(DocumentCommand.createSetCurrentSpread(sp));
const TEXT = [['Imprimez la page du T-Rex.', 'Imprimez la page T-Rex.'], ['On est là pour vous aider : ', 'Écrivez-nous à ']];
const WIDTH = { "Installez l'appli": 1000, 'Imprimez la page T-Rex': 1000, 'Scannez le QR': 1000, 'Imprimez la page suivante': 1000, "Besoin d'aide": 1300, 'Écrivez-nous': 1400, 'Ceci est un extrait': { width: 1500, center: true } };
for (const n of sp.layers.all) {
  if (!n.isFrameTextNode) continue;
  for (const [en, fr] of TEXT) {
    const si = n.storyInterface; const t = si.text; const idx = t.indexOf(en); if (idx < 0) continue;
    const base = si.storyRange.begin; const sel = Selection.createEmpty(doc); sel.addNode(n);
    sel.addSubSelectionForNode(n, TextSelection.create([{ begin: base + idx, end: base + idx + en.length }]));
    doc.executeCommand(DocumentCommand.createSetSelection(sel)); doc.executeCommand(DocumentCommand.createSetText(sel, fr));
    console.log('TEXTE', JSON.stringify(n.storyInterface.text.slice(0, 80)));
  }
  const t = n.storyInterface.text;
  for (const [prefix, spec0] of Object.entries(WIDTH)) {
    if (!t.startsWith(prefix)) continue;
    const spec = typeof spec0 === 'number' ? { width: spec0 } : spec0;
    const b = n.getSpreadBaseBox(false); if (b.width >= spec.width) { console.log('déjà large', prefix); continue; }
    const sx = spec.width / b.width; const ax = spec.center ? b.x + b.width / 2 : b.x;
    const xf = new Transform(); xf.scale(sx, 1); xf.translate(ax * (1 - sx), 0);
    doc.applyTransform(xf, n.selfSelection);
    const nb = n.getSpreadBaseBox(false); console.log('LARGEUR', prefix, b.width.toFixed(0), '→', nb.width.toFixed(0), 'x', nb.x.toFixed(0), '→', (nb.x + nb.width).toFixed(0));
  }
}

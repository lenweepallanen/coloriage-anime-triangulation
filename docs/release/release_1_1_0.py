#!/usr/bin/env python3
"""Release 1.1.0 (build 5) — prépare les deux stores SANS soumettre (go de Nicolas le 05/10/2026).

  python3 docs/release/release_1_1_0.py asc    # App Store Connect : version 1.1.0 + notes + build 5 (attend le traitement)
  python3 docs/release/release_1_1_0.py play   # Google Play : AAB envoyé en release BROUILLON sur la piste production + notes

Ce qui reste à cliquer par Nicolas : déclaration de confidentialité (ASC) / sécurité des données (Play),
puis « Soumettre pour examen » (ASC) et « Examiner la release » → déploiement (Play).
Réutilise les clients docs/release/asc_api.py et play_api.py (clés hors dépôt, ~/.picopop-keys.env).
"""
import os, sys, time, json

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

VERSION, BUILD = '1.1.0', '5'
NOTES = {
    'en-US': 'Anonymous usage counts (no personal data) to help us improve PicoPop, footstep sounds in films now play in full, and small fixes.',
    'fr-FR': "Comptages d'usage anonymes (aucune donnée personnelle) pour améliorer PicoPop, les bruits de pas des films sont joués en entier, et petites corrections.",
}


def asc():
    import asc_api as A
    app, name = A.app_id()
    print(f'app {name} ({app})')
    # 1. build 5 traité ?
    build = None
    for _ in range(60):
        d = A.get('/v1/builds', **{'filter[app]': app, 'filter[version]': BUILD, 'fields[builds]': 'version,processingState,uploadedDate', 'limit': 5})
        for b in d['data']:
            if b['attributes']['version'] == BUILD:
                build = b
        if build and build['attributes']['processingState'] == 'VALID':
            break
        print('build', BUILD, 'en traitement…' if build else 'pas encore visible…')
        time.sleep(60)
    if not build or build['attributes']['processingState'] != 'VALID':
        sys.exit('build 5 toujours pas traité : relancer plus tard')
    print('build', BUILD, 'VALID', build['id'])
    # 2. version 1.1.0 (créée si absente)
    d = A.get('/v1/apps/' + app + '/appStoreVersions', **{'filter[versionString]': VERSION, 'filter[platform]': 'IOS', 'fields[appStoreVersions]': 'versionString,appStoreState,appVersionState'})
    if d['data']:
        ver = d['data'][0]; print('version', VERSION, 'existe déjà :', ver['attributes'])
    else:
        s, r = A.request('POST', '/v1/appStoreVersions', body={'data': {'type': 'appStoreVersions', 'attributes': {'platform': 'IOS', 'versionString': VERSION, 'releaseType': 'AFTER_APPROVAL'}, 'relationships': {'app': {'data': {'type': 'apps', 'id': app}}}}})
        if s != 201: sys.exit(f'création version → {s} {json.dumps(r)[:600]}')
        ver = r['data']; print('version', VERSION, 'créée', ver['id'])
    vid = ver['id']
    # 3. notes de version par langue (localisations créées avec la version, sinon on les crée)
    d = A.get(f'/v1/appStoreVersions/{vid}/appStoreVersionLocalizations', **{'fields[appStoreVersionLocalizations]': 'locale,whatsNew'})
    existing = {l['attributes']['locale']: l for l in d['data']}
    for locale, text in NOTES.items():
        if locale in existing:
            s, r = A.request('PATCH', f"/v1/appStoreVersionLocalizations/{existing[locale]['id']}", body={'data': {'type': 'appStoreVersionLocalizations', 'id': existing[locale]['id'], 'attributes': {'whatsNew': text}}})
        else:
            s, r = A.request('POST', '/v1/appStoreVersionLocalizations', body={'data': {'type': 'appStoreVersionLocalizations', 'attributes': {'locale': locale, 'whatsNew': text}, 'relationships': {'appStoreVersion': {'data': {'type': 'appStoreVersions', 'id': vid}}}}})
        print('notes', locale, '→', s, '' if s in (200, 201) else json.dumps(r)[:300])
    # 4. build attaché
    s, r = A.request('PATCH', f'/v1/appStoreVersions/{vid}/relationships/build', body={'data': {'type': 'builds', 'id': build['id']}})
    print('build attaché →', s, '' if s == 204 else json.dumps(r)[:300])
    print('ASC prêt : il reste la confidentialité de l’app et « Soumettre pour examen » dans App Store Connect.')


def play():
    import play_api as P
    aab = os.path.expanduser('~/Downloads/picopop-1.1.0-versionCode5.aab')
    s, edit = P.request('POST', '/edits', body={})
    if s != 200: sys.exit(f'edit → {s} {edit}')
    eid = edit['id']; print('edit', eid)
    env = P.load_env()
    import urllib.request
    url = f"https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/{env['PLAY_PACKAGE']}/edits/{eid}/bundles?uploadType=media"
    req = urllib.request.Request(url, data=open(aab, 'rb').read(), method='POST', headers={'Authorization': 'Bearer ' + P.token(), 'Content-Type': 'application/octet-stream'})
    with urllib.request.urlopen(req, timeout=900) as r:
        b = json.loads(r.read()); print('bundle envoyé : versionCode', b.get('versionCode'))
    s, r = P.request('PUT', f'/edits/{eid}/tracks/production', body={'track': 'production', 'releases': [{'name': VERSION, 'versionCodes': [str(b['versionCode'])], 'status': 'draft', 'releaseNotes': [{'language': k, 'text': v} for k, v in NOTES.items()]}]})
    print('piste production (brouillon) →', s, '' if s == 200 else json.dumps(r)[:400])
    s, r = P.request('POST', f'/edits/{eid}:commit')
    print('commit →', s, '' if s == 200 else json.dumps(r)[:400])
    print('Play prêt : release 1.1.0 en BROUILLON sur production — sécurité des données puis « Examiner la release » dans la console.')


if __name__ == '__main__':
    {'asc': asc, 'play': play}[sys.argv[1]]()

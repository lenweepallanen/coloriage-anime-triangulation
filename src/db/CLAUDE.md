# Base de données — Firebase (Firestore + Cloud Storage)

## Architecture

Séparation métadonnées / blobs :
- **Firestore** : documents légers (métadonnées, géométrie maillage, marqueurs)
- **Cloud Storage** : fichiers lourds (images, vidéos, JSON keyframes/animation)

## Configuration

**Fichier :** `firebase.ts`
- Projet Firebase : `coloriage-anime-triangulation`
- Base Firestore nommée : `'coloriages'`
- Bucket Storage : `coloriage-anime-triangulation.firebasestorage.app`

## Collections Firestore

### `projects` (ProjectDoc)
```typescript
{
  name: string
  createdAt: number
  mesh: {
    anchorPoints: Point2D[]
    contourIndices: number[]
    internalPoints: Point2D[]
    triangles: { a: number, b: number, c: number }[]
    topologyLocked: boolean
    anchorTriangles: { a, b, c }[]
    internalBarycentrics: BarycentricRef[]
    keyframeInterval: number
    hasKeyframes: boolean           // Flag, données dans Storage
    hasAnchorFrames: boolean        // Flag, données dans Storage
    hasVideoFramesMesh: boolean     // Flag, données dans Storage
  } | null
  markers: MarkerCorners | null
}
```

### `scans` (ScanDoc)
```typescript
{
  projectId: string
  scannedAt: number
}
```

## Chemins Cloud Storage

```
projects/{projectId}/originalImage        → Blob image
projects/{projectId}/video                → Blob vidéo
projects/{projectId}/keyframes.json       → JSON KeyframeData[]
projects/{projectId}/anchorFrames.json    → JSON Point2D[][]
projects/{projectId}/videoFramesMesh.json → JSON Point2D[][]
scans/{scanId}/scanImage                  → Blob image rectifiée
```

## API (projectsStore.ts)

| Fonction | Description |
|----------|-------------|
| `createProject(name)` | Crée projet avec UUID |
| `getProject(id)` | Charge métadonnées + télécharge blobs + JSON Storage |
| `getAllProjects()` | Liste projets (métadonnées seules) |
| `updateProject(project, uploadOnly?)` | Sauvegarde sélective avec hints |
| `deleteProject(id)` | Supprime projet + scans + fichiers Storage |

### Upload Hints

`updateProject` accepte un tableau `uploadOnly` pour éviter les re-uploads inutiles :
- `'image'` — upload uniquement l'image
- `'video'` — upload uniquement la vidéo
- `'keyframes'` — upload keyframes.json
- `'anchorFrames'` — upload anchorFrames.json
- `'videoFramesMesh'` — upload videoFramesMesh.json

Sans hint, seules les métadonnées Firestore sont mises à jour.

## API (scansStore.ts)

| Fonction | Description |
|----------|-------------|
| `createScan(projectId, scanImageBlob)` | Crée scan + upload image |
| `getScan(id)` | Charge scan + blob |
| `getScansByProject(projectId)` | Liste scans (métadonnées) |
| `updateScan(scan)` | Met à jour scan + image |
| `deleteScan(id)` | Supprime document + fichier |

## Helpers internes

- `uploadBlob(path, blob)` — Upload vers Cloud Storage
- `downloadBlob(path)` — Télécharge blob, retourne `null` si échec

## Sérialisation triangles

Les triangles `[number, number, number][]` sont convertis en `{ a, b, c }[]` pour Firestore (qui ne supporte pas les arrays imbriqués). La conversion se fait dans `updateProject` / `getProject`.

## Historique

Migration depuis IndexedDB (commit `d2bda23`). L'ancienne implémentation utilisait deux object stores (`'projects'`, `'scans'`) dans une base `'coloringAppDB'`.

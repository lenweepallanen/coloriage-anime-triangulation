import { getDB } from './database';
import type { Scan } from '../types/project';

export async function createScan(projectId: string, scanImageBlob: Blob): Promise<Scan> {
  const db = await getDB();
  const scan: Scan = {
    id: crypto.randomUUID(),
    projectId,
    scannedAt: Date.now(),
    scanImageBlob,
    textureMap: null,
  };
  await db.put('scans', scan);
  return scan;
}

export async function getScan(id: string): Promise<Scan | undefined> {
  const db = await getDB();
  return db.get('scans', id);
}

export async function getScansByProject(projectId: string): Promise<Scan[]> {
  const db = await getDB();
  return db.getAllFromIndex('scans', 'byProject', projectId);
}

export async function updateScan(scan: Scan): Promise<void> {
  const db = await getDB();
  await db.put('scans', scan);
}

export async function deleteScan(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('scans', id);
}

import { getDB } from './database';
import type { Project } from '../types/project';

export async function createProject(name: string): Promise<Project> {
  const db = await getDB();
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    originalImageBlob: null,
    videoBlob: null,
    mesh: null,
    markers: null,
  };
  await db.put('projects', project);
  return project;
}

export async function getProject(id: string): Promise<Project | undefined> {
  const db = await getDB();
  return db.get('projects', id);
}

export async function getAllProjects(): Promise<Project[]> {
  const db = await getDB();
  return db.getAll('projects');
}

export async function updateProject(project: Project): Promise<void> {
  const db = await getDB();
  await db.put('projects', project);
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDB();
  // Delete associated scans first
  const tx = db.transaction(['projects', 'scans'], 'readwrite');
  const scansIndex = tx.objectStore('scans').index('byProject');
  let cursor = await scansIndex.openCursor(id);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.objectStore('projects').delete(id);
  await tx.done;
}

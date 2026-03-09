import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'coloringAppDB';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('scans')) {
          const scansStore = db.createObjectStore('scans', { keyPath: 'id' });
          scansStore.createIndex('byProject', 'projectId');
        }
      },
    });
  }
  return dbPromise;
}

// A small promise wrapper around IndexedDB. Playlists and file handles live
// here; settings stay in localStorage.

const DB_NAME = 'phosphor';
const DB_VERSION = 1;
export type StoreName = 'playlists' | 'handles';

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB is unavailable'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another open copy of Phosphor'));
  });
  return opening;
}

async function run<T>(store: StoreName, mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = body(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error ?? request.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export const db = {
  getAll<T>(store: StoreName): Promise<T[]> {
    return run(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },
  get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return run(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  },
  put<T>(store: StoreName, value: T): Promise<IDBValidKey> {
    return run(store, 'readwrite', (s) => s.put(value));
  },
  delete(store: StoreName, key: string): Promise<undefined> {
    return run(store, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
  },
};

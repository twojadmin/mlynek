import { initializeApp } from 'firebase/app';
import { getDatabase, connectDatabaseEmulator, ref, get, update } from 'firebase/database';
import { initializeAuth, inMemoryPersistence, connectAuthEmulator, signInWithEmailAndPassword, signOut } from 'firebase/auth';
window.MlynekFirebaseAdmin = { initializeApp, getDatabase, connectDatabaseEmulator, ref, get, update,
  initializeAuth, inMemoryPersistence, connectAuthEmulator, signInWithEmailAndPassword, signOut };

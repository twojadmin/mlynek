import { initializeApp } from 'firebase/app';
import { getDatabase, connectDatabaseEmulator, ref, onValue, set, update, remove, onDisconnect, serverTimestamp } from 'firebase/database';
window.MlynekFirebase = { initializeApp, getDatabase, connectDatabaseEmulator, ref, onValue, set, update, remove, onDisconnect, serverTimestamp };

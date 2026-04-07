import { getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseEnabled = Object.values(firebaseConfig).every(
  (value) => typeof value === 'string' && value.length > 0,
);

export const ROOM_COLLECTION = import.meta.env.VITE_FIREBASE_ROOM_COLLECTION || 'fitBetRooms';
export const PROFILE_COLLECTION =
  import.meta.env.VITE_FIREBASE_PROFILE_COLLECTION || 'fitBetProfiles';

let app = null;
let auth = null;
let db = null;

if (firebaseEnabled) {
  app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}

export { app, auth, db };

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from 'firebase/auth';
import { arrayUnion, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { PROFILE_COLLECTION, ROOM_COLLECTION, auth, db, firebaseEnabled } from './lib/firebase';
import authShowcaseImage from './assets/fit-bet-hero-people.jpg';

const CACHE_KEY = 'fit-bet-room-cache';
const ROOM_STORAGE_KEY = 'fit-bet-room-code';
const MONTHLY_ALERT_STORAGE_PREFIX = 'fit-bet-monthly-alert';
const RATE = 10;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EMPTY_WORKOUT_ENTRY = Object.freeze({
  workedOut: false,
  arrivalTime: '',
  leaveTime: '',
  weightKg: '',
});
const SIDE_OPTIONS = [
  { value: 'pink', label: 'Pink Side', emoji: '\uD83D\uDC96' },
  { value: 'blue', label: 'Blue Side', emoji: '\uD83D\uDC99' },
];
const AUTH_SHOWCASE_IMAGE = authShowcaseImage;
const HERO_SHOWCASE_IMAGE =
  'https://images.pexels.com/photos/3822726/pexels-photo-3822726.jpeg?auto=compress&cs=tinysrgb&w=1600';

function padDay(day) {
  return String(day).padStart(2, '0');
}

function formatMonthKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function createCalendarDays(viewDate) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();
  const cells = [];

  for (let index = 0; index < firstDay; index += 1) {
    cells.push(null);
  }

  for (let day = 1; day <= totalDays; day += 1) {
    cells.push(day);
  }

  return cells;
}

function formatMonthLabel(date) {
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function createEmptyWorkoutEntry() {
  return { ...EMPTY_WORKOUT_ENTRY };
}

function getDaysInMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function normalizeRoomCode(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}

function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  for (let index = 0; index < 8; index += 1) {
    const randomIndex = Math.floor(Math.random() * alphabet.length);
    code += alphabet[randomIndex];
  }

  return code;
}

function normalizeCalendarData(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const nextCalendar = {};

  for (const [monthKey, monthValue] of Object.entries(raw)) {
    if (!monthValue || typeof monthValue !== 'object' || Array.isArray(monthValue)) {
      continue;
    }

    const nextMonth = {};

    for (const [dayKey, dayValue] of Object.entries(monthValue)) {
      if (!dayValue || typeof dayValue !== 'object' || Array.isArray(dayValue)) {
        continue;
      }

      const nextDay = {};

      for (const [uid, checked] of Object.entries(dayValue)) {
        if (checked === true) {
          nextDay[uid] = {
            workedOut: true,
            arrivalTime: '',
            leaveTime: '',
            weightKg: '',
          };
          continue;
        }

        if (checked && typeof checked === 'object' && !Array.isArray(checked)) {
          const arrivalTime =
            typeof checked.arrivalTime === 'string' ? checked.arrivalTime : '';
          const leaveTime =
            typeof checked.leaveTime === 'string' ? checked.leaveTime : '';
          const rawWeight =
            typeof checked.weightKg === 'string' || typeof checked.weightKg === 'number'
              ? checked.weightKg
              : typeof checked.weight === 'string' || typeof checked.weight === 'number'
                ? checked.weight
                : '';
          const weightKg =
            rawWeight === '' ? '' : String(rawWeight);
          const workedOut = 
            typeof checked.workedOut === 'boolean' ? checked.workedOut : false;

          if (workedOut || arrivalTime || leaveTime || weightKg) {
            nextDay[uid] = {
              workedOut,
              arrivalTime,
              leaveTime,
              weightKg,
            };
          }
        }
      }

      if (Object.keys(nextDay).length > 0) {
        nextMonth[dayKey] = nextDay;
      }
    }

    if (Object.keys(nextMonth).length > 0) {
      nextCalendar[monthKey] = nextMonth;
    }
  }

  return nextCalendar;
}

function normalizeMembers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const nextMembers = {};

  for (const [uid, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    const side = value.side === 'blue' ? 'blue' : value.side === 'pink' ? 'pink' : null;

    if (!side) {
      continue;
    }

    nextMembers[uid] = {
      displayName: typeof value.displayName === 'string' ? value.displayName : '',
      side,
      email: typeof value.email === 'string' ? value.email : '',
    };
  }

  return nextMembers;
}

function readStoredCache() {
  if (typeof window === 'undefined') {
    return { calendarData: {}, members: {} };
  }

  try {
    const stored = window.localStorage.getItem(CACHE_KEY);

    if (!stored) {
      return { calendarData: {}, members: {} };
    }

    const parsed = JSON.parse(stored);

    if (parsed && typeof parsed === 'object' && ('calendarData' in parsed || 'members' in parsed)) {
      return {
        calendarData: normalizeCalendarData(parsed.calendarData),
        members: normalizeMembers(parsed.members),
      };
    }

    return {
      calendarData: normalizeCalendarData(parsed),
      members: {},
    };
  } catch {
    return { calendarData: {}, members: {} };
  }
}

function readStoredRoomCode() {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.localStorage.getItem(ROOM_STORAGE_KEY) ?? '';
}

function buildMemberPayload(profile, user) {
  return {
    displayName: profile.displayName,
    side: profile.side,
    email: user.email ?? '',
  };
}

function getUserFacingError(error, fallbackMessage) {
  if (error && typeof error === 'object' && 'code' in error) {
    const errorCode = error.code;

    if (
      errorCode === 'auth/invalid-api-key' ||
      errorCode === 'auth/api-key-not-valid.-please-pass-a-valid-api-key.'
    ) {
      return 'Your deployed app is using an invalid Firebase web API key. In Vercel, check VITE_FIREBASE_API_KEY, remove any quotes or extra spaces, save it for Production, and redeploy.';
    }

    if (errorCode === 'auth/configuration-not-found' || errorCode === 'auth/operation-not-allowed') {
      return 'Firebase Authentication is not fully configured yet. In Firebase Console, open Authentication, enable Email/Password under Sign-in method, save it, then refresh Fit Bet.';
    }

    if (errorCode === 'auth/app-not-authorized' || errorCode === 'auth/unauthorized-domain') {
      return 'This app domain is not authorized for your Firebase project. In Firebase Console, open Authentication settings and add this domain to Authorized domains, then refresh.';
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallbackMessage;
}

function getSyncLabel(syncStatus) {
  switch (syncStatus) {
    case 'setup-needed':
      return 'Firebase setup needed';
    case 'auth-checking':
      return 'Checking account';
    case 'signed-out':
      return 'Sign in required';
    case 'profile-needed':
      return 'Finish your profile';
    case 'connecting':
      return 'Connecting room';
    case 'saving':
      return 'Saving changes';
    case 'synced':
      return 'Shared live';
    case 'error':
      return 'Sync error';
    default:
      return 'Ready to log locally';
  }
}

function getDayMeta(dayEntry, members) {
  const sides = new Set();

  for (const [uid, entry] of Object.entries(dayEntry ?? {})) {
    if (!entry?.workedOut) {
      continue;
    }

    const side = members[uid]?.side;

    if (side) {
      sides.add(side);
    }
  }

  if (sides.has('pink') && sides.has('blue')) {
    return {
      status: 'both',
      label: 'Pink and Blue workout',
      emoji: '\uD83D\uDC96\u00A0\uD83D\uDC99',
    };
  }

  if (sides.has('pink')) {
    return {
      status: 'pink',
      label: 'Pink workout',
      emoji: '\uD83D\uDC96',
    };
  }

  if (sides.has('blue')) {
    return {
      status: 'blue',
      label: 'Blue workout',
      emoji: '\uD83D\uDC99',
    };
  }

  return {
    status: 'idle',
    label: 'No workout logged',
    emoji: '',
  };
}

function summarizeMonthEntries(monthEntries, members) {
  return Object.values(monthEntries ?? {}).reduce(
    (summary, dayEntries) => {
      for (const [uid, entry] of Object.entries(dayEntries ?? {})) {
        if (!entry?.workedOut) {
          continue;
        }

        const side = members[uid]?.side;

        if (side === 'pink') {
          summary.pinkDays += 1;
        }

        if (side === 'blue') {
          summary.blueDays += 1;
        }
      }

      return summary;
    },
    { pinkDays: 0, blueDays: 0 },
  );
}

function formatWorkoutDate(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function SidePicker({ value, onChange }) {
  return (
    <div className="side-chooser">
      {SIDE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`side-button ${value === option.value ? 'active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          <span>{option.emoji}</span>
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function AuthPage({
  authBusy,
  authError,
  authForm,
  authLoading,
  authMode,
  firebaseEnabled,
  handleAuthSubmit,
  setAuthError,
  setAuthForm,
  setAuthMode,
}) {
  return (
    <main className="auth-shell">
      <section className="auth-layout">
        <div
          className="auth-showcase"
          style={{ '--auth-showcase-image': `url(${AUTH_SHOWCASE_IMAGE})` }}
        >
          <div className="auth-orb auth-orb-pink" aria-hidden="true" />
          <div className="auth-orb auth-orb-blue" aria-hidden="true" />
          <div className="auth-showcase-top">
            <p className="eyebrow">FIT BET</p>
          </div>
          <h1>Keep the bet live.</h1>
          <p className="auth-subcopy">Two accounts. One shared calendar.</p>
          <p className="auth-subcopy">
            Log workouts, mark gym days, and compare Pink vs Blue in real time.
          </p>
        </div>

        <section className="auth-card">
          {!firebaseEnabled ? (
            <>
              <p className="panel-kicker">Setup needed</p>
              <h2>Add Firebase keys first</h2>
              <p className="auth-card-copy">Add your Firebase web config in <code>.env</code>.</p>
            </>
          ) : authLoading ? (
            <>
              <p className="panel-kicker">Checking session</p>
              <h2>Getting your account ready</h2>
              <p className="auth-card-copy">Checking for an active login on this device.</p>
            </>
          ) : (
            <>
              <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
                <button
                  type="button"
                  className={`auth-tab ${authMode === 'login' ? 'active' : ''}`}
                  onClick={() => {
                    setAuthMode('login');
                    setAuthError('');
                  }}
                >
                  Log in
                </button>
                <button
                  type="button"
                  className={`auth-tab ${authMode === 'signup' ? 'active' : ''}`}
                  onClick={() => {
                    setAuthMode('signup');
                    setAuthError('');
                  }}
                >
                  Create account
                </button>
              </div>

              <p className="panel-kicker">
                {authMode === 'signup' ? 'New profile' : 'Welcome back'}
              </p>
              <h2>
                {authMode === 'signup'
                  ? 'Start your side of the bet'
                  : 'Pick up where you left off'}
              </h2>
              <p className="auth-card-copy">
                {authMode === 'signup'
                  ? 'Create your account and choose your side.'
                  : 'Log in to your profile and keep logging right away.'}
              </p>

              <form className="stack-form auth-form" onSubmit={handleAuthSubmit}>
                <label className="field-label" htmlFor="auth-email">
                  Email
                </label>
                <input
                  id="auth-email"
                  className="text-input"
                  type="email"
                  value={authForm.email}
                  onChange={(event) =>
                    setAuthForm((current) => ({
                      ...current,
                      email: event.target.value,
                    }))
                  }
                  placeholder="you@example.com"
                />

                <label className="field-label" htmlFor="auth-password">
                  Password
                </label>
                <input
                  id="auth-password"
                  className="text-input"
                  type="password"
                  value={authForm.password}
                  onChange={(event) =>
                    setAuthForm((current) => ({
                      ...current,
                      password: event.target.value,
                    }))
                  }
                  placeholder="At least 6 characters"
                />

                {authMode === 'signup' ? (
                  <>
                    <label className="field-label" htmlFor="signup-name">
                      Display name
                    </label>
                    <input
                      id="signup-name"
                      className="text-input"
                      type="text"
                      value={authForm.displayName}
                      onChange={(event) =>
                        setAuthForm((current) => ({
                          ...current,
                          displayName: event.target.value,
                        }))
                      }
                      placeholder="Julia"
                    />
                  </>
                ) : null}

                {authMode === 'signup' ? (
                  <>
                    <span className="field-label">Choose your side</span>
                    <SidePicker
                      value={authForm.side}
                      onChange={(nextSide) =>
                        setAuthForm((current) => ({
                          ...current,
                          side: nextSide,
                        }))
                      }
                    />
                  </>
                ) : (
                  <p className="helper-note">
                    Missing profiles default to pink so you can log straight away.
                  </p>
                )}

                <div className="auth-submit-row">
                  <button type="submit" className="action-button primary" disabled={authBusy}>
                    {authBusy
                      ? 'Working...'
                      : authMode === 'signup'
                        ? 'Create account'
                        : 'Log in'}
                  </button>
                </div>
              </form>

              <p className="helper-note">
                Use one account per person.
              </p>
              {authError ? <p className="error-note">{authError}</p> : null}
            </>
          )}
        </section>
      </section>
    </main>
  );
}

export default function App() {
  const initialCache = useMemo(() => readStoredCache(), []);
  const [today, setToday] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState(() => new Date().getDate());
  const [viewDate, setViewDate] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [calendarData, setCalendarData] = useState(initialCache.calendarData);
  const [roomMembers, setRoomMembers] = useState(initialCache.members);
  const [roomCode, setRoomCode] = useState(() => normalizeRoomCode(readStoredRoomCode()));
  const [roomInput, setRoomInput] = useState(() => normalizeRoomCode(readStoredRoomCode()));
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(firebaseEnabled);
  const [profile, setProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [authMode, setAuthMode] = useState('signup');
  const [authBusy, setAuthBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [roomHydrated, setRoomHydrated] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [authError, setAuthError] = useState('');
  const [profileError, setProfileError] = useState('');
  const [roomError, setRoomError] = useState('');
  const [dayDetailsError, setDayDetailsError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [monthlyWinnerAlert, setMonthlyWinnerAlert] = useState(null);
  const [dayDetailsBusy, setDayDetailsBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeMenuPanel, setActiveMenuPanel] = useState('profile');
  const [authForm, setAuthForm] = useState({
    email: '',
    password: '',
    displayName: '',
    side: 'pink',
  });
  const [profileForm, setProfileForm] = useState({
    displayName: '',
    side: 'pink',
  });
  const [dayDetailsForm, setDayDetailsForm] = useState(() => createEmptyWorkoutEntry());

  const calendarDataRef = useRef(calendarData);
  const lastRemoteCalendarJsonRef = useRef(JSON.stringify(calendarData));

  useEffect(() => {
    calendarDataRef.current = calendarData;
  }, [calendarData]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setToday(new Date());
    }, 60000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    setSelectedDay((current) => Math.min(current, getDaysInMonth(viewDate)));
  }, [viewDate]);

  useEffect(() => {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        calendarData,
        members: roomMembers,
      }),
    );
  }, [calendarData, roomMembers]);

  useEffect(() => {
    if (roomCode) {
      window.localStorage.setItem(ROOM_STORAGE_KEY, roomCode);
      return;
    }

    window.localStorage.removeItem(ROOM_STORAGE_KEY);
  }, [roomCode]);

  useEffect(() => {
    if (!firebaseEnabled || !auth) {
      setAuthLoading(false);
      return undefined;
    }

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setAuthUser(user);
      setAuthLoading(false);
      setAuthError('');
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!firebaseEnabled || !db || !authUser) {
      setProfile(null);
      setProfileLoading(false);
      return undefined;
    }

    setProfileLoading(true);
    const profileRef = doc(db, PROFILE_COLLECTION, authUser.uid);

    const unsubscribe = onSnapshot(
      profileRef,
      (snapshot) => {
        setProfileLoading(false);
        setProfile(snapshot.exists() ? snapshot.data() : null);
        setProfileError('');
      },
      (error) => {
        setProfileLoading(false);
        setProfileError(getUserFacingError(error, 'We could not load your profile right now.'));
      },
    );

    return unsubscribe;
  }, [authUser]);

  useEffect(() => {
    if (!authUser) {
      setProfileForm({ displayName: '', side: 'pink' });
      return;
    }

    if (profile?.displayName && profile?.side) {
      setProfileForm({
        displayName: profile.displayName,
        side: profile.side,
      });
      return;
    }

    setProfileForm((current) => ({
      displayName: current.displayName || authUser.displayName || authUser.email?.split('@')[0] || '',
      side: current.side || 'pink',
    }));
  }, [authUser, profile?.displayName, profile?.side]);

  const effectiveProfile = useMemo(() => {
    if (!authUser) {
      return null;
    }

    const displayName =
      profile?.displayName?.trim() ||
      authUser.displayName?.trim() ||
      authUser.email?.split('@')[0] ||
      '';

    if (!displayName) {
      return null;
    }

    return {
      displayName,
      side: profile?.side === 'blue' || profile?.side === 'pink' ? profile.side : 'pink',
    };
  }, [authUser, profile?.displayName, profile?.side]);

  useEffect(() => {
    if (!firebaseEnabled || !db || !authUser || profileLoading || !effectiveProfile) {
      return undefined;
    }

    if (profile?.displayName && profile?.side) {
      return undefined;
    }

    const profileRef = doc(db, PROFILE_COLLECTION, authUser.uid);
    let cancelled = false;

    async function syncProfile() {
      try {
        await setDoc(
          profileRef,
          {
            displayName: effectiveProfile.displayName,
            side: effectiveProfile.side,
            email: authUser.email ?? '',
            ...(profile === null ? { createdAt: serverTimestamp() } : {}),
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );

        if (!cancelled) {
          setProfileError('');
        }
      } catch (error) {
        if (!cancelled) {
          setProfileError(getUserFacingError(error, 'We could not prepare your profile right now.'));
        }
      }
    }

    syncProfile();

    return () => {
      cancelled = true;
    };
  }, [authUser, db, effectiveProfile, profile, profileLoading]);

  useEffect(() => {
    if (
      !firebaseEnabled ||
      !db ||
      !authUser ||
      profileLoading ||
      !effectiveProfile?.displayName ||
      !effectiveProfile?.side ||
      !roomCode
    ) {
      setRoomHydrated(false);
      return undefined;
    }

    setRoomHydrated(false);
    setRoomError('');
    setCopyMessage('');

    const roomRef = doc(db, ROOM_COLLECTION, roomCode);

    const unsubscribe = onSnapshot(
      roomRef,
      async (snapshot) => {
        try {
          const memberPayload = buildMemberPayload(effectiveProfile, authUser);

          if (!snapshot.exists()) {
            const seedCalendar = calendarDataRef.current;

            lastRemoteCalendarJsonRef.current = JSON.stringify(seedCalendar);
            setRoomMembers((current) => ({
              ...current,
              [authUser.uid]: memberPayload,
            }));
            setRoomHydrated(true);

            await setDoc(
              roomRef,
              {
                calendarData: seedCalendar,
                members: {
                  [authUser.uid]: memberPayload,
                },
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
                memberUids: [authUser.uid],
                ownerUid: authUser.uid,
              },
              { merge: true },
            );

            return;
          }

          const snapshotData = snapshot.data() ?? {};
          const remoteCalendar = normalizeCalendarData(snapshotData.calendarData);
          const remoteMembers = normalizeMembers(snapshotData.members);
          const remoteCalendarJson = JSON.stringify(remoteCalendar);
          const remoteMembersJson = JSON.stringify(remoteMembers);

          lastRemoteCalendarJsonRef.current = remoteCalendarJson;
          setCalendarData((current) =>
            JSON.stringify(current) === remoteCalendarJson ? current : remoteCalendar,
          );
          setRoomMembers((current) =>
            JSON.stringify(current) === remoteMembersJson ? current : remoteMembers,
          );
          setRoomHydrated(true);
          setRoomError('');
        } catch (error) {
          setRoomHydrated(false);
          setRoomError(getUserFacingError(error, 'We could not connect this room right now.'));
        }
      },
      (error) => {
        setRoomHydrated(false);
        setRoomError(getUserFacingError(error, 'We could not connect this room right now.'));
      },
    );

    return () => {
      unsubscribe();
    };
  }, [authUser, effectiveProfile, profileLoading, roomCode]);

  useEffect(() => {
    if (
      !firebaseEnabled ||
      !db ||
      !authUser ||
      profileLoading ||
      !effectiveProfile?.displayName ||
      !effectiveProfile?.side ||
      !roomCode ||
      !roomHydrated
    ) {
      return undefined;
    }

    const roomRef = doc(db, ROOM_COLLECTION, roomCode);
    const memberPayload = buildMemberPayload(effectiveProfile, authUser);
    let cancelled = false;

    async function syncMemberProfile() {
      try {
        await setDoc(
          roomRef,
          {
            members: {
              [authUser.uid]: memberPayload,
            },
            memberUids: arrayUnion(authUser.uid),
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );

        if (!cancelled) {
          setRoomError('');
        }
      } catch (error) {
        if (!cancelled) {
          setRoomError(getUserFacingError(error, 'We could not sync your room profile right now.'));
        }
      }
    }

    syncMemberProfile();

    return () => {
      cancelled = true;
    };
  }, [authUser, effectiveProfile, profileLoading, roomCode, roomHydrated]);

  useEffect(() => {
    if (
      !firebaseEnabled ||
      !db ||
      !authUser ||
      profileLoading ||
      !effectiveProfile?.displayName ||
      !effectiveProfile?.side ||
      !roomCode ||
      !roomHydrated
    ) {
      return undefined;
    }

    const nextCalendarJson = JSON.stringify(calendarData);

    if (nextCalendarJson === lastRemoteCalendarJsonRef.current) {
      return undefined;
    }

    let cancelled = false;
    const roomRef = doc(db, ROOM_COLLECTION, roomCode);

    setIsSaving(true);

    async function pushCalendarChanges() {
      try {
        await setDoc(
          roomRef,
          {
            calendarData,
            updatedAt: serverTimestamp(),
            memberUids: arrayUnion(authUser.uid),
          },
          { merge: true },
        );

        if (!cancelled) {
          lastRemoteCalendarJsonRef.current = nextCalendarJson;
          setRoomError('');
          setIsSaving(false);
        }
      } catch (error) {
        if (!cancelled) {
          setRoomError(getUserFacingError(error, 'We could not save your workout update right now.'));
          setIsSaving(false);
        }
      }
    }

    pushCalendarChanges();

    return () => {
      cancelled = true;
    };
  }, [authUser, calendarData, effectiveProfile, profileLoading, roomCode, roomHydrated]);

  const resolvedMembers = useMemo(() => {
    const nextMembers = { ...roomMembers };

    if (authUser && effectiveProfile?.displayName && effectiveProfile?.side) {
      nextMembers[authUser.uid] = buildMemberPayload(effectiveProfile, authUser);
    }

    return nextMembers;
  }, [authUser, effectiveProfile, roomMembers]);

  const pinkMember = useMemo(
    () => Object.values(resolvedMembers).find((member) => member.side === 'pink') ?? null,
    [resolvedMembers],
  );
  const blueMember = useMemo(
    () => Object.values(resolvedMembers).find((member) => member.side === 'blue') ?? null,
    [resolvedMembers],
  );
  const monthKey = formatMonthKey(viewDate);
  const monthEntries = calendarData[monthKey] ?? {};
  const calendarDays = useMemo(() => createCalendarDays(viewDate), [viewDate]);
  const profileReady = Boolean(
    effectiveProfile?.displayName &&
      (effectiveProfile?.side === 'pink' || effectiveProfile?.side === 'blue'),
  );
  const canLog = Boolean(authUser && profileReady);
  const pinkDisplayName = pinkMember?.displayName ?? 'Pink Side';
  const blueDisplayName = blueMember?.displayName ?? 'Blue Side';
  const selectedDayKey = padDay(selectedDay);
  const selectedDate = new Date(viewDate.getFullYear(), viewDate.getMonth(), selectedDay);
  const selectedDateLabel = formatWorkoutDate(selectedDate);
  const selectedDayEntries = monthEntries[selectedDayKey] ?? {};
  const currentUserEntry = useMemo(() => {
    if (!authUser) {
      return EMPTY_WORKOUT_ENTRY;
    }

    return selectedDayEntries[authUser.uid] ?? EMPTY_WORKOUT_ENTRY;
  }, [authUser, selectedDayEntries]);

  useEffect(() => {
    setDayDetailsForm({ ...currentUserEntry });
    setDayDetailsError('');
    setDayDetailsBusy(false);
  }, [currentUserEntry, selectedDayKey, authUser?.uid]);

  useEffect(() => {
    if (!isSaving) {
      setDayDetailsBusy(false);
    }
  }, [isSaving]);

  const monthSummary = useMemo(
    () => summarizeMonthEntries(monthEntries, resolvedMembers),
    [monthEntries, resolvedMembers],
  );

  const pinkAmount = monthSummary.pinkDays * RATE;
  const blueAmount = monthSummary.blueDays * RATE;
  const difference = Math.abs(pinkAmount - blueAmount);

  let winnerMessage = 'Create both profiles and join the same room to start the live head-to-head bet.';
  if (pinkMember && blueMember) {
    if (pinkAmount === blueAmount) {
      winnerMessage = `${pinkMember.displayName} and ${blueMember.displayName} are tied right now.`;
    } else if (pinkAmount > blueAmount) {
      winnerMessage = `${pinkMember.displayName} is winning by R${difference}. ${blueMember.displayName} owes a catch-up session.`;
    } else {
      winnerMessage = `${blueMember.displayName} is winning by R${difference}. ${pinkMember.displayName} owes a catch-up session.`;
    }
  }

  const previousMonthAlertCandidate = useMemo(() => {
    if (today.getDate() !== 1 || !roomCode) {
      return null;
    }

    const previousMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const previousMonthKey = formatMonthKey(previousMonthDate);
    const previousMonthEntries = calendarData[previousMonthKey] ?? {};
    const previousMonthSummary = summarizeMonthEntries(previousMonthEntries, resolvedMembers);
    const previousPinkAmount = previousMonthSummary.pinkDays * RATE;
    const previousBlueAmount = previousMonthSummary.blueDays * RATE;
    const totalLoggedDays = previousMonthSummary.pinkDays + previousMonthSummary.blueDays;

    if (totalLoggedDays === 0) {
      return null;
    }

    const monthLabel = formatMonthLabel(previousMonthDate);
    const previousDifference = Math.abs(previousPinkAmount - previousBlueAmount);
    let title = `${monthLabel} ended in a draw`;
    let body = `${pinkDisplayName} and ${blueDisplayName} both finished on R${previousPinkAmount}.`;

    if (previousPinkAmount > previousBlueAmount) {
      title = `${pinkDisplayName} won ${monthLabel}`;
      body = `${pinkDisplayName} finished R${previousDifference} ahead. ${blueDisplayName} owes a catch-up session.`;
    } else if (previousBlueAmount > previousPinkAmount) {
      title = `${blueDisplayName} won ${monthLabel}`;
      body = `${blueDisplayName} finished R${previousDifference} ahead. ${pinkDisplayName} owes a catch-up session.`;
    }

    return {
      body,
      id: `${roomCode}-${previousMonthKey}`,
      monthLabel,
      summary: previousMonthSummary,
      title,
    };
  }, [blueDisplayName, calendarData, pinkDisplayName, resolvedMembers, roomCode, today]);

  useEffect(() => {
    if (!previousMonthAlertCandidate) {
      setMonthlyWinnerAlert(null);
      return;
    }

    const storageKey = `${MONTHLY_ALERT_STORAGE_PREFIX}:${previousMonthAlertCandidate.id}`;

    try {
      if (window.localStorage.getItem(storageKey) === 'seen') {
        setMonthlyWinnerAlert(null);
        return;
      }
    } catch {
      // Ignore local-storage access issues and show the alert anyway.
    }

    setMonthlyWinnerAlert(previousMonthAlertCandidate);
  }, [previousMonthAlertCandidate]);

  const selectedDayMemberSummaries = useMemo(() => {
    return [
      {
        key: 'pink',
        label: pinkDisplayName,
        side: 'pink',
        entry: pinkMember
          ? selectedDayEntries[
              Object.entries(resolvedMembers).find(([, member]) => member.side === 'pink')?.[0] ?? ''
            ] ?? null
          : null,
      },
      {
        key: 'blue',
        label: blueDisplayName,
        side: 'blue',
        entry: blueMember
          ? selectedDayEntries[
              Object.entries(resolvedMembers).find(([, member]) => member.side === 'blue')?.[0] ?? ''
            ] ?? null
          : null,
      },
    ];
  }, [blueDisplayName, blueMember, pinkDisplayName, pinkMember, resolvedMembers, selectedDayEntries]);

  const syncStatus = useMemo(() => {
    if (!firebaseEnabled) {
      return 'setup-needed';
    }

    if (authLoading) {
      return 'auth-checking';
    }

    if (!authUser) {
      return 'signed-out';
    }

    if (!profileReady || profileLoading) {
      return 'profile-needed';
    }

    if (roomError) {
      return 'error';
    }

    if (roomCode && !roomHydrated) {
      return 'connecting';
    }

    if (isSaving) {
      return 'saving';
    }

    if (roomCode) {
      return 'synced';
    }

    return 'ready';
  }, [authLoading, authUser, firebaseEnabled, isSaving, profileLoading, profileReady, roomCode, roomError, roomHydrated]);

  async function handleAuthSubmit(event) {
    event.preventDefault();

    if (!firebaseEnabled || !auth || !db) {
      return;
    }

    const email = authForm.email.trim();
    const password = authForm.password;
    const displayName = authForm.displayName.trim();

    if (!email || !password) {
      setAuthError('Add both your email and password first.');
      return;
    }

    if (authMode === 'signup' && !displayName) {
      setAuthError('Choose a display name for your profile.');
      return;
    }

    setAuthBusy(true);
    setAuthError('');

    try {
      if (authMode === 'signup') {
        const credentials = await createUserWithEmailAndPassword(auth, email, password);

        await updateProfile(credentials.user, {
          displayName,
        });

        await setDoc(
          doc(db, PROFILE_COLLECTION, credentials.user.uid),
          {
            displayName,
            side: authForm.side,
            email,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );

        setProfileForm({
          displayName,
          side: authForm.side,
        });
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }

      setAuthForm((current) => ({
        ...current,
        password: '',
      }));
    } catch (error) {
      setAuthError(getUserFacingError(error, 'We could not sign you in right now.'));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleProfileSave(event) {
    event.preventDefault();

    if (!firebaseEnabled || !db || !authUser) {
      return;
    }

    const displayName = profileForm.displayName.trim();

    if (!displayName) {
      setProfileError('Choose a display name for this profile.');
      return;
    }

    setProfileBusy(true);
    setProfileError('');

    try {
      if (auth.currentUser) {
        await updateProfile(auth.currentUser, {
          displayName,
        });
      }

      await setDoc(
        doc(db, PROFILE_COLLECTION, authUser.uid),
        {
          displayName,
          side: profileForm.side,
          email: authUser.email ?? '',
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    } catch (error) {
      setProfileError(getUserFacingError(error, 'We could not save your profile right now.'));
    } finally {
      setProfileBusy(false);
    }
  }

  async function handleSignOut() {
    if (!auth) {
      return;
    }

    try {
      await signOut(auth);
      setRoomHydrated(false);
      setCopyMessage('');
      setProfileError('');
    } catch (error) {
      setAuthError(getUserFacingError(error, 'We could not sign you out right now.'));
    }
  }

  async function handleLeaveRoomAndSignOut() {
    handleLeaveRoom();
    await handleSignOut();
  }

  async function handleCopyCode() {
    if (!roomCode || typeof navigator === 'undefined' || !navigator.clipboard) {
      setCopyMessage('Copy the room code manually for now.');
      return;
    }

    try {
      await navigator.clipboard.writeText(roomCode);
      setCopyMessage('Room code copied. Send it to the other profile.');
    } catch {
      setCopyMessage('Clipboard access was blocked, so copy the code manually.');
    }
  }

  function handleDismissMonthlyWinnerAlert() {
    if (!monthlyWinnerAlert) {
      return;
    }

    try {
      window.localStorage.setItem(
        `${MONTHLY_ALERT_STORAGE_PREFIX}:${monthlyWinnerAlert.id}`,
        'seen',
      );
    } catch {
      // Ignore local-storage access issues and dismiss in memory.
    }

    setMonthlyWinnerAlert(null);
  }

  function handleCreateRoom() {
    if (!profileReady) {
      setRoomError('Save your profile first so your side is attached to the room.');
      return;
    }

    const nextCode = generateRoomCode();
    setRoomInput(nextCode);
    setRoomCode(nextCode);
    setRoomHydrated(false);
    setRoomError('');
  }

  function handleJoinRoom() {
    if (!profileReady) {
      setRoomError('Save your profile first so your side is attached to the room.');
      return;
    }

    const nextCode = normalizeRoomCode(roomInput);

    if (!nextCode) {
      setRoomError('Enter a room code first.');
      return;
    }

    setRoomInput(nextCode);
    setRoomCode(nextCode);
    setRoomHydrated(false);
    setRoomError('');
  }

  function handleLeaveRoom() {
    setRoomCode('');
    setRoomInput('');
    setRoomHydrated(false);
    setRoomError('');
    setCopyMessage('');
    lastRemoteCalendarJsonRef.current = JSON.stringify(calendarDataRef.current);
  }

  function handleMonthChange(offset) {
    setViewDate((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  }

  function handleDayClick(day) {
    setSelectedDay(day);
  }

  function handleDayDetailsChange(field, value) {
    setDayDetailsForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function handleWorkedOutToggle() {
    setDayDetailsForm((current) => ({
      ...current,
      workedOut: !current.workedOut,
    }));
  }

  function handleClearDayDetails() {
    setDayDetailsForm(createEmptyWorkoutEntry());
    setDayDetailsError('');
  }

  function handleSaveDayDetails(event) {
    event.preventDefault();

    if (!canLog || !authUser) {
      setDayDetailsError('Sign in and save your profile first.');
      return;
    }

    if (dayDetailsForm.arrivalTime && dayDetailsForm.leaveTime && dayDetailsForm.leaveTime < dayDetailsForm.arrivalTime) {
      setDayDetailsError('Leaving time should be later than arrival time.');
      return;
    }

    const shouldAwaitRemoteSave = Boolean(roomCode && roomHydrated && !profileLoading);

    if (shouldAwaitRemoteSave) {
      setDayDetailsBusy(true);
    }

    setDayDetailsError('');

    const dayKey = selectedDayKey;
    const weightValue = String(dayDetailsForm.weightKg || '').trim();
    
    const nextEntry = {
      workedOut: dayDetailsForm.workedOut,
      arrivalTime: dayDetailsForm.arrivalTime,
      leaveTime: dayDetailsForm.leaveTime,
      weightKg: weightValue,
    };

    if (JSON.stringify(nextEntry) === JSON.stringify(currentUserEntry)) {
      if (shouldAwaitRemoteSave) {
        setDayDetailsBusy(false);
      }
      return;
    }

    const shouldKeepEntry =
      nextEntry.workedOut || nextEntry.arrivalTime || nextEntry.leaveTime || weightValue !== '';

    setCalendarData((current) => {
      const currentMonth = { ...(current[monthKey] ?? {}) };
      const currentDay = { ...(currentMonth[dayKey] ?? {}) };

      if (shouldKeepEntry) {
        currentDay[authUser.uid] = nextEntry;
      } else {
        delete currentDay[authUser.uid];
      }

      if (Object.keys(currentDay).length > 0) {
        currentMonth[dayKey] = currentDay;
      } else {
        delete currentMonth[dayKey];
      }

      if (Object.keys(currentMonth).length > 0) {
        return {
          ...current,
          [monthKey]: currentMonth,
        };
      }

      const nextCalendar = { ...current };
      delete nextCalendar[monthKey];
      return nextCalendar;
    });

    if (!shouldAwaitRemoteSave) {
      setDayDetailsBusy(false);
    }
  }

  if (!authUser) {
    return (
      <AuthPage
        authBusy={authBusy}
        authError={authError}
        authForm={authForm}
        authLoading={authLoading}
        authMode={authMode}
        firebaseEnabled={firebaseEnabled}
        handleAuthSubmit={handleAuthSubmit}
        setAuthError={setAuthError}
        setAuthForm={setAuthForm}
        setAuthMode={setAuthMode}
      />
    );
  }

  return (
    <main className="app-shell">
      {monthlyWinnerAlert ? (
        <div className="month-alert-overlay" role="presentation">
          <section className="month-alert-card" role="dialog" aria-modal="true" aria-labelledby="month-alert-title">
            <p className="month-alert-eyebrow">Previous Month Winner</p>
            <h2 id="month-alert-title">{monthlyWinnerAlert.title}</h2>
            <p className="month-alert-copy">{monthlyWinnerAlert.body}</p>
            <div className="month-alert-summary">
              <span>{monthlyWinnerAlert.monthLabel}</span>
              <span>Pink: R{monthlyWinnerAlert.summary.pinkDays * RATE}</span>
              <span>Blue: R{monthlyWinnerAlert.summary.blueDays * RATE}</span>
            </div>
            <div className="month-alert-actions">
              <button
                type="button"
                className="action-button primary"
                onClick={handleDismissMonthlyWinnerAlert}
              >
                Close alert
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <div className="app-topbar">
        <div className="topbar-menu">
          <button
            type="button"
            className={`menu-toggle ${menuOpen ? 'active' : ''}`}
            onClick={() => setMenuOpen((current) => !current)}
            aria-expanded={menuOpen}
            aria-controls="dashboard-menu"
            aria-label="Open menu"
          >
            <span />
            <span />
            <span />
          </button>

          {menuOpen ? (
            <>
              <button
                type="button"
                className="menu-scrim"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
              />

              <section
                id="dashboard-menu"
                className="menu-dropdown"
                role="dialog"
                aria-modal="true"
                aria-label="Dashboard menu"
              >
                <div className="menu-dropdown-inner">
                  <div className="menu-nav">
                    <p className="panel-kicker">Menu</p>
                    <button
                      type="button"
                      className={`menu-nav-button ${activeMenuPanel === 'profile' ? 'active' : ''}`}
                      onClick={() => setActiveMenuPanel('profile')}
                    >
                      Profile
                    </button>
                    <button
                      type="button"
                      className={`menu-nav-button ${activeMenuPanel === 'room' ? 'active' : ''}`}
                      onClick={() => setActiveMenuPanel('room')}
                    >
                      Shared room
                    </button>
                    <button
                      type="button"
                      className={`menu-nav-button ${activeMenuPanel === 'settings' ? 'active' : ''}`}
                      onClick={() => setActiveMenuPanel('settings')}
                    >
                      Settings
                    </button>
                  </div>

                  <div className="menu-panel">
                    {activeMenuPanel === 'profile' ? (
                      <div className="menu-panel-section">
                        <p className="panel-kicker">Profile</p>
                        <h3>Personal login and profile</h3>

                        <div className="account-summary">
                          <p className="room-note">
                            Signed in as <strong>{authUser.email ?? 'your account'}</strong>
                          </p>
                        </div>

                        {profileLoading ? (
                          <p className="helper-note">Loading your profile...</p>
                        ) : (
                          <>
                            <form className="stack-form" onSubmit={handleProfileSave}>
                              <label className="field-label" htmlFor="profile-name">
                                Display name
                              </label>
                              <input
                                id="profile-name"
                                className="text-input"
                                type="text"
                                value={profileForm.displayName}
                                onChange={(event) =>
                                  setProfileForm((current) => ({
                                    ...current,
                                    displayName: event.target.value,
                                  }))
                                }
                                placeholder="Julia"
                              />

                              <span className="field-label">Your side</span>
                              <SidePicker
                                value={profileForm.side}
                                onChange={(nextSide) =>
                                  setProfileForm((current) => ({
                                    ...current,
                                    side: nextSide,
                                  }))
                                }
                              />

                              <div className="room-actions single">
                                <button
                                  type="submit"
                                  className="action-button primary"
                                  disabled={profileBusy}
                                >
                                  {profileBusy ? 'Saving...' : profileReady ? 'Save profile changes' : 'Save profile'}
                                </button>
                              </div>
                            </form>

                            <p className="helper-note">
                              Choose opposite sides on the two accounts so the calendar can color your
                              bet correctly.
                            </p>
                          </>
                        )}

                        {authError ? <p className="error-note">{authError}</p> : null}
                        {profileError ? <p className="error-note">{profileError}</p> : null}
                      </div>
                    ) : null}

                    {activeMenuPanel === 'room' ? (
                      <div className="menu-panel-section">
                        <p className="panel-kicker">Shared room</p>
                        <h3>One room, two personal profiles</h3>
                        <p className="panel-note">
                          One of you creates a room code, the other joins it, and after that both
                          phones stay on the same live calendar.
                        </p>

                        {profileReady ? (
                          <>
                            <label className="field-label" htmlFor="room-code">
                              Shared room code
                            </label>
                            <div className="room-entry">
                              <input
                                id="room-code"
                                type="text"
                                value={roomInput}
                                placeholder="Enter or create a code"
                                onChange={(event) => setRoomInput(normalizeRoomCode(event.target.value))}
                              />
                            </div>

                            <div className="room-actions">
                              <button type="button" className="action-button primary" onClick={handleJoinRoom}>
                                Join room
                              </button>
                              <button type="button" className="action-button secondary" onClick={handleCreateRoom}>
                                New room
                              </button>
                            </div>

                            {roomCode ? (
                              <>
                                <p className="room-note">Active room: {roomCode}</p>
                                <div className="room-members">
                                  <p className="room-member-pill pink-member">
                                    {pinkMember ? `Pink: ${pinkMember.displayName}` : 'Pink: waiting for a profile'}
                                  </p>
                                  <p className="room-member-pill blue-member">
                                    {blueMember ? `Blue: ${blueMember.displayName}` : 'Blue: waiting for a profile'}
                                  </p>
                                </div>
                                <div className="room-actions single">
                                  <button
                                    type="button"
                                    className="action-button subtle"
                                    onClick={handleCopyCode}
                                  >
                                    Copy code
                                  </button>
                                </div>
                              </>
                            ) : null}

                            {copyMessage ? (
                              <p className="helper-note">{copyMessage}</p>
                            ) : (
                              <p className="helper-note">
                                Keep the room code private. Anyone with the code can join this shared bet.
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="helper-note">
                            Sign in and save your profile first. After that, you can create or join a
                            shared room from your own account.
                          </p>
                        )}

                        {roomError ? <p className="error-note">{roomError}</p> : null}
                      </div>
                    ) : null}

                    {activeMenuPanel === 'settings' ? (
                      <div className="menu-panel-section">
                        <p className="panel-kicker">Settings</p>
                        <h3>Room and device actions</h3>
                        <p className="panel-note">
                          Manage how this phone stays connected to the shared Fit Bet room.
                        </p>

                        <div className={`sync-pill ${syncStatus} sidebar-sync-pill`}>
                          <span className="sync-dot" />
                          <span>{getSyncLabel(syncStatus)}</span>
                        </div>

                        <div className="room-actions single">
                          <button
                            type="button"
                            className="action-button subtle"
                            onClick={handleLeaveRoom}
                            disabled={!roomCode}
                          >
                            Leave room on this phone
                          </button>
                        </div>

                        <div className="room-actions single">
                          <button
                            type="button"
                            className="action-button warning"
                            onClick={handleLeaveRoomAndSignOut}
                            disabled={!roomCode}
                          >
                            Leave room and log out
                          </button>
                        </div>

                        <p className="helper-note">
                          Use the top-right button if you only want to log out and keep this phone
                          connected to the room.
                        </p>
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>
            </>
          ) : null}
        </div>

        <button
          type="button"
          className="action-button subtle topbar-logout"
          onClick={handleSignOut}
        >
          Log out
        </button>
      </div>

      <section
        className="hero-card hero-card-image"
        style={{ '--hero-image': `url(${HERO_SHOWCASE_IMAGE})` }}
      >
        <div className="hero-copy">
          <p className="eyebrow">FIT BET</p>
          <h1>Turn gym consistency into a shared game.</h1>
          <p className="hero-text">
            Each of you logs workouts from your own personal profile, and the calendar turns violet
            automatically whenever you both show up on the same day.
          </p>
        </div>

        <div className="winner-banner">
          <span className="winner-label">This month</span>
          <p>{winnerMessage}</p>
          <div className={`sync-pill ${syncStatus}`}>
            <span className="sync-dot" />
            <span>{getSyncLabel(syncStatus)}</span>
          </div>
        </div>
      </section>

      <section className="scoreboard">
        <article className="score-card pink-card">
          <div>
            <p className="score-name">Pink Side</p>
            <h2>R{pinkAmount}</h2>
          </div>
          <p>{pinkMember ? `${pinkMember.displayName} - ${monthSummary.pinkDays} logged days` : 'Waiting for a pink profile'}</p>
        </article>

        <article className="score-card blue-card">
          <div>
            <p className="score-name">Blue Side</p>
            <h2>R{blueAmount}</h2>
          </div>
          <p>{blueMember ? `${blueMember.displayName} - ${monthSummary.blueDays} logged days` : 'Waiting for a blue profile'}</p>
        </article>
      </section>

      <section className="board-layout">
        <div className="board-main">
          <div className="calendar-card">
            <div className="calendar-toolbar">
              <button type="button" className="nav-button" onClick={() => handleMonthChange(-1)}>
                &larr;
              </button>

              <div>
                <p className="calendar-kicker">Monthly board</p>
                <h2>{viewDate.toLocaleString('en-US', { month: 'long', year: 'numeric' })}</h2>
              </div>

              <button type="button" className="nav-button" onClick={() => handleMonthChange(1)}>
                &rarr;
              </button>
            </div>

            <p className="calendar-helper">
              Pick a date to log your workout details. Violet appears automatically when both
              profiles mark a workout on the same day.
            </p>

            <div className="calendar-legend" aria-hidden="true">
              <span className="legend-item pink">
                <span className="legend-dot" />
                Pink logged
              </span>
              <span className="legend-item blue">
                <span className="legend-dot" />
                Blue logged
              </span>
              <span className="legend-item both">
                <span className="legend-dot" />
                Both logged
              </span>
            </div>

            <div className="weekday-row" aria-hidden="true">
              {WEEKDAYS.map((weekday) => (
                <span key={weekday}>{weekday}</span>
              ))}
            </div>

            <div className="calendar-grid">
              {calendarDays.map((day, index) => {
                if (day === null) {
                  return <div key={`blank-${index}`} className="calendar-cell calendar-empty" />;
                }

                const dayKey = padDay(day);
                const dayEntries = monthEntries[dayKey] ?? {};
                const { label, emoji, status } = getDayMeta(dayEntries, resolvedMembers);
                const isToday =
                  day === today.getDate() &&
                  viewDate.getMonth() === today.getMonth() &&
                  viewDate.getFullYear() === today.getFullYear();

                return (
                  <button
                    key={day}
                    type="button"
                    className={`calendar-cell ${status} ${isToday ? 'today' : ''} ${canLog ? '' : 'locked'}`}
                    onClick={() => handleDayClick(day)}
                    aria-label={`${label} for ${viewDate.toLocaleString('en-US', {
                      month: 'long',
                    })} ${day}`}
                  >
                    <span className="day-number">{day}</span>
                    <span className="day-mark">{emoji}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <section className="day-details-section">
            <div className="panel-card details-card">
              <p className="panel-kicker">Day details</p>
              <h3>{selectedDateLabel}</h3>
              <p className="panel-note">
                Save your arrival time, leaving time, and weight for this date. Monthly totals still
                only count days where you marked that you worked out.
              </p>

              <form className="stack-form day-details-form" onSubmit={handleSaveDayDetails}>
                <label className={`toggle-row ${dayDetailsForm.workedOut ? 'active' : ''}`}>
                  <input
                    type="checkbox"
                    checked={dayDetailsForm.workedOut}
                    onChange={handleWorkedOutToggle}
                    disabled={!canLog}
                  />
                  <span>I worked out on this day</span>
                </label>

                <div className="detail-grid">
                  <div>
                    <label className="field-label" htmlFor="arrival-time">
                      Arrival time
                    </label>
                    <input
                      id="arrival-time"
                      className="text-input"
                      type="time"
                      value={dayDetailsForm.arrivalTime}
                      onChange={(event) => handleDayDetailsChange('arrivalTime', event.target.value)}
                      disabled={!canLog}
                    />
                  </div>

                  <div>
                    <label className="field-label" htmlFor="leave-time">
                      Leaving time
                    </label>
                    <input
                      id="leave-time"
                      className="text-input"
                      type="time"
                      value={dayDetailsForm.leaveTime}
                      onChange={(event) => handleDayDetailsChange('leaveTime', event.target.value)}
                      disabled={!canLog}
                    />
                  </div>

                  <div className="detail-grid-span">
                    <label className="field-label" htmlFor="weight-kg">
                      Weight (kg)
                    </label>
                    <input
                      id="weight-kg"
                      className="text-input"
                      type="number"
                      min="0"
                      step="0.1"
                      value={dayDetailsForm.weightKg}
                      onChange={(event) => handleDayDetailsChange('weightKg', event.target.value)}
                      disabled={!canLog}
                      placeholder="80.5"
                    />
                  </div>
                </div>

                <div className="room-actions">
                  <button type="submit" className="action-button primary" disabled={!canLog || dayDetailsBusy}>
                    {dayDetailsBusy ? 'Saving...' : 'Save day details'}
                  </button>
                  <button
                    type="button"
                    className="action-button subtle"
                    onClick={handleClearDayDetails}
                    disabled={!canLog}
                  >
                    Clear my details
                  </button>
                </div>
              </form>

              {roomCode ? (
                <p className="helper-note">
                  Your details only update your own profile for this date. The other person updates
                  theirs from their own login.
                </p>
              ) : (
                <p className="helper-note">
                  You can log on this phone right away. Create or join a room whenever you want the
                  entries synced to both phones.
                </p>
              )}

              {dayDetailsError ? <p className="error-note">{dayDetailsError}</p> : null}

              <div className="day-participant-list">
                {selectedDayMemberSummaries.map((memberSummary) => (
                  <div
                    key={memberSummary.key}
                    className={`day-entry-card ${memberSummary.side}`}
                  >
                    <p className="day-entry-name">{memberSummary.label}</p>
                    {memberSummary.entry ? (
                      <>
                        <p>{memberSummary.entry.workedOut ? 'Workout logged' : 'No workout ticked'}</p>
                        <p>
                          Arrival:{' '}
                          {memberSummary.entry.arrivalTime || 'Not logged'}
                        </p>
                        <p>
                          Leaving:{' '}
                          {memberSummary.entry.leaveTime || 'Not logged'}
                        </p>
                        <p>
                          Weight:{' '}
                          {memberSummary.entry.weightKg ? `${memberSummary.entry.weightKg} kg` : 'Not logged'}
                        </p>
                      </>
                    ) : (
                      <p>No details logged for this day yet.</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>

      </section>
    </main>
  );
}

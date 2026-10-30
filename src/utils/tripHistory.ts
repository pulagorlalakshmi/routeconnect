export interface SavedTrip {
  id: number;
  from: string;
  to: string;
  date: string;
  time?: string;
  created_at?: string;
}

const STORAGE_KEY_PREFIX = 'my_trips_user_';
const GUEST_STORAGE_KEY = 'my_trips';

let idCounter = 0;
function nextId(): number {
  return Date.now() * 1000 + (idCounter++ % 1000);
}

export function getUserStorageKey(userId?: number | null): string {
  return userId ? `${STORAGE_KEY_PREFIX}${userId}` : GUEST_STORAGE_KEY;
}

export function getLocalTrips(userId?: number | null): SavedTrip[] {
  try {
    if (userId) {
      const userKey = `${STORAGE_KEY_PREFIX}${userId}`;
      const userStored = localStorage.getItem(userKey);
      return userStored ? JSON.parse(userStored) : [];
    }
    const stored = localStorage.getItem(GUEST_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export function saveLocalTrips(trips: SavedTrip[], userId?: number | null): void {
  try {
    if (userId) {
      localStorage.setItem(`${STORAGE_KEY_PREFIX}${userId}`, JSON.stringify(trips));
    } else {
      localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(trips));
    }
  } catch (e) {
    console.error('Failed to save trips locally:', e);
  }
}

export async function fetchServerTrips(sessionId: string): Promise<SavedTrip[] | null> {
  try {
    const res = await fetch('/api/user/trips', {
      headers: { Authorization: `Bearer ${sessionId}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.trips)) {
        return data.trips;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function recordSearchTrip(
  trip: { from: string; to: string; date: string; time?: string },
  user?: { id: number } | null,
  sessionId?: string | null
): Promise<SavedTrip[]> {
  const cleanFrom = trip.from.trim();
  const cleanTo = trip.to.trim();
  const cleanDate = trip.date;
  const cleanTime = trip.time || '';

  if (!cleanFrom || !cleanTo || !cleanDate) {
    return getLocalTrips(user?.id);
  }

  const currentTrips = getLocalTrips(user?.id);
  const isDup = currentTrips.some(
    t =>
      t.from.toLowerCase() === cleanFrom.toLowerCase() &&
      t.to.toLowerCase() === cleanTo.toLowerCase() &&
      t.date === cleanDate &&
      (t.time ?? '') === cleanTime
  );

  let updatedTrips = currentTrips;
  if (!isDup) {
    const newEntry: SavedTrip = {
      id: nextId(),
      from: cleanFrom,
      to: cleanTo,
      date: cleanDate,
      time: cleanTime || undefined
    };
    updatedTrips = [newEntry, ...currentTrips];
    saveLocalTrips(updatedTrips, user?.id);
  }

  // If user is signed in, sync to server
  if (user && sessionId) {
    try {
      const res = await fetch('/api/user/trips', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`
        },
        body: JSON.stringify({
          from: cleanFrom,
          to: cleanTo,
          date: cleanDate,
          time: cleanTime || null
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.trip && !isDup) {
          updatedTrips = updatedTrips.map(t => (t.id === updatedTrips[0]?.id ? { ...t, id: data.trip.id } : t));
          saveLocalTrips(updatedTrips, user.id);
        }
      }
    } catch (e) {
      console.error('Failed to sync search to server:', e);
    }
  }

  return updatedTrips;
}

export async function removeTripFromHistory(
  id: number,
  user?: { id: number } | null,
  sessionId?: string | null
): Promise<SavedTrip[]> {
  const currentTrips = getLocalTrips(user?.id);
  const updatedTrips = currentTrips.filter(t => t.id !== id);
  saveLocalTrips(updatedTrips, user?.id);

  if (user && sessionId) {
    try {
      await fetch(`/api/user/trips/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${sessionId}` }
      });
    } catch (e) {
      console.error('Failed to delete trip from server:', e);
    }
  }

  return updatedTrips;
}

export async function syncPendingTripsWithServer(
  sessionId?: string | null,
  userId?: number | null
): Promise<SavedTrip[]> {
  if (!userId) return getLocalTrips(null);
  try {
    const local = getLocalTrips(userId);
    const guest = getLocalTrips(null);
    const combined = [...local];
    for (const g of guest) {
      if (
        !combined.some(
          c =>
            c.from.toLowerCase() === g.from.toLowerCase() &&
            c.to.toLowerCase() === g.to.toLowerCase() &&
            c.date === g.date &&
            (c.time ?? '') === (g.time ?? '')
        )
      ) {
        combined.push(g);
      }
    }

    if (sessionId) {
      try {
        const res = await fetch('/api/user/trips/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionId}`
          },
          body: JSON.stringify({ trips: combined })
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.trips)) {
            saveLocalTrips(data.trips, userId);
            return data.trips;
          }
        }
      } catch (err) {
        console.error('Server sync failed, keeping local merged trips:', err);
      }
    }
    saveLocalTrips(combined, userId);
    return combined;
  } catch (e) {
    console.error('Failed to sync trips on sign-in:', e);
    return getLocalTrips(userId);
  }
}

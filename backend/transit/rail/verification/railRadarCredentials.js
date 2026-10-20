// RailRadar credentials: which API key the backend uses, its quota state, and the failover policy.
//
//   RAILRADAR_API_KEY=...            primary credential                       (server-side .env only; never logged)
//   RAILRADAR_BACKUP_API_KEY=...     optional second credential
//   RAILRADAR_ACTIVE_KEY=primary     which credential is preferred: primary | backup (a deliberate, operator-made switch)
//   RAILRADAR_KEY_FAILOVER=off       off  (default) - only the preferred credential is ever used
//                                    auth           - if the active credential is REJECTED (401/403: invalid / revoked),
//                                                     the other one is used instead
//                                    quota          - as "auth", and also when the active credential's monthly allowance
//                                                     is used up (RailRadar reports 0 remaining, or this process's budget
//                                                     is reached) or RailRadar rate-limits it (429). The preferred key is
//                                                     always tried first, so it is used again as soon as it recovers
//                                                     (rate-limit cooldown over, or a new month).
//   RAILRADAR_MONTHLY_REQUEST_BUDGET=100   per credential; this process stops using a credential at it
//
// "quota" combines the allowances of two RailRadar accounts. Enable it only with RailRadar's permission for this
// application (RouteConnect's operator has that confirmation; keep it on file). Provider-wide failures (timeouts,
// network errors, 5xx) never switch credentials: the other key would fail the same way and only spend more quota.
// Key values never leave this module except in the Authorization header built for a request.

const SLOTS = Object.freeze([
  { id: 'primary', envName: 'RAILRADAR_API_KEY' },
  { id: 'backup', envName: 'RAILRADAR_BACKUP_API_KEY' }
]);
export const FAILOVER_MODES = Object.freeze(['off', 'auth', 'quota']);
const DEFAULT_COOLDOWN_SECONDS = 60;
const MAX_COOLDOWN_SECONDS = 3600;

const monthOf = now => now.toISOString().slice(0, 7);

export function createCredentialManager({ env = process.env, disabled = false, now = () => new Date() } = {}) {
  const budget = Number(env.RAILRADAR_MONTHLY_REQUEST_BUDGET) > 0 ? Number(env.RAILRADAR_MONTHLY_REQUEST_BUDGET) : 100;
  const failover = FAILOVER_MODES.includes(env.RAILRADAR_KEY_FAILOVER) ? env.RAILRADAR_KEY_FAILOVER : 'off';
  // Key values are held in a closure-private Map, never on an object that could be serialised or logged.
  const secrets = new Map();
  const credentials = SLOTS.map(slot => {
    const value = disabled ? '' : String(env[slot.envName] ?? '').trim();
    if (value) secrets.set(slot.id, value);
    return { id: slot.id, envName: slot.envName, present: Boolean(value), rejected: false, month: null, used: 0, providerRemaining: null, coolUntil: 0 };
  });
  const requested = env.RAILRADAR_ACTIVE_KEY === 'backup' ? 'backup' : 'primary';
  const order = requested === 'backup' ? ['backup', 'primary'] : ['primary', 'backup'];
  const byId = id => credentials.find(c => c.id === id);
  // "off" / "auth": a sticky active credential (the requested one; with failover on, the other if it is missing).
  // "quota": chosen per request (see current()).
  let activeId = byId(requested).present ? requested : null;
  if (!activeId && failover !== 'off') activeId = credentials.find(c => c.present)?.id ?? null;
  let lastFailover = null;

  const rollMonth = credential => {
    const current = monthOf(now());
    if (credential.month !== current) { credential.month = current; credential.used = 0; credential.providerRemaining = null; }
  };
  const exhausted = credential => {
    rollMonth(credential);
    return credential.used >= budget || credential.providerRemaining === 0;
  };
  const coolingDown = credential => credential.coolUntil > now().getTime();
  const usable = credential => credential.present && !credential.rejected && !exhausted(credential) && !coolingDown(credential);

  // The credential requests go to now: in "quota" mode the first usable one in preference order.
  const current = () => {
    if (failover === 'quota') return order.map(byId).find(usable) ?? null;
    return activeId ? byId(activeId) : null;
  };
  const switchedAway = (fromId, reason) => {
    const next = current();
    if (!next || next.id === fromId) return false;
    lastFailover = { from: fromId, to: next.id, reason, at: now().toISOString() };
    return true;
  };

  function availability() {
    if (!credentials.some(c => c.present)) return { available: false, code: 'NOT_CONFIGURED', reason: 'Scheduled train search is not configured (no RailRadar API key on the server).' };
    const active = current();
    if (active && usable(active)) return { available: true, credentialId: active.id };
    if (failover === 'quota') {
      // Nothing usable: report why, about the configured credentials as a whole.
      const present = credentials.filter(c => c.present);
      if (present.every(c => c.rejected)) return { available: false, code: 'UNAUTHORIZED', reason: 'RailRadar rejected every configured API key.' };
      if (present.some(c => !c.rejected && !exhausted(c) && coolingDown(c))) return { available: false, code: 'RATE_LIMITED', reason: 'RailRadar is rate-limiting requests; train schedules will be back shortly.' };
      return { available: false, code: 'BUDGET_EXHAUSTED', reason: 'The scheduled-train request allowance for this month is used up on every configured RailRadar key; train schedules are unavailable until it resets.' };
    }
    if (!active) return { available: false, code: 'NOT_CONFIGURED', reason: `The selected RailRadar credential (${requested}) is not configured on the server.` };
    if (active.rejected) return { available: false, code: 'UNAUTHORIZED', reason: 'RailRadar rejected the configured API key.' };
    if (exhausted(active)) return { available: false, code: 'BUDGET_EXHAUSTED', reason: 'The scheduled-train request allowance for this month is used up; train schedules are unavailable until it resets.' };
    return { available: false, code: 'RATE_LIMITED', reason: 'RailRadar is rate-limiting requests; train schedules will be back shortly.' };
  }

  return {
    failover,
    availability,

    /** Reserve one request on the current credential; returns its Authorization header value, or throws. */
    acquire() {
      const state = availability();
      if (!state.available) throw Object.assign(new Error(state.reason), { code: state.code });
      const credential = byId(state.credentialId);
      credential.used++;
      return { credentialId: credential.id, authorization: `Bearer ${secrets.get(credential.id)}` };
    },

    /**
     * Record RailRadar's own remaining-quota header for the credential that made the request. Returns true when this
     * used the credential up and the next request will go to the other one ("quota" mode).
     */
    recordQuota(credentialId, remaining) {
      const credential = byId(credentialId);
      if (!credential || !Number.isFinite(remaining)) return false;
      rollMonth(credential);
      credential.providerRemaining = remaining;
      return remaining === 0 && failover === 'quota' && switchedAway(credentialId, 'quota_exhausted');
    },

    /**
     * The credential was rejected (401/403). Returns true when another credential takes over (the caller retries once):
     * failover "auth" or "quota", and another usable credential.
     */
    reject(credentialId) {
      const credential = byId(credentialId);
      if (credential) credential.rejected = true;
      if (failover === 'off') return false;
      if (failover === 'auth') {
        const other = credentials.find(c => c.id !== credentialId && c.present && !c.rejected);
        if (!other) return false;
        activeId = other.id;
        lastFailover = { from: credentialId, to: other.id, reason: 'rejected', at: now().toISOString() };
        return true;
      }
      return switchedAway(credentialId, 'rejected');
    },

    /**
     * RailRadar rate-limited the credential (429). It rests for Retry-After seconds (default 60, at most an hour);
     * returns true when another credential takes over ("quota" mode only; the caller retries once).
     */
    rateLimited(credentialId, retryAfterSeconds) {
      const credential = byId(credentialId);
      if (!credential) return false;
      const seconds = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? Math.min(retryAfterSeconds, MAX_COOLDOWN_SECONDS) : DEFAULT_COOLDOWN_SECONDS;
      credential.coolUntil = now().getTime() + seconds * 1000;
      return failover === 'quota' && switchedAway(credentialId, 'rate_limited');
    },

    /** Safe summary for diagnostics: presence, state and usage only, never a key value. */
    summary() {
      const active = current();
      return {
        active: active && usable(active) ? active.id : null,
        preferred: requested,
        failover,
        budgetPerCredential: budget,
        lastFailover,
        credentials: credentials.map(c => {
          rollMonth(c);
          return {
            id: c.id, envName: c.envName, present: c.present,
            state: !c.present ? 'not_configured' : c.rejected ? 'rejected' : exhausted(c) ? 'quota_exhausted' : coolingDown(c) ? 'rate_limited' : c.id === active?.id ? 'active' : 'standby',
            usedThisMonth: c.used, providerRemaining: c.providerRemaining
          };
        })
      };
    }
  };
}

/**
 * TripStateMachine.js — MyMilesAI Build 214 (Phase 2)
 *
 * Pure-JS state machine for auto-detecting drives. Consumes events from
 * react-native-background-geolocation (Transistorsoft) in production via
 * App.js SDK bindings. Tonight: used in the PWA with synthetic events
 * (window.__tsmInject*) for browser-based validation before native wiring.
 *
 * Architecture reference: MyMilesAI_Build210_Architecture.docx
 *   - Section 4.1: Five states
 *   - Section 4.2: Tunable parameters
 *   - Section 4.3: Edge cases
 *   - Section 5.1: Native → PWA message contract
 *   - Section 9.1: Unit-testable in isolation (this file has zero RN deps)
 *
 * IMPORTANT: This module is deliberately free of React Native, Expo, and
 * native imports so it can run in Node/Jest for unit tests. The SDK wiring
 * lives in App.js and just calls sm.ingestLocation() / sm.ingestMotion() /
 * sm.ingestActivity().
 */

'use strict';

// ─── States (Section 4.1) ────────────────────────────────────────────────
const STATES = Object.freeze({
  IDLE:      'IDLE',
  POTENTIAL: 'POTENTIAL',
  IN_TRIP:   'IN_TRIP',
  ENDING:    'ENDING',
  COMPLETED: 'COMPLETED',
});

// ─── Default tunable parameters (Section 4.2) ────────────────────────────
// Every value is documented. Every value is overridable via constructor opts.
// NEVER hardcode these in downstream code — always read from sm.params.
const DEFAULT_PARAMS = Object.freeze({
  // POTENTIAL → IN_TRIP promotion
  // Promotion fires when (speed exceeded MIN_TRIP_SPEED_MPH) AND
  // either (confirmation time elapsed) OR (cumulative distance exceeded).
  // The distance alternate handles short-but-real drives (parking lot exits,
  // quick errands) that wouldn't hit the 60s gate.
  MIN_TRIP_SPEED_MPH:          10,    // above walking/running speed
  MIN_TRIP_CONFIRM_SECS:       60,    // sustained-movement confirmation window
  MIN_POTENTIAL_DISTANCE_MI:   0.05,  // alternate promotion: >80m traveled
  ACTIVITY_VEHICLE_CONFIDENCE: 75,    // SDK activity confidence threshold (%)

  // IN_TRIP recording
  DISTANCE_FILTER_METERS:      10,    // SDK records a point every 10m

  // IN_TRIP → ENDING
  ENDING_STOP_SPEED_MPH:       2,     // sub-2mph counts as stopped
  ENDING_STOP_SECS:            180,   // 3 minutes stopped = possibly ending

  // ENDING → COMPLETED
  COMPLETE_STOP_SECS:          300,   // 5 minutes total stopped = trip ended

  // Trip emission filter
  MIN_TRIP_DISTANCE_MILES:     0.3,   // drop parking-lot repositioning

  // GPS loss tolerance (Section 4.3)
  GPS_GAP_INTERPOLATE_SECS:    30,    // gaps ≤30s interpolated; >30s split
});

// ─── Constants ──────────────────────────────────────────────────────────
const MPS_TO_MPH = 2.236936;
const METERS_PER_MILE = 1609.344;
const EARTH_R_METERS = 6371000;

// ─── Haversine distance (meters) ────────────────────────────────────────
function haversineMeters(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return 0;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng/2) ** 2;
  return 2 * EARTH_R_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ─── UID generator (trip_uid contract, Section 5.1) ─────────────────────
// Format: t_<ts>_<rand8> — matches existing trip_uid schema in Supabase
function genTripUid(ts) {
  const r = Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8,'0');
  return `t_${ts}_${r}`;
}

// ─── TripStateMachine ───────────────────────────────────────────────────
class TripStateMachine {
  /**
   * @param {object} [opts]
   * @param {object} [opts.params]  override DEFAULT_PARAMS
   * @param {function} [opts.emit]  (eventName, payload) => void  — bridge to PWA
   * @param {function} [opts.now]   () => number(ms)  — injectable clock for tests
   * @param {function} [opts.log]   (...args) => void  — injectable logger
   */
  constructor(opts = {}) {
    this.params = Object.freeze({ ...DEFAULT_PARAMS, ...(opts.params || {}) });
    this._emit  = opts.emit || (() => {});
    this._now   = opts.now  || (() => Date.now());
    this._log   = opts.log  || (() => {});

    this.state = STATES.IDLE;

    // Rolling context
    this._lastActivity = null;           // { type, confidence, ts }
    this._isMoving = false;              // last onMotionChange value

    // Active trip buffer (null in IDLE)
    this._trip = null;

    // POTENTIAL confirmation window — first position that crossed speed threshold
    this._potentialSince = null;         // epoch ms
    this._potentialStartPos = null;      // captured to seed IN_TRIP if promoted
    this._potentialLastPos = null;       // last position during POTENTIAL
    this._potentialDistanceM = 0;        // cumulative meters since POTENTIAL start

    // Stop tracking — first location under ENDING_STOP_SPEED_MPH
    this._stoppedSince = null;           // epoch ms
  }

  // ───── Public getters (for tests + UI introspection) ─────
  getState()       { return this.state; }
  getActiveTrip()  { return this._trip ? { ...this._trip, positions: [...this._trip.positions] } : null; }
  getParams()      { return this.params; }

  // ───── Ingest APIs — called from App.js SDK bindings ─────

  /**
   * Called from BackgroundGeolocation.onMotionChange(event).
   * @param {boolean} isMoving
   * @param {number}  [ts]   epoch ms; defaults to now
   */
  ingestMotion(isMoving, ts) {
    const t = ts != null ? ts : this._now();
    this._isMoving = !!isMoving;
    this._log('[TSM] motion', isMoving, 'state=', this.state);

    if (!isMoving) {
      // Stopped. IDLE stays IDLE; POTENTIAL aborts back to IDLE; IN_TRIP moves to ENDING.
      if (this.state === STATES.POTENTIAL) {
        this._resetPotential();
        this._transition(STATES.IDLE, t, 'motion_stopped_during_potential');
      } else if (this.state === STATES.IN_TRIP) {
        this._stoppedSince = t;
        this._transition(STATES.ENDING, t, 'motion_stopped');
      }
      // ENDING stays in ENDING; COMPLETED is transient and already handled.
      return;
    }

    // Moving
    if (this.state === STATES.IDLE) {
      this._potentialSince = t;
      this._potentialStartPos = null;   // will be set on first qualifying onLocation
      this._transition(STATES.POTENTIAL, t, 'motion_started');
    } else if (this.state === STATES.ENDING) {
      // Movement resumed before COMPLETE_STOP_SECS elapsed — resume trip
      this._stoppedSince = null;
      this._transition(STATES.IN_TRIP, t, 'motion_resumed');
    }
  }

  /**
   * Called from BackgroundGeolocation.onActivityChange(event).
   * @param {string} type        'in_vehicle'|'on_bicycle'|'on_foot'|'still'|'unknown'
   * @param {number} confidence  0–100
   * @param {number} [ts]
   */
  ingestActivity(type, confidence, ts) {
    const t = ts != null ? ts : this._now();
    this._lastActivity = { type, confidence, ts: t };
    this._log('[TSM] activity', type, confidence);
    // Activity alone doesn't drive transitions; it's a gate inside _maybePromoteToTrip.
  }

  /**
   * Called from BackgroundGeolocation.onLocation(location).
   * @param {object} loc  { lat, lng, speed(m/s), accuracy(m), ts(ms), altitude? }
   */
  ingestLocation(loc) {
    if (!loc || !isFinite(loc.lat) || !isFinite(loc.lng)) return;
    const t = loc.ts != null ? loc.ts : this._now();
    const speedMph = (loc.speed != null && loc.speed >= 0) ? loc.speed * MPS_TO_MPH : 0;

    // Normalize position record
    const pos = {
      lat: loc.lat,
      lng: loc.lng,
      ts: t,
      accuracy: loc.accuracy != null ? loc.accuracy : null,
      speed_mph: speedMph,
    };

    switch (this.state) {
      case STATES.IDLE:
        // Hold position; promotion requires motion event + sustained speed.
        break;

      case STATES.POTENTIAL:
        if (!this._potentialStartPos) {
          this._potentialStartPos = pos;
          this._potentialLastPos = pos;
          this._potentialDistanceM = 0;
        } else {
          // Accumulate distance since POTENTIAL started — used as the
          // alternate promotion gate for short-but-real trips.
          const dM = haversineMeters(
            this._potentialLastPos.lat, this._potentialLastPos.lng,
            pos.lat, pos.lng
          );
          if (dM >= 2) this._potentialDistanceM += dM;
          this._potentialLastPos = pos;
        }
        this._maybePromoteToTrip(pos, t);
        break;

      case STATES.IN_TRIP:
        this._appendTripPosition(pos);
        this._checkInTripStopping(pos, t);
        break;

      case STATES.ENDING:
        // Keep appending positions — if we resume, they're part of the trip.
        this._appendTripPosition(pos);
        if (speedMph >= this.params.ENDING_STOP_SPEED_MPH) {
          // Moving again — back to IN_TRIP
          this._stoppedSince = null;
          this._transition(STATES.IN_TRIP, t, 'speed_resumed');
        } else {
          this._checkEndingComplete(t);
        }
        break;

      default:
        break;
    }
  }

  /**
   * Tick — called by a setInterval in App.js (e.g. every 10s).
   * Required because a stopped device emits no onLocation events, so we need
   * a clock-driven path to fire ENDING→COMPLETED when COMPLETE_STOP_SECS elapses.
   * @param {number} [ts]
   */
  tick(ts) {
    const t = ts != null ? ts : this._now();
    if (this.state === STATES.ENDING) this._checkEndingComplete(t);
    if (this.state === STATES.IN_TRIP && this._stoppedSince) {
      // Guard — in case motion event was missed but we see no movement via tick
      if (t - this._stoppedSince >= this.params.ENDING_STOP_SECS * 1000) {
        this._transition(STATES.ENDING, t, 'tick_stop_detected');
      }
    }
  }

  /**
   * Reset to IDLE. Used on user sign-out, or if PWA sends stop_tracking.
   * Discards any active trip without emitting (do NOT save half-trips here).
   */
  reset(reason) {
    this._trip = null;
    this._resetPotential();
    this._stoppedSince = null;
    this._isMoving = false;
    this._transition(STATES.IDLE, this._now(), reason || 'external_reset');
  }

  // ───── Internal ─────

  _resetPotential() {
    this._potentialSince = null;
    this._potentialStartPos = null;
    this._potentialLastPos = null;
    this._potentialDistanceM = 0;
  }

  _transition(next, ts, reason) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this._log('[TSM]', prev, '→', next, '(', reason, ')');
    this._emit('state_changed', { from: prev, to: next, ts, reason });

    if (next === STATES.IN_TRIP && !this._trip) this._startTrip(ts);
    if (next === STATES.COMPLETED) this._finalizeTrip(ts);
    if (next === STATES.IDLE) this._trip = null;
  }

  _maybePromoteToTrip(pos, t) {
    // Gate 1: speed must have exceeded MIN_TRIP_SPEED_MPH at least once.
    // Gate 2: EITHER confirmation window (MIN_TRIP_CONFIRM_SECS) has elapsed
    //         OR cumulative distance exceeds MIN_POTENTIAL_DISTANCE_MI (the
    //         alternate path for short-but-real trips that wouldn't hit the
    //         time gate — e.g. parking lot exit + 30s drive).
    // Gate 3: activity should be in_vehicle at >= ACTIVITY_VEHICLE_CONFIDENCE
    //         — but we accept missing activity data (some devices don't emit it)
    //         to avoid failing to detect trips on older hardware.
    const p = this.params;

    if (pos.speed_mph < p.MIN_TRIP_SPEED_MPH) return;

    const elapsed = t - this._potentialSince;
    const distanceMi = (this._potentialDistanceM || 0) / METERS_PER_MILE;
    const timeReady = elapsed >= p.MIN_TRIP_CONFIRM_SECS * 1000;
    const distanceReady = distanceMi >= p.MIN_POTENTIAL_DISTANCE_MI;
    if (!timeReady && !distanceReady) return;

    // Activity gate (soft — only rejects if we have data AND it's clearly wrong)
    if (this._lastActivity) {
      const a = this._lastActivity;
      const recent = (t - a.ts) < 120 * 1000;   // activity sample within 2 min
      if (recent) {
        const isVehicle = a.type === 'in_vehicle' && a.confidence >= p.ACTIVITY_VEHICLE_CONFIDENCE;
        const isWalking = (a.type === 'on_foot' || a.type === 'walking' || a.type === 'running')
                           && a.confidence >= p.ACTIVITY_VEHICLE_CONFIDENCE;
        if (isWalking && !isVehicle) {
          // High-confidence walk — do NOT promote even if speed spiked (GPS noise)
          return;
        }
        // If activity says in_vehicle, we're good. If unknown/still but speed
        // is sustained, we trust speed (soft gate).
      }
    }

    // Promote
    this._transition(STATES.IN_TRIP, t, 'speed_confirmed');
    if (this._potentialStartPos) this._appendTripPosition(this._potentialStartPos);
    this._appendTripPosition(pos);
  }

  _startTrip(ts) {
    const uid = genTripUid(ts);
    this._trip = {
      trip_uid: uid,
      start_ts: ts,
      end_ts: null,
      start_lat: null,
      start_lng: null,
      end_lat: null,
      end_lng: null,
      distance_m: 0,
      positions: [],        // {lat, lng, ts, accuracy, speed_mph}
      max_speed_mph: 0,
    };
    this._emit('trip_started', {
      trip_uid: uid,
      start_ts: ts,
      start_lat: null,
      start_lng: null,
    });
  }

  _appendTripPosition(pos) {
    if (!this._trip) return;
    const trip = this._trip;
    const last = trip.positions[trip.positions.length - 1];

    // Seed start coords AND start_ts on first position.
    // start_ts must match the first actual position (not the promotion moment)
    // so that duration_sec and avg_speed_mph reflect the whole drive.
    if (trip.start_lat == null) {
      trip.start_lat = pos.lat;
      trip.start_lng = pos.lng;
      trip.start_ts = pos.ts;
    }

    // Distance accumulation with GPS-gap guard (Section 4.3)
    if (last) {
      const gapSecs = (pos.ts - last.ts) / 1000;
      if (gapSecs > this.params.GPS_GAP_INTERPOLATE_SECS) {
        // Long gap — still count the straight-line distance (SDK would have
        // buffered), but flag it. We don't drop the trip; downstream Routes
        // API correction (Build 164 feature) reconciles this.
        this._log('[TSM] gps_gap', gapSecs, 'sec — interpolating');
      }
      const dM = haversineMeters(last.lat, last.lng, pos.lat, pos.lng);
      // Tiny reject: ignore sub-2m drift between consecutive points
      if (dM >= 2) trip.distance_m += dM;
    }

    trip.positions.push(pos);
    if (pos.speed_mph > trip.max_speed_mph) trip.max_speed_mph = pos.speed_mph;
    trip.end_lat = pos.lat;
    trip.end_lng = pos.lng;
    trip.end_ts = pos.ts;

    // Progress event every 10 positions (roughly every ~10s at 1Hz)
    if (trip.positions.length % 10 === 0) {
      this._emit('trip_progress', {
        trip_uid: trip.trip_uid,
        current_lat: pos.lat,
        current_lng: pos.lng,
        current_speed_mph: pos.speed_mph,
        elapsed_secs: (pos.ts - trip.start_ts) / 1000,
        distance_mi_so_far: trip.distance_m / METERS_PER_MILE,
      });
    }
  }

  _checkInTripStopping(pos, t) {
    if (pos.speed_mph < this.params.ENDING_STOP_SPEED_MPH) {
      if (this._stoppedSince == null) this._stoppedSince = t;
      const stoppedFor = t - this._stoppedSince;
      if (stoppedFor >= this.params.ENDING_STOP_SECS * 1000) {
        this._transition(STATES.ENDING, t, 'in_trip_stopped_180s');
      }
    } else {
      this._stoppedSince = null;
    }
  }

  _checkEndingComplete(t) {
    if (this._stoppedSince == null) return;
    const stoppedFor = t - this._stoppedSince;
    if (stoppedFor >= this.params.COMPLETE_STOP_SECS * 1000) {
      this._transition(STATES.COMPLETED, t, 'complete_stop_300s');
    }
  }

  _finalizeTrip(ts) {
    const trip = this._trip;
    if (!trip) {
      // Shouldn't happen, but don't crash
      this._transition(STATES.IDLE, ts, 'finalize_no_trip');
      return;
    }

    const distance_mi = trip.distance_m / METERS_PER_MILE;
    const durationSec = (trip.end_ts - trip.start_ts) / 1000;
    const avgSpeedMph = durationSec > 0
      ? (distance_mi / (durationSec / 3600))
      : 0;

    // Minimum distance filter (Section 4.2)
    if (distance_mi < this.params.MIN_TRIP_DISTANCE_MILES) {
      this._log('[TSM] trip below min distance', distance_mi, '— discarding');
      this._emit('trip_discarded', {
        trip_uid: trip.trip_uid,
        reason: 'below_min_distance',
        distance_mi,
      });
      this._trip = null;
      this._transition(STATES.IDLE, ts, 'trip_too_short');
      return;
    }

    // Guard: must have start AND end coords (the Build 210.5 missing_coords bug)
    if (trip.start_lat == null || trip.end_lat == null) {
      this._log('[TSM] trip missing coords — discarding');
      this._emit('trip_discarded', {
        trip_uid: trip.trip_uid,
        reason: 'missing_coords',
      });
      this._trip = null;
      this._transition(STATES.IDLE, ts, 'missing_coords');
      return;
    }

    const payload = {
      trip_uid: trip.trip_uid,
      start_ts: trip.start_ts,
      end_ts: trip.end_ts,
      start_lat: trip.start_lat,
      start_lng: trip.start_lng,
      end_lat: trip.end_lat,
      end_lng: trip.end_lng,
      distance_mi,
      duration_sec: durationSec,
      avg_speed_mph: avgSpeedMph,
      max_speed_mph: trip.max_speed_mph,
      positions: trip.positions,
    };

    this._emit('trip_completed', payload);
    this._trip = null;
    this._transition(STATES.IDLE, ts, 'trip_emitted');
  }
}

// ─── Export (UMD-lite: Node CommonJS + browser global) ───────────────────
// Node (tests): require('./TripStateMachine.js').TripStateMachine
// Browser (PWA): window.TripStateMachine, window.TSM_STATES, etc.
(function (root) {
  const api = {
    TripStateMachine,
    STATES,
    DEFAULT_PARAMS,
    haversineMeters,
    genTripUid,
    MPS_TO_MPH,
    METERS_PER_MILE,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined' && root) {
    root.TripStateMachine = TripStateMachine;
    root.TSM_STATES = STATES;
    root.TSM_DEFAULT_PARAMS = DEFAULT_PARAMS;
    root.TSM_haversineMeters = haversineMeters;
    root.TSM_genTripUid = genTripUid;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));

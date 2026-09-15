// Piece D's frame-liveness ladder: the decision about whether the station is
// showing a live picture, a held one, or the committed archive still — and the
// detection of a camera that has frozen while still serving healthy HTTP.
//
// Pure and clock-injected on purpose. It reads no wall clock, opens no socket
// and touches no filesystem; it takes poll *outcomes* and a now() and answers
// questions. That is what lets a test drive a full hour of station time in a
// few milliseconds, which is the only reason the age-accounting regression
// below is cheap enough to keep tested.
//
// Specified in docs/superpowers/specs/2026-09-14-visual-layer-design.md,
// sections "A camera can freeze while HTTP says it is fresh", "The fallback
// ladder", "The archive still" and "The caption line".

export const LIVE = 'LIVE';
export const HELD = 'HELD';
export const ARCHIVE = 'ARCHIVE';

// The spec's thresholds, justified there against the measured ~61 s publish
// cadence and its observed 121 s dropped-publish gaps. Six minutes is three
// times the worst observed staleness. Do not retune them here.
export const LIVE_MAX_MS = 6 * 60_000;
export const HELD_MAX_MS = 30 * 60_000;

// Two genuine consecutive frames from a live camera are never byte-identical —
// JPEG noise alone guarantees it. Five consecutive identical bodies (~5 min) is
// the confidence threshold for declaring the camera frozen.
export const FROZEN_AFTER_REPEATS = 5;

// The Last-Modified the NPS -002 stills have carried unchanged since, verified
// 2026-09-14. The caption may show an old picture; it may not imply it is now.
export const ARCHIVE_DATE = '2025-01-10';

const MS_PER_MIN = 60_000;

// Three things that are easy to conflate and must not be:
//
//   a successful fetch  the transport worked (200 with a body, or a 304)
//   a new frame         a 200 whose bytes differ from the frame already held
//   a fresh frame       the held frame is younger than LIVE_MAX_MS
//
// The age dates from the last *new* frame. It is never refreshed by a
// successful fetch that returned bytes already held, and never by a 304.
//
// This is the whole point of the module. The naive ladder advances the age on
// every successful fetch and stops only once `frozen` latches at five repeats,
// which keeps the caption claiming `live` for five minutes after the camera has
// already stopped — off a frame the renderer was already holding. So `frozen`
// is a declaration for the caption and the log; it is not what stops the clock.
// The first repeat stops the clock, before there is any evidence of a freeze,
// because a repeat is simply not new information about the world.
export function createLiveness({ now, archiveDate = ARCHIVE_DATE } = {}) {
  if (typeof now !== 'function') {
    throw new TypeError('createLiveness needs an injected now() clock');
  }

  let heldHash = null;   // the frame currently cached, or null before the first one
  let frameAt = null;    // when the last genuinely different frame arrived
  let repeats = 0;       // consecutive fetches that returned bytes already held
  let frozen = false;

  // Record one poll outcome. `kind` is:
  //   frame      200 with a body; `hash` identifies its bytes
  //   unchanged  304 — nothing new, which is ordinary at this cadence
  //   error      refused, timed out, 429, 5xx: no information at all
  function record(outcome) {
    const kind = outcome === null || outcome === undefined ? undefined : outcome.kind;

    if (kind === 'frame') {
      if (typeof outcome.hash !== 'string' || outcome.hash === '') {
        throw new TypeError('a frame outcome needs a hash identifying its bytes');
      }
      if (outcome.hash === heldHash) {
        // Byte-identical to what we hold. Not new information: the age stands.
        repeats += 1;
        if (repeats >= FROZEN_AFTER_REPEATS) frozen = true;
      } else {
        // A genuinely new frame. Recovery has no hysteresis: one of these
        // returns the ladder to LIVE however long it has been broken.
        heldHash = outcome.hash;
        frameAt = now();
        repeats = 0;
        frozen = false;
      }
      return;
    }

    if (kind === 'unchanged') {
      // A 304 carries no body, so it cannot show the content repeated — it is
      // not a frozen signal. It is also not evidence against one: it says the
      // origin file has not moved, which agrees with the content not moving.
      // So it neither advances the run nor breaks it, and it never refreshes
      // the age: a camera that has gone silent 304s forever while its picture
      // ages, and the ladder must fall through on that age alone.
      return;
    }

    if (kind === 'error') {
      // No information. The run of *consecutive* identical bodies is broken,
      // but a failed fetch is not evidence the camera came back, so a frozen
      // declaration already made stands until a new frame disproves it.
      if (!frozen) repeats = 0;
      return;
    }

    throw new TypeError(`unknown poll outcome: ${JSON.stringify(kind)}`);
  }

  // The ladder, evaluated at now(). Callable between polls: during an outage
  // nothing is being recorded, and the picture still has to age.
  function status() {
    if (frameAt === null) {
      // Nothing cached. Never black, never a live claim.
      return {
        state: ARCHIVE,
        frozen,
        ageMs: null,
        frameAt: null,
        caption: archiveCaption(),
      };
    }

    const ageMs = now() - frameAt;
    const state = ageMs < LIVE_MAX_MS ? LIVE
      : ageMs <= HELD_MAX_MS ? HELD
      : ARCHIVE;

    return { state, frozen, ageMs, frameAt, caption: captionFor(state, ageMs) };
  }

  function archiveCaption() {
    return `archive ${archiveDate} — not live`;
  }

  // The honesty burden for all three states sits on this one line. The renderer
  // prefixes the place and the view; what it may not do is soften this.
  function captionFor(state, ageMs) {
    if (state === LIVE) return 'live';
    if (state === HELD) return `held, frame ${Math.floor(ageMs / MS_PER_MIN)} min old`;
    return archiveCaption();
  }

  return { record, status };
}

# Visual layer (piece D) — design

Date: 2026-09-14
Status: specified, not implemented

## Problem

YouTube Live requires a video track, and piece E ships one: a still PNG with the
station name on a dark ground, looped forever. That is enough to be on the air and
nothing more. Piece D is the picture that makes the stream worth looking up at —
"the part that rewards occasional attention" — without becoming the part that demands
it.

The direction is an **ASCII-rendered live webcam of the harbour whose weather bends
the music**, so the picture and the score are two views of one place. It has to survive
three things the pretty version of the idea does not address: the rights to rebroadcast
somebody else's camera, what the picture looks like at 3am, and what renders when the
camera is unreachable — which it will be.

## Scope

**In scope.** The frame source and its polling contract, the mandatory crop, the ASCII
rendering, night behaviour, the fallback ladder and its switchover conditions, and the
handoff to piece E's `videofeed`.

**Out of scope.** Implementing any of it. The broadcast pipeline (piece E) — this spec
adds a frame *source* behind an existing seam and changes nothing downstream of it. The
weather feed's data handling (piece B, #39), though the location decision is shared and
is stated below so #39 can follow it. Colour, overlays carrying score state, listener
interaction (piece F), and any change to `composer.mjs`, `station.mjs` or `runtime/`.

## Decisions adopted, not reopened

From `docs/superpowers/specs/2026-09-13-broadcast-ops-design.md:196-248`:

- **The seam is a named pipe carrying PNG frames.** ffmpeg reads
  `-f image2pipe -framerate 2 -i /run/endless-memory/video.fifo` and knows nothing about
  what writes it. `videofeed` writes it.
- **Piece D is a frame source that `videofeed` reads, never a process in the broadcast
  path.** `ops/stream.sh` holds the fifo open read-write on a spare descriptor, so no
  writer's death can EOF the encoder.
- **The contract piece D must meet is small: hand `videofeed` a PNG, 1280x720, whenever
  there is a new one.** Rate, timing, muxing and encoding stay on piece E's side.

This spec adds nothing to that seam and asks for no change to it.

## Step 1: the source, and whether the direction survived

**It survived.** Recorded on #38 (2026-09-14) and summarised here because a spec that
makes a reader open an issue to learn whether its own premise holds is not a spec.

**Source: the NPS Boston Light cameras**, four cardinal views from Little Brewster
Island, served as direct JPEGs with no player embed:

```
https://www.nps.gov/webcams-boha/{west,north,south,east}-001.jpeg
```

Verified by fetch 2026-09-14: all four HTTP 200, `image/jpeg`, **3840×2160**, 228–525 KB.

**Rights are clear and monetization does not constrain them.** NPS material is
generally in the public domain; commercial republication is permitted and requires only
a notice that no copyright protection is claimed in US Government works
(17 U.S.C. § 403). An earlier reading of this project's own piece E spec claimed the
monetization question fed this gate; that was wrong, is corrected on #38, and was
corrected in the piece E spec by PR #48.

`https://www.nps.gov/robots.txt` (read 2026-09-14) disallows `/ns/`, `/search/` and
`loader.cfm`. It does not disallow `/webcams-boha/`.

**The other two candidate locations were assessed and rejected.** Marblehead's webcams
are all private yacht clubs surfaced through aggregators (WeatherBug, meteoblue,
worldcam) that impose their own terms on top; every one would need written permission
from a private operator with no public-domain fallback. Winthrop is moot: it shares
KBOS observations with Boston, and Boston Light looks over the same water.

**Location decision, shared with #39: Boston.** Observations from **KBOS**, tides from
**NOAA station 8443970** — which is the station whose reading the camera itself burns
into the frame. Piece B should follow this rather than re-decide it.

**State the geography honestly.** Little Brewster Island is in the outer harbour off
Hull, roughly 9 miles from Logan. The picture and the weather driving the music are the
same harbour, not the same point. NPS itself pairs this camera with tide station
8443970, so the pairing is defensible — but "Boston" should not be allowed to paper
over the distance.

## The crop is a hard requirement

**Every live frame has three trademarks burned into it.** Top-right: the **NPS
Arrowhead**, the **USCG Sector Boston** seal, and the **Hull Lifesaving Museum** logo.
The top band also carries a capture timestamp at the left; the bottom band carries a
tide-reading overlay.

The Arrowhead may not be used without prior written permission from the Director of the
National Park Service, and the museum mark is exactly the third-party exception the NPS
disclaimer carves out. **Public domain covers the imagery, not the marks inside it.**
Broadcasting the frame unmodified would republish three trademarks continuously, 24
hours a day, on a channel that may be monetized.

This is a legal requirement, not an aesthetic preference. It happens to also be an
aesthetic gain — burned-in text becomes unreadable noise in ASCII — but that is a
side effect and must not be what the requirement rests on.

**Measured extents (2026-09-14, `west-001.jpeg`, 3840×2160).** The trademark block ends
at y ≈ 305; the bottom overlay text begins at y ≈ 2087.

**The specified crop is `crop=3840:1700:0:360`** — drop the top 360 rows and the bottom
100 rows, keep full width. That clears the marks by ~55 px at the top and ~27 px at the
bottom.

Three requirements on how the crop is applied, each of which exists so that a bug
cannot leak a mark onto the air:

1. **The crop happens at ingest, in the same step that decodes the JPEG**, before any
   other code can see the pixels. It is not a render-time option and there is no code
   path that renders an uncropped frame.
2. **The uncropped bytes are never written to disk and never retained** beyond the
   decode call.
3. **The crop is re-checked by eye whenever the overlay layout could have changed** —
   at minimum before launch and after any observed change in frame dimensions. A fixed
   pixel rectangle against an overlay somebody else controls is a standing assumption,
   not a guarantee. If the source ever stops being 3840×2160, the renderer must refuse
   to publish the frame rather than crop by ratio and hope.

## Polling: cadence, politeness, and cost

**Measured cadence is ~60 s.** Recorded on #38 over 8 distinct frames on 2026-09-14:
intervals 59, 61, 61, 59, 121, 58, 121 s, median **61 s**. The two 121 s gaps are within
a second of 2×61, so they are *dropped publishes*, not a variable interval.

**The conditional-GET path works, and the design uses it.** Verified 2026-09-14: the
server returns `ETag` and `Last-Modified`, and a request carrying the current
`If-Modified-Since` returns **304** with no body.

The polling contract:

- **One camera, not four.** The west view only (see "Which view"). 1440 requests/day,
  not 5760.
- **Poll every 60 s**, never faster. This is the source's own cadence and the floor the
  issue sets. A poll that finds nothing new costs a 304 and roughly a hundred bytes.
- **Always send `If-None-Match` / `If-Modified-Since`** from the last frame held. On
  304, do nothing at all — no decode, no re-render, no write.
- **Identify the client honestly.** A `User-Agent` naming the project, its repository
  URL, and a contact. Not a browser string.
- **Back off on failure.** On 429 or any 5xx, exponential backoff from 60 s to a
  15-minute ceiling, with jitter. A camera that is down must not be polled harder than
  one that is up.
- **Never fetch the other three views, and never fetch the archive stills at runtime**
  (see "The fallback ladder").

**Metered cost.** At a 61 s publish cadence, roughly 1400 of 1440 daily polls return a
new image of ~400 KB: about **560 MB/day inbound, ~17 GB/month**. That is inbound
traffic on the piece E VPS, where the binding budget is the ~324 GB/month *outbound*
figure already recorded in the piece E spec. It should still be checked against the
chosen instance's allowance before launch rather than assumed free.

## Which view

**West, fixed.** By day the west view carries three distinct luminance registers — the
keeper's house and rocky shore in the foreground, the water, and the Boston skyline on
the horizon — which is what ASCII conversion needs. North and east are largely flat sky
over flat water; rendered, they read as bands.

**At night the choice stops being aesthetic.** Cropped-region luminance across all four
views at 21:11 EDT, 2026-09-14:

| view | mean | p02–p98 span | verdict |
|---|---|---|---|
| **west** | 27.9 | **75** | the lit Boston skyline carries it |
| north | 22.6 | 23 | nearly no range; renders as near-uniform |
| east | 19.3 | 11 | dead |
| south | 180.5 | 107 | **not night at all — the camera is frozen** (below) |

West is not merely the best view at night; **it is the only one of the four that is both
live and usable at night.** The skyline that makes it work is the thing the other three
do not point at.

**Fixed rather than rotating.** A rotating view would swamp the change the station is
actually made of. The picture holds one frame for a minute at a time and changes over
hours — tide, light, weather — and that slow change is only legible if the camera does
not move. Rotation is also now ruled out on availability grounds: one of the four cameras
was observed dead during the single day this spec was researched.

## A camera can freeze while HTTP says it is fresh

This was found by accident and it invalidates the obvious liveness check, so it is
recorded before the fallback ladder that depends on it.

**The south camera is frozen.** Observed 2026-09-14:

- Its frames are **byte-identical** across 4.5 hours — the same MD5 at 17:10, 18:54,
  20:30 and 21:11 EDT.
- Its burned-in timestamp reads **2026-05-19 12:38:20**, nearly four months stale, and
  its tide overlay reads 8.736 ft against west's contemporaneous 0.563 ft.
- It nevertheless served a **200 with a `Last-Modified` of 20:54:12 GMT** — a file the
  origin genuinely wrote that day, whose *contents* were four months old. Its
  `Last-Modified` has not moved since.

Two distinct failures, and the ladder has to catch both:

1. **The camera goes silent.** `Last-Modified` stops advancing. An age check on HTTP
   metadata catches this.
2. **The camera republishes a stale picture.** `Last-Modified` advances, the fetch
   succeeds, and the content is months old. **No HTTP-level check catches this at all.**

West was healthy throughout — its bytes changed on every sample and its `Last-Modified`
tracked the ~60 s cadence — so the chosen view is not the broken one. That is luck, not
design, and the design must not depend on it.

**The primary content-liveness test is content change itself.** Two genuine consecutive
frames from a live camera are never byte-identical; JPEG noise alone guarantees it, and
west's samples bear that out. So: **if the fetched image is byte-identical to the frame
already held across five consecutive successful fetches (~5 minutes), treat the camera as
frozen** regardless of what HTTP claims, and fall through the ladder as though the fetch
had failed.

**A repeated frame never refreshes the age.** The five-fetch run is the confidence
threshold for *declaring* the camera frozen; it is **not** a grace period during which
repeats count as fresh. The age always dates from the last frame whose bytes actually
differed. This distinction is not cosmetic: simulating the ladder against the recorded
south-camera frames showed that the naive version — advance the age on every successful
fetch, then latch `frozen` at five — keeps captioning the picture **`live` for five
minutes after the camera has already stopped**, off a frame it already held. Detecting a
frozen camera cannot be faster than a few identical frames, but claiming freshness for
frames already known to be repeats is a choice, and the wrong one.

**The ground truth, if the hash test ever proves insufficient, is the burned-in
timestamp** — which sits in the top band that the trademark crop removes. The overlay this
spec is legally required to delete is the only thing in the frame that proves the frame is
current. Reading it before cropping is therefore available and is the fallback detector;
it is not specified as the primary one because it needs character recognition and the hash
test needs nothing. **If it is ever implemented, the band is read and discarded — it must
still never reach the encoder.**

## The ASCII rendering

Prototyped 2026-09-14 against recorded frames, never against the live feed, per the
issue's constraint.

**Grid: 160 columns × 35 rows.** The crop is 3840×1700 (2.26:1); at a monospace cell
aspect near 1:2 a 160×35 grid reproduces that without stretching. Rendered at 13 px in
Menlo this fills 1280 px of width and about 590 px of the 720 px height, leaving a band
below for the caption line.

**Ramp: the ten-level `" .:-=+*#%@"`, dark to light.** Longer ramps were tried and
rejected. A 70-glyph ramp at the same grid reads as noise: the eye picks up glyph
*shapes* rather than tone, and the harbour disappears into texture. Ten levels keep the
scene.

**Polarity: bright maps to dense.** Light glyphs on a near-black ground, so a bright sky
is a dense field and the water is open. Inverting it makes the sky read as a hole.

**Per-frame auto-level.** Sample the cropped luminance, take the 2nd and 98th
percentiles, and stretch that range across the ramp. Without it the harbour sits in a
narrow mid-band and most of the ramp goes unused. This is the single most load-bearing
step at night; see below.

**Downscale with area averaging** (`scale=...:flags=area`), not point sampling. One
output cell is an average of ~24×48 source pixels, which is also what suppresses sensor
noise.

A real frame, west view, 2026-09-14 16:53 EDT, at the specified grid and ramp:

```
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%############
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%############
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%##########
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%#####
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@%@@%@@@@#@@@@@@@@#%@@@%%#@%@@@%@@@@@@%@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%
@@@@@@@@@@@@@@@@@@%@@@@@@@@@@@@@%%@@@@@#%*#@%##*#%%%%%%%+++***++++++++++##%**@@*#+*@%%@%%%@@@@@@@@@%######%%%@%%@@@@%%@%%%@%%%%%%%*%@@@%%@@@%%%%%%%%%%%%%%%%%%%%
----==+++++==----::::::::::::::---+++++*******=------=+++++*****++++++++++++++++++++++++++++=========---------------------------------==========-==--=======----
*****************+*++++++++++++++++++++++++++++++++++++++++++++++++++++============================----------------------------------------------------------:::
%%%%%%##########********************+++++++++++++++++++++++++++++=============================--=------------------------------::-:..::.:::::---------------::::
%%%###########***#***********************++++++++++++++++++========================------=---------------------------------:.    ...                .......:::::
%%%#%###########*************+***+++++++++++++++++++++++++++++++++++++++++===+++=++========----------------::::::::::::::.    ....                            .
%%%%########****************+++++++++++++++++++++++++++++=+=======================================---------------=-==+++=::::--::::. . .
%%%###########**************+*+++++++++++++++++++++++++++++=+====================================+=+===+===============-------:::::.  .  .......................
%%#%%########********************+++++++++++++++++++++++++++++++++======================================--------------------------::::::::::::::::::::::::::::::
%%#####**#***********+*****+++++++++*+++++++++++++=++========================================-==-====---=----------:::--::::::::::::::::::::::::::::::::::::::::
###*******************+**++**++++++++++++++++++++==+=+======================+==============--------------:::--:::::::::::::::::::::::::::::::::::::::..:........
###*##******************+*+++++++++++++++++++++++++++++++++++++++++++++==+=============---------------------------------------:---::----:---:::::::::.:.:.......
*#***#***********+++****+*+*++++++++++++++++++++++++++++++++==++++====+==================================--===-==-=---=-------::::::::::::::::::::::..:.........
+***+**+*******+***+*+++*++++**+++++++++++++++++++++=++++==++==+==================-==========--===-==--=-------------------::-::::-:::::::::::::::::::.:::......
**+*+*++*************+++++++++++++++++++++++==++=+===++++=++===========================--=-------------------------------------------:---::::::::::.............
*#*********+***++++==+**++++*+++++++++++++++++=+++=++=++++==+=========+==============================-==---------------------------::::::::::::::::.:.:.:.......
#********+++++:  ....:+++++++++++++++==++++++++=+=++=++====+======+================-=========----------------------:----::::::::::::::::.::::::::..::::.........
********#****+   *+= :+++++*+++++++++++++++++++==++++=============--==============--==---==-=-----------------:------:-::::::::::::::::...:.:::.:..:..:::.::::..
*****+**+****+   :-: .++++++++++++++++++++++=++++==::=+++========+=+==========--===-==--=---------------::::--:::::::::::::::.::::::::.:::..:.....:...........:.
***+===++*++==:...:. .=++++=========++=++++=+++++**. -+++==========-====---===------------------::----:--::-:::::::::::::::.:..::::::::::..:::..................
**+=- :+**+-. ..:---.:=++=+++++++++-=---... ..:-:::. ...=++-=-----------:----::---::::--::::::::::-::::-:::::::::::::::.::::-:::::::...::.::..:....:............
+++===+++=..   ..:---=+--:++==+++=     ........         :=: .-==-----------------:--::-::-:::-:::::::::::::::-:::::::::::::::::::........:......................
=++=++++-.. .-:.  ...:-:.-+-  .+++=.   ......            :--. .:==-=----------::--:::::::::--::::-:::::::::::::...::::::.......::..................:......:::...
===++=--...-#:............:..::=====. .:......         .---:::.  :--------------------::-::::::----::::::::::::::::..:::::::..........:::....:::......:.........
:=+**+-..-*+:.::.:::.:....:....  ..  .:..             :--.  :---.  :=-----::-----:------::::---:::::::::::::::.:....::::::::..:::....::.:::::...................
=+**+-.-*+----::===---::..:.         -- :           :----.  ------.  .-=---------------:-::::::::::::::::::::::---::::::-::::::.......:................... ...
+**+=:=*---. :--:::---==+=: ..     .-=- -.  .......:--------------:..  .--:::----:---:::--::::::::::::::-:::::::..:::::.......:::..........  .:.......  ........
==*----:        ::..-----:-:. ......--:  :--------------::...:-----:.:.--:--------::--=----:-------:::::::::::::::::::::.::......::........................... .
%%##::::.:::. .::   --:--:::::..   ....  :----:  :------.    .-----:.. -==-..::    ....:::------::---::-::::::::::::::...:....................:.................
#%#*:....:::...:.   .  ...:.....   . ..  :----.  :------:...::----:...  ...::.:...       ...: .::--::--:::::.::::::::::::::......:::.........................
```

### Rasterising to the PNG

The prototype rasterised with ffmpeg `drawtext` reading a `textfile`, onto a 1280x720
`color=` source. Two findings worth carrying forward:

- **`drawtext` expands `%` as a format specifier.** The ramp contains `%`, so the first
  attempt failed with `Stray %`. `expansion=none` is required. Any rasteriser that
  interpolates the glyph field through a format string has this bug waiting in it.
- **ffmpeg is already a host dependency** for piece E, so using it to decode, crop and
  downscale costs no new dependency. The alternative — a JPEG decoder in pure Node — is
  work this project does not need to do.

The no-runtime-dependencies guard in `runtime/render.test.mjs` covers `composer.mjs`,
`station.mjs` and `runtime/`. Piece D lives in `ops/` alongside piece E's files, outside
that guard, and touches none of the three.

## Night: observed, not assumed

The issue's worry was specific and correct to raise: *a harbour webcam at 3am is close to
black, and black ASCII is dead air for the eyes.* Nobody had seen a night frame; the
step-1 research ran at 07:19 local.

**Frames were fetched across the whole dusk-into-dark transition on 2026-09-14**, west
view, sampled every 8 minutes from 16:54 to 21:11 EDT, plus six consecutive published
frames at 21:16–21:22 EDT. Mean and 2nd/98th-percentile luminance of the **cropped**
region, 160×35 grid:

| Local time | mean | p02 | p98 | span | what is happening |
|---|---|---|---|---|---|
| 16:54–18:14 | 118–127 | 52–64 | 192–236 | 134–184 | daylight |
| 18:22–18:46 | 101 → 78 | 37 → 31 | 227 → 157 | 190 → 126 | light falling |
| **18:53** | — | — | — | — | **sunset, observed in frame** — the sun sits on the horizon behind the skyline |
| 18:54–19:02 | 121, 120 | 44, 39 | 199 | 155–160 | mean *rises*: the camera re-meters for the sunset sky |
| 19:10–19:50 | 111 → 35 | 34 → 13 | 198 → 97 | 164 → 84 | steep fall through twilight |
| **19:58–21:11** | **27.9–29.7** | **17** | **92–93** | **75–76** | **night plateau — flat within ±0.9 mean over 73 minutes** |

Three things follow, and the third is the one that decides the design.

**1. Night is not black, and the reason is the one the issue guessed.** The west view's
horizon carries the lit Boston skyline, and at 21:09 it is the brightest thing in the
frame by a wide margin. Below it the harbour is dark but not empty: at 0.563 ft of tide
the exposed flats and the tidal channel are visible, and the keeper's house catches
enough light to read. The night frame is a *different composition* — a bright band over
a dark field — not a degraded version of the day one.

**2. The scene reaches its night steady state early and stays there.** The plateau begins
at 19:58 and holds flat for the next 73 minutes. This matters for the part that was not
observed (below): by 20:00 the loss of daylight is finished, and nothing after that point
is still getting darker for that reason.

**3. Without the per-frame auto-level, night genuinely is dead air.** This is not a
judgement call; it is visible in the output. Rendered with a fixed 0–255 mapping, the
21:09 frame produces **28 of its 35 rows as a single repeated glyph** — a uniform field
of `.` with no structure whatsoever. Only the skyline band survives. Rendered through the
2nd/98th-percentile stretch already specified for daytime, the same frame resolves the
channel, the shoreline and the house.

**So the auto-level is not a nicety that improves the day picture. It is the single step
that makes night a picture at all.** It must never be made optional, and any future
"simplification" that replaces it with a fixed mapping silently kills half of every day.

### The answer to the question the issue posed

Night is **not a different visual mode, not a different source, and not a different
crop.** It is the same camera, the same `crop=3840:1700:0:360`, the same 160×35 grid and
the same ten-glyph ramp, carried by the auto-level the day render already needs. A
day/night mode switch was considered and rejected: it would put a visible seam in the
picture twice a day at exactly the hours when the light is most interesting, to solve a
problem the existing pipeline already solves.

One thing is added, and it is on all the time rather than at night only.

### Temporal smoothing, and the prediction that was wrong

The expectation going in was that stretching a dark frame would amplify sensor noise into
random glyph churn — "boil" — which is actively hostile to a stream meant to preserve
concentration. **Measured, that prediction was wrong in its premise and right in its
conclusion.**

Glyph churn, the share of the 5600-cell grid whose character changes between renders:

| pair | separation | churn |
|---|---|---|
| day, 17:10 → 17:18 → 17:26 | 8 min | 19.3%, 23.7% |
| night, 20:55 → 21:03 → 21:11 | 8 min | 11.7%, 12.3% |
| night, six consecutive published frames | ~60 s | 12.1, 10.7, 10.9, 11.9, 11.0% |

Night churn is *lower* than day churn, because daytime water glitter moves more than
night noise does — so "night boils worse than day" is false. But night churn is
**identical at 60 seconds and at 8 minutes**, and that is the tell: change that does not
grow with elapsed time is not change. Roughly 11–12% of the night grid is a
frame-independent noise floor, flickering with no information in it.

An exponential moving average over the luminance grid, applied before the glyph mapping,
removes most of it. Measured over the same six consecutive frames:

| α | churn (whole grid) | vs. unsmoothed |
|---|---|---|
| 1.0 (none) | 10.7–12.1% | — |
| 0.6 | 5.3–7.7% | ~2× |
| **0.4** | **2.9–6.4%** | **~3×** |
| 0.25 | 2.0–6.2% | ~4× |

**α = 0.4 is specified.** It takes the noise floor to about 4% and settles a genuine step
change in roughly 2–3 frames, which at a 60-second publish cadence is 2–3 minutes. Against
a scene whose real content changes over hours — tide, light, weather — a two-minute
settle is not a cost; it makes the picture drift rather than cut, which is what this
station is for. Going further to α = 0.25 buys little and lags more.

The smoothing runs day and night. Its effect on the *daytime* picture was not measured —
consecutive daytime frames were not captured, because the measurement was made at night —
and that gap is an acceptance criterion below, not a thing to assume away.

### What was not observed: 3am

**The night frames here are 21:09–21:22 EDT. Nobody has seen 3am, and this spec does not
claim to have.**

What the observation does establish is that the *daylight* variable is finished: the
luminance plateau is reached by 19:58 and holds flat for 73 minutes. The remaining
variable between 21:00 and 03:00 is the city's own lighting — office floors going dark
after midnight — which dims the skyline band without touching the harbour navigation
lights, the lighthouse, or the street lighting along Hull.

The mechanism is also self-correcting by construction: the auto-level stretches whatever
range the frame contains, so a dimmer skyline is re-normalised rather than lost. What
would actually break it is not dimness but **range collapse** — the frame's p02–p98 span
shrinking until sensor noise spans several ramp steps and the foreground becomes boil.

That is measurable, and it is the gate rather than a hope:

- At the observed night span of **76 levels**, unsmoothed churn is 11–12% and smoothed
  churn is ~4%.
- **The bar is smoothed churn at or below 8%.** Span is the cheap proxy to log; churn is
  the thing that matters and is directly measurable.
- If a 24-hour log shows the span collapsing far enough to push smoothed churn past that
  bar, night needs a different answer after all — most likely dropping to a coarser grid
  overnight, which trades detail for stability. That would be a real mode switch and this
  spec does not specify one, because on the evidence available none is needed.

**If it turns out 3am is unusable, that kills the leading direction for a third of every
day, and the honest response is the fallback ladder below rather than a prettier
renderer.** Saying so now is cheaper than discovering it after launch.

### The night render

Six consecutive published frames, 2026-09-14 21:16–21:22 EDT, α = 0.4, at the specified
grid and ramp. The bright band is the Boston skyline; the dotted field below traces the
tidal channel and the shore at 0.563 ft of tide:

```
::::-:::-:--------------------------------------------------------------------------------=====================-===--===-==-------------------------------------
-:----------------------------------------------------==---------------------------=-============================================-=-----------------------------
------------------------------------------------====--=--------------------------====================================================---------------------------
----------------========-====--=-=--=---================--------------------------==========+=+=+==+=+++=++=+++++============================-------------------
--------=---=====+=====================+=%@===+@=======+@#**+@@#=*+==*-----=#---==+====+++*********+++++++++*****+++++++++++++++================================
-----------===+===+==%***%#=+**#@%*%**@@@@@#%@@@@@@@@@@@@@@@@@@@@@@@@@@@@%#@@*=@@@@%@%#@@@@@@@@@@@@%*+***#@#@@@@@%%@@@@@@@##@@@%*+@+++++=======#++===========+++
      . .:--:        ..: ... .#@@+=*-++%%*%@#@%%#+=@-#*++@@@@@####%@#****#***=+#+#@@@%#@@@@@@@@@@@@@-::--:=#@@@@@%@@@@@@@@@+@@*#@*%::=:--:-.:-.:=:------:=+::--
                                                                            .............::::::-::::........::::.....::::...........  ...
                                              .       .  .   . ... .. ............................................................
          .  .......   ...                     .    ....  ... ...................................................................
...  .. .  ....................................................... . . .           .......................................   .  .
.      .    .   . ..................................................................................   .                 .     .   .
         .     .. ...  .... ...... .......................................................:...........:... .
.         .    ... .....................................................................:::.         ...:....
.  . . ...................................................................................:::.              ..                                           . ...
 .. .  ... . ................................................................................:::..                 .............  .                  ..  .   .
.     . .    ...... ..................................................................................
        ....... .......................................................................................                                ..... .. . .
     ...... .... ..  ..................................................................................                          ..............    .
              .  .. .   . . ...........................................................................                      ......... ...
             .           .....  ... .... ............... ........ .... ................  ... .........                  ........... . ..
                       ..   ..   .  ..   . ........... ... ......... .............. . .    .  ..........        ......................   .
                        .  .   ..     . .. .... ... . .......... ...... .... .   .. .... . . .........................................
                        . . ... .....  ...  ...  .    .  . .  .. .   .  ......  . ...  .  ....................................
                                        .   .          .           .       . ..  .  . ......  .....  . .........    .  .
                                                                                ......... ............................ .
                                                               .   ..  . ....... ........... ....... .... .. .. . . .        . .
                                                          ..     .  .... .. . . .   . .............. .... ... .  ..
                                                        .....     . ...   ...  ...        .  ....... . . .   .. .  .
                                                       ..   ....      ..   . ...... .   .. .............   .  ..
                                                     ....   ......     ..  ....    . ..  .        .  ...  .
                                                   .. .............                               .........
                                          ...............     .....                  .                 .
                                          ....    .  ...      ....
                                          ...     ..  ..      ..
```


## The fallback ladder

The feed will be unreachable. The requirement is that the station never goes black and
never claims to be showing something it is not.

**The division of responsibility matters more than the thresholds.** There are two
freshness checks and they answer different questions:

| Check | Owner | Question | Failure action |
|---|---|---|---|
| Is D's PNG fresh? | `videofeed` (piece E) | Is piece D alive? | last good frame, then `ops/placeholder.png` |
| Is the camera's picture new? | piece D | Is the *camera* alive **and publishing new pictures**? | the ladder below |

**Piece D keeps rewriting its PNG even when the camera is down.** This is the load-bearing
rule. If D stopped writing when the fetch failed, `videofeed` would time D out and fall
back to the station-name placeholder, and the visual layer would vanish on exactly the
failure it is supposed to absorb. D always has a picture; D decides what it is.

The ladder is driven by the age of the last **good** frame, where *good* means a fetch
that succeeded **and** produced content that is not frozen by the test above. A frozen
camera ages exactly like an unreachable one.

| State | Condition | What renders | Caption |
|---|---|---|---|
| **LIVE** | last good frame < 6 min | the newest frame | place, view, and the frame's capture time |
| **HELD** | last good frame 6–30 min | the last good frame, unchanged | same, with the age made explicit |
| **ARCHIVE** | last good frame > 30 min, or none cached | the NPS archive still, same crop and ramp | marked as archive, with its date |

Recovery is immediate in the other direction: one successful fetch returns the renderer
to LIVE with no hysteresis, because a true live picture is never the wrong thing to show.

**Why 6 minutes, given that ~2 minutes of staleness is normal.** The measured cadence is
61 s with observed dropped publishes producing 121 s gaps, so a frame up to about two
minutes old is an ordinary, healthy frame. A three-minute threshold would trip on two
consecutive dropped publishes, and two of seven observed intervals were drops — a sample
far too small to fit a drop-rate model, but large enough to say that consecutive drops
are not rare. **Six minutes is three times the observed worst-case staleness**, which is
the ordinary "three missed heartbeats" convention with the heartbeat taken as the worst
observed gap rather than the median. It is cheap to loosen and should be revisited once
a longer sample exists.

**Why HELD keeps the stale frame for 24 more minutes.** A twenty-minute-old picture of
that harbour is still a true picture of that harbour; the light and the tide have barely
moved. Swapping it for a still from January 2025 would be a downgrade in truthfulness,
not an improvement. Thirty minutes is where "the light in this picture is no longer the
light outside" starts to bite.

### The archive still

The fallback is not an abstract card. **The NPS serves a static, overlay-free still for
each of the four views** at `{west,north,south,east}-002.jpeg` — verified 2026-09-14:
HTTP 200, 3840×2160, all four `Last-Modified: Fri, 10 Jan 2025 16:27 GMT` and unchanged
since. Inspected at full resolution, they carry **no Arrowhead, no seal, no museum logo,
no timestamp and no tide overlay**. Same place, same public-domain status, same
framing family. `-003` and beyond return 403, so there is no frame archive to mine.

Requirements:

- **Fetched once and committed**, alongside `ops/placeholder.png`. Never fetched at
  runtime: it is the thing that renders when the network is the problem.
- **Rendered through the same crop and the same ramp** as a live frame. One code path,
  so the crop can never be skipped and the fallback can never look like a different
  product.
- **Captioned as archive, with its date.** The station may show an old picture; it may
  not imply the old picture is now.

Below the LIVE/HELD/ARCHIVE ladder sits piece E's own floor — `ops/placeholder.png`,
emitted by `videofeed` if piece D is not running at all. That stays exactly as piece E
specified it and is not this spec's to change.

## The caption line

The band below the ASCII panel carries one line of ordinary text — not ASCII-rendered,
drawn as glyphs — naming the place, the view, and the frame's own capture time. It is
the only thing on the screen that is allowed to assert a fact, so it carries the
honesty burden for all three ladder states: live, held, or archive.

Keep it small and low-contrast. It is a footnote, not a chyron.

## Interfaces

```
ops/videoframe.mjs                 the poller and renderer; one process, forever
ops/frames/boston-light-west.png   the 1280x720 PNG videofeed reads (atomic rename)
ops/frames/archive-west.jpeg       the committed NPS archive still
ops/endless-memory-videoframe.service
```

- **Write atomically.** Render to a temporary file in the same directory and `rename()`
  it over the published path. `videofeed` must never read a half-written PNG.
- **Supervision matches piece E's shape:** `Restart=always`, no start limit, a dedicated
  unprivileged user. A visual layer that gives up quietly is the failure this spec's
  whole fallback section exists to prevent.
- **The process is independent of both piece E units.** It can be stopped, restarted and
  deployed without touching the broadcast.

## Constraints

- **Never poll the NPS server faster than 60 s**, one view only, always conditional,
  honest `User-Agent`, backoff on failure. This is someone else's server and the station
  runs forever.
- **The crop is not optional and not configurable off.**
- **Nothing in `composer.mjs`, `station.mjs` or `runtime/` changes.** The
  no-runtime-dependencies guard scans raw source text and binds; `ops/` sits outside it.
- **No change to the ffmpeg invocation, the fifo, the encoder settings, or either piece E
  unit.** Piece D substitutes into the seam as specified or it is wrong.
- **The sound does not move.** No fixture and no golden is regenerated by this piece.
- ffmpeg 8.0+ and Node 22 on the piece E host; no new system dependency.

## Open questions

1. **Does a dense ASCII field survive 800 kbps at 720p30?** Piece E sized the video
   bitrate for a *static* placeholder. A 160×35 glyph field is high-frequency detail, and
   every keyframe has to re-encode it. The picture is static for a minute at a time, so
   P-frames are nearly empty and the cost is concentrated in the I-frame — but this has
   not been measured. **Answerable in piece E's tier-0 run** by feeding it a real ASCII
   frame instead of the placeholder and looking at the result. If it is soft, the cheap
   lever is on this side — fewer, larger glyphs (a 128×28 grid was prototyped and is
   legible, if coarser) — not piece E's bitrate.
2. **How often does the overlay layout change?** The crop is a fixed pixel rectangle
   against an overlay NPS controls. Nobody knows its history. Until somebody does, the
   dimension check in "The crop" is the guard.
3. **Should the caption carry anything from the score** — the current scene, a recalled
   motif? It would tie D to A the way the location ties D to B. Deliberately deferred: it
   is a second feature wearing the first one's clothes, and it needs its own decision
   about whether the stream explains itself or simply plays.
4. **Colour.** Everything here is monochrome. A tint driven by the weather journal is
   the obvious next idea and is out of scope; it should not be added without deciding
   what it costs the encoder.

## Acceptance criteria

1. **The crop is proven, not asserted.** Before launch, a recorded live frame and the
   committed archive still are both rendered through the real ingest path and the top and
   bottom bands are inspected *by eye* at full resolution. The implementation has exactly
   one decode call site, and it crops; this is checked by reading the source, because
   "no other path exists" is a claim about the code, not about a test.
2. **The renderer refuses an unexpected frame size.** Fed a JPEG that is not 3840×2160,
   it declines to publish and holds the previous frame, rather than cropping by ratio.
   Verified by feeding it a resized copy.
3. **Poll behaviour is observed, not intended.** Over a continuous 6-hour run against the
   live camera: no more than one request per 60 s, and the great majority of polls that
   find nothing new return **304**, both read from the renderer's own log rather than
   assumed. The `User-Agent` actually sent is recorded here verbatim.
4. **The ladder is exercised by breaking the network, not by unit-testing the state
   machine.** With the renderer running, the host's route to `www.nps.gov` is blocked and
   LIVE → HELD → ARCHIVE is observed at the specified thresholds; the route is restored
   and the immediate return to LIVE is observed. At no point is the frame black, and at no
   point does the caption claim live while the picture is held or archived.
5. **Cold start with no cached frame renders the archive still**, not a black frame and
   not piece E's placeholder. Verified by starting the renderer with an empty frame
   directory and no network.
6. **A frozen camera is detected and does not reach the air as a live claim.** Fed the
   same JPEG repeatedly, the renderer declares the source frozen within five fetches and
   falls through the ladder, rather than broadcasting a still picture captioned live. This
   is testable offline against the recorded south-camera frames, which are a real
   instance rather than a synthetic one. **The specific regression to test for is the age
   accounting**: assert that the caption stops claiming `live` no later than six minutes
   after the last genuinely *different* frame — not six minutes after the last successful
   fetch. A harness driving the ladder off an injectable clock runs the whole hour in
   well under a second, so there is no excuse for leaving this untested.
7. **Piece D cannot take the station off the air.** During a piece E tier-2 run, piece D's
   process is killed. The broadcast does not end; the picture freezes; the unit restarts
   and resumes. This is piece E's criterion 6 re-run with a real frame source instead of a
   placeholder, and it is the criterion that matters most here.
8. **Night is measured over a full 24 hours before launch, including 3am.** The renderer
   logs each frame's p02–p98 span and its glyph churn against the previous render. A
   continuous 24-hour log is read, and **smoothed churn stays at or below 8%** through the
   overnight hours. This is the criterion that closes the one thing this spec observed at
   21:00 and not at 03:00. If it fails, the night answer changes before launch.
9. **The auto-level is verified to be load-bearing, by removing it.** A recorded night
   frame rendered with a fixed 0–255 mapping must produce the dead output recorded above —
   a near-uniform field. This exists so that a later reader who is tempted to simplify the
   stretch away can see in one command what it costs. Daytime smoothing is checked in the
   same pass: consecutive *daytime* frames are captured and the α = 0.4 render is compared
   against α = 1.0, confirming the smoothing does not visibly lag real daytime motion.
   That comparison was not made in this spec and is the one measurement it owes.
10. **Open question 1 is closed by observation.** A real ASCII frame is fed through piece
   E's tier-0 run and the encoded result is looked at. The verdict — legible, or soft
   enough to need a coarser grid — is recorded in this file before launch.
11. **The § 403 notice exists.** Wherever the stream is described publicly, a notice
    states that no copyright protection is claimed in the US Government works it
    incorporates. This is the one thing the rights analysis actually requires of us, and
    it is easy to finish the build without it.
12. `npm test` counts are unchanged, `composer.mjs`, `station.mjs` and `runtime/` are
    untouched, and no fixture or golden is regenerated by this piece.

## Risks

| Risk | Mitigation |
|---|---|
| The overlay layout moves and a trademark reaches the air | The crop clears the marks by ~55 px top and ~27 px bottom; the renderer refuses any frame that is not 3840×2160 rather than cropping by ratio; re-checked by eye before launch. Residual risk is real and unmonitored — nobody knows this overlay's change history (open question 2). |
| A camera freezes while still serving fresh HTTP headers | Observed on the south camera during this research, not hypothesised. Content-change detection over five consecutive fetches, with the burned-in timestamp as ground truth if that proves insufficient. Acceptance criterion 6 tests it against the real frozen frames. |
| NPS removes or relocates the cameras | The ARCHIVE state renders a **committed** still of the same place, so a dead source degrades to an old true picture rather than to black. Detection is piece E's existing alerting; this spec adds no new watchdog. |
| The station is treated as abusing someone else's server | One view, 60 s floor, always-conditional requests, honest `User-Agent` with a contact, exponential backoff to 15 minutes on failure. The polling contract is a constraint, not a default. |
| A dense ASCII field is too detailed for 800 kbps | Open question 1, closed in piece E's tier-0 before launch. The lever is on this side — a coarser grid — never piece E's bitrate. |
| Piece D destabilises a working stream | D is a file writer; `videofeed` reads a path and owns its own fallback. Acceptance criterion 7 proves the broadcast survives D's death. |
| A half-written PNG reaches the encoder | Render to a temporary file in the same directory and `rename()` over the published path. |
| The picture holds one frame for a minute and reads as broken | The caption carries the frame's own capture time, so stillness is legible as stillness rather than as a stall. |
| Night is unusable at 3am, which this spec did not observe | Criterion 8 measures a full 24 hours before launch against a stated churn bar. The luminance plateau at 19:58 and the auto-level's adaptive stretch are the reasons to expect it holds; neither is a substitute for the log. |
| Someone "simplifies" the auto-level away | It is the step that makes night a picture rather than 28 identical rows. Criterion 9 makes the cost visible in one command rather than leaving it as a sentence in a spec. |
| Temporal smoothing lags real daytime motion | α = 0.4 settles in 2–3 frames against a 60 s cadence and a scene that changes over hours. Unmeasured by day, and criterion 9 owes that measurement. |

# SPIR-V shaders and the Vulkan (MoltenVK) default on macOS

Agentium ships the prebuilt SPIR-V shaders in
`binaries/data/mods/mod/shaders/spirv/` and
`binaries/data/mods/public/shaders/spirv/` so that the Vulkan backend works
out of the box. On macOS, Vulkan runs through MoltenVK
(`binaries/system/libMoltenVK.dylib`, loaded by `source/ps/VideoMode.cpp`),
and `rendererbackend = "vulkan"` is the default in
`binaries/data/config/default.cfg`.

Why: the GL backend only gets a legacy OpenGL 2.1 context on macOS, which
disables GPU skinning (`source/renderer/RenderingOptions.cpp`) and FSR
upscaling. Vulkan via MoltenVK supports compute and storage buffers, so both
work. If Vulkan device creation fails (or `shaders/spirv/canvas2d` is
missing), `CVideoMode::CreateBackendDevice` logs an error and falls back to
`gl` automatically; that fallback is unchanged.

## Provenance of the shipped SPIR-V files

The shaders were taken unmodified from the official 0 A.D. 0.28.0 release
data, not compiled locally. Agentium's GLSL sources under
`binaries/data/mods/{mod,public}/shaders/` are byte-identical to upstream
0.28.0 (`git diff 5617ba8a8 -- binaries/data/mods/mod/shaders
binaries/data/mods/public/shaders` is empty), so the release SPIR-V matches
them exactly.

- URL: https://releases.wildfiregames.com/0ad-0.28.0-unix-data.tar.xz
- Size: 1,415,012,652 bytes
- SHA-256: `e844b30ae2102c47e0a4fff2f0e0ef05ba0cebb1890aa72276fa12457c39526f`
  (verified against the published `0ad-0.28.0-unix-data.tar.xz.sha256sum`)
- Inside the tarball the mods are zipped:
  `0ad-0.28.0/binaries/data/mods/mod/mod.zip` and
  `0ad-0.28.0/binaries/data/mods/public/public.zip`. Only `shaders/spirv/`
  was extracted from each, and only the `*.spv` and `*.xml` files were
  copied (the `*.xmb` files in the zips are the engine's XML cache and are
  regenerated at runtime).
- Result: `mod` 828 files (1317 in the zip incl. `.xmb`), `public` 7948
  files; 1769 `.spv` + 7007 `.xml` in total, about 44 MB.

To refresh them after a shader change, either repeat the steps above with a
newer release/nightly (`get-nightly-shaders.sh` exports them from the
nightly SVN), or compile them with `compile.py` as described in `README.md`
(needs `glslc`, spirv-tools and a rules JSON).

Git handling: `.gitignore` upstream ignores `binaries/data/mods/*/shaders/spirv`;
Agentium un-ignores the two directories. `.gitattributes` marks `*.spv` as
`binary` and does not route them through Git LFS, so the GitHub fork serves
them as plain blobs.

## Verification on macOS (2026-11-04, Apple M1 Pro, macOS 27.2, 3456x2234 window)

Command used for both backends (uncapped frame rate, per-process logs):

```
binaries/system/pyrogenesis -windowed -unique-logs -conf=overlay.fps:true \
  -conf=adaptivefps.session:1000 -autostart="skirmishes/acropolis_bay_2p"
```

GL run adds `-conf=rendererbackend:gl`.

Vulkan log: `Loaded @executable_path/libMoltenVK.dylib`, `Vulkan available
device: 'Apple M1 Pro' Type: 1 Supported: Y`, `rendererbackend = "vulkan"`,
no "GPU skinning isn't supported on the current hardware" line and no
renderer ERROR lines.

| Backend | FPS overlay (two samples) | Profiler root msec/frame | render msec/frame (CPU) |
|---------|---------------------------|--------------------------|-------------------------|
| Vulkan (MoltenVK) | 541, 253 | 4.996 | 0.749 |
| GL (OpenGL 2.1 "Metal - 91.7") | 127 | 8.783 | 2.955 |

The GL log contains `GPU skinning isn't supported on the current hardware.`
and links the GLSL programs; the Vulkan log has neither. Frame rate was read
from the `overlay.fps` counter about 55 s after launch; the profiler numbers
come from a Shift+F11 snapshot (`logs/profile.txt`) taken a few seconds
later. Skirmish civs are random per run, so the two scenes are similar but
not identical. Both runs carried the same GUI script error spam from
uncommitted in-progress session GUI work, which costs CPU time equally on
both backends.

Main menu: also started on Vulkan with no autostart; the GUI renders
correctly, the FPS counter reads 1528, and the log shows the same
MoltenVK/device lines with no ERROR or WARNING entries.

## Speed defaults (2026-11-04, later the same day)

Where the time goes. Measured with the engine's HTTP profiler
(`-conf=profiler2.autoenable:true -conf=profiler2.gpu.enable:false`, main
thread, last 10 s of each run; note that the default `profiler2.gpu.enable =
true` adds a per-frame GPU timestamp readback that capped every run at
~85 FPS, so it was turned off for measuring). Scene: `scenarios/combat_demo_huge`,
Apple M1 Pro, Vulkan/MoltenVK, uncapped:

| Variant | avg FPS | median ms | p99 ms |
|---|---|---|---|
| hidpi on (3456x2168 px) | 43.9 | 22.1 | 29.5 |
| hidpi off (1728x1084 px) | 44.4 | 21.9 | 28.9 |
| hidpi off + FSR 75 % | 43.7 | 22.3 | 28.9 |
| hidpi off + vsync | 45.2 | 21.6 | 27.4 |
| hidpi off + shadows off | 69.3 | 14.0 | 20.5 |
| hidpi off + shadows, silhouettes, particles off, materialmgr.quality 5 | 74.0 | 13.2 | 19.6 |

Resolution makes no measurable difference: the frame is bound by main-thread
CPU work (`render` 14.8 ms, of which shadow map 3.4, prepare models 3.0,
model draw submission 4.3, compute silhouettes 0.7; `Present` then waits
~6 ms for a MoltenVK drawable, i.e. the GPU is busy with vertex/skinning work
that also does not scale with pixels). On the light `acropolis_bay_2p` start
scene the game runs at 250-500 FPS whatever the resolution.

Defaults changed in `binaries/data/config/default.cfg` for speed:

- `hidpi = false` (as requested; no FPS gain, but a quarter of the pixels,
  so less GPU power/heat on the laptop and on the 5K display).
- `shadows = false` (the one big win, +56 % in unit-dense scenes).
- `silhouettes = false` (small win).
- Left alone: `vsync = false` (FIFO on a 60 Hz display would drop a 44 FPS
  scene to 30), `adaptivefps.session = 60`, `particles`, `materialmgr.quality`,
  `renderer.scale = 1.0` (FSR is pointless when the GPU is not pixel-bound).

Not fixable from config: with the RL interface (arena matches) the main loop
skips the per-frame game update (`source/main.cpp`, `if (!rlInterface)`), so
the simulation only advances and interpolates inside each HTTP `/step`; units
move in 200 ms jumps however high the frame rate. Smooth motion needs the
RL path to call `g_Game->Interpolate` every frame.

Verification of the new defaults (no `-conf` overrides except the profiler
and the FPS cap): `combat_demo_huge` 73.1 FPS avg, median 13.3 ms, p99 20.0 ms
(was 43.9 / 22.1 / 29.5); `acropolis_bay_2p` 241.6 FPS avg, median 2.1 ms. Log
shows `hidpi off`, 1728x1084 pixels, MoltenVK loaded, no ERROR lines.
On-screen check after the user allowed screen recording: `acropolis_bay_2p`
273 FPS with the full session GUI; `combat_demo_huge` 76 FPS (14.4 ms/frame)
with the new defaults versus 49 FPS (23.3 ms/frame) with `shadows = true`,
same scene. The black ground in that demo is the map itself (also black with
shadows on), not a rendering fault.

## Choppy motion in arena (RL interface) matches: fixed in the engine

Resolution was put back to `hidpi = true` (it made no measurable difference);
`shadows = false` and `silhouettes = false` stay.

Cause: with `-rl-interface` the main loop skipped `CGame::Update` entirely, so
the simulation advanced *and* interpolated only inside each HTTP `/step`
(one 200 ms turn per step at arena speed 1). Between steps nothing moved,
then everything jumped: 5 visual updates per second however high the FPS.

Fix (uncommitted):
- `CTurnManager::AdvanceInterpolation()` moves the interpolation clock
  towards the current turn without ever running a turn; `RunSingleTurn()`
  runs exactly one turn and restarts that clock at offset 0.
- `CGame::UpdateInterpolationOnly()` (per frame: render clock + interpolation)
  and `CGame::StepTurn()` (one turn, GUI SimulationUpdate event, LOS dirty).
- `main.cpp`: in RL mode call `UpdateInterpolationOnly` every frame, also when
  the window has no focus (matches are watched from the arena page), and never
  the normal `Update`.
- `RLInterface.cpp`: the visual step calls `StepTurn()` per requested turn
  instead of `g_Game->Update(200 ms)`. The headless path is unchanged.

Measured with a 4 s screen recording of a 1000x700 region at 30 fps, counting
consecutive frame pairs with no visible change (mean grey diff < 0.15):

| Run | static pairs |
|---|---|
| Normal skirmish, Petra vs Petra, observer (reference) | 2 % |
| Arena-style RL game, 1 turn per 200 ms, after the fix | 14 % |
| Same before the fix | not measured (old binary rebuilt); by construction ~5 of 6 frames at 30 fps were static |

Probe scripts live in the session scratchpad (`rl_probe.sh`, `videodiff.py`):
start `pyrogenesis -rl-interface=127.0.0.1:6123 -windowed`, POST `/reset` with
the attributes from a replay's `commands.txt`, then POST `/step?turns=1` every
200 ms like `arena/src/match.ts`.

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

#!/usr/bin/python3
"""Build the OSX bundle from existing elements.

App bundles are intended to be self-contained and portable.
An SDK is required, usually included with Xcode. The SDK ensures
that only those system libraries are used which are available on
the chosen target and compatible systems.

This is Python because plistlib is extremely strict about what it accepts,
and it's used by dmgbuild, and saving the Plist doesn't really work otherwise.
"""

import argparse
import glob
import os
import plistlib
import shutil
import subprocess
import sys
from datetime import UTC, datetime


parser = argparse.ArgumentParser()
parser.add_argument("bundle_version", help="Bundle version")
parser.add_argument("--architecture", help="aarch64 (arm64) or x86_64 (amd64)", default="aarch64")
parser.add_argument("--min_osx", help="Minimum supported OSX version", default="10.15")
parser.add_argument("--bundle_identifier", help="Bundle identifier", default="com.agentium.game")
parser.add_argument("-s", "--signkey", help="Signature key sha sum (omit for an ad-hoc signature)")
parser.add_argument(
    "--no-dmg", help="Stop after the signed .app (no .dmg, no notarization)", action="store_true"
)
parser.add_argument(
    "--rebuild-archives",
    help="Rebuild archives/ with pyrogenesis -archivebuild even if it exists",
    action="store_true",
)
parser.add_argument("--notarytool_user", help="Apple ID user for notarization")
parser.add_argument("--notarytool_team", help="Team ID for notarization")
parser.add_argument("--notarytool_password", help="App password for notarization")
parser.add_argument(
    "--dev", help="Turn on dev mode, which isn't fit for release but faster", action="store_true"
)
args = parser.parse_args()

ARCH = args.architecture
BUNDLE_IDENTIFIER = args.bundle_identifier
BUNDLE_VERSION = args.bundle_version
BUNDLE_MIN_OSX_VERSION = args.min_osx

# No key: an ad-hoc signature, which runs on this machine and on others after
# "right-click > Open" (Gatekeeper), but cannot be notarized.
SIGNKEY = args.signkey or "-"
ADHOC = args.signkey is None
NOTARIZE = not ADHOC and bool(args.notarytool_user and args.notarytool_team and args.notarytool_password)


def codesign(target, *extra):
    cmd = ["codesign", "-s", SIGNKEY, "-f", *([] if ADHOC else ["--timestamp"]), *extra, target]
    subprocess.run(cmd, check=True)


def build_archives():
    """Pack each shipped mod into archives/<mod>/<mod>.zip with the engine's archive builder."""
    for mod in ("mod", "public"):
        out = f"archives/{mod}"
        os.makedirs(out, exist_ok=True)
        print(f"Building archive for {mod} (this takes a while for public)")
        subprocess.run(
            [
                "binaries/system/pyrogenesis",
                "-mod=mod",
                f"-archivebuild=binaries/data/mods/{mod}",
                f"-archivebuild-output={out}/{mod}.zip",
            ],
            check=True,
        )
        if os.path.isfile(f"binaries/data/mods/{mod}/mod.json"):
            shutil.copy(f"binaries/data/mods/{mod}/mod.json", out)


NOTARYTOOL_USER = args.notarytool_user
NOTARYTOOL_TEAM = args.notarytool_team
NOTARYTOOL_PASSWORD = args.notarytool_password

BUNDLE_DMG_NAME = f"agentium-{BUNDLE_VERSION}-macos-{ARCH}"
BUNDLE_OUTPUT = "Agentium.app"
BUNDLE_CONTENTS = BUNDLE_OUTPUT + "/Contents"
BUNDLE_BIN = BUNDLE_CONTENTS + "/MacOS"
BUNDLE_RESOURCES = BUNDLE_CONTENTS + "/Resources"
BUNDLE_FRAMEWORKS = BUNDLE_CONTENTS + "/Frameworks"
BUNDLE_PLUGINS = BUNDLE_CONTENTS + "/PlugIns"
BUNDLE_SHAREDSUPPORT = BUNDLE_CONTENTS + "/SharedSupport"

print("Creating bundle directories")

shutil.rmtree(BUNDLE_OUTPUT, ignore_errors=True)
os.makedirs(BUNDLE_BIN)
os.makedirs(BUNDLE_FRAMEWORKS)
os.makedirs(BUNDLE_PLUGINS)
os.makedirs(BUNDLE_RESOURCES)
os.makedirs(BUNDLE_SHAREDSUPPORT)

print("Copying binaries")

# Only pyrogenesis for now, until we find a way to load
#     multiple binaries from one app bundle
# TODO: Would be nicer if we could set this path in premake
shutil.copy("binaries/system/pyrogenesis", BUNDLE_BIN)

print("Copying libs")
# libAtlasUI is only built with the Atlas editor (wxWidgets); the game runs without it.
LIBS = [lib for lib in ("libAtlasUI.dylib", "libCollada.dylib", "libMoltenVK.dylib") if os.path.isfile("binaries/system/" + lib)]
for lib in LIBS:
    shutil.copy("binaries/system/" + lib, BUNDLE_FRAMEWORKS)
if "libAtlasUI.dylib" not in LIBS:
    print("  (no libAtlasUI.dylib: the scenario editor is not included)")

if not args.dev:
    print("Signing libs")
    for lib in LIBS:
        codesign(BUNDLE_FRAMEWORKS + "/" + lib)

if not args.dev:
    if args.rebuild_archives or not glob.glob("archives/*/*.zip"):
        build_archives()
    print("Copying archived game data from archives/")
    for mod in glob.glob("archives/*/"):
        print(f"Copying {mod}")
        shutil.copytree(mod, BUNDLE_RESOURCES + "/data/mods/" + mod.replace("archives/", ""))
else:
    print("Symlinking mods")
    os.makedirs(BUNDLE_RESOURCES + "/data/mods")
    os.chdir(BUNDLE_RESOURCES + "/data/mods")
    for mod in glob.glob("../../../../../binaries/data/mods/*"):
        os.symlink(mod, mod.replace("../../../../../binaries/data/mods/", ""))
    os.chdir("../../../../../")

print("Copying non-archived game data")
shutil.copytree("binaries/data/config", BUNDLE_RESOURCES + "/data/config")
shutil.copytree("binaries/data/l10n", BUNDLE_RESOURCES + "/data/l10n")
shutil.copytree("binaries/data/tools", BUNDLE_RESOURCES + "/data/tools")
# Remove the dev.cfg file or 0 A.D. will assume it's running a dev copy.
os.unlink(BUNDLE_RESOURCES + "/data/config/dev.cfg")

shutil.copy("build/resources/0ad.icns", BUNDLE_RESOURCES)
shutil.copy("build/resources/InfoPlist.strings", BUNDLE_RESOURCES)

print("Copying readmes")
# TODO: Also want copies in the DMG - decide on layout
for file in glob.glob("*.txt"):
    shutil.copy(file, BUNDLE_RESOURCES)
shutil.copy("libraries/LICENSE.txt", BUNDLE_RESOURCES + "/LIB_LICENSE.txt")

print("Creating Info.plist")

with open(BUNDLE_CONTENTS + "/Info.plist", "wb") as f:
    plistlib.dump(
        {
            "CFBundleName": "Agentium",
            "CFBundleIdentifier": BUNDLE_IDENTIFIER,
            "CFBundleVersion": BUNDLE_VERSION,
            "CFBundlePackageType": "APPL",
            "CFBundleSignature": "none",
            "CFBundleExecutable": "pyrogenesis",
            "CFBundleShortVersionString": BUNDLE_VERSION,
            "CFBundleDevelopmentRegion": "English",
            "CFBundleInfoDictionaryVersion": "6.0",
            "NSHighResolutionCapable": True,
            "NSSupportsAutomaticGraphicsSwitching": True,
            "LSApplicationCategoryType": "public.app-category.strategy-games",
            "CFBundleIconFile": "0ad",
            "LSHasLocalizedDisplayName": True,
            "LSMinimumSystemVersion": BUNDLE_MIN_OSX_VERSION,
            "NSHumanReadableCopyright": f"Agentium is a fork of 0 A.D., Copyright © {datetime.now(tz=UTC).year} Wildfire Games and the Agentium contributors. GPL-2.0-or-later; art CC-BY-SA.",
            "UTExportedTypeDeclarations": [
                {
                    "UTTypeIdentifier": BUNDLE_IDENTIFIER,
                    "UTTypeTagSpecification": {
                        "public.filename-extension": ["pyromod"],
                    },
                    "UTTypeConformsTo": ["public.zip-archive"],
                    "UTTypeDescription": "Agentium Zipped Mod",
                    "UTTypeIconFile": "0ad",
                }
            ],
            "CFBundleDocumentTypes": [
                {
                    "CFBundleTypeExtensions": ["pyromod"],
                    "CFBundleTypeRole": "Editor",
                    "CFBundleTypeIconFile": "0ad",
                    "LSHandlerRank": "Owner",
                },
                {
                    "CFBundleTypeExtensions": ["zip"],
                    "CFBundleTypeRole": "Viewer",
                    "CFBundleTypeIconFile": "0ad",
                    "LSHandlerRank": "Alternate",
                },
            ],
        },
        f,
    )

if args.dev:
    print(f"Dev mode bundle complete, located at {BUNDLE_OUTPUT}")
    sys.exit(0)

print("Signing bundle" + (" (ad-hoc)" if ADHOC else ""))
codesign(BUNDLE_OUTPUT, "-o", "runtime", "--entitlements", "source/tools/dist/0ad.entitlements")

if args.no_dmg:
    print(f"Bundle complete, located at {BUNDLE_OUTPUT}")
    sys.exit(0)

print("Creating .dmg")
import dmgbuild  # noqa: E402  (pip install dmgbuild)


# Package the app into a dmg
dmgbuild.build_dmg(
    filename=BUNDLE_DMG_NAME + ".dmg",
    volume_name=BUNDLE_DMG_NAME,
    settings_file="source/tools/dist/dmgbuild-settings.py",
    defines={
        "app": BUNDLE_OUTPUT,
        "background": "build/resources/dmgbackground.png",
        "icon": "build/resources/0ad.icns",
    },
)

print("Signing .dmg")
codesign(BUNDLE_DMG_NAME + ".dmg", "-i", BUNDLE_IDENTIFIER)

if not NOTARIZE:
    print(f"Bundle complete! {BUNDLE_DMG_NAME}.dmg is {'ad-hoc signed' if ADHOC else 'signed'} but not notarized (pass --signkey and the --notarytool_* options for a notarized release).")
    sys.exit(0)

print("Notarizing .dmg")
subprocess.run(
    [
        "xcrun",
        "notarytool",
        "submit",
        BUNDLE_DMG_NAME + ".dmg",
        "--apple-id",
        NOTARYTOOL_USER,
        "--team-id",
        NOTARYTOOL_TEAM,
        "--password",
        NOTARYTOOL_PASSWORD,
        "--wait",
    ],
    check=True,
)

print("Stapling notarization ticket")
subprocess.run(["xcrun", "stapler", "staple", BUNDLE_DMG_NAME + ".dmg"], check=True)

print(f"Bundle complete! Installer located at {BUNDLE_DMG_NAME}.dmg.")

#!/usr/bin/env bash
# Build the patched untrunc engine for this machine and put it into resources/bin/<os>-<arch>/.
#
#   macOS:   needs Xcode Command Line Tools (xcode-select --install). nasm optional (brew install nasm).
#   Windows: run from an MSYS2 "MINGW64" shell with: pacman -S --needed git make diffutils mingw-w64-x86_64-gcc mingw-w64-x86_64-nasm
#   Linux:   build-essential git (nasm optional)
#
# Sources are pulled from GitHub only (ffmpeg.org is not needed).
set -euo pipefail

UNTRUNC_REPO="https://github.com/anthwlock/untrunc.git"
UNTRUNC_COMMIT="87a5d9202ae48495b9aa6b5880649dbdf32c82d0"   # tested with this commit
FFMPEG_REPO="https://github.com/FFmpeg/FFmpeg.git"
FFMPEG_TAG="n7.1"
FF_VER="7.1"

root="$(cd "$(dirname "$0")/.." && pwd)"
work="${WORK:-$root/.untrunc-build}"

case "$(uname -s)" in
  Darwin) os=mac ;;
  Linux) os=linux ;;
  MINGW*|MSYS*|CYGWIN*) os=win ;;
  *) echo "unsupported OS $(uname -s)"; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "unsupported arch $(uname -m)"; exit 1 ;;
esac
if [[ "$os" == mac ]]; then jobs="$(sysctl -n hw.ncpu)"; else jobs="$(nproc 2>/dev/null || echo 4)"; fi

echo "==> building untrunc for $os-$arch in $work"
mkdir -p "$work"
cd "$work"

if [[ ! -d untrunc/.git ]]; then
  git init -q untrunc
  git -C untrunc remote add origin "$UNTRUNC_REPO"
fi
git -C untrunc fetch -q --depth 1 origin "$UNTRUNC_COMMIT"
git -C untrunc checkout -q -f FETCH_HEAD
git -C untrunc apply --ignore-whitespace "$root/patches/untrunc-moov-only.patch"

cd untrunc
if [[ ! -d "ffmpeg-$FF_VER" ]]; then
  git clone -q --depth 1 --branch "$FFMPEG_TAG" "$FFMPEG_REPO" "ffmpeg-$FF_VER"
fi

ff_flags=(
  --disable-doc --disable-programs --disable-everything --enable-decoders --enable-parser=hevc
  --enable-demuxers --enable-protocol=file --disable-avdevice --disable-swresample --disable-swscale
  --disable-avfilter --disable-postproc --disable-vdpau --disable-xlib --disable-vaapi --disable-libdrm
  --disable-zlib --disable-bzlib --disable-lzma --disable-iconv
)
[[ "$os" == mac ]] && ff_flags+=(--disable-audiotoolbox --disable-videotoolbox)
if [[ "$arch" == x64 ]] && ! command -v nasm >/dev/null; then
  echo "   (nasm not found — building ffmpeg without x86 assembly, a bit slower but works)"
  ff_flags+=(--disable-x86asm)
fi

if [[ ! -f "ffmpeg-$FF_VER/libavcodec/libavcodec.a" ]]; then
  echo "==> configuring ffmpeg $FFMPEG_TAG"
  (cd "ffmpeg-$FF_VER" && ./configure "${ff_flags[@]}" > ../ffmpeg-configure.log)
  echo "==> building ffmpeg (a few minutes)"
  make -s -C "ffmpeg-$FF_VER" -j"$jobs" > ffmpeg-build.log
fi
# untrunc's Makefile treats ffmpeg as unbuilt (and re-runs configure) if config.asm is missing,
# which configure doesn't create on every platform (e.g. macOS arm64)
[[ -f "ffmpeg-$FF_VER/config.asm" ]] || touch "ffmpeg-$FF_VER/config.asm"
[[ "$os" == mac ]] && mv -f "ffmpeg-$FF_VER/VERSION" "ffmpeg-$FF_VER/VERSION.bak" 2>/dev/null || true

echo "==> building untrunc"
if [[ "$os" == win ]]; then
  # MinGW has no libdl, and static ffmpeg needs a few Windows system libs after -lavutil:
  # override the Makefile's link line completely.
  ff="ffmpeg-$FF_VER"
  win_ld="-L$ff/libavformat -lavformat -L$ff/libavcodec -lavcodec -L$ff/libavutil -lavutil"
  win_ld+=" -static -lpthread -lbcrypt -lws2_32 -lole32 -luser32 -s"
  make -s FF_VER="$FF_VER" IS_RELEASE=1 LDFLAGS="$win_ld" -j"$jobs" > untrunc-build.log
else
  extra_ld=""
  [[ "$os" == mac ]] && extra_ld="-liconv"
  LDFLAGS="$extra_ld" make -s FF_VER="$FF_VER" IS_RELEASE=1 -j"$jobs" > untrunc-build.log
fi

exe=untrunc
[[ "$os" == win ]] && exe=untrunc.exe
out="$root/resources/bin/$os-$arch"
mkdir -p "$out"
cp -f "$exe" "$out/$exe"
chmod +x "$out/$exe"
echo "==> $("$out/$exe" -V 2>&1 | head -1)"
echo "==> done: $out/$exe"

#!/bin/bash
set -euo pipefail
export PATH=/opt/node/bin:/opt/cargo/bin:/opt/patchelf/bin:/opt/vulkan/1.4.304.1/x86_64/bin:$PATH
export PATCHELF=/opt/patchelf/bin/patchelf
export VULKAN_SDK=/opt/vulkan/1.4.304.1/x86_64
export CMAKE_PREFIX_PATH=$VULKAN_SDK
export CARGO_BUILD_JOBS=3
export XZ_OPT=-T4
unset OPENSCREEN_SYMBOL_FLOOR
cd /workspace
git fetch origin
git switch --detach a4f92422
mkdir /output/remembered-source-a4f92422
npm run build:native:linux
node /instructions/manifest.mjs
npm run build-vite
npx electron-builder --linux AppImage deb pacman rpm --config.npmRebuild=false --publish never
node scripts/verify-packaged-distribution.mjs --package-dir release/1.9.5/linux-unpacked --platform linux --arch x64 --source-sha "$(git rev-parse HEAD)"
git rev-parse HEAD > /output/remembered-source-a4f92422/source-sha.txt
cp -a release /output/remembered-source-a4f92422/
chown -R 1000:1000 /output/remembered-source-a4f92422
printf 'REMEMBERED_SOURCE_PORTABLE_POLICY_PASS\n'

#!/bin/sh
# SPDX-FileCopyrightText: syuilo and misskey-project
# SPDX-License-Identifier: AGPL-3.0-only
set -eu

# Keep the version aligned with .github/actions/setup-libvips/action.yml.
vips_version=8.18.3
vips_sha256=f41285b61bfb495605494f074ca341f7791a1d406e2f157dcea606ef1ae1b146

apt-get update
apt-get install -y --no-install-recommends \
	build-essential curl ca-certificates meson ninja-build pkg-config \
	libglib2.0-dev libexpat1-dev libjpeg62-turbo-dev libpng-dev \
	libwebp-dev libtiff-dev libexif-dev liblcms2-dev libcgif-dev \
	libjxl-dev libheif-dev libfftw3-dev liborc-0.4-dev libspng-dev \
	libarchive-dev libhwy-dev librsvg2-dev

build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
curl --fail --location --retry 3 \
	"https://github.com/libvips/libvips/releases/download/v${vips_version}/vips-${vips_version}.tar.xz" \
	--output "$build_dir/vips.tar.xz"
printf '%s  %s\n' "$vips_sha256" "$build_dir/vips.tar.xz" | sha256sum --check -
tar -xf "$build_dir/vips.tar.xz" -C "$build_dir"
meson setup "$build_dir/build" "$build_dir/vips-$vips_version" \
	--prefix=/opt/vips --libdir=lib --buildtype=release \
	-Dintrospection=disabled -Djpeg-xl=enabled
meson compile -C "$build_dir/build" -j 4
meson install -C "$build_dir/build"
printf '%s\n' /opt/vips/lib > /etc/ld.so.conf.d/misskey-vips.conf
ldconfig

# Discover the Debian runtime packages from the libraries actually linked by
# libvips and its modules, rather than maintaining architecture-specific SONAMEs.
find /opt/vips/lib -type f -name '*.so*' -exec ldd '{}' \; > "$build_dir/ldd.txt"
if grep -q 'not found' "$build_dir/ldd.txt"; then
	cat "$build_dir/ldd.txt"
	exit 1
fi
awk '$3 ~ /^\// { print $3 }' "$build_dir/ldd.txt" | sort -u > "$build_dir/libraries.txt"
while IFS= read -r library; do
	case "$library" in /opt/vips/*) continue ;; esac
	resolved=$(readlink -f "$library")
	package=$(dpkg-query -S "$resolved" 2>/dev/null || dpkg-query -S "$library")
	printf '%s\n' "$package" | sed 's/: .*//'
done < "$build_dir/libraries.txt" | sort -u > /opt/vips/runtime-packages.txt
test -s /opt/vips/runtime-packages.txt
PKG_CONFIG_PATH=/opt/vips/lib/pkgconfig pkg-config --modversion vips-cpp

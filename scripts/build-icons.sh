#!/usr/bin/env bash
# Regenerate each app's icons from <app>/web/icon-source.png. Needs ImageMagick 7.
# Run it after replacing a source image and commit the results in <app>/web/static.
#
#   favicon.ico            16, 32, 48: browser tabs
#   icon-192/512.png       transparent corners: launchers, notifications, the header
#   icon-maskable-512.png  full bleed with the artwork inside the 80% safe zone: Android
#   apple-touch-icon.png   full bleed and opaque, which iOS requires
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Lines up with the band under the header in both source images.
header_end=378

# Square the artwork to its bounds and shave the dark fringe left by the background removal.
cutout() {
    magick "$1" -trim +repage -background none -gravity center -extent 966x966 \
        -channel A -morphology Erode Disk:3 +channel "$2"
}

# A sheet that continues the header and the paper out to the edges, with the artwork on top.
#   bleed <source> <cutout> <fraction of the canvas the artwork fills> <size> <out>
bleed() {
    local src="$1" art="$2" fill="$3" size="$4" out="$5"
    local canvas=1024 tile inset top head
    # Fade the artwork's edge into the sheet so its outline doesn't show.
    magick "$art" -channel A -morphology Erode Disk:34 -blur 0x10 +channel "$work/feathered.png"
    tile=$(awk "BEGIN { printf \"%d\", $canvas * $fill }")
    inset=$(((canvas - tile) / 2))
    head=$(awk "BEGIN { printf \"%d\", ($header_end - 142) * $tile / 966 }")
    top=$((inset + head))
    # Both strips come from columns clear of any artwork, and stretch across the canvas.
    magick "$src" -crop 1x$((header_end - 150))+627+150 +repage -resize "${canvas}x${head}!" "$work/head.png"
    magick "$src" -crop 1x600+165+400 +repage -resize "${canvas}x$((canvas - top))!" "$work/paper.png"
    magick -size "${canvas}x${canvas}" xc:none \
        \( "$work/head.png" -crop 1x1+0+0 +repage -resize "${canvas}x$((inset + 1))!" \) -geometry +0+0 -composite \
        "$work/head.png" -geometry "+0+$inset" -composite \
        "$work/paper.png" -geometry "+0+$top" -composite \
        \( "$work/feathered.png" -resize "${tile}x${tile}" \) -geometry "+$inset+$inset" -composite \
        -alpha remove -alpha off -filter Lanczos -resize "${size}x${size}" -strip -depth 8 "$out"
}

for app in huginn muninn; do
    src="$root/$app/web/icon-source.png"
    out="$root/$app/web/static"
    art="$work/$app.png"
    cutout "$src" "$art"

    for size in 192 512; do
        magick "$art" -filter Lanczos -resize "${size}x${size}" -strip -depth 8 "$out/icon-$size.png"
    done
    # Mitchell, because Lanczos rings around Muninn's dots at these sizes.
    for size in 16 32 48; do
        magick "$art" -filter Mitchell -resize "${size}x${size}" -strip -depth 8 "$work/fav-$size.png"
    done
    magick "$work/fav-16.png" "$work/fav-32.png" "$work/fav-48.png" "$out/favicon.ico"

    # 0.7 keeps the artwork, including Muninn's lowest dot, inside the maskable safe circle.
    bleed "$src" "$art" 0.7 512 "$out/icon-maskable-512.png"
    bleed "$src" "$art" 1 180 "$out/apple-touch-icon.png"
done

# Pen spike

One page, no build, no dependencies: does this browser on this device hand a
web page the pen's pressure, tilt, hover and eraser, and at what rate? This
is the go/no-go for a web frontend on the Surface Pro 11 (Chromium under
Hyprland, pen via iptsd) and the Galaxy Z Fold (Chrome, S Pen).

```sh
# From the Surface, serve it to the tailnet (Pointer Events need no HTTPS):
python3 -m http.server -d spikes/pen 8099 --bind 0.0.0.0
```

Then open `http://<this machine's tailnet name or IP>:8099/` on each device,
scribble with the pen pressing lighter and harder, hover the pen above the
screen, flip it to the eraser, pan with a finger and pinch with two. The
verdict line turns green when eight or more distinct pressure levels have
arrived. **Report** shows a JSON summary to paste into an issue or a chat.

What a pass looks like per device: pen pressure levels in the dozens, pen
events at 100Hz+ with coalesced samples above 1 per event, hover `yes`,
touch rows separate from the pen row, mouse pressure fixed at 0.50.

If the Surface reports one flat pressure level, the gap is between iptsd,
libinput's tablet path, Hyprland's `zwp_tablet_v2` and Chromium's Ozone
Wayland backend; Rnote proves the first three, so start at Chromium
(`chrome://flags`, `--ozone-platform=wayland`, and whether the pen shows as a
tablet tool in `libinput debug-events`).

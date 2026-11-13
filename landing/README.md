# Fleetwake landing page

A single-file, scroll-driven landing page for the fleet telemetry platform. A live Three.js night city runs behind five chapters: Live, Ingest, Broadcast, Replay and Detect. It ends with the architecture strip and a call to action.

## Run it

Open `index.html` in a browser, or serve the folder:

```sh
npx serve landing
# or
python3 -m http.server 4173 --directory landing
```

Nothing needs to be built. The page loads Three.js r128 from cdnjs and its fonts from Google Fonts.

## What to change before submission

- **Product name:** "Fleetwake" is a placeholder.
- **Stats:** the four numbers in the architecture section are load-test goals. Replace them with your measured results.
- **Dashboard links:** the "Open dashboard" links point to `#launch`. Point them at the React dashboard route (for example `/dashboard`) once it exists.

## How the scene works

- The roads are Catmull-Rom curves. Vehicles move along them by arc length, and each vehicle has a plate, a sequence number and a speed that feed the live event list.
- The vehicles are built at runtime from extruded side profiles with rounded bevels. There are five types: an electric fastback saloon, an SUV, a box truck, a bus and a motorbike with a rider. Each type is drawn as three `InstancedMesh` layers (paint, details and lamps) that share one transform, so the whole fleet costs a handful of draw calls.
- Scroll position picks a camera shot for each chapter. Some shots are fixed and some follow a moving vehicle, and the camera eases between them.
- `prefers-reduced-motion` slows the traffic and removes the camera easing.

## Credits

- [Three.js](https://threejs.org) r128, MIT license.
- The scroll-driven storytelling was inspired by [Kage](https://github.com/MengTo/kage) by Meng To. No code or artwork is reused from it.
- The look of the saloon draws on the [VEYRA interactive car](https://github.com/amirmushichge/veyra-interactive-car) design study by Amir Mušić (MIT). None of its code or media is used; the 3D models here are original.
- The content structure takes cues from motorq.com.
- Fonts: Big Shoulders Display, Instrument Sans and IBM Plex Mono, from Google Fonts (SIL Open Font License).

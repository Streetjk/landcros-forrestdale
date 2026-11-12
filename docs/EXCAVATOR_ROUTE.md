# EX2000-7 SiteNav animation — isolated demonstrator

Status: published as a **visual demonstration only**, not an approved vehicle or traffic route.

The owner drew a yellow excavator route on a 1189×885 screenshot of the
Forrestdale SiteNav viewer on 12 November 2026. The orange site traffic arrows
in the reference screenshot are separate and must not be modified.

## Deployment isolation

- Target static-site base: https://landcros-forrestdale-static.onrender.com/
- Additive suffix: `/excavator-route.html`
- The normal root URL continues using `index.html`.
- The build makes a copy of the HTML viewer with the new suffix. Its animation
  code only imports on that suffix.
- Asset target: `assets/excavator/EX2000_7_SiteNav_v6.glb`.
- Previous v2, v3, v4 and v5 GLBs are retained for comparison; the route page uses v6.
- Rejected primitive model must **never** be copied to this asset path.

## Route georeferencing

Digitised yellow line in screenshot pixel coordinates, with world conversion
cross-checked against the already present orange route points in
`sites/landcros/data/traffic.json` and label anchors in
`sites/landcros/data/buildings.geojson`. This is approximate 2D registration,
not an engineering survey. It does not verify clearance or ground elevation.

For the owner screenshot only:

`screen_x ≈ 646 - 40.5 × scene_z`

`screen_y ≈ 710 + 41.0 × scene_x`

Key positions:

| Screenshot (px) | Scene (x, z) | Description |
|---|---|---|
| (617, 405) | (-7.44, 0.72) | Yellow termination in Module lane |
| (803, 440) | (-6.58, -3.87) | First bend, east of Module |
| (808, 566) | (-3.52, -3.99) | Passage beside Parts building |
| (964, 636) | (-1.81, -7.84) | South of Mining workshop |
| (1130, 569) | (-3.45, -11.94) | Eastern workshop side |
| (1098, 473) | (-5.77, -11.16) | Eastern yellow termination |

The renderer spline follows all intermediate points in
`excavator-route.js`. Per the owner's instruction on 12 November 2026,
the excavator starts at the eastern yellow termination and heads **180°
opposite** the previous animation, finishing in the Module lane. The path
is one-way; travel stops at the end. **Replay** resets to the eastern start,
and there is no automated backwards return. At the destination, the tracks
stop and only the upperstructure slews **clockwise 180°** over 8 seconds with
smooth start/stop easing. During travel the house remains exactly aligned
with the undercarriage at 0°. The final slew lands at **−180°**, facing
rearward but exactly parallel to the tracks; it cannot stop a few degrees
skewed. The final position is held until Replay. Pause/Resume
also works during this parking slew; the control shows **Parking** until the
turn completes, then **Parked**. It does not follow the orange traffic-control
arrows.

## Dimensions and animation

- Real EX2000-7 specification basis: 8.3 m backhoe boom, 3.6 m arm,
  5.62 m undercarriage width, 7.24 m upperstructure width.
- Official Hitachi brochure:
  https://hitachicm.com.au/wp-content/uploads/2023/08/KS-EN465Q-EX2000-7-Brochure-JAN-2026-WEB.pdf
- The first render reference showed an EX2600. Version 3 is instead based
  primarily on six owner-provided photographs of an actual EX2000-7
  (EX935/MMS) in the workshop. The photographs show an incomplete assembly,
  so the installed stick and bucket remain simplified.
- Scene scale is currently ~12.449 physical metres per SiteNav unit from
  `assets/gps-calibration.json` (status: provisional).
- Speed choices are **1×, 2× and 5×**, initially **2×**. The 1× demo rate is
  equivalent to 4.2 km/h (twice the first demo's baseline); starting 2× is
  an 8.4 km/h equivalent *visual playback rate*, not a recommended machine
  travel speed.
- On portrait phones (up to 600 CSS px wide), the route control panel is a
  **260px-wide, top-right toolbar** beneath the LANDCROS branding: a short
  live-status chip plus a single row of playback, camera and speed controls.
  It retains 40px touch targets, keyboard focus indicators and the full
  desktop panel for larger screens. The camera remains draggable.
- Motion uses the Opus-generated `ExcavatorRig` solver and 92 instanced
  track shoes, independently rotating upperstructure, and a one-way
  spline route. The original rig retains its joint and cylinder animation
  capability, but the public **Dig cycle button is removed**.
- The Opus 5.5-generated v5 model retains v4 geometry, assembled from six
  owner photographs. Both front hanging ladders remain removed, and the
  **BIG YELLOW** markings replace MMS/chevrons. The tint of `CAB_GLASS`
  retains glTF `alphaMode=BLEND` and now has opacity **0.15** (85% transparent).
  Its factory-inspired Hitachi orange material is calibrated against the
  photographed orange paint: sRGB `#EE6B1F` (converted to linear channels
  `0.855, 0.147, 0.0137` for glTF). This is a visual photo match, not an
  independently verified OEM paint-code specification.
  All other structural materials remain opaque. V5 is 73,030 triangles,
  1.41 MB; its binary geometry and animation buffer is byte-identical to v4.
  All 92 track shoes and the named joints and three clips are preserved.
  The v5 rig passed both parameter validations, with 500 random pose checks.
  These are mechanical checks, not cross-device proof.
- The **Opus 5.5-produced v6** adds a generic, seated Hitachi excavator operator
  inside the existing cab, attached to `SLEW` so the operator turns with the
  upperstructure while the tracks remain independent. The 2,288-triangle
  character wears yellow high-visibility overalls with reflective bands,
  a white hardhat, gloves, black work boots and small tinted safety glasses.
  Both hands are positioned at two in-cab joysticks in a separate 356-triangle
  `CAB_CONTROLS` object. The character is a stylised non-identifiable employee,
  not a photographic portrait. Its safety glasses are too small to be clearly
  resolved at the normal mobile-wide camera position; they become visible in
  close-up. V6 is **75,674 instanced triangles, 1.48 MB** and retains all three
  motion clips, 92 shoes, 85% transparent glazing and `#EE6B1F` orange.
  Headless Blender re-import verified `CAB_OPERATOR` and `CAB_CONTROLS` have
  parent `SLEW`, the operator fits within the cab volume, with zero triangle
  contacts against the upperstructure, boom and front attachments. Hand/joystick
  overlaps are intentional. The rig passed 500 random-pose pin checks.
- The camera follows by default. It retains the **actual SiteNav compass
  heading and pitch** during the initial dolly, focuses on the moving machine
  over 5 seconds and reaches final framing in about **10 seconds**
  (down from 18). The ending camera distance now adapts to screen shape:
  **4.15 SiteNav units on portrait phones**, easing down to **2.85 units on
  wide screens**, leaving room for the full boom, bucket, house and tracks
  instead of cutting off the attachment at the edge. Camera distance uses
  quintic easing; pitch only begins to adjust
  after 3 seconds and the gentle azimuth orbit starts after 4 seconds, with
  a further 4-second acceleration ramp. The view is never snapped to the
  chassis heading, avoiding the previous abrupt site-wide rotation.
  Dragging, panning or zooming switches to **manual-follow**: the owner
  retains their chosen view while
  the camera translates with the travelling rig. **Recenter** re-enters the
  same gentle blend from the current camera pose; **Unfollow** and **Focus**
  toggle follow entirely.
- The ordinary SiteNav introduction is suppressed **only** on
  `/excavator-route.html` to prevent it fighting the route camera. The normal
  homepage retains its original introductory sequence.
- The excavator uses dedicated WebGL camera layer 29. Its geometry is excluded
  from the splat/traffic pass and rendered in a **second, final pass**, after
  the splat and traffic arrows, following one depth-buffer clear. The model's
  opaque materials retain depth testing, while cab glazing retains genuine
  alpha blending. The standard homepage rendering pipeline is unchanged.

## Acceptance before operational use

1. Confirm Opus-produced GLB is genuinely improved compared with rejected V1.
2. Inspect front, side and rear screenshots for silhouette and decals.
3. Validate named rig joints, static body separation and moving shoe orientation.
4. Check the new page loads the original splat, route, and GLB on desktop/mobile.
5. Confirm the root URL's UI/content and data remain unchanged.
6. Obtain owner visual acceptance before presenting the animation as an
   officially approved excavator travel route or a dimensionally exact machine.

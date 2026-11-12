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
- Asset target: `assets/excavator/EX2000_7_SiteNav_v3.glb`.
- The v2 GLB is retained for comparison, but the route page uses v3.
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
and there is no automated backwards return. It does not follow the orange
traffic-control arrows.

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
- Speed choices are **1×, 2× and 5×**; the default 1× demonstration rate is
  4.2 km/h equivalent (twice the first demo's baseline). Multipliers are
  visual playback controls, not recommended machine travel speeds.
- Motion uses the Opus-generated `ExcavatorRig` solver and 92 instanced
  track shoes, independently rotating upperstructure, and a one-way
  spline route. The original rig retains its joint and cylinder animation
  capability, but the public **Dig cycle button is removed**.
- The v3 GLB is **1,368,484 bytes, 71,414 triangles, eight materials**.
  It preserves the v2 joint hierarchy and passed 500 random rig poses with
  <0.001 m hydraulic pin misalignment, including validation against the
  original params. These are mechanical checks, not cross-device proof.
- The camera follows by default, slowly zooms in over about 18 seconds
  and orbits the moving excavator. **Unfollow** returns to manual navigation;
  **Focus** reactivates the automatic view.
- The excavator's meshes are submitted to the transparent render queue
  after the splat (render order 1) and traffic arrows (3), with render order
  50 and depth testing retained for its own geometry. The isolated route
  page therefore does not modify the splat on the normal homepage.

## Acceptance before operational use

1. Confirm Opus-produced GLB is genuinely improved compared with rejected V1.
2. Inspect front, side and rear screenshots for silhouette and decals.
3. Validate named rig joints, static body separation and moving shoe orientation.
4. Check the new page loads the original splat, route, and GLB on desktop/mobile.
5. Confirm the root URL's UI/content and data remain unchanged.
6. Obtain owner visual acceptance before presenting the animation as an
   officially approved excavator travel route or a dimensionally exact machine.

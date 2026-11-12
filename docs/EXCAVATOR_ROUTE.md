# EX2000-7 SiteNav animation — isolated demonstrator

Status: staged, **not a published or approved travel route**.

The owner drew a yellow excavator route on a 1189×885 screenshot of the
Forrestdale SiteNav viewer on 12 November 2026. The orange site traffic arrows
in the reference screenshot are separate and must not be modified.

## Deployment isolation

- Target static-site base: https://landcros-forrestdale-static.onrender.com/
- Additive suffix: `/excavator-route.html`
- The normal root URL continues using `index.html`.
- The build makes a copy of the HTML viewer with the new suffix. Its animation
  code only imports on that suffix.
- Asset target: `assets/excavator/EX2000_7_SiteNav_v2.glb`.
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
`excavator-route.js`. The initial demonstration traverses and reverses over
the same marked polyline because the screenshot contains no unambiguous
one-way order. It does not follow the orange traffic-control arrows.

## Dimensions and animation

- Real EX2000-7 specification basis: 8.3 m backhoe boom, 3.6 m arm,
  5.62 m undercarriage width, 7.24 m upperstructure width.
- Official Hitachi brochure:
  https://hitachicm.com.au/wp-content/uploads/2023/08/KS-EN465Q-EX2000-7-Brochure-JAN-2026-WEB.pdf
- Uploaded turntable render is EX2600, not EX2000. Use it only as a styling
  reference, never as evidence of EX2000 dimensions.
- Scene scale is currently ~12.449 physical metres per SiteNav unit from
  `assets/gps-calibration.json` (status: provisional).
- Simulation starts at 10× preview speed. Physical baseline used is 2.1 km/h.
- Motion uses the Opus-generated `ExcavatorRig` mechanical solver and 92
  instanced shoes, independently rotating upperstructure, and back-and-forth
  travel animation. The **Dig cycle** button suspends travel, bends the boom,
  stick and bucket, and animates the cylinders while the upperstructure slews.
- The GLB is 1,059,532 bytes (52,848 triangles); it passed 500 random rig
  poses with less than 0.001 m hydraulic pin misalignment. These are geometry
  tests, not proof the scene renders correctly on all devices.

## Acceptance before production

1. Confirm Opus-produced GLB is genuinely improved compared with rejected V1.
2. Inspect front, side and rear screenshots for silhouette and decals.
3. Validate named rig joints, static body separation and moving shoe orientation.
4. Check the new page loads the original splat, route, and GLB on desktop/mobile.
5. Confirm the root URL's UI/content and data remain unchanged.
6. Obtain owner visual acceptance before deploying the model to the live site.

<claude-mem-context>
# Memory Context

# [landcros-forrestdale] recent context, 2026-05-24 12:03am GMT+8

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (20,238t read) | 889,462t work | 98% savings

### May 18, 2026
S547 Code review of viewer3d.js for memory leaks, animation loop issues, race conditions in async boot(), auto-orbit + GSAP tween interaction correctness, and selectPoint/showPointList toggle bugs; provide score 1-10 and cite specific line numbers. (May 18 at 5:55 PM)
2219 7:30p 🔵 Multiple Memory Leaks Identified in viewer3d.js Three.js Scene Management
2220 " 🔴 GSAP Tween Kill Does Not Reset Camera Animation State
2221 " 🔵 Idle Throttle Logic Appears Sound; Animation Loop Does Unnecessary Work
2222 " 🔵 Auto-Orbit and GSAP Tween State Machine Has Race Condition Window
2225 " 🔵 Road Network and Static Geometry Never Disposed in renderRoads()
2226 " 🔵 Texture Loaders and Ground Plane Materials Never Disposed
2227 " 🔵 Splat Viewer Replacement Without Disposal; Double-Load Hazard
2228 " 🔵 Debug-Mode Event Listeners Never Removed (Plane Adjustment HUD)
2229 " ✅ Code Review Summary: viewer3d.js Memory Leaks and State Management Issues
S573 Diagnose why #cam-presets buttons do not reposition when the mobile info panel unfolds (≤767px viewport) in viewer3d.html and viewer3d.js. Investigate 5 specific hypothesis points about MOBILE_BP definition, CSS !important rules, function definition timing, togglePanel call paths, and other sheet-mid class additions. (May 18 at 7:31 PM)
2290 9:40p 🔵 CSS !important rule prevents inline style.bottom from taking effect on mobile
2291 " 🔵 selectPoint() correctly calls _updateCamPresetsBottom, but CSS !important blocks the style update
S586 Fix bug in viewer3d.js selectPoint() where controls.enabled = false prevents user interaction during fly-to tween; implement drag interrupt handler to kill tween and restore control responsiveness (May 18 at 9:40 PM)
2309 9:55p 🔵 CSS and HTML structure for mobile panel bugs identified
2310 " 🔵 BUG 1 root cause: #panel-toggle margin-left: auto overrides justify-content centering
2311 " 🔵 BUG 2 root cause: display:none on #panel-header-text hides "Locations" title label
2312 " 🔵 Complete CSS analysis for BUG 1: margin-left auto persists from default styles
2313 " 🔵 Complete HTML and CSS analysis for BUG 2: hidden text container removes panel labeling
2315 10:02p 🔵 Mapped selectPoint() and control-state management locations in viewer3d.js
2316 " 🔵 Analyzed camera tween mechanism and selectPoint() complete flow
2317 " 🔴 Implemented drag interrupt for camera fly-to tween in selectPoint()
2318 " 🔴 Verified drag-interrupt fix syntax and placement in selectPoint()
S593 Diagnose two CSS/HTML bugs in viewer3d.html: (1) Mobile panel chevron not centred, (2) Site Navigator text disappeared on mobile. Analysis only, no edits. (May 18 at 10:03 PM)
S610 Review viewer3d.js and viewer3d.html for bugs, performance issues, security issues, and UX improvements with specific file and line numbers (May 18 at 10:24 PM)
### May 19, 2026
S679 Debug and fix SiteNav 3D viewer comparison mode splat rendering — "Splat ready" message displays but no 3D models are visible despite slider appearing and scissor rendering being enabled (May 19 at 6:53 PM)
### May 22, 2026
2704 9:03p 🔵 Render flow shows conditional path: comparison mode skips normal renderer
2705 " 🔵 Comparison splat models missing scale and center transforms applied to primary splat
2706 9:04p 🔵 Confirmed: comparison splat models missing scale.setScalar() applied to primary
2707 " 🔴 Fixed comparison splats missing scale and center transforms
2708 " ✅ Moved initComparison() call into try block for better flow control
2709 " 🔵 Syntax validation passed for modified files
2710 9:05p 🟣 Debug panel added for real-time splat rotation adjustment with localStorage persistence
2712 " 🔵 Splat file bounds analysis confirms variable geometry requiring per-model scale
2713 " 🔵 Verified code changes in place and syntax valid across modified files
S687 Review and plan 3-4 point alignment feature (Kabsch-Umeyama algorithm) for Three.js Gaussian Splat comparison viewer in splat-compare.js (May 22 at 9:05 PM)
2748 10:26p 🔵 Examined splat-compare.js architecture for 3-4 point alignment planning
2749 " 🔵 Project uses browser-based CDN imports via importmap, not npm packages
S729 Analyze a successful multi-model Gaussian Splat alignment workflow and design a reliable, repeatable architecture that non-technical users can follow, including decisions about automation vs interactivity, preprocessing, ICP placement (browser vs server), and alignment data storage. (May 22 at 10:27 PM)
### May 23, 2026
S739 Investigate scissor-based split-screen rendering artifacts in Three.js + GS3D dual-model comparison viewer; score 6 specific architectural questions (GS3D internals, visibility toggles, render targets, double-buffering, scissor respect, compositing) with 1-10 confidence and line references. (May 23 at 1:21 PM)
2825 1:46p 🔵 Current comparison-only scene architecture and primary splat loading behavior
2826 " 🔵 Comparison module architecture: scissor rendering split-view implementation
2827 " 🔵 Config schema current structure: site metadata, assets, plane, splat, comparison, camera sections
2828 " 🔵 Viewer3d.html and index.html are nearly identical; index.html is the primary homepage
2829 " 🔵 Boot sequence and page lifecycle: config load → scene build → splat background load
2830 " 🔵 No URL parameter routing system currently exists for dynamic model selection
2849 2:16p 🚨 querySelector selector injection via unescaped model IDs
2850 " 🔐 URL parameter model IDs not validated against config before use
2851 " 🔵 HTML escaping implemented via esc() helper function
2852 " 🔵 Configuration-driven comparison mode and model limits
2853 " 🔵 URL encoding used for model IDs in navigation
2895 3:00p 🔵 Three.js Gaussian Splat Compositing Pipeline Architecture
2896 " 🔵 GaussianSplats3D Viewer Configuration and Material API
2897 " 🔵 Scissor-Based Split-Screen Rendering Implementation
2898 3:01p 🔵 Asset Configuration and Model Separation
2899 3:02p ✅ Render-to-Texture Composite Pipeline for Gaussian Splat Boundary Artifact Mitigation
2900 " ✅ Composite Render Pipeline Successfully Implemented in splat-compare.js
2901 " ✅ Comparison Scene Loader and Viewer Integration
S766 Investigate and solve visual compositing artifacts at boundaries where Gaussian Splat comparison models meet background splat in Three.js viewer (May 23 at 3:03 PM)
2938 3:50p 🔵 Existing render-to-texture composite solution for GS3D viewer edge artifacts

Access 889k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>
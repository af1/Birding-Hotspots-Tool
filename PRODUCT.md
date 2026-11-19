# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Hobby birders planning an outing, at home on a laptop or phone, the night before or the morning of a trip.

## Product Purpose

Finds and ranks eBird hotspots near a place, along a driving route, or for a target species, using the birder's own eBird API key. Success: the birder leaves with a short, trustworthy list of where to go and why (species counts, recent sightings, lifers, drive time, weather).

## Positioning

Runs entirely in the browser on public eBird data plus the birder's own key and life list; no account, no server-side storage of the key.

## Operating Context

Planning session before a trip. Outputs used later: PDF report, GPX waypoints, Google Maps links, shareable URLs.

## Capabilities and Constraints

- Static site, vanilla JS ES modules, no build step; deployed on Vercel.
- Strict CSP in index.html; fonts only from Google Fonts.
- Search modes: radius (eBird caps at 50 km), drive time (30/60 min), route, species.
- Light and dark themes via `data-theme` and `prefers-color-scheme`.

## Brand Commitments

None binding (user confirmed colors and font may be replaced freely).

## Accessibility & Inclusion

WCAG AA contrast in both themes.

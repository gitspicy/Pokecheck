# Species artwork

All 1,045 species/forms in `data.json`'s `baseStats` have a matching image here, generated
from a one-time local pipeline (not part of the running app - no network calls happen at
request time):

1. Source: official Sugimori artwork mirrored by
   [HybridShivam/Pokemon](https://github.com/HybridShivam/Pokemon) (`assets/images/`),
   itself sourced from Bulbapedia. Covers Gen I-IX plus regional/alternate forms.
2. Each source PNG was downloaded once, then resized locally (Pillow, `LANCZOS`) and
   re-encoded as WebP (`quality=85`) into two sizes:
   - `hero/{slug}.webp` - max 260px, used for each Pokemon card's header image.
   - `icon/{slug}.webp` - max 56px, used in the autocomplete dropdown and the evolution
     family strip.

`{slug}` matches the corresponding `baseStats` key in `data.json` exactly (e.g.
`ponyta_galarian.webp`), so the backend just checks `is_file()` against a species' own key -
no separate mapping file to keep in sync.

## Known gaps

A handful of very niche forms don't have distinct official art available and fall back to
their base species' artwork instead of having no image at all: Armored Mewtwo
(`mewtwo_armored`) and the three Paldean Tauros breeds (`tauros_aqua`/`_blaze`/`_combat`).

## Refreshing

There's no build script checked in for this (it was a one-off local run against a cloned
copy of HybridShivam/Pokemon). To add images for species added to `baseStats` later, download
the matching `assets/images/{dex}[-{Form}].png` file, resize/re-encode the same way, and drop
it in under the new baseStats key's name in both `hero/` and `icon/`.

# Forge Nexxus brand assets

Built from the canonical mark already in the app — the `.forge-mark` path in
`docs/index.html` (`viewBox="0 0 24 30"`). The mark is the single source of
truth; everything here is a render of it.

## Colour

The app has no accent colour, so the mark does not get one. It uses two values
already in `docs/styles.css`:

- `#121315` — `--bg`, the dark ground
- `#e9ebee` — `--text`, the ink

`svg/forge-mark.svg` is filled with `currentColor`, so inline it and let the
surface set the colour.

## What is here

    svg/    vector masters. forge-mark.svg is the one to inline.
    logo/   the mark on its own and on solid grounds, 1024–4096px.
    icon/   AppIcon-1024.png is the Xcode/App Store source. Square and
            full-bleed on purpose — iOS applies the corner mask itself, so
            the radius is never baked in.
    icon/ios/   the iOS size ladder, 20–1024.
    icon/web/   favicon.ico, PWA sizes, and rounded variants for surfaces
                that do not mask their own corners.

The mark sits slightly above the geometric centre of the icon square: its mass
is in the lower flare, so centring it by bounding box reads as bottom-heavy.

## No wordmark

Forge Nexxus is set in the system font stack, so the wordmark belongs in the
device's own typeface at the point of use rather than baked into a PNG in a
substitute face. Set it in the UI font beside the mark.

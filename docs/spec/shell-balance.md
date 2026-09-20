# Shell visual balance

Owner direction, 2026-09-20: the logo is too small beside the controls; New Connection and Send dominate desktop and mobile; the mobile menu frame touches the divider. This amendment supersedes the corresponding v5 visual sizes, keeping its layout and interaction contracts.

- Render the brand at 32px (reduced from the first 36px preview after owner review).
- Paint New Connection at 24px with a 14px glyph; retain its existing target (44px on touch).
- Use the same secondary-button styling for Send as the adjacent keypad control: shared background, border, radius and icon sizing. Keep the touch target and desktop broadcast label; only New Connection retains a distinct primary treatment.
- Keep the mobile menu border transparent.
- Remove the header shadow and the interior touch-row line; retain the workspace boundary.
- Preserve all themes, keyboard focus, six touch actions, menu anchoring, composer behavior and layout caps.

The exact pixel choices implement the owner's requested hierarchy and are subject to screenshot review in the PR.

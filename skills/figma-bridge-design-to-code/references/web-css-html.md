# Modern CSS and HTML for Figma-to-code

This reference adapts the maintainer-provided `modern-css-html` skill for a
source-faithful Figma-to-code workflow. It is intentionally narrower than a
general web-platform handbook: use it to make implementation decisions without
overriding the Figma visual contract or the target repository's engineering
contract.

## Authority and precedence

Use this order when two rules pull in different directions:

1. explicit user requirements and approved deviations;
2. exact Figma facts, annotations, prototype evidence, and source assets;
3. the target project's framework, browser matrix, components, tokens, and
   established styling conventions;
4. accessible platform semantics and stable browser behavior;
5. the preferences in this reference.

Modern CSS is an implementation tool, not permission to redesign. Do not change
visible geometry, text wrapping, interaction behavior, or component identity to
make a preferred CSS pattern easier to use.

## Translate layout evidence, not screenshots

- Map Figma horizontal or vertical Auto Layout to the project's normal flex or
  stack primitive. Map native Figma Auto Layout Grid to CSS Grid when the
  two-dimensional track relationship is part of the design. A Figma Layout
  Guide is alignment evidence, not proof that the container uses CSS Grid.
- Preserve explicit `FIXED`, `HUG`, and `FILL` intent. A fixed Figma dimension
  normally remains fixed at the reference viewport. Hug content may map to
  intrinsic sizing such as `fit-content` or `max-content`; fill normally needs
  the project's stretch primitive, `flex: 1`, or `inline-size: 100%` plus the
  required `min-inline-size: 0`. Choose the mapping from parent and text facts,
  not from the label alone.
- When a centered text node must shrink with its container, preserve fill sizing
  and center through text alignment. Do not replace it with hug sizing merely
  because the wide reference frame happens to fit.
- Use container-owned `gap` for Figma Auto Layout item spacing. Preserve
  `margin:auto`, negative margins, explicit offsets, overlaps, and absolute
  placement when they are source facts; they are not interchangeable with gap.
- Prefer `minmax(0, 1fr)` and `min-inline-size: 0` where long content must be
  allowed to shrink inside grid or flex tracks. Validate the rendered wrapping
  rather than applying either mechanically.
- Preserve source order unless Figma and application semantics prove a different
  order. Visual reordering must not make keyboard or screen-reader order diverge.
- Use logical properties when they fit the project's conventions and preserve
  the exact design. Do not mechanically rewrite an established physical-property
  codebase as part of a Figma implementation.

## Responsive behavior requires evidence

A single Figma viewport proves one rendered state, not an entire responsive
function.

- Derive breakpoints, fluid ranges, and layout changes only from additional
  frames, Figma constraints, variables, annotations, existing application
  behavior, or explicit user direction.
- Intrinsic patterns such as `auto-fit`, `minmax()`, container queries, and
  `clamp()` are useful only when they preserve the reference state and follow
  supported responsive evidence.
- Never treat a Figma value as the maximum of an invented `clamp()` range.
- Prefer component-local responsiveness when the project already uses container
  queries. Remember that a query affects descendants, not the container itself,
  and that containment can alter intrinsic sizing.
- Use viewport queries when behavior genuinely depends on the viewport or input
  device rather than on the component's available space.

Test at the reference width first, then at every evidenced responsive width and
at narrow intermediate widths for overflow. An invented but plausible mobile
layout is not fidelity.

## Semantic markup without semantic drift

- Use native elements for established meaning: buttons for actions, anchors for
  navigation, headings in a coherent hierarchy, landmarks for page regions,
  labels for controls, and tables for tabular data.
- Figma appearance alone does not prove behavior. A rectangle labelled “Next”
  may look like a button, but routing, submission, dialog, and disclosure
  semantics must come from annotations, prototype reactions, the target app, or
  user direction.
- Prefer native `dialog`, `popover`, `details`, form controls, lazy loading, and
  other platform behavior when it is behaviorally equivalent, accessible in the
  target support matrix, and compatible with the existing stack.
- Do not replace established framework state or application logic merely to
  achieve a zero-JavaScript implementation. JavaScript remains appropriate for
  data, persistence, routing, complex gestures, application state, and focus or
  announcement behavior not supplied by the platform.
- Never use a clickable `div` where a native interactive element matches the
  proven behavior. Preserve visible focus with `:focus-visible` and verify the
  keyboard path.

## CSS architecture follows the project

- Reuse the project's tokens, layers, modules, naming, resets, utilities, and
  component primitives. Do not introduce a second styling architecture solely
  for this screen.
- Keep design roles together: typography size, weight, line height, tracking,
  and font family should resolve through the same project role when one exists.
- Use role tokens for paired foreground and background colors. Raw values are
  acceptable only when the exact Figma fact has no compatible project token and
  the project convention permits literals.
- Prefer low-specificity selectors and the project's scoping mechanism. Avoid
  `!important` unless overriding a stylesheet outside project control.
- Use inline styles only for runtime values that genuinely need to cross into
  CSS, normally through a custom property, or when the target framework already
  treats them as its standard styling mechanism.
- Let the build own prefixes and transforms. Do not use browser sniffing as a
  feature test.

## Modern features and fallbacks

Browser support is time-sensitive. Respect the target project's browser matrix
and verify current support before relying on a limited or experimental feature.

- Prefer a stable declaration followed by a progressive enhancement when an
  unsupported value is simply ignored.
- Use `@supports` when absence would otherwise create broken layout, overlap, or
  unreachable behavior. Do not wrap harmless progressive polish in gates that
  only add noise.
- Never rely on a custom-property value becoming invalid as a cascade fallback;
  computed-value failure can discard the entire declaration. Register a typed
  property with a valid initial value when that guarantee is required.
- Native popovers, anchor positioning, view transitions, scroll-driven
  animation, style queries, scroll-state queries, new form styling, and other
  recent features require a usable fallback proportional to their role.
- Experimental syntax must stay additive and must be reverified at ship time.
  Do not make pixel parity depend on a moving specification unless the user and
  target browser contract explicitly allow it.

## Motion and accessibility

- Every non-essential animation and transition must respect
  `prefers-reduced-motion`. The reduced state must still expose the final
  content and preserve the interaction.
- Prefer transform and opacity for animated polish. Do not change an exact
  design motion curve, duration, or animated property without evidence merely
  for performance.
- Check contrast, focus visibility, target size, semantics, keyboard order, and
  reduced motion in addition to the pixel comparison. Native controls are a
  strong accessibility starting point, not proof; verify load-bearing controls
  with keyboard and the project's accessibility tooling.
- Account for forced colors and reduced transparency when the design uses
  essential borders, translucent surfaces, or backdrop effects.

## Images and performance

- Preserve exported Figma images and SVGs. Supply intrinsic dimensions or an
  evidenced `aspect-ratio` to prevent layout shift.
- Lazy-load below-the-fold images and iframes when compatible with the target
  project. Do not lazy-load the primary above-the-fold image.
- Avoid permanent `will-change`, layout work on every scroll event, runtime CSS
  `@import`, and animations that unnecessarily repaint large regions.
- Performance optimization must not discard source artwork, effects, or exact
  layout facts. If an exact effect is too expensive, measure it and request an
  explicit deviation instead of silently simplifying it.

## Web verification additions

Alongside the Bridge fidelity ledger and pixel diff:

- inspect computed layout mode, dimensions, overflow, text wrapping, fonts,
  object fit/position, and token values on the mapped browser elements;
- exercise every evidenced interactive state with keyboard and pointer;
- test reduced motion and any required theme modes;
- verify the stable fallback for each feature that is not supported throughout
  the project's browser matrix;
- test long text and narrow containers where the Figma facts indicate fill or
  shrink behavior;
- record any semantic or responsive inference as an explicit reviewed
  deviation, never as an invisible implementation choice.

// Geometric "H" brand mark — navy H with green corner triangles — traced as
// inline SVG from the owner's supplied artwork (512×512 reference) so it
// renders crisp at any size with no binary asset or pipeline entry.
// Geometry: a LARGE green triangle fills the top-left corner (roughly half
// the width), a small one sits in the bottom-right; the navy H has a
// full-height right stem with a diagonal-cut bottom corner, and the left
// stem rises into a thick diagonal crossbar capped by a horizontal plateau.
// Decorative only (the wordmark logo beside it carries the accessible name),
// hence aria-hidden.
//
// To ship the exact original artwork instead, drop it at
// public/htl-h-mark.png and replace the SVG below with
//   <img src="/htl-h-mark.png" alt="" className={className} />
const NAVY = "#1E2B4D";
const GREEN = "#3D8B6D";

const HMark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 512 512" aria-hidden="true" focusable="false" className={className}>
    {/* white rounded tile behind the mark — the artwork is navy-on-white, and
        both places this renders (hero header, gate page) sit on the dark navy
        hero background where a bare navy H would vanish. Matches the white
        tile the wordmark logo already sits on. */}
    <rect x="0" y="0" width="512" height="512" rx="44" fill="#FFFFFF" />
    {/* big top-left green triangle */}
    <polygon points="6,6 250,6 6,225" fill={GREEN} />
    {/* small bottom-right green triangle */}
    <polygon points="506,438 506,506 438,506" fill={GREEN} />
    {/* right stem: full height, bottom-right corner cut on the diagonal */}
    <polygon points="345,4 508,4 508,418 418,506 345,506" fill={NAVY} />
    {/* left stem + diagonal crossbar (horizontal plateau on top) */}
    <polygon points="6,300 155,170 345,170 345,245 172,350 172,506 6,506" fill={NAVY} />
  </svg>
);

export default HMark;

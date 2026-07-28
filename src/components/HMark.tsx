// Geometric "H" brand mark — navy H with green corner triangles — reproduced
// as inline SVG from the owner's supplied artwork so it renders crisp at any
// size with no binary asset or pipeline entry. Decorative only (the wordmark
// logo beside it carries the accessible name), hence aria-hidden.
//
// To ship the exact original artwork instead, drop it at
// public/htl-h-mark.png and replace the SVG below with
//   <img src="/htl-h-mark.png" alt="" className={className} />
const NAVY = "#1E2B4D";
const GREEN = "#3D8B6D";

const HMark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false" className={className}>
    {/* green corner triangles */}
    <polygon points="0,0 36,0 0,36" fill={GREEN} />
    <polygon points="100,100 100,74 74,100" fill={GREEN} />
    {/* the H: right stem (full height), left stem (lower two-thirds),
        thick diagonal crossbar rising left → right */}
    <rect x="66" y="0" width="22" height="88" fill={NAVY} />
    <rect x="12" y="36" width="22" height="64" fill={NAVY} />
    <polygon points="12,62 66,34 66,54 12,82" fill={NAVY} />
  </svg>
);

export default HMark;

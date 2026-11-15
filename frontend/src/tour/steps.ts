export interface Step {
  /** CSS selector of the thing to point at. Steps whose target is missing are skipped. */
  target: string;
  title: string;
  body: string;
  /** Steps with the same group form a section the visitor can skip as a whole. */
  group?: string;
}

export const HOME_STEPS: Step[] = [
  {
    target: ".home-search",
    title: "Pick a spot",
    body: "Type RA then Dec in degrees (like 133.7951 -7.2451), a star's name, or plain words like \"a cold brown dwarf\". Niche turns words into a place.",
  },
  {
    target: ".home-chart",
    title: "Or pick a star in 3D",
    body: "Niche in 3D shows the test targets around the Sun. Drag to turn it, then click a star's name to open it.",
  },
  {
    target: ".home-search button.primary",
    title: "Press Look",
    body: "We grab every SPHEREx picture of that spot. The tour carries on once the viewer opens.",
  },
];

const BASICS = "The basics";
const MOVERS = "Find what moves";
const DATA = "Dig into the data";
const HELP = "Help and extras";

export const VIEWER_STEPS: Step[] = [
  {
    group: BASICS,
    target: ".stage",
    title: "The picture",
    body: "This is your patch of sky. Drag to move around, scroll or pinch to zoom, double-click to re-centre on a spot.",
  },
  {
    group: BASICS,
    target: ".player",
    title: "Flip through the dates",
    body: "Play flips through the pictures in date order. Stars stay put. If something jumps between frames, look closer. Drag the slider to step by hand.",
  },
  {
    group: BASICS,
    target: ".controls .search",
    title: "Go somewhere else",
    body: "Type coordinates, a name, or plain words like \"a nearby brown dwarf\". Or pick a test target next to it, like Barnard's Star.",
  },
  {
    group: BASICS,
    target: ".controls > label:nth-of-type(2)",
    title: "Colour and size",
    body: "SPHEREx sees 102 infrared colours, called bands. Cold, faint objects often show up best in the longer ones. Field of view, next to it, sets how much sky you see.",
  },
  {
    group: MOVERS,
    target: ".image-ops",
    title: "Spot the change",
    body: "Difference mode subtracts one picture from another. Stars cancel out, so whatever moved is left as a light and dark pair.",
  },
  {
    group: MOVERS,
    target: ".movers",
    title: "Let us look for you",
    body: "Find movers follows every dot from visit to visit and lists the ones drifting in a straight line.",
  },
  {
    group: MOVERS,
    target: ".lightcurve",
    title: "Brightness over time",
    body: "Press Pick a star, then click one. You get a chart of how its brightness changes from date to date.",
  },
  {
    group: DATA,
    target: ".overlay-panel",
    title: "Known stars on top",
    body: "Mark stars from Gaia and WISE, or SPLICES stars seen through icy dust. Click a mark to see what it is.",
  },
  {
    group: DATA,
    target: ".products",
    title: "What's in each exposure",
    body: "Switch from the sky to the glow from our own solar system, the noise, or the problem pixels SPHEREx flagged.",
  },
  {
    group: DATA,
    target: ".spectrum",
    title: "Measure its light",
    body: "Measures how bright the centre spot is in each band. The shape of that curve hints at how hot the object is.",
  },
  {
    group: DATA,
    target: ".aladin-panel",
    title: "Compare with other maps",
    body: "Open this to lay your spot over the SPHEREx all-sky map or other surveys.",
  },
  {
    group: HELP,
    target: ".niche-btn",
    title: "Ask Niche",
    body: "Niche is a small AI helper that runs in your browser. It asks before its one-time download (about half a gigabyte). Drag the button anywhere.",
  },
  {
    group: HELP,
    target: "a[href$='?view=3d']",
    title: "Niche in 3D",
    body: "See where the targets sit around the Sun in a 3D map, and click one to fly back here.",
  },
  {
    group: HELP,
    target: ".saved",
    title: "Keep this view",
    body: "Save a view to come back to it later. Sign in to keep saves across devices.",
  },
  {
    group: HELP,
    target: "#glossary",
    title: "Stuck on a word?",
    body: "Each little ? button explains a word. The full list is down here.",
  },
  {
    group: HELP,
    target: ".tour-retake",
    title: "That's it",
    body: "You can run this tour again any time from this button.",
  },
];

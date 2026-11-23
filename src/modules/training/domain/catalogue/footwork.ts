import { drill, SAFE } from "./define";

const base = [SAFE.floor, SAFE.space, SAFE.water];

export const footwork = [
  drill(1, "footwork", {
    title: "Six-corner shadow footwork",
    skill: "Movement",
    level: "Beginner",
    format: "Singles",
    minutes: 10,
    players: 1,
    equipment: ["Rackets"],
    objective:
      "Learn the path to all six corners of the court and the push back to the centre base.",
    setup:
      "One player on a half court, starting at the centre base with the racket up. No shuttle is used.",
    steps:
      "Split-step, then move to the front-left corner and reach with the racket.|Push back to the base and split-step again.|Repeat for the other five corners in a fixed order.|Rest, then repeat in the opposite order.",
    cues: "Small split-step before every move.|Last step is a controlled lunge.|Push off the front foot to recover.",
    mistakes:
      "Crossing the feet on the way to the rear court.|Standing up straight after the lunge instead of pushing back.",
    easier: "Walk the pattern slowly and name each corner aloud.",
    harder:
      "Do the pattern against a set time, keeping the same form for the whole round.",
    safety: [...base, SAFE.stop],
  }),
  drill(2, "footwork", {
    title: "Random star shadow drill",
    skill: "Movement",
    level: "Intermediate",
    format: "Singles",
    minutes: 10,
    players: 2,
    equipment: ["Rackets"],
    objective:
      "React to an unexpected call, move to the right corner and recover without thinking about the order.",
    setup:
      "The player stands at the base; a partner stands at the net and points to one of the six corners.",
    steps:
      "The partner points to a corner.|The player split-steps, moves there, shadows a stroke and returns to base.|The partner points again as soon as the player is back.|Swap roles after each short round.",
    cues: "Watch the hand, not the feet.|Split-step as the partner points.|Return to base before the next point.",
    mistakes: "Guessing the corner early.|Reaching with the arm while the feet stay behind.",
    easier: "The partner pauses a little longer between points.",
    harder:
      "Shorten the pause, or point in quick pairs of corners.",
    safety: [...base, SAFE.stop],
  }),
  drill(3, "footwork", {
    title: "Tempo shadowing",
    skill: "Movement",
    level: "Beginner",
    format: "Singles",
    minutes: 10,
    players: 1,
    equipment: ["Rackets"],
    objective:
      "Build court stamina with a steady, relaxed rhythm that keeps good technique over a longer time.",
    setup:
      "One player on a court. A partner or a clock counts the rounds.",
    steps:
      "Start at the base and move around all six corners at a steady pace.|Keep the same rhythm for each round.|Pause briefly between rounds.|Stop the round when the form begins to slip.",
    cues: "Same rhythm every round.|Quiet landings.|Breathe out on the lunge.",
    mistakes: "Starting too fast and fading.|Letting the racket arm drop between corners.",
    easier: "Shorter rounds with longer rests.",
    harder: "Longer rounds, or a slightly faster steady pace.",
    safety: [...base, SAFE.warm],
  }),
  drill(4, "footwork", {
    title: "Side-to-side defence shuffles",
    skill: "Defence",
    level: "Beginner",
    format: "Both",
    minutes: 10,
    players: 1,
    equipment: ["Rackets", "Cones"],
    objective:
      "Move quickly from side to side in a low defensive stance without crossing the feet.",
    setup:
      "Two cones mark the mid-court sidelines. The player starts in the middle in a low ready position.",
    steps:
      "Shuffle to one cone and touch the line with the racket tip.|Push off and shuffle to the other cone.|Keep the knees bent and the racket in front.|Rest after each short round.",
    cues: "Low and wide.|Push, do not step across.|Racket stays in front.",
    mistakes: "Standing tall.|Crossing the feet instead of shuffling.",
    easier: "Walk the shuffle at half speed.",
    harder: "Add a call from a partner for the direction to move.",
    safety: [...base],
  }),
  drill(5, "footwork", {
    title: "Front-to-back V pattern",
    skill: "Movement",
    level: "Intermediate",
    format: "Singles",
    minutes: 10,
    players: 1,
    equipment: ["Rackets"],
    objective:
      "Link the front-court lunge with the retreat to the rear court on the same side.",
    setup: "One player on a half court, starting at the centre base.",
    steps:
      "Move to the front-left net and lunge.|Push back to the base, then retreat to the rear-left corner.|Return to the base and repeat on the right side.|Rest after each pair of sides.",
    cues: "Recover through the base each time.|Turn the body for the rear corner.|Lunge with the racket foot forward.",
    mistakes: "Running past the base.|Backing up facing the net instead of turning.",
    easier: "Do the front half and the rear half as two separate drills first.",
    harder: "Add a quick racket swing at each corner, or time the rounds.",
    safety: [...base, SAFE.stop],
  }),
  drill(6, "footwork", {
    title: "China jump footwork",
    skill: "Movement",
    level: "Advanced",
    format: "Singles",
    minutes: 10,
    players: 1,
    equipment: ["Rackets"],
    objective:
      "Practise an explosive two-footed lateral jump to reach flat shots on either side, including round the head.",
    setup:
      "One player at the mid-court base. A partner may call the side. No shuttle is needed at first.",
    steps:
      "Split-step and jump sideways off both feet.|Land softly on both feet in a balanced stance.|Swing the racket as if meeting a flat shot.|Recover to the base and repeat on the other side.",
    cues: "Jump from a low split-step.|Land with bent knees.|Recover straight away.",
    mistakes: "Jumping up instead of across.|Landing stiff-legged.",
    easier: "Take a small hop and a step instead of a full jump.",
    harder: "Add a feed, or call the side only after the split-step.",
    safety: [...base, SAFE.landing, SAFE.warm],
    minimumAge: 12,
  }),
  drill(7, "footwork", {
    title: "Shuttle pick-up relay",
    skill: "Movement",
    level: "Beginner",
    format: "Both",
    minutes: 10,
    players: 2,
    equipment: ["Rackets", "Shuttles"],
    objective:
      "Use proper lunges and split-steps while carrying out a simple, fun task.",
    setup:
      "Place four to six shuttles in one corner. Each player or team has a target corner on the other side.",
    steps:
      "Split-step at the base, lunge to the pile and pick up one shuttle.|Return to the base through a split-step.|Lunge to the target corner and place the shuttle down.|Repeat until the pile is moved; then move them back.",
    cues: "Bend the legs, not the back.|Split-step each time at the base.|Place, do not throw.",
    mistakes: "Bending the back to pick up.|Skipping the split-step at the base.",
    easier: "Use fewer shuttles and a shorter route.",
    harder: "Race the clock or a partner, keeping the form.",
    safety: [...base, SAFE.shuttles],
  }),
  drill(8, "footwork", {
    title: "Mirror footwork",
    skill: "Movement",
    level: "Beginner",
    format: "Singles",
    minutes: 8,
    players: 2,
    equipment: ["Rackets"],
    objective:
      "Sharpen reaction and balance by copying a partner's movement across the net.",
    setup:
      "Two players face each other across the net, each on their own half court.",
    steps:
      "The leader moves anywhere on their half; the other mirrors the move.|Keep the same distance from the net as the leader.|Swap leaders after a short round.|Add shadow strokes once the movement is smooth.",
    cues: "Eyes on the partner's hips.|Stay low and ready.|Mirror, do not chase.",
    mistakes: "Watching the feet only.|Standing still while the partner moves.",
    easier: "The leader moves slowly and stays on one line.",
    harder: "The leader moves quickly and changes direction without warning.",
    safety: [...base],
  }),
  drill(9, "footwork", {
    title: "Resistance band court movement",
    skill: "Movement",
    level: "Advanced",
    format: "Singles",
    minutes: 10,
    players: 2,
    equipment: ["Rackets", "Resistance band"],
    objective:
      "Build leg drive for lunges and rear-court retreats against a light, steady resistance.",
    setup:
      "The player wears a band around the waist; a partner holds the other end from behind with a light pull.",
    steps:
      "Lunge forward against the band and recover to the base.|Retreat to the rear court while the partner keeps a light, even pull.|Rest, then swap roles.|Remove the band for a few free repeats at the end.",
    cues: "Light pull, steady form.|Drive from the legs.|Same footwork as without the band.",
    mistakes: "Leaning into the band instead of driving.|Too strong a pull that changes the footwork.",
    easier: "No band, only the partner's hand as a guide.",
    harder: "Slightly more pull, or add a swing at each end.",
    safety: [...base, SAFE.band, SAFE.load],
    minimumAge: 12,
  }),
  drill(10, "footwork", {
    title: "Four-corner line touch",
    skill: "Movement",
    level: "Intermediate",
    format: "Singles",
    minutes: 8,
    players: 1,
    equipment: ["Rackets"],
    objective:
      "Build sprint-and-stop speed by touching the four outer corners of the singles court.",
    setup:
      "One player on a singles court, starting at the centre base with the racket held up.",
    steps:
      "Sprint to a front corner and touch the line with the free hand.|Return to the base.|Touch the other front corner, then the two rear corners.|Rest, then go the other way.",
    cues: "Racket stays up.|Touch with the free hand.|Stop under control, no sliding.",
    mistakes: "Dropping the racket arm.|Sliding into the line.",
    easier: "Jog the route and touch only the near corners.",
    harder: "Time the rounds or touch in an order called by a partner.",
    safety: [...base, SAFE.stop],
  }),
];

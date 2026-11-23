import { drill, SAFE } from "./define";

const base = [SAFE.floor, SAFE.shuttles, SAFE.space, SAFE.water];

export const feeding = [
  drill(11, "feeding", {
    title: "20-shuttle corner endurance",
    skill: "Movement",
    level: "Intermediate",
    format: "Singles",
    minutes: 15,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Return a long run of feeds to different corners while keeping the same form.",
    setup:
      "A feeder stands at the net with a basket of about 20 shuttles; the player starts at the base.",
    steps:
      "The feeder sends a shuttle to any corner.|The player returns it with a clear stroke.|The player recovers to the base before the next feed.|Rest after the basket, then swap roles.",
    cues: "Same stroke shape on every shuttle.|Recover to the base each time.|Breathe steadily.",
    mistakes: "Rushing the stroke when tired.|Not recovering to the base.",
    easier: "Feed more slowly and to predictable corners.",
    harder: "Feed faster or with less warning.",
    safety: [...base, SAFE.stop],
  }),
  drill(12, "feeding", {
    title: "Front-and-back attack",
    skill: "Overhead",
    level: "Intermediate",
    format: "Singles",
    minutes: 15,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Switch between an overhead shot from the rear and a net shot at the front without losing balance.",
    setup:
      "A feeder alternates high lifts to the rear court and low tosses to the net.",
    steps:
      "The feeder lifts high to the rear court.|The player plays a smash or a drop shot.|The feeder tosses low to the net.|The player moves in and plays a net shot or a kill.",
    cues: "Hit, then recover to the base.|Turn early for the rear court.|Stay low for the net.",
    mistakes: "Waiting at the base for the toss.|Rushing the net and over-hitting.",
    easier: "Use a drop shot instead of a smash and feed the net a little higher.",
    harder: "Make the feeds random.",
    safety: [...base, SAFE.eyes],
  }),
  drill(13, "feeding", {
    title: "Smash-and-follow kill",
    skill: "Overhead",
    level: "Advanced",
    format: "Singles",
    minutes: 15,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Follow a full smash straight away with a rush to the net to finish a short return.",
    setup:
      "The feeder lifts to the back court, then tosses a short shuttle to the net.",
    steps:
      "The feeder lifts to the rear court.|The player smashes.|The feeder tosses a short shuttle to the net straight away.|The player rushes in and kills it down.",
    cues: "Land and push forward.|Racket up before the kill.|Strike down, not out.",
    mistakes: "Standing still after the smash.|Lifting the kill into the net tape.",
    easier: "The feeder pauses a little longer before the second toss.",
    harder: "Vary the net toss left or right.",
    safety: [...base, SAFE.eyes],
  }),
  drill(14, "feeding", {
    title: "Rapid net-to-net fifties",
    skill: "Net play",
    level: "Intermediate",
    format: "Both",
    minutes: 10,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Develop a soft touch and tight, spinning net shots under a steady rhythm.",
    setup:
      "A feeder tosses shuttles just over the net to the left and then the right; the player stays close to the net.",
    steps:
      "The feeder tosses the shuttle near the net tape.|The player plays a tight net shot back.|The feeder alternates left and right.|Count how many tight shots in a row.",
    cues: "Soft fingers.|Racket up, meet it early.|Tight over the tape.",
    mistakes: "A big swing.|Lifting the shuttle high above the tape.",
    easier: "Feed slowly to one side only.",
    harder: "Feed to both sides quickly, or ask for a spin.",
    safety: [...base],
  }),
  drill(15, "feeding", {
    title: "Rear-court round-the-head series",
    skill: "Overhead",
    level: "Advanced",
    format: "Singles",
    minutes: 15,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Practise the footwork and swing for an overhead forehand from the backhand rear corner.",
    setup:
      "The feeder sends high shuttles to the player's backhand rear corner.",
    steps:
      "Turn and step back to the corner.|Swing round the head and play a clear or a drop.|Recover to the base.|Repeat, then rest and swap.",
    cues: "Turn the shoulders early.|Lean away from the shuttle, contact high.|Push back to the base.",
    mistakes: "Falling backwards after the stroke.|Using a weak backhand when time allows a round-the-head stroke.",
    easier: "Practise the swing and footwork without a shuttle first.",
    harder: "Add a smash and vary the depth of the feed.",
    safety: [...base, SAFE.warm],
    minimumAge: 12,
  }),
  drill(16, "feeding", {
    title: "Late backhand recovery",
    skill: "Defence",
    level: "Advanced",
    format: "Singles",
    minutes: 12,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Handle shuttles that arrive deep behind you on the backhand side and recover quickly.",
    setup:
      "The feeder sends shuttles just behind the player on the backhand side.",
    steps:
      "The player moves back and turns to the backhand corner.|Plays a backhand clear, drop or defensive lift.|Recovers to the base.|Rest and swap roles.",
    cues: "Back to the net, racket ready.|Meet it early.|Recover without waiting.",
    mistakes: "Reaching with the arm only.|Standing and watching the shuttle.",
    easier: "Feed a little shallower and slower.",
    harder: "Feed late and ask for an accurate clear.",
    safety: [...base],
  }),
  drill(17, "feeding", {
    title: "Jump smash and recover",
    skill: "Overhead",
    level: "Advanced",
    format: "Singles",
    minutes: 12,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Add power with a jump smash and be ready for the reply by recovering to a balanced mid-court position.",
    setup:
      "The feeder lifts high to the rear court; the player starts at the base.",
    steps:
      "Move to the rear court and time a small jump.|Smash at the top of the jump.|Land balanced on both feet.|Move to the mid-court and block the reply.",
    cues: "Time the jump with the swing.|Land on both feet.|Block with a short, firm touch.",
    mistakes: "Jumping early.|Landing off balance and missing the reply.",
    easier: "Do a standing smash first, then add a small jump.",
    harder: "Feed a quicker and flatter lift.",
    safety: [...base, SAFE.landing, SAFE.warm, SAFE.eyes],
    minimumAge: 12,
  }),
  drill(18, "feeding", {
    title: "Three-on-one pressure defence",
    skill: "Defence",
    level: "Advanced",
    format: "Singles",
    minutes: 12,
    players: 4,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Practise blocks, drives and high lifts against repeated attacks.",
    setup:
      "Two or three feeders take turns smashing from the far court at a controlled pace; one defender holds the other side.",
    steps:
      "A feeder smashes at a controlled pace.|The defender blocks, drives or lifts the reply.|The next feeder smashes straight away.|Rotate the defender after a short round.",
    cues: "Low and ready.|Short, firm touch.|Lift high when out of position.",
    mistakes: "Swinging big at a smash.|Standing too close to the net.",
    easier: "Feeders smash at half pace and to one side.",
    harder: "Feeders vary the pace and direction.",
    safety: [...base, SAFE.eyes, SAFE.stop],
  }),
  drill(19, "feeding", {
    title: "Flat-drive rapid fire",
    skill: "Defence",
    level: "Intermediate",
    format: "Both",
    minutes: 10,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Sharpen reflexes and quick grip changes against fast shuttles at body height.",
    setup:
      "The player stands at mid-court; the feeder sends fast, flat shuttles at the body and shoulders.",
    steps:
      "The feeder sends a flat shuttle at the chest or shoulder.|The player blocks or drives it back using a short swing.|Change between forehand and backhand grip.|Rest and swap roles.",
    cues: "Compact swing.|Hands up, in front of the body.|Change grip with the fingers.",
    mistakes: "Big swings.|Letting the shuttle come past the body.",
    easier: "Feed at a slower pace and a little lower.",
    harder: "Feed faster, or alternate left and right body positions.",
    safety: [...base, SAFE.eyes, SAFE.stop],
  }),
  drill(20, "feeding", {
    title: "Cross-court net and lift",
    skill: "Net play",
    level: "Intermediate",
    format: "Singles",
    minutes: 12,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Choose between a tight cross-court net shot and a deep cross-court lift from the same position.",
    setup:
      "The feeder tosses to the forehand net; the player starts at the base.",
    steps:
      "Lunge to the net and play a tight cross-court net shot.|Recover.|On the next feed, play a high cross-court lift to the far rear corner.|Alternate, then rest and swap.",
    cues: "Same preparation for both shots.|Lift high and deep.|Recover through the base.",
    mistakes: "Telegraphing the shot.|Lifting short.",
    easier: "Practise one shot at a time first.",
    harder: "The feeder calls the shot just before the toss.",
    safety: [...base],
  }),
];

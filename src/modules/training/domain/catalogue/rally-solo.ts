import { drill, SAFE } from "./define";

const base = [SAFE.floor, SAFE.shuttles, SAFE.space, SAFE.water];
const solo = [SAFE.floor, SAFE.shuttles, SAFE.water];

export const rally = [
  drill(21, "rally", {
    title: "Clear-to-clear, standing then moving",
    skill: "Overhead",
    level: "Beginner",
    format: "Singles",
    minutes: 12,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Hit high, deep clears back and forth with a steady rhythm, first standing and then moving.",
    setup: "Two players, one on each side, near the rear service line.",
    steps:
      "Rally clears straight, standing still.|Count how many deep clears in a row.|Then each player moves a step either side between shots.|Finish by moving corner to corner.",
    cues: "Turn side-on.|Hit up and through the shuttle.|Recover to the centre after each shot.",
    mistakes: "Hitting too flat.|Standing still after the shot.",
    easier: "Stay in one spot and aim for a rear-court zone.",
    harder: "Move to different corners and clear to the far corner each time.",
    safety: [...base],
  }),
  drill(22, "rally", {
    title: "Clear, drop and lift triangle",
    skill: "Overhead",
    level: "Intermediate",
    format: "Singles",
    minutes: 12,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Link three shots in a cycle so movement between the rear court and the net becomes natural.",
    setup: "Two players on a half court each, one starting at the rear.",
    steps:
      "Player A clears to the rear.|Player B hits a drop shot to the net.|Player A moves in and lifts high.|Repeat the cycle and swap roles after a set time.",
    cues: "Same preparation for the clear and the drop.|Lift high and deep.|Recover after each shot.",
    mistakes: "Telegraphing the drop shot.|Lifting short to the mid-court.",
    easier: "Slow the cycle and keep shots to one side.",
    harder: "Add a cross-court choice on the lift.",
    safety: [...base],
  }),
  drill(23, "rally", {
    title: "Half-court singles",
    skill: "Movement",
    level: "Beginner",
    format: "Singles",
    minutes: 12,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Improve accuracy, patience and front-to-back stamina on a narrower court.",
    setup:
      "Play a full rally using only the left or right half of the court; everything hit outside the half is out.",
    steps:
      "Serve into the half court.|Rally using the full length but not the width.|Count the longest rally.|Switch halves halfway through.",
    cues: "Use depth, not width.|Recover to the centre.|Patience is the aim.",
    mistakes: "Smashing too early.|Not recovering to the middle.",
    easier: "Use a shorter court.",
    harder: "Shrink the half further, or play to a score.",
    safety: [...base],
  }),
  drill(24, "rally", {
    title: "Mid-court flat drives",
    skill: "Defence",
    level: "Intermediate",
    format: "Both",
    minutes: 10,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Keep fast, flat drives low over the net without letting the shuttle rise or drop.",
    setup:
      "Both players stand near their service lines and drive to each other.",
    steps:
      "Start with slow, flat drives.|Increase the pace as the rhythm settles.|Use both forehand and backhand drives.|If the shuttle falls, restart.",
    cues: "Short swing.|Hit through the middle of the shuttle.|Eyes up and hands ready.",
    mistakes: "Big backswing.|Hitting the shuttle upward.",
    easier: "Rally slowly and let the shuttle bounce off the racket softly.",
    harder: "Go faster, or play to a count without a lift.",
    safety: [...base, SAFE.eyes],
  }),
  drill(25, "rally", {
    title: "Net battle at the T",
    skill: "Net play",
    level: "Intermediate",
    format: "Both",
    minutes: 10,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Win the net with tight net shots, pushes and blocks, forcing the opponent to lift.",
    setup:
      "Both players stay close to the net inside the front half of the court.",
    steps:
      "Start a rally with a net shot.|Play only net shots, pushes and blocks.|The player who lifts loses the point.|Play short games and swap partners.",
    cues: "Racket up, meet it early.|Tight over the tape.|Small, soft movements.",
    mistakes: "Swinging.|Hitting into the net from a low racket.",
    easier: "Allow one lift per rally.",
    harder: "Only cross-court net shots allowed.",
    safety: [...base],
  }),
  drill(26, "rally", {
    title: "Smash, block and lift",
    skill: "Defence",
    level: "Intermediate",
    format: "Singles",
    minutes: 12,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Practise the attack and defence sequence of a smash, a tight block and a lift.",
    setup: "Two players on opposite halves, one attacking and one defending.",
    steps:
      "Player A smashes at medium pace.|Player B blocks tightly to the net.|Player A moves forward and lifts back high.|Player B smashes next; swap roles after a set time.",
    cues: "Controlled smash, not full power.|Soft hands on the block.|Lift high and deep.",
    mistakes: "Smashing too hard for the partner.|A block that floats up.",
    easier: "Use a half-smash.",
    harder: "Increase the pace of the smash.",
    safety: [...base, SAFE.eyes],
  }),
  drill(27, "rally", {
    title: "Two-versus-one court coverage",
    skill: "Movement",
    level: "Advanced",
    format: "Singles",
    minutes: 10,
    players: 3,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Build court coverage and fitness against two partners who move the single player around.",
    setup:
      "One player covers the whole singles court; two partners play together on the other side.",
    steps:
      "The pair rallies and moves the single player front, back and side to side.|The single player returns every shuttle.|Rotate who is the single player after a short round.|Keep rounds short.",
    cues: "Recover to the centre every time.|Play deep when pushed.|Stay calm.",
    mistakes: "Stopping recovery when tired.|Hitting weak, short lifts.",
    easier: "The pair plays only down the middle and slowly.",
    harder: "The pair attacks faster and plays more variety.",
    safety: [...base, SAFE.stop],
  }),
  drill(28, "rally", {
    title: "Cross-court versus straight clears",
    skill: "Overhead",
    level: "Intermediate",
    format: "Singles",
    minutes: 12,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Force continuous side-to-side movement by playing different clear directions.",
    setup:
      "Player A plays only straight clears; Player B plays only diagonal clears.",
    steps:
      "Player A clears straight down the line.|Player B clears diagonally.|Both keep the rally going with deep clears.|Swap the roles after a few minutes.",
    cues: "Disguise the direction.|Use the legs to reach the corner.|Recover to the centre.",
    mistakes: "Hitting short clears.|Forgetting the assigned direction.",
    easier: "Allow a drop shot as a rest shot.",
    harder: "Add a smash on a short clear.",
    safety: [...base],
  }),
  drill(29, "rally", {
    title: "No-lift attacking game",
    skill: "Doubles",
    level: "Advanced",
    format: "Both",
    minutes: 10,
    players: 4,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Learn to keep the shuttle flat or downward so the attack never gives the opponent time.",
    setup:
      "A rally game in which lifting the shuttle high is not allowed; best in doubles.",
    steps:
      "Serve and rally.|Every shot must stay flat, drive or push down.|A high lift loses the point.|Play short games and swap pairs.",
    cues: "Hit early.|Drive flat, low over the net.|Stay in an attacking formation.",
    mistakes: "Defensive lifts out of habit.|Losing balance from over-hitting.",
    easier: "Allow one lift per player per rally.",
    harder: "Only drives and net shots allowed.",
    safety: [...base, SAFE.eyes],
  }),
  drill(30, "rally", {
    title: "Four-shot serve and return",
    skill: "Serve & return",
    level: "Beginner",
    format: "Both",
    minutes: 10,
    players: 2,
    equipment: ["Rackets", "Shuttles", "Net"],
    objective:
      "Master the first four shots of a rally: the serve, the return, the third shot and the fourth shot.",
    setup:
      "Two players play only the first four shots, then stop and begin a new rally.",
    steps:
      "Serve, return, third shot, fourth shot.|Stop after the fourth shot and talk about what worked.|Repeat for a set number of rallies.|Switch server and receiver.",
    cues: "A good serve sets up the rally.|Return to the open space.|Be ready for the third shot.",
    mistakes: "Serving too high.|Ignoring the third shot.",
    easier: "Practise the serve and return only.",
    harder: "Add the fifth and sixth shots.",
    safety: [...base],
  }),
];

export const solo5 = [
  drill(31, "solo", {
    title: "Continuous wall drives",
    skill: "Defence",
    level: "Beginner",
    format: "Both",
    minutes: 8,
    players: 1,
    equipment: ["Rackets", "Shuttles", "Wall"],
    objective:
      "Build quick hands and finger power with a short swing against a flat wall.",
    setup:
      "Stand about one and a half to two metres from a flat, clear wall, with nothing fragile nearby.",
    steps:
      "Hit the shuttle against the wall with a short flat drive.|Hit it again as it returns.|Keep the swing short and use the fingers.|Count the longest run.",
    cues: "Short swing.|Fingers and wrist, not the arm.|Eyes on the shuttle.",
    mistakes: "A big swing.|Standing too close.",
    easier: "Stand a little further away and hit slowly.",
    harder: "Move closer or use a faster rhythm.",
    safety: [...solo, "Check the wall and the area behind you are clear of people and glass."],
  }),
  drill(32, "solo", {
    title: "Alternating forehand and backhand wall drill",
    skill: "Defence",
    level: "Intermediate",
    format: "Both",
    minutes: 8,
    players: 1,
    equipment: ["Rackets", "Shuttles", "Wall"],
    objective:
      "Train the grip change between forehand and backhand on every shot.",
    setup:
      "A flat wall and a clear area about two metres from the wall.",
    steps:
      "Hit a forehand drive.|Change grip and hit a backhand drive.|Switch grips on every shot.|Count the longest run.",
    cues: "Change grip with the fingers.|Relaxed grip.|Same short swing on both sides.",
    mistakes: "Gripping too hard.|Switching late.",
    easier: "Do five forehands then five backhands.",
    harder: "Speed up while keeping control.",
    safety: [...solo],
  }),
  drill(33, "solo", {
    title: "Target box serving",
    skill: "Serve & return",
    level: "Beginner",
    format: "Both",
    minutes: 10,
    players: 1,
    equipment: ["Rackets", "Shuttles", "Net", "Target"],
    objective:
      "Improve serve accuracy with low backhand serves and flick serves into a target.",
    setup:
      "Place a hoop or towel as a target on the service line; put a basket of shuttles beside the server.",
    steps:
      "Serve low backhand serves into the target.|Count how many land inside.|Switch to flick serves and aim for the rear target.|Collect the shuttles and repeat.",
    cues: "Steady, repeatable action.|Contact below the waist.|Follow through to the target.",
    mistakes: "Changing the action each time.|Serving too high.",
    easier: "Use a larger target and a shorter serve.",
    harder: "Use a smaller target, or serve under a time limit.",
    safety: [...solo, "Walk to collect shuttles; do not run onto loose ones."],
  }),
  drill(34, "solo", {
    title: "Racket-head speed swings",
    skill: "Overhead",
    level: "Intermediate",
    format: "Both",
    minutes: 8,
    players: 1,
    equipment: ["Rackets", "Head cover"],
    objective:
      "Build swing speed with a controlled overhead action using a racket with a head cover on.",
    setup:
      "A clear space away from other people, using a racket with its head cover on for extra resistance.",
    steps:
      "Stand side-on with a relaxed grip.|Swing overhead with a smooth, fast action.|Pause after each swing and reset the feet.|Repeat for a few short sets.",
    cues: "Relax, then accelerate.|Turn the body, then the arm.|Finish the swing in balance.",
    mistakes: "Tensing the arm.|Swinging too hard too soon.",
    easier: "Use a normal racket and a slower swing.",
    harder: "Add a small step into the swing.",
    safety: [...solo, SAFE.warm, "Swing in clear space; keep everyone and everything out of the swing path."],
    minimumAge: 10,
  }),
  drill(35, "solo", {
    title: "Shuttle keep-ups",
    skill: "Net play",
    level: "Beginner",
    format: "Both",
    minutes: 5,
    players: 1,
    equipment: ["Rackets", "Shuttles"],
    objective:
      "Improve hand-eye coordination and a soft touch by keeping a shuttle in the air.",
    setup:
      "Stand in a clear space with a shuttle and a racket.",
    steps:
      "Tap the shuttle upward using the racket frame.|Keep it going without letting it fall.|Change to the strings, front and back.|Count the longest run.",
    cues: "Soft touch.|Eyes on the shuttle.|Small movements.",
    mistakes: "Hitting too hard.|Moving the feet too much.",
    easier: "Allow a bounce or catch between taps.",
    harder: "Alternate frame and strings, or change hands.",
    safety: [...solo],
  }),
];

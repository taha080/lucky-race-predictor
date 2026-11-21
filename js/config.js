// Lucky Race Predictor — configuration
// Fill these in from your Supabase project:
//   Supabase dashboard -> Project Settings -> API
//     Project URL  -> SUPABASE_URL
//     anon public  -> SUPABASE_ANON_KEY
// NEVER put the service_role key here — it must never ship in frontend code.
//
// If the placeholders are left as-is, the app runs in DEMO mode:
// races + speed table live in localStorage and predictions work without
// an account. Set the values below to enable real accounts & subscriptions.

// eslint-disable-next-line no-unused-vars
var LRP_CONFIG = {
  SUPABASE_URL: "https://alqqhzbgcodgdbbcrinm.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFscXFoemJnY29kZ2RiYmNyaW5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUyMzY5MjMsImV4cCI6MjExMDgxMjkyM30.u9nWRGvL2CQSSOV0rgHOD3g3G7h3_riUopBhyuE9AfQ",

  // Recency weighting for history: exponential decay over saved races.
  // The newest race has weight 1.0; the weight halves every
  // HISTORY_HALF_LIFE_RACES races (default 50). Applies to the win-rate
  // history blend and to the Unknown-box track probabilities.
  HISTORY_HALF_LIFE_RACES: 50,

  // Segment length weights: how much of a race each segment covers.
  // Derived from full-track races 21-29 (see README): the first segment
  // is short (~19%), the middle segment is the longest (~51%), the last
  // ~30%. Edit to refine as more full-track races are saved; the three
  // values are normalised to sum to 1. A missing/invalid value falls
  // back to equal thirds [1/3, 1/3, 1/3].
  SEGMENT_LENGTHS: [0.189, 0.511, 0.300],

  // Odds blend: how much the game's odds move the prediction %.
  // The odds imply a chance for each vehicle: (1 / odds), normalised
  // across the 3 picked vehicles — higher odds = lower implied chance
  // (the game pays more on the vehicle it thinks is less likely).
  // Final % = (1 - ODDS_BLEND_WEIGHT) * track+speed+history %
  //         + ODDS_BLEND_WEIGHT * odds-implied %.
  // 0.1 = odds only NUDGE the % a little (user's order, 21 Nov voice
  // call: odds come from how many people bet on a vehicle, not from
  // who will win — so they must never decide the prediction).
  // Changing the odds on the Predict tab moves the shown % only
  // slightly; MAIN / BACKUP almost never flips on odds alone.
  ODDS_BLEND_WEIGHT: 0.1,

  // Admin emails (in addition to profiles.is_admin = true in the database).
  // Admins can grant / revoke subscriptions from the Account tab.
  // NOTE: for the admin panel's database reads/writes to work, the admin
  // must ALSO have profiles.is_admin = true (set it in the Supabase SQL
  // editor). See sql/schema.sql and README.md.
  ADMIN_EMAILS: [
    "ahantaha16@gmail.com",
    "ahsantaha16@gmail.com"
  ]
};

if (typeof window !== "undefined") {
  window.LRP_CONFIG = LRP_CONFIG;
}

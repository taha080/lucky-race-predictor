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
  SUPABASE_URL: "YOUR_SUPABASE_URL",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_KEY",

  // Admin emails (in addition to profiles.is_admin = true in the database).
  // Admins can grant / revoke subscriptions from the Account tab.
  // NOTE: for the admin panel's database reads/writes to work, the admin
  // must ALSO have profiles.is_admin = true (set it in the Supabase SQL
  // editor). See sql/schema.sql and README.md.
  ADMIN_EMAILS: [
    // "owner@example.com"
  ]
};

if (typeof window !== "undefined") {
  window.LRP_CONFIG = LRP_CONFIG;
}

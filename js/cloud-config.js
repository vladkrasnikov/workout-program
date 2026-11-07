// Public browser configuration. With an empty URL/key the app is catalog-only.
// Never place a Supabase service_role key in this file.
export default Object.freeze({
  supabaseUrl: "",
  supabasePublishableKey: "",
  supabaseClientUrl: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm",
  table: "workout_snapshots",
  emailRedirectTo: "",
  passwordResetRedirectTo: "",
});

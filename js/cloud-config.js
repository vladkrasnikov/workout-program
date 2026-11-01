// Public browser configuration. Leave URL/key empty to keep local guest mode.
// Never place a Supabase service_role key in this file.
export default Object.freeze({
  supabaseUrl: "",
  supabasePublishableKey: "",
  supabaseClientUrl: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm",
  table: "workout_snapshots",
  emailRedirectTo: "",
  passwordResetRedirectTo: "",
});

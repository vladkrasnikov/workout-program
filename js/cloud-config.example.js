// Copy this file to cloud-config.js and fill in public project values only.
// A publishable/anon key is designed for browser use when Row Level Security is enabled.
// Never put a service_role key in a client-side file.
export default Object.freeze({
  supabaseUrl: "",
  supabasePublishableKey: "",
  supabaseClientUrl: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm",
  emailRedirectTo: "",
  passwordResetRedirectTo: "",
});

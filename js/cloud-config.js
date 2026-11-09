// Public browser configuration. With an empty URL/key local workouts remain available.
// Never place a Supabase service_role key in this file.
export default Object.freeze({
  supabaseUrl: "https://rlxlelsnoggwnqtsabhh.supabase.co",
  supabasePublishableKey: "sb_publishable_VFKoltJdEi4gsw5nNM_d3w_vIaZ8l1B",
  supabaseClientUrl: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm",
  table: "workout_snapshots",
  emailRedirectTo: "https://vladkrasnikov.github.io/workout-program/",
  passwordResetRedirectTo: "https://vladkrasnikov.github.io/workout-program/",
});

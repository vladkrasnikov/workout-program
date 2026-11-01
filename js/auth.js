const DEFAULT_AUTH_OPTIONS = Object.freeze({
  persistSession: true,
  autoRefreshToken: true,
  detectSessionInUrl: true,
});

export class CloudNotConfiguredError extends Error {
  constructor() {
    super("Хмарний профіль не налаштовано");
    this.name = "CloudNotConfiguredError";
  }
}

const publicKey = (config = {}) => config.supabasePublishableKey ?? config.supabaseAnonKey ?? "";

export function isCloudConfigured(config = {}) {
  return Boolean(String(config.supabaseUrl ?? "").trim() && String(publicKey(config)).trim());
}

const unwrap = (result) => {
  if (result?.error) throw result.error;
  return result?.data ?? null;
};

const disabledSubscription = Object.freeze({ unsubscribe() {} });

/**
 * Thin adapter over the official @supabase/supabase-js createClient function.
 * The browser integration supplies createClient; token refresh remains owned by Supabase.
 */
export function createSupabaseAuth({ config = {}, createClient } = {}) {
  const configured = isCloudConfigured(config);
  if (configured && typeof createClient !== "function") {
    throw new TypeError("Для налаштованої хмари потрібен createClient з @supabase/supabase-js");
  }

  const client = configured
    ? createClient(config.supabaseUrl, publicKey(config), {
      auth: { ...DEFAULT_AUTH_OPTIONS, ...(config.authOptions ?? {}) },
    })
    : null;

  const requireClient = () => {
    if (!client) throw new CloudNotConfiguredError();
    return client;
  };

  return Object.freeze({
    configured,
    client,

    async getSession() {
      if (!client) return null;
      return unwrap(await client.auth.getSession())?.session ?? null;
    },

    onAuthStateChange(callback) {
      if (!client) return disabledSubscription;
      const result = client.auth.onAuthStateChange(callback);
      return result?.data?.subscription ?? result?.subscription ?? disabledSubscription;
    },

    async signUp({ email, password, redirectTo = config.emailRedirectTo } = {}) {
      const options = redirectTo ? { emailRedirectTo: redirectTo } : undefined;
      return unwrap(await requireClient().auth.signUp({ email, password, ...(options ? { options } : {}) }));
    },

    async signIn({ email, password } = {}) {
      return unwrap(await requireClient().auth.signInWithPassword({ email, password }));
    },

    async signOut() {
      unwrap(await requireClient().auth.signOut({ scope: "local" }));
    },

    async resetPasswordForEmail(email, { redirectTo = config.passwordResetRedirectTo ?? config.emailRedirectTo } = {}) {
      const options = redirectTo ? { redirectTo } : undefined;
      unwrap(await requireClient().auth.resetPasswordForEmail(email, options));
    },

    async updatePassword(password) {
      return unwrap(await requireClient().auth.updateUser({ password }));
    },
  });
}

export const SUPABASE_AUTH_DEFAULTS = DEFAULT_AUTH_OPTIONS;

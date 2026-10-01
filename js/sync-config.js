/* Your Supabase project (see README → Cloud sync). Both values are PUBLIC by design — the anon
   key is safe in a web page because row-level security limits every request to the signed-in
   user's own row. NEVER put the service_role key here. Leave empty to run without sync. */
window.SYNC_CONFIG = window.SYNC_CONFIG || { url: '', anonKey: '' };

const { createClient } = require('@supabase/supabase-js');

// Service-role key bypasses Row Level Security entirely — this client can read/write
// any row regardless of owner. Every route that queries user-owned tables must filter
// by `user_id = req.user.id` manually; RLS will not do it for calls made through this
// client. requireAuth only establishes *who* the caller is, not what they may access.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = supabase;

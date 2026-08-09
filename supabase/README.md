# Database migrations

No Supabase CLI is installed in this project yet. Migrations in `migrations/` are applied
manually: open the Supabase Dashboard → SQL Editor, paste the file's contents, run it.

Files follow the Supabase CLI's own naming convention
(`<YYYYMMDDHHmmss>_<description>.sql`) so they slot in cleanly once the CLI is installed,
without renaming.

Once the CLI is installed and the project is linked (`supabase link --project-ref <ref>`),
mark migrations that were already applied manually as applied — don't just run
`supabase db push` and let it try to re-run them (it will fail against objects that already
exist):

```
supabase migration repair --status applied <timestamp>
```

for each migration file already applied through the Dashboard.

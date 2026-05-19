# <div align="center">SupaBase Jump for Obsidian</div>

<div align="center">
Sync your Obsidian vault with one or many Supabase projects. Edit the same note on two devices simultaneously. Pool multiple free-tier projects to extend storage past 500 MB. Built-in diagnostics make connection issues debuggable from settings instead of the dev console.
</div>

<br />

<div align="center">

**Note:** This is an unofficial way to sync and back up your notes. [Obsidian Sync](https://obsidian.md/sync) is the official supported option.

</div>

<div align="center">
  <a href="https://github.com/brianstm/obsidian-supabase-jump/releases">
    <img src="https://img.shields.io/github/v/release/brianstm/obsidian-supabase-jump?style=for-the-badge&sort=semver&label=LATEST&color=6874e8" alt="Latest release" />
  </a>
</div>

## Demo

![Demo Video](assets/video-demo.gif)

> If the video is blurry, you can [download it here](assets/video-demo.mp4).

## What's new in v2

- **Multi-project sharding.** Add one or more Supabase projects in settings. Files are deterministically routed to a project by a stable hash of the path, so the same path always lands on the same shard. Capacity scales with the number of free-tier projects you add.
- **Setup wizard.** A guided modal walks through Project URL + anon key, runs the schema setup as labelled SQL fragments via the Management API, creates the storage bucket, signs you in, and verifies the project is usable with a round-trip probe. Each step reports HTTP status and response body on failure with a "retry just this step" button.
- **Magic-link auth.** Optional one-time-code sign-in per project — no password stored. Password auth is still supported and now wraps the password with an at-rest obfuscation (vault-id-derived XOR; see security notes).
- **Adaptive realtime.** Reconnects with exponential backoff + jitter. Brief outages are silent — a user notice only fires after the channel has been down for `escalateAfterMs` (default 30 s). JWT-expired errors trigger a session refresh before a Notice.
- **Diagnostics in-plugin.** Structured log buffer, level dropdown in settings, "Open log panel" command with live filtering, "Copy diagnostics" button that redacts URLs and tokens.
- **Rebalance command.** When you add or disable a project, run "Rebalance projects" to move rows + storage objects to their correct shards.

## Features

- Real-time collaborative editing (Yjs CRDTs over Supabase Broadcast)
- Real-time database sync via Supabase Realtime
- Conflict resolution by modification time (last-write-wins outside CRDT sessions)
- Binary files via Supabase Storage; text files inline in Postgres
- Frontmatter properties + tags extracted into queryable columns
- Selective sync (excluded folders, platform-specific paths)
- `.obsidian/` config folder sync
- Self-hosted Supabase support
- Mobile + desktop
- Offline queueing

## Quick Start

### 1. Create one or more Supabase projects

Create at least one free project at [supabase.com](https://supabase.com). For each one, copy:

- **Project URL** (`https://<ref>.supabase.co`)
- **Anon/public key** (Project Settings → API)

You only need a **Personal Access Token** (account-level, see [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)) for the one-time setup. The wizard uses it once, never stores it.

### 2. Install

Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install BRAT from the Community Plugins store.
2. **Settings → BRAT → Add Beta Plugin** → paste `https://github.com/brianstm/obsidian-supabase-jump`.

Or manually:

1. Download `main.js` and `manifest.json` from the latest release.
2. Drop them into `<vault>/.obsidian/plugins/supabase-jump/`.
3. Reload Obsidian and enable the plugin.

### 3. Run the setup wizard

Open **Settings → SupaBase Jump → Open wizard**. The wizard walks through, per project:

1. **Credentials.** Paste Project URL + anon key + a project label.
2. **Schema setup.** Paste a PAT and click "Run schema setup". The wizard runs seven labelled SQL steps; any failure shows the exact HTTP status, request URL, and response body, and gives you a per-step retry button.
3. **Storage bucket.** Click "Create / verify" — creates the `vault-attachments` bucket via the Management API. If creation fails (e.g. some self-hosted setups), create it manually and click "Create / verify" to confirm.
4. **Authentication.** Pick email + password OR magic-link OTP. Magic-link sends a 6-digit code to your inbox; paste it back.
5. **Verify.** Round-trips a tiny row to confirm RLS + bucket + auth are wired correctly.
6. **Save project.** The project is appended to settings and connection starts.

To add a second project: settings → "Add project". Run the wizard again. Then click **"Rebalance now"** to redistribute existing files across the new shard set.

## Usage

### Status bar

The status bar shows the aggregate state across all enabled projects:

| Icon | Meaning |
|------|---------|
| 🟢 | All projects synced |
| 🟡 | One or more projects connecting |
| 🔄 | A sync is in progress |
| 🟠 | One or more projects degraded (realtime offline, retrying) |
| ⚠️  | One or more projects in error state |
| 🔴 | All projects offline |

Hover or run the **Show sync status** command to see the full `N/M synced` label.

### Multi-project routing

Files are routed to a project by `hash(path) % enabledProjects.length`, using a random salt generated on first install. Same path → same project, deterministically, until you add, remove, or disable a project. Then run **Rebalance projects** to move files to their new shards.

The catalog (`vault_files` table) lives in each project; the bucket lives in each project. There is no single "metadata project" — each project is fully independent.

### Diagnostics

When something goes wrong:

1. **Settings → SupaBase Jump → Diagnostics → Open log panel.** Live-updating ring buffer (last 1000 entries by default), level filter, scope filter.
2. **Copy diagnostics.** Copies a redacted text bundle (logs + plugin meta + settings with URLs/keys redacted) to the clipboard. Paste into a GitHub issue.

The default log level is `info`. Switch to `debug` to see push/pull events per file when debugging sync issues.

### Realtime tuning

In Settings → Diagnostics:

- **Realtime escalate-after (seconds).** How long a realtime channel must stay down before showing a user notice. Default 30 s — brief flaps (WiFi switch, sleep/wake) don't surface a Notice.

In `data.json` you can also tune `realtime.reconnectInitialMs` (default 1000) and `realtime.reconnectMaxMs` (default 60000) for backoff bounds.

### Real-time collaborative editing

When two devices open the same `.md` file, they join an ephemeral Supabase Broadcast channel for that file (on whichever project the file is sharded to). Edits merge via Yjs CRDTs. State is not persisted to the database — closing the note releases the channel and mtime-based conflict resolution takes over.

### Manual sync

| Command | Action |
|---------|--------|
| `SupaBase Jump: Force sync now` | Full two-way sync across all enabled projects |
| `SupaBase Jump: Fetch from database` | Pull-only sync |
| `SupaBase Jump: Show sync status` | Print aggregate status to a Notice |
| `SupaBase Jump: Open log panel` | Open the log buffer view |
| `SupaBase Jump: Open setup wizard` | Add a new project |
| `SupaBase Jump: Copy diagnostics to clipboard` | Export redacted diagnostics |
| `SupaBase Jump: Rebalance projects` | Re-shard files after a project set change |

### Platform-specific config paths

In settings → Platform-specific config paths, toggle which `.obsidian/` files sync only to mobile vs only to desktop. Useful for keeping different themes, plugin sets, or hotkeys per platform.

| Toggle | Path |
|--------|------|
| Appearance | `appearance.json` |
| Themes folder | `themes/` |
| CSS Snippets | `snippets/` |
| All plugins | `plugins/` |
| Installed plugins list | `community-plugins.json` |
| Custom hotkeys | `hotkeys.json` |
| Workspace layout | `workspace.json` |

Rows for platform-tagged files carry `platform = 'mobile'` or `'desktop'`; pulls skip rows tagged for a different platform.

### Self-hosted Supabase

Each project in the wizard can target any Supabase-compatible URL. The Management API steps require `api.supabase.com` reachability with your PAT; self-hosted setups that don't expose this can paste the SQL from the wizard transcript into your own SQL editor and skip the bucket-creation step (create the bucket manually instead).

Magic-link auth requires SMTP to be configured in your Supabase project; if you're self-hosting without SMTP, pick password auth for that project.

## How It Works

### Database schema

Each project carries the same `vault_files` table:

| Column | Type | Description |
|--------|------|-------------|
| `id` | text (PK) | `{vaultId}::{path}` with slashes → `__SLASH__` |
| `vault_id` | text | Vault identifier; same across projects |
| `path` | text | Relative file path |
| `content` | text | Text body (text files) |
| `storage_path` | text | Storage key (binary files) |
| `frontmatter` | jsonb | Parsed YAML frontmatter |
| `tags` | text[] | Tags extracted from `tags:` |
| `platform` | text | `all` / `mobile` / `desktop` |
| `mtime`/`ctime`/`size` | bigint | File metadata |
| `deleted` | boolean | Soft-delete |
| `user_id` | uuid | RLS scope key |

`user_id` is per-project — each project's auth.uid() is independent. The plugin uses `pool.getUserId(projectId)` whenever it needs the right one.

### Storage bucket

Each project has a private `vault-attachments` bucket. Binary files are uploaded to `{userId}/{vaultId}/{base64url(path)}{ext}`. The RLS policy on `storage.objects` requires the first folder segment to match the requesting user.

### Routing

```
shardFor(path, projects, salt) = enabledProjects[fnv1a(salt + ":" + path) % enabledProjects.length]
```

`enabledProjects` is sorted by id, so the routing is stable across devices as long as the project set + salt are identical. Adding/removing/disabling projects changes the modulo and requires a rebalance.

### Realtime

One `postgres_changes` subscription per enabled project on the `vault_files` table filtered by `vault_id`. Each subscription is managed by `RealtimeSupervisor`:

- `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED` → exponential backoff with ±20% jitter, capped at `reconnectMaxMs`.
- JWT expired (PGRST301 / message contains "JWT expired") → call `refreshSession()` once, then re-subscribe without backoff.
- Sustained outage > `escalateAfterMs` → user Notice; status bar already shows degraded immediately.

Per-file CRDT broadcast channels use the same supervisor — transient errors no longer surface a Notice.

### Diagnostics

`logger.ts` exposes a ring buffer (default 1000 entries) and four levels. Settings → Log level controls verbosity. `exportDiagnostics` produces a redacted text bundle: URLs are reduced to host+path, keys/tokens are masked, errors are stringified with stack trace truncated to 8 lines.

## Troubleshooting

### "Setup failed at step …"

Open the wizard transcript for that project. Each SQL step is labelled with HTTP status + response body. Common causes:

- **`create-table` / `create-policy` → 401 / 403:** PAT lacks permission on the project, or you pasted the anon key instead of a PAT. Generate a fresh PAT at [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens).
- **`add-publication` → 42710 (publication already has table):** harmless — the DO block should swallow this; if it didn't, the wizard's per-step retry will succeed on the next attempt.
- **`storage-rls` → 42501 (insufficient privilege):** the project's `storage` schema is locked down by a hosting provider. Create the policy manually in the Supabase SQL editor using the SQL from the wizard transcript.

### "Connection lost — reconnecting…" used to spam, now silent

Brief realtime outages now stay silent until they exceed `escalateAfterMs` (default 30 s). The status bar shows 🟠 immediately; only the Notice is debounced. If you'd rather see Notices sooner, lower **Diagnostics → Realtime escalate-after (seconds)** to 5–10.

### Files not syncing on one device

1. Status bar should read 🟢. If it shows 🟠 or ⚠️ on one device, open the log panel and filter scope `realtime` — the supervisor logs every reconnect attempt with the underlying status.
2. Check **Settings → Vault ID** matches across devices.
3. Compare the project set: both devices must have the same projects + same `routing.hashSalt`. If they don't, paths route to different shards. Easiest fix: re-export `data.json` from the working device or re-add the same projects on the failing device in the same order.

### Magic-link OTP never arrives

Magic-link uses your Supabase project's email SMTP. On self-hosted instances without SMTP, no link/code is sent. Switch the project to password auth in **Edit project → Authentication → Method**.

### "Project rejected the query — check RLS policy"

The plugin saw a `42501` (RLS violation) when reading from one project. Run the **storage-rls** and **create-policy** steps for that project in the wizard again, then click **Verify**. If verify passes but live sync still fails, the project's `user_id` column on existing rows may not match `auth.uid()` for the signed-in user — clear those rows and let the plugin re-push.

## Security model

- **Vault data stays in your own Supabase projects.** No third-party servers.
- **Row Level Security** is enforced on every project's `vault_files` table and `storage.objects` bucket; you can only read or write rows scoped to your own `auth.uid()`.
- **CRDT broadcast channels are ephemeral.** Yjs state is never persisted to the database.
- **Password storage on disk is obfuscation, not encryption.** Passwords in `data.json` are XOR'd with a vault-id-derived key. Anyone with read access to `data.json` *and* your vault id can recover the password. If this is unacceptable, use magic-link auth (no password stored at all) or a self-hosted Obsidian setup with disk encryption.
- **Personal Access Tokens are never persisted.** The wizard accepts a PAT just-in-time and discards it as soon as the steps complete.
- **Diagnostics are redacted before clipboard.** URLs are reduced to host+path; keys/tokens are masked. Inspect the output before sharing in an issue.
- **No telemetry.** The plugin makes no outbound requests other than to the Supabase projects you configure.

## Migration from v1.x

v1 settings are migrated automatically on first load:

- Old top-level fields (`supabaseUrl`, `supabaseAnonKey`, `email`, `password`, `vaultId`, etc.) are wrapped into a new `projects[0]` entry labelled "Project 1".
- A random `routing.hashSalt` is generated.
- The password (if any) is moved out of `data.json` and re-stored as an obfuscated `passwordEncrypted` field.
- Behavior is unchanged with a single project — `N=1` sharding routes every file to the same project, so no rebalance is needed.

To opt into multi-project sharding, add a second project in settings and run **Rebalance projects**.

## Development

```bash
git clone https://github.com/brianstm/obsidian-supabase-jump.git
cd obsidian-supabase-jump
npm install
npm run dev      # watch + rebuild
npm run build    # tsc --noEmit && esbuild production
npm run lint
```

### Project structure

```
src/
├── main.ts                 Plugin entry, command/event wiring, host bindings
├── settings.ts             Settings types, defaults, helpers, settings tab UI
├── migration.ts            v1 → v2 settings migration
├── routing.ts              Stable FNV-1a hashing for shardFor()
├── secret-storage.ts       At-rest password obfuscation
├── project-client-pool.ts  Multi-project Supabase client lifecycle + auth
├── realtime-supervisor.ts  Adaptive realtime reconnect with debounced Notices
├── sync.ts                 Push/pull/full-sync/realtime-event handling
├── realtime-crdt.ts        Per-file Yjs broadcast over supervised channels
├── setup-wizard.ts         Wizard modal: labelled SQL steps + auth + verify
├── log-panel.ts            In-app log buffer viewer
├── rebalance.ts            Resumable cross-project rebalance task
├── logger.ts               Ring buffer + redacted diagnostics export
└── frontmatter.ts          YAML frontmatter parser
```

## License

MIT — see [LICENSE](LICENSE)

## Support

- **Issues & feature requests:** [GitHub Issues](https://github.com/brianstm/obsidian-supabase-jump/issues)
- Include the output of **Copy diagnostics to clipboard** with bug reports.

## Acknowledgments

Built with [Obsidian Plugin API](https://docs.obsidian.md), [Supabase](https://supabase.com), [supabase-js](https://github.com/supabase/supabase-js), and [Yjs](https://github.com/yjs/yjs).

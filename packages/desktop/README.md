# Prime Agent Desktop

Electron desktop client for Prime Agent.

## Syncing the Fork

The repository includes a script that synchronizes the GitHub fork and local `main` branch with
[`PrimeIntellect-ai/prime-agent`](https://github.com/PrimeIntellect-ai/prime-agent). Run it from the repository root with a clean worktree and an authenticated GitHub CLI:

```bash
gh auth status
./scripts/sync-upstream.sh
```

This updates the fork's `main` branch on GitHub and fast-forwards the local `main` branch. It does not change the current feature branch.

To also merge the refreshed `main` branch into the current feature branch:

```bash
./scripts/sync-upstream.sh --merge-current
```

Use `./scripts/sync-upstream.sh --help` to view the available options.

## Running the App

Run the desktop app in development mode from the repository root:

```bash
npm run dev --workspace @earendil-works/pi-desktop
```

After creating an unpacked Linux application, run it from the repository root with:

```bash
PRIME_AGENT_DESKTOP_CWD="$PWD" ./packages/desktop/dist/linux-unpacked/prime-agent
```

`PRIME_AGENT_DESKTOP_CWD` selects the repository used by new desktop sessions. Packaged macOS and Windows applications can be launched from their corresponding directories under `packages/desktop/dist/`.

## Packaging

Run packaging commands from the repository root:

```bash
# Create an unpacked application for local inspection.
npm run package --workspace @earendil-works/pi-desktop

# Create installers for the current host platform.
npm run dist --workspace @earendil-works/pi-desktop
```

Artifacts are written to `packages/desktop/dist/`. The package includes the compiled Prime Agent daemon entrypoint under the application's resources directory.

macOS and Windows artifacts are unsigned unless the corresponding signing credentials are configured in the environment.

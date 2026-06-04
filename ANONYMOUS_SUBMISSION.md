# Anonymous submission notes

This repository is intended for **double-blind review artifact upload**.

- Do **not** link this repo from a non-anonymous project page until de-anonymization.
- Create the GitHub repository under a **neutral name** (e.g. `dls-browser-streaming-artifact`).
- Use a **generic** GitHub account display name; avoid author names in commits if the venue requires it.
- Set commit author for this repo only:

```bash
git config user.name "Anonymous Artifact"
git config user.email "noreply@anonymous.invalid"
```

- Replace placeholder URLs in `overlay/config/experiment_matrix.json` via environment variables before running (see README).
- Raw trial CSV/JSON outputs are **not** included (size + de-identification). The harness reproduces measurements on your infrastructure.

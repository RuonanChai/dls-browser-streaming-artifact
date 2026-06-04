# Push to GitHub (anonymous account)

Use a **neutral repository name**, e.g. `dls-browser-streaming-artifact`.

## 1. Create empty repo on GitHub

Log in to the anonymous GitHub account, create a **new private or public** repository:

- Name: `dls-browser-streaming-artifact`
- Do **not** initialize with README (this repo already has one)

## 2. Push from this machine

```bash
cd d:/Program/spark-main/dls-anonymous-artifact

# Anonymous commit identity (repo-local only)
git config user.name "Anonymous Artifact"
git config user.email "noreply@anonymous.invalid"

git branch -M main
git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/dls-browser-streaming-artifact.git
git push -u origin main
```

Replace `<YOUR_GITHUB_USERNAME>` with the username for the anonymous account (not necessarily the email address).

## 3. Paper submission

Submit only:

```
https://github.com/<YOUR_GITHUB_USERNAME>/dls-browser-streaming-artifact
```

Do not link author homepages until de-anonymization.

## Optional: GitHub CLI

If `gh` is installed and logged into the anonymous account:

```bash
gh auth login
gh repo create dls-browser-streaming-artifact --private --source=. --remote=origin --push
```

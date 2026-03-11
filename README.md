# How to install?

1. Copy (or symlink) the entire obsidian-git-deeplink folder into your vault's plugins directory: `<your-vault>/.obsidian/plugins/git-deeplink/`

2. Open Obsidian → Settings → Community Plugins → enable Git DeepLink.

# How to use?

1. Move the cursor to the place in the file you want to link to (Git DeepLink will try to link to the closest block or heading).
2. Right-click and click "Copy Git DeepLink" in the context menu
3. The link will be copied to your clipboard. You can now use is as a regular link a webpage or any other place that supports hyperlinks.
4. Once the link is clicked, it will:
    - Open Obisidian
    - Select the correct Obisidian Vault
    - Check if the worktree is clean. If not, stash the changes.
    - Checkout the correct branch and update it with the latest changes from origin (`git pull origin`).
    - Wait for Obsidian to index the file.
    - Open the file at the correct location.
    - As a fallback, if the Vault is not backed by git, try to open the file directly.

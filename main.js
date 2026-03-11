const { Plugin, Notice, FuzzySuggestModal } = require("obsidian");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Execute a Git command in the given working directory.
 * Returns a Promise that resolves with stdout or rejects with the error message.
 */
function execGit(cmd, cwd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(stderr ? stderr.trim() : error.message);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Poll until a file shows up in the vault (after a branch switch), or until timeout.
 * Returns a Promise that resolves to true (found) or false (timed out).
 */
function waitForFile(app, filePath, intervalMs = 300, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (app.vault.getAbstractFileByPath(filePath)) {
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        resolve(false);
      } else {
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
}

// ══════════════════════════════════════════════════════════════════════
//  Branch picker modal (fuzzy-searchable list)
// ══════════════════════════════════════════════════════════════════════
class BranchSuggestModal extends FuzzySuggestModal {
  constructor(app, branches, onChoose) {
    super(app);
    this.branches = branches;
    this.onChoose = onChoose;
    this.resolved = false;
    this.setPlaceholder("Type to search branches…");
  }

  getItems() {
    return this.branches;
  }

  getItemText(item) {
    return `${item.display}  [${item.type}]`;
  }

  onChooseItem(item) {
    this.resolved = true;
    this.onChoose(item);
  }

  onClose() {
    // If the user dismissed without picking, resolve with null
    if (!this.resolved) {
      this.onChoose(null);
    }
  }
}

class GitDeepLinkPlugin extends Plugin {
  onload() {
    // ── Status bar item for progress feedback ─────────────────────────
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.style.display = "none";

    // ── Feature 1: URI Handler ────────────────────────────────────────
    this.registerObsidianProtocolHandler("git-deeplink", async (params) => {
      await this.handleDeepLink(params);
    });

    // ── Feature 2: "Copy Git DeepLink" command ────────────────────────
    this.addCommand({
      id: "copy-git-deeplink",
      name: "Copy Git DeepLink",
      editorCallback: async (editor, view) => {
        await this.copyDeepLink(editor, view);
      },
    });

    // Also add it to the right-click editor context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        menu.addItem((item) => {
          item
            .setTitle("Copy Git DeepLink")
            .setIcon("link")
            .onClick(async () => {
              await this.copyDeepLink(editor, view);
            });
        });
      })
    );

    // ── Feature 3: "Git: Checkout branch" command ──────────────────────
    this.addCommand({
      id: "git-checkout-branch",
      name: "Git: Checkout branch",
      callback: async () => {
        await this.checkoutBranchFromPalette();
      },
    });
  }

  // ── Status bar helpers ──────────────────────────────────────────────
  setStatus(text) {
    this.statusBarItem.setText(text);
    this.statusBarItem.style.display = "";
  }

  clearStatus() {
    this.statusBarItem.setText("");
    this.statusBarItem.style.display = "none";
  }

  // ── Logging helper ─────────────────────────────────────────────────
  logToFile(level, message, extra) {
    try {
      const pluginDir = path.join(
        this.app.vault.adapter.getBasePath(),
        this.app.vault.configDir,
        "plugins",
        this.manifest.id
      );
      const logPath = path.join(pluginDir, "git-deeplink.log");
      const timestamp = new Date().toISOString();
      let line = `[${timestamp}] [${level}] ${message}`;
      if (extra !== undefined) {
        line += `\n  ` + String(extra).split("\n").join("\n  ");
      }
      line += "\n";
      fs.appendFileSync(logPath, line, "utf-8");
    } catch (_) {
      // Logging must never break the plugin
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  Feature 1 — Handle incoming obsidian://git-deeplink?… URIs
  // ════════════════════════════════════════════════════════════════════
  async handleDeepLink(params) {
    const { vault, branch, file, anchor } = params;

    this.logToFile("INFO", `Deep link received`, `params: vault=${vault}, branch=${branch}, file=${file}, anchor=${anchor}`);

    // --- Validate required params ---
    if (!vault || !file) {
      this.logToFile("ERROR", "Missing required parameters (vault, file)", JSON.stringify(params));
      new Notice("Git DeepLink: Missing required parameters (vault, file).", 8000);
      return;
    }

    // --- Validate vault ---
    const currentVault = this.app.vault.getName();
    if (currentVault !== vault) {
      this.logToFile("ERROR", `Vault mismatch: expected "${vault}", got "${currentVault}"`);
      new Notice(
        `Git DeepLink: Vault mismatch.\nExpected "${vault}", but the open vault is "${currentVault}".`,
        8000
      );
      return;
    }

    const basePath = this.app.vault.adapter.getBasePath();

    // --- Detect whether the vault is backed by a Git repository ---
    let isGitRepo = false;
    try {
      await execGit("git rev-parse --is-inside-work-tree", basePath);
      isGitRepo = true;
    } catch (_) {
      isGitRepo = false;
    }

    if (isGitRepo) {
      if (!branch) {
        this.logToFile("ERROR", "Vault is a Git repository but no branch was specified", JSON.stringify(params));
        new Notice("Git DeepLink: This vault is Git-backed but no branch was specified in the link.", 8000);
        return;
      }

      try {
        // 1. Check for dirty working tree
        this.setStatus("🔗 Checking working tree…");
        const status = await execGit("git status --porcelain", basePath);
        if (status.length > 0) {
          const timestamp = new Date().toLocaleString();
          this.setStatus("🔗 Stashing changes…");
          new Notice("Git DeepLink: Working tree is dirty — stashing changes…", 5000);
          await execGit(`git stash push -m "git-deeplink auto-stash ${timestamp}"`, basePath);
        }

        // 2. Fetch latest from origin
        this.setStatus("🔗 Fetching from origin… (1/3)");
        await execGit("git fetch origin", basePath);

        // 3. Checkout target branch
        this.setStatus(`🔗 Checking out ${branch}… (2/3)`);
        await execGit(`git checkout ${branch}`, basePath);

        // 4. Pull latest changes
        this.setStatus(`🔗 Pulling ${branch}… (3/3)`);
        await execGit(`git pull origin ${branch}`, basePath);
      } catch (err) {
        this.clearStatus();
        this.logToFile("ERROR", "Git command failed during deep link flow", err);
        new Notice(`Git DeepLink Error:\n${err}`, 10000);
        return;
      }

      // 5. Wait for Obsidian to re-index the file system after the branch switch
      this.setStatus("🔗 Waiting for vault to re-index…");
      const found = await waitForFile(this.app, file);
      if (!found) {
        this.clearStatus();
        this.logToFile("ERROR", `Timed out waiting for file "${file}" to appear after branch switch`);
        new Notice(
          `Git DeepLink: Timed out waiting for file "${file}" to appear after branch switch.`,
          8000
        );
        return;
      }
    } else {
      this.logToFile("INFO", "Vault is not a Git repository — skipping Git operations, opening file directly");
    }

    // 6. Open the file at the heading / block anchor
    this.setStatus("🔗 Opening file…");
    const linkText = anchor ? `${file}#${anchor}` : file;
    await this.app.workspace.openLinkText(linkText, "", true);
    this.clearStatus();
    this.logToFile("INFO", `Deep link flow completed successfully`, `branch=${branch}, file=${file}, anchor=${anchor}`);
  }

  // ════════════════════════════════════════════════════════════════════
  //  Feature 2 — Copy a Git DeepLink for the current cursor position
  // ════════════════════════════════════════════════════════════════════
  async copyDeepLink(editor, view) {
    const file = view.file;
    if (!file) {
      new Notice("Git DeepLink: No active file.", 5000);
      return;
    }

    const basePath = this.app.vault.adapter.getBasePath();
    let branch = null;

    try {
      branch = await execGit("git rev-parse --abbrev-ref HEAD", basePath);
    } catch (_) {
      // Not a git repo — branch will remain null
      this.logToFile("INFO", "Vault is not a Git repository — generating link without branch");
    }

    // --- Determine anchor (heading or block ID) ---
    const cursor = editor.getCursor();
    const currentLineText = editor.getLine(cursor.line);
    let anchor = "";

    // Check if the current line has a block ID (e.g. ^task-123)
    const blockIdMatch = currentLineText.match(/\^([\w-]+)\s*$/);
    if (blockIdMatch) {
      anchor = "^" + blockIdMatch[1];
    } else {
      // Walk upward to find the nearest heading
      for (let i = cursor.line; i >= 0; i--) {
        const line = editor.getLine(i);
        const headingMatch = line.match(/^#{1,6}\s+(.+)/);
        if (headingMatch) {
          anchor = headingMatch[1].trim();
          break;
        }
      }
    }

    // --- Build the URL ---
    const vaultName = this.app.vault.getName();
    const filePath = file.path;

    const url =
      `obsidian://git-deeplink` +
      `?vault=${encodeURIComponent(vaultName)}` +
      (branch ? `&branch=${encodeURIComponent(branch)}` : "") +
      `&file=${encodeURIComponent(filePath)}` +
      (anchor ? `&anchor=${encodeURIComponent(anchor)}` : "");

    // --- Copy to clipboard ---
    try {
      await navigator.clipboard.writeText(url);
      new Notice("Git DeepLink copied to clipboard!", 4000);
    } catch (err) {
      this.logToFile("ERROR", "Failed to copy to clipboard", err);
      new Notice(`Git DeepLink: Failed to copy to clipboard.\n${err}`, 8000);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  Feature 3 — Interactive branch checkout from command palette
  // ════════════════════════════════════════════════════════════════════
  async checkoutBranchFromPalette() {
    const basePath = this.app.vault.adapter.getBasePath();

    // 1. Verify this is a Git repository
    try {
      await execGit("git rev-parse --is-inside-work-tree", basePath);
    } catch (_) {
      new Notice("Git: This vault is not a Git repository.", 8000);
      return;
    }

    // 2. Fetch all remotes so the list is up-to-date
    this.setStatus("🌿 Fetching remotes…");
    try {
      await execGit("git fetch --all --prune", basePath);
    } catch (err) {
      this.clearStatus();
      this.logToFile("ERROR", "git fetch --all --prune failed", err);
      new Notice(`Git: Failed to fetch remotes.\n${err}`, 8000);
      return;
    }

    // 3. Collect local branches
    let localRaw = "";
    try {
      localRaw = await execGit("git branch --format=%(refname:short)", basePath);
    } catch (err) {
      this.clearStatus();
      this.logToFile("ERROR", "Failed to list local branches", err);
      new Notice(`Git: Failed to list local branches.\n${err}`, 8000);
      return;
    }

    // 4. Collect remote branches
    let remoteRaw = "";
    try {
      remoteRaw = await execGit("git branch -r --format=%(refname:short)", basePath);
    } catch (err) {
      this.clearStatus();
      this.logToFile("ERROR", "Failed to list remote branches", err);
      new Notice(`Git: Failed to list remote branches.\n${err}`, 8000);
      return;
    }

    this.clearStatus();

    const localBranches = localRaw
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);

    const localSet = new Set(localBranches);

    const remoteBranches = remoteRaw
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean)
      .filter((b) => !b.endsWith("/HEAD"));

    const items = [];

    // Add local branches
    for (const b of localBranches) {
      items.push({ display: b, ref: b, type: "local" });
    }

    // Add remote branches that don't already exist locally
    for (const b of remoteBranches) {
      // b is like "origin/feature-x"
      const shortName = b.replace(/^[^/]+\//, ""); // strip remote prefix
      if (!localSet.has(shortName)) {
        items.push({ display: b, ref: b, type: "remote" });
      }
    }

    if (items.length === 0) {
      new Notice("Git: No branches found.", 5000);
      return;
    }

    // 5. Open the fuzzy-search modal and wait for the user's choice
    const chosen = await new Promise((resolve) => {
      new BranchSuggestModal(this.app, items, resolve).open();
    });

    if (!chosen) {
      // User dismissed the modal
      return;
    }

    // 6. Checkout the selected branch
    this.setStatus(`🌿 Checking out ${chosen.display}…`);
    try {
      if (chosen.type === "local") {
        await execGit(`git checkout ${chosen.ref}`, basePath);
      } else {
        // Remote branch → create a local tracking branch
        const localName = chosen.ref.replace(/^[^/]+\//, "");
        await execGit(`git checkout -b ${localName} ${chosen.ref}`, basePath);
      }
      this.clearStatus();
      new Notice(`Git: Switched to ${chosen.display}`, 4000);
      this.logToFile("INFO", `Checked out branch: ${chosen.display} (${chosen.type})`);
    } catch (err) {
      this.clearStatus();
      this.logToFile("ERROR", `Checkout failed for ${chosen.display}`, err);
      new Notice(`Git: Checkout failed.\n${err}`, 10000);
    }
  }
}

module.exports = GitDeepLinkPlugin;

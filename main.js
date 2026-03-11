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
//  Branch picker modal (fuzzy-searchable list with async loading)
// ══════════════════════════════════════════════════════════════════════
class BranchSuggestModal extends FuzzySuggestModal {
  constructor(app, branches, onChoose) {
    super(app);
    this.branches = branches;
    this.onChoose = onChoose;
    this.resolved = false;
    this.loading = true;
    this.setPlaceholder("Loading branches…");
  }

  getItems() {
    if (this.loading && this.branches.length === 0) {
      // Return a disabled sentinel item while loading with no branches yet
      return [{ display: "Loading branches…", ref: null, type: "loading" }];
    }
    return this.branches;
  }

  getItemText(item) {
    if (item.type === "loading") return item.display;
    return `${item.display}  [${item.type}]`;
  }

  onChooseItem(item) {
    if (item.type === "loading") return; // ignore clicks on the loading sentinel
    this.resolved = true;
    this.onChoose(item);
  }

  onClose() {
    // onClose fires BEFORE onChooseItem in Obsidian, so we defer
    // the dismissal check to give onChooseItem a chance to run first.
    setTimeout(() => {
      if (!this.resolved) {
        this.onChoose(null);
      }
    }, 50);
  }

  /**
   * Replace the branch list and refresh the rendered suggestions.
   */
  updateBranches(branches, loading) {
    this.branches = branches;
    this.loading = loading;
    if (!loading) {
      this.setPlaceholder("Type to search branches…");
    }
    // Re-render the suggestion list so the user sees the update immediately.
    // FuzzySuggestModal stores the current query in this.inputEl.
    this.updateSuggestions();
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
      id: "git-deeplink-checkout-branch",
      name: "Checkout branch",
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

  // ── Refresh obsidian-git status after branch changes ───────────────
  // obsidian-git only updates its branch status bar in response to its
  // own operations.  After we checkout a branch externally we need to
  // poke it so the UI stays in sync.
  async refreshObsidianGit() {
    try {
      const obsidianGit = this.app.plugins?.getPlugin("obsidian-git");
      if (!obsidianGit) return;

      // Update the branch name shown in the status bar
      await obsidianGit.branchBar?.display();

      // Ask obsidian-git to do a full refresh (source-control view,
      // cached status, etc.).
      this.app.workspace.trigger("obsidian-git:refresh");

      this.logToFile("DEBUG", "Triggered obsidian-git status refresh");
    } catch (err) {
      // Never let a cosmetic refresh break the main flow
      this.logToFile("WARN", "Failed to refresh obsidian-git status", err);
    }
  }

  // ── Git execution helper ────────────────────────────────────────────
  // Prefer obsidian-git plugin's gitManager when available (handles
  // credentials, SSH keys, GPG, etc.), otherwise fall back to direct CLI.
  async runGit(args) {
    const obsidianGit = this.app.plugins?.getPlugin("obsidian-git");
    if (obsidianGit?.gitManager?.git) {
      this.logToFile("DEBUG", `runGit via obsidian-git: git ${args.join(" ")}`);
      const result = await obsidianGit.gitManager.git.raw(args);
      return (result || "").trim();
    }
    // Fallback: shell out directly
    const basePath = this.app.vault.adapter.getBasePath();
    const cmd = "git " + args.join(" ");
    this.logToFile("DEBUG", `runGit via CLI: ${cmd}`);
    return execGit(cmd, basePath);
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

    // --- Detect whether the vault is backed by a Git repository ---
    let isGitRepo = false;
    try {
      await this.runGit(["rev-parse", "--is-inside-work-tree"]);
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
        const status = await this.runGit(["status", "--porcelain"]);
        if (status.length > 0) {
          const timestamp = new Date().toLocaleString();
          this.setStatus("🔗 Stashing changes…");
          new Notice("Git DeepLink: Working tree is dirty — stashing changes…", 5000);
          await this.runGit(["stash", "push", "-m", `git-deeplink auto-stash ${timestamp}`]);
        }

        // 2. Fetch latest from origin
        this.setStatus("🔗 Fetching from origin… (1/3)");
        await this.runGit(["fetch", "origin"]);

        // 3. Checkout target branch
        this.setStatus(`🔗 Checking out ${branch}… (2/3)`);
        await this.runGit(["checkout", branch]);

        // 4. Pull latest changes
        this.setStatus(`🔗 Pulling ${branch}… (3/3)`);
        await this.runGit(["pull", "origin", branch]);

        // Refresh obsidian-git so its status bar shows the new branch
        await this.refreshObsidianGit();
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

    let branch = null;

    try {
      branch = await this.runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
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
    // 1. Verify this is a Git repository
    try {
      await this.runGit(["rev-parse", "--is-inside-work-tree"]);
    } catch (_) {
      new Notice("Git: This vault is not a Git repository.", 8000);
      return;
    }

    // 2. Collect local branches immediately (fast, no network)
    let localItems = [];
    try {
      const localRaw = await this.runGit(["branch", "--format=%(refname:short)"]);
      const localBranches = localRaw.split("\n").map((b) => b.trim()).filter(Boolean);
      localItems = localBranches.map((b) => ({ display: b, ref: b, type: "local" }));
    } catch (err) {
      this.logToFile("ERROR", "Failed to list local branches", err);
      new Notice(`Git: Failed to list local branches.\n${err}`, 8000);
      return;
    }

    // Also grab cached remote branches (from the last fetch, no network call)
    let cachedRemoteItems = [];
    try {
      const remoteRaw = await this.runGit(["branch", "-r", "--format=%(refname:strip=2)"]);
      const localSet = new Set(localItems.map((i) => i.display));
      cachedRemoteItems = remoteRaw
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean)
        .filter((b) => !b.endsWith("/HEAD"))
        .filter((b) => !localSet.has(b.replace(/^[^/]+\//, "")))
        .map((b) => ({ display: b, ref: b, type: "remote" }));
    } catch (err) {
      this.logToFile("WARN", "Failed to list cached remote branches", err);
    }

    // 3. Open the modal immediately with whatever we have
    const modal = new BranchSuggestModal(
      this.app,
      [...localItems, ...cachedRemoteItems],
      null // onChoose will be set via the promise below
    );

    const chosenPromise = new Promise((resolve) => {
      modal.onChoose = resolve;
    });

    modal.open();

    // 4. Fetch all remotes in the background and refresh the list
    this.setStatus("🌿 Fetching remotes…");
    (async () => {
      try {
        await this.runGit(["fetch", "--all", "--prune"]);

        // Re-collect branches after fetch
        const [freshLocalRaw, freshRemoteRaw] = await Promise.all([
          this.runGit(["branch", "--format=%(refname:short)"]),
          this.runGit(["branch", "-r", "--format=%(refname:strip=2)"]),
        ]);

        const freshLocalBranches = freshLocalRaw.split("\n").map((b) => b.trim()).filter(Boolean);
        const freshLocalSet = new Set(freshLocalBranches);

        const freshRemoteBranches = freshRemoteRaw
          .split("\n")
          .map((b) => b.trim())
          .filter(Boolean)
          .filter((b) => !b.endsWith("/HEAD"));

        const freshItems = [];
        for (const b of freshLocalBranches) {
          freshItems.push({ display: b, ref: b, type: "local" });
        }
        for (const b of freshRemoteBranches) {
          const shortName = b.replace(/^[^/]+\//, "");
          if (!freshLocalSet.has(shortName)) {
            freshItems.push({ display: b, ref: b, type: "remote" });
          }
        }

        modal.updateBranches(freshItems, false);
      } catch (err) {
        this.logToFile("WARN", "Background fetch failed, keeping cached branch list", err);
        // Mark loading as done even if fetch failed — the cached list is still usable
        modal.updateBranches(modal.branches, false);
      } finally {
        this.clearStatus();
      }
    })();

    // 5. Wait for the user's choice
    const chosen = await chosenPromise;

    if (!chosen) {
      // User dismissed the modal
      return;
    }

    // 6. Checkout the selected branch
    this.setStatus(`🌿 Checking out ${chosen.display}…`);
    try {
      if (chosen.type === "local") {
        await this.runGit(["checkout", chosen.ref]);
      } else {
        // Remote branch → create a local tracking branch
        const localName = chosen.ref.replace(/^[^/]+\//, "");
        await this.runGit(["checkout", "-b", localName, chosen.ref]);
      }
      this.clearStatus();
      new Notice(`Git: Switched to ${chosen.display}`, 4000);
      this.logToFile("INFO", `Checked out branch: ${chosen.display} (${chosen.type})`);

      // Refresh obsidian-git so its status bar shows the new branch
      await this.refreshObsidianGit();
    } catch (err) {
      this.clearStatus();
      this.logToFile("ERROR", `Checkout failed for ${chosen.display}`, err);
      new Notice(`Git: Checkout failed.\n${err}`, 10000);
    }
  }
}

module.exports = GitDeepLinkPlugin;

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_REMEMBERED_TASKS = 2000;

function readJsonSafe(filePath) {
  try {
    if (!filePath || !existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveDataDir(explicitDir) {
  const candidates = [
    explicitDir,
    process.env.XYQ_AUTH_DIR || null,
  ].filter(Boolean);
  if (candidates.length === 0) return null;
  for (const dir of candidates) {
    if (
      existsSync(join(dir, "plugin-auth.json")) ||
      existsSync(join(dir, "plugins.json")) ||
      existsSync(join(dir, "logins.json")) ||
      existsSync(join(dir, "providers.json"))
    ) {
      return dir;
    }
  }
  return candidates[0];
}

function resolveOpenCodeAuthFallback() {
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdgData, "opencode", "auth.json");
}

function computeKeyHint(entry) {
  const raw = String(entry?.key || entry?.access || "").trim();
  if (!raw) return "";

  // If raw is JSON (session export or browser-credential.json), extract inner token for last-4 hint
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      const tokenCandidate =
        parsed?.access_key ??
        parsed?.accessKey ??
        parsed?.token ??
        parsed?.data?.access_key ??
        null;
      if (typeof tokenCandidate === "string" && tokenCandidate.trim().length >= 8) {
        return `····${tokenCandidate.trim().slice(-4)}`;
      }
      const cookieArr = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.cookies)
        ? parsed.cookies
        : Array.isArray(parsed?.data?.cookies)
        ? parsed.data.cookies
        : null;
      if (cookieArr) {
        const sess =
          cookieArr.find((c) => c && (c.name === "sessionid" || c.name === "sid_tt") && c.value) ??
          cookieArr.find((c) => c && typeof c.value === "string" && c.value.length >= 8);
        if (sess && String(sess.value).trim().length >= 8) {
          return `····${String(sess.value).trim().slice(-4)}`;
        }
      }
    } catch {
      // Fall through
    }
    return "";
  }

  // If raw looks like a Cookie header, prefer sessionid/sid_tt last-4
  const sessMatch = raw.match(/\b(?:sessionid|sid_tt)\s*=\s*([^;\s]+)/i);
  if (sessMatch && sessMatch[1].length >= 8) {
    return `····${sessMatch[1].slice(-4)}`;
  }

  const cleaned = raw.replace(/^(?:Authorization\s*:\s*)?Bearer\s+/i, "").trim();
  return cleaned.length >= 8 ? `····${cleaned.slice(-4)}` : "";
}

function fingerprintEntry(entry) {
  return createHash("sha256")
    .update(JSON.stringify(entry ?? {}))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Shared Magpie multi-account pool reader for plugin tools.
 *
 * Reads `<dataDir>/plugin-auth.json`, `logins.json`, and `providers.json` on demand
 * because Magpie's `runTool` executes outside `inScope()` (where `client.auth.get`
 * returns `{ data: undefined }` and `auth.loader` is never invoked).
 */
export class MagpieAccountPool {
  constructor({
    providerId,
    defaultDirectory,
    clientAuth,
    legacyOptions,
    createClientFromSaved,
    createLegacyClient,
  }) {
    this.providerId = providerId;
    this.magpieProviderKey = `plugin:${providerId}`;
    this.defaultDir = defaultDirectory || null;
    this.clientAuth = clientAuth || null;
    this.legacyOptions = legacyOptions ?? {};
    this.createClientFromSaved = createClientFromSaved;
    this.createLegacyClient = createLegacyClient;

    this._slotClients = new Map(); // slot -> { fingerprint, client }
    this._legacyClient = null;
    this._taskSlotMap = new Map(); // taskId -> slot
  }

  rememberTask(taskId, slot) {
    if (!taskId || !slot) return;
    const key = String(taskId);
    if (this._taskSlotMap.has(key)) {
      this._taskSlotMap.delete(key);
    } else if (this._taskSlotMap.size >= MAX_REMEMBERED_TASKS) {
      const oldest = this._taskSlotMap.keys().next().value;
      if (oldest !== undefined) {
        this._taskSlotMap.delete(oldest);
      }
    }
    this._taskSlotMap.set(key, slot);
  }

  listAccounts(runtimeDir) {
    const dataDir = resolveDataDir(runtimeDir || this.defaultDir);
    if (!dataDir) return [];
    const authJson =
      readJsonSafe(join(dataDir, "plugin-auth.json")) ??
      readJsonSafe(resolveOpenCodeAuthFallback()) ??
      {};
    const loginsJson = readJsonSafe(join(dataDir, "logins.json"));
    const providersJson = readJsonSafe(join(dataDir, "providers.json")) ?? {};

    // Support both Magpie's real `{ providers: [{ id: "xiaoyunque", ... }] }` schema
    // and direct keyed `{ "plugin:xiaoyunque": { ... } }` maps.
    const providerRow = Array.isArray(providersJson?.providers)
      ? providersJson.providers.find(
          (p) =>
            p &&
            (p.id === this.providerId ||
              p.id === this.magpieProviderKey ||
              p.id === `${this.providerId}-plugin`)
        )
      : null;
    const providerCfg =
      providerRow ??
      providersJson[this.magpieProviderKey] ??
      providersJson[this.providerId] ??
      {};
    if (providerCfg.off === true) return [];

    const aliases =
      providerCfg.accountNames && typeof providerCfg.accountNames === "object"
        ? providerCfg.accountNames
        : {};
    // Support both Magpie's real top-level array `[{ agent: "plugin:xiaoyunque", home, user, first, active, on }]`
    // and keyed `{ "plugin:xiaoyunque": [...] }` fixtures.
    const loginEntries = Array.isArray(loginsJson)
      ? loginsJson.filter(
          (l) => l && (l.agent === this.magpieProviderKey || l.agent === this.providerId)
        )
      : Array.isArray(loginsJson?.[this.magpieProviderKey])
      ? loginsJson[this.magpieProviderKey]
      : [];

    const rawSlots = Object.entries(authJson)
      .filter(([k, v]) => (k === this.providerId || k.startsWith(`${this.providerId}#`)) && v && typeof v === "object")
      .sort(([a], [b]) =>
        a === this.providerId ? -1 : b === this.providerId ? 1 : a.localeCompare(b)
      );

    // Match Magpie's internal/plugin/providers.go#pluginNames disambiguation
    const baseUserBySlot = new Map();
    const counts = new Map();
    for (const [slot, entry] of rawSlots) {
      const base = String(
        entry.accountId || entry?.metadata?.email || entry.email || ""
      ).trim();
      baseUserBySlot.set(slot, base);
      if (base) {
        counts.set(base, (counts.get(base) || 0) + 1);
      }
    }

    const seen = new Map();
    const accounts = rawSlots.map(([slot, entry], index) => {
      const base = baseUserBySlot.get(slot) || "";
      let user = base;
      if (base && (counts.get(base) || 0) > 1) {
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        const tag = slot.includes("#") ? slot.split("#")[1] : String(n);
        user = `${base} (${tag})`;
      }

      const keyHint = computeKeyHint(entry);
      const alias =
        (user && (aliases[user] || aliases[user.toLowerCase()])) ||
        (base && (aliases[base] || aliases[base.toLowerCase()])) ||
        aliases[slot] ||
        aliases[slot.toLowerCase()] ||
        "";
      const loginMatch =
        loginEntries.find((l) => l && l.home && l.home === slot) ??
        loginEntries.find((l) => l && user && l.user === user) ??
        loginEntries.find((l) => l && l.user === slot) ??
        null;

      const enabled = loginMatch ? loginMatch.on !== false : true;
      const first = loginMatch
        ? Boolean(loginMatch.first || loginMatch.active)
        : index === 0 && loginEntries.length === 0;
      const orderIdx = loginMatch ? loginEntries.indexOf(loginMatch) : 1000 + index;

      return {
        slot,
        user,
        alias,
        label: alias || user || keyHint || slot,
        keyHint,
        enabled,
        first,
        orderIdx,
        entry,
      };
    });

    accounts.sort((a, b) => {
      if (a.first !== b.first) return a.first ? -1 : 1;
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.orderIdx - b.orderIdx;
    });

    return accounts;
  }

  resolve({ account, taskId, directory } = {}) {
    const accounts = this.listAccounts(directory);

    // 1. Explicit `account` selector
    if (account && String(account).trim()) {
      const q = String(account).trim();
      const qLower = q.toLowerCase();
      if (qLower === "options" || qLower === "legacy") {
        return {
          client: this._getLegacy(),
          slot: "options",
          label: "options",
          entry: null,
          setAuth: null,
          boundByTask: false,
        };
      }
      const qHintSuffix = qLower.replace(/^·+/, "");
      const matched = accounts.find(
        (a) =>
          a.slot === q ||
          a.slot.toLowerCase() === qLower ||
          (a.label && a.label.toLowerCase() === qLower) ||
          (a.user && a.user.toLowerCase() === qLower) ||
          (a.alias && a.alias.toLowerCase() === qLower) ||
          (a.keyHint &&
            (a.keyHint.toLowerCase() === qLower ||
              (qHintSuffix.length >= 4 && a.keyHint.slice(-4).toLowerCase() === qHintSuffix)))
      );
      if (!matched) {
        const available = accounts.map((a) => `${a.label} (${a.slot})`).join(", ") || "无";
        throw new Error(
          `未找到指定的小云雀账号 "${q}"。当前供应商页面已配置账号：${available}`
        );
      }
      return this._materialize(matched, { boundByTask: false });
    }

    // 2. Sticky slot bound to an in-flight taskId / runId
    if (taskId && this._taskSlotMap.has(String(taskId))) {
      const rememberedSlot = this._taskSlotMap.get(String(taskId));
      if (rememberedSlot === "options") {
        return {
          client: this._getLegacy(),
          slot: "options",
          label: "options",
          entry: null,
          setAuth: null,
          boundByTask: true,
        };
      }
      const hit = accounts.find((a) => a.slot === rememberedSlot);
      if (hit) {
        return this._materialize(hit, { boundByTask: true });
      }
    }

    // 3. Top enabled account on Magpie's Providers page
    const active = accounts.find((a) => a.enabled);
    if (active) {
      return this._materialize(active, { boundByTask: false });
    }

    // 4. Seamless fallback to plugins.json options / env vars when no enabled UI account exists
    return {
      client: this._getLegacy(),
      slot: "options",
      label: "options",
      entry: null,
      setAuth: null,
      boundByTask: false,
    };
  }

  /**
   * Lists remaining enabled accounts (plus legacy options if configured) to try
   * when an unbound `get_task` / `wait_task` / `cancel_task` encounters a task-not-found error.
   */
  listFallbackTargets(excludeSlot, runtimeDir) {
    const accounts = this.listAccounts(runtimeDir);
    const out = [];
    for (const acc of accounts) {
      if (acc.enabled && acc.slot !== excludeSlot) {
        out.push(this._materialize(acc, { boundByTask: false }));
      }
    }
    if (excludeSlot !== "options") {
      const legacy = this._getLegacy();
      if (typeof legacy?.hasCredentials === "function" && legacy.hasCredentials()) {
        out.push({
          client: legacy,
          slot: "options",
          label: "options",
          entry: null,
          setAuth: null,
          boundByTask: false,
        });
      }
    }
    return out;
  }

  materializeAccount(acc) {
    return this._materialize(acc, { boundByTask: false });
  }

  getLegacyClient() {
    return this._getLegacy();
  }

  _materialize(acc, { boundByTask = false } = {}) {
    const fp = fingerprintEntry(acc.entry);
    const cached = this._slotClients.get(acc.slot);
    if (cached && cached.fingerprint === fp) {
      return {
        client: cached.client,
        slot: acc.slot,
        label: acc.label,
        entry: acc.entry,
        setAuth: cached.setAuth,
        boundByTask,
      };
    }
    const setAuth = async (newBody) => {
      if (this.clientAuth?.set) {
        await this.clientAuth.set({ path: { id: acc.slot }, body: newBody });
      }
    };
    const client = this.createClientFromSaved(acc.entry, { slot: acc.slot, setAuth });
    this._slotClients.set(acc.slot, { fingerprint: fp, client, setAuth });
    return {
      client,
      slot: acc.slot,
      label: acc.label,
      entry: acc.entry,
      setAuth,
      boundByTask,
    };
  }

  _getLegacy() {
    if (!this._legacyClient) {
      this._legacyClient = this.createLegacyClient(this.legacyOptions);
    }
    return this._legacyClient;
  }
}

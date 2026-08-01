const CONTRACT_ADDRESS = "0xa611cdd4948233602353d6708a1f3edfa05b4ebf";
const CONTRACT_ABI = [
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function mint(address to, uint256 amount)",
  "function redeem(uint256 amount)",
  "function pause()",
  "function unpause()",
  "event PointsGiven(address indexed to, uint256 amount)",
  "event PointsRedeemed(address indexed customer, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// Rewards catalog is UI-only (off-chain business logic). Redeeming an item just
// calls the on-chain redeem(amount) with that item's point cost.
const REWARDS_MENU = [
  { id: "espresso",    name: "Espresso",         desc: "A single shot, straight up.",        cost: 30,  icon: "☕" },
  { id: "latte",       name: "Latte",            desc: "Espresso with steamed milk.",        cost: 50,  icon: "🥛" },
  { id: "cappuccino",  name: "Cappuccino",       desc: "Equal parts espresso, milk, foam.",  cost: 80,  icon: "🫧" },
  { id: "croissant",   name: "Croissant",        desc: "Buttery, flaky, fresh baked.",        cost: 60,  icon: "🥐" },
  { id: "combo",       name: "Coffee + Pastry",  desc: "Any drink with a croissant.",         cost: 120, icon: "🎁" },
];

const iface = new ethers.Interface(CONTRACT_ABI);

// How far back (in blocks) to search when loading history. Public RPC endpoints
// often refuse eth_getLogs over very large ranges, so we look back a bounded
// window instead of scanning from block 0. ~50,000 blocks is roughly a week on
// most testnets — raise it if you need older history and your RPC allows it.
const LOG_LOOKBACK_BLOCKS = 50000;

function loyaltyApp() {
  return {
    connected: false,
    account: null,
    isOwner: false,
    paused: false,
    balance: "0",
    mintTo: "",
    mintAmount: "",
    redeemAmount: "",
    minting: false,
    pausing: false,
    redeeming: false,
    mintStatus: { type: "", msg: "" },
    pauseStatus: { type: "", msg: "" },
    redeemStatus: { type: "", msg: "" },
    globalError: "",
    hasInjectedWallet: false,
    demoMode: false,

    // Rewards catalog state
    rewardsMenu: REWARDS_MENU,
    redeemingItemId: null,
    itemStatus: { type: "", msg: "" },
    lastReward: null,
    showCustom: false,

    // History state
    mintHistory: [],
    loadingMintHistory: false,
    redeemHistory: [],
    loadingRedeemHistory: false,

    async init() {
      this.hasInjectedWallet = Boolean(window.ethereum);
      if (!window.ethereum) {
        this.globalError = "No wallet detected. Open this page in a real browser (Chrome/Edge/Firefox/Brave) with the MetaMask extension installed — it will not work inside VS Code's Live Preview or any embedded webview.";
        return;
      }
      // Reconnect silently if already authorized, and react to account/chain changes without refresh
      window.ethereum.on("accountsChanged", () => this.connect());
      window.ethereum.on("chainChanged", () => window.location.reload());

      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      if (accounts.length > 0) await this.connect();
    },

    async connect() {
      this.globalError = "";
      if (!window.ethereum) {
        this.globalError = "No wallet detected. Open this page in a real browser (Chrome/Edge/Firefox/Brave) with the MetaMask extension installed — it will not work inside VS Code's Live Preview or any embedded webview.";
        return this.startDemo();
      }
      try {
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        if (!accounts.length) return this.disconnect();

        this.account = accounts[0];
        this.connected = true;
        this.demoMode = false;

        await this.loadState();
      } catch (err) {
        console.error(err);
        this.globalError = err?.message || "Failed to connect wallet. Check the browser console for details.";
        this.disconnect();
      }
    },

    startDemo() {
      this.connected = true;
      this.demoMode = true;
      this.account = "0x0000000000000000000000000000000000000000";
      this.isOwner = false;
      this.paused = false;
      this.balance = "0";
      this.globalError = "";
    },

    disconnect() {
      this.connected = false;
      this.account = null;
      this.isOwner = false;
      this.balance = "0";
      this.demoMode = false;
      this.lastReward = null;
    },

    // ---- Raw JSON-RPC helpers (bypass ethers Provider/Contract/Signer classes) ----
    async ethCall(fnName, args = []) {
      const data = iface.encodeFunctionData(fnName, args);
      const result = await window.ethereum.request({
        method: "eth_call",
        params: [{ to: CONTRACT_ADDRESS, data }, "latest"]
      });
      return iface.decodeFunctionResult(fnName, result);
    },

    async sendTx(fnName, args = []) {
      const data = iface.encodeFunctionData(fnName, args);
      const txHash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: this.account, to: CONTRACT_ADDRESS, data }]
      });
      return this.waitForReceipt(txHash);
    },

    async waitForReceipt(txHash) {
      for (;;) {
        const receipt = await window.ethereum.request({
          method: "eth_getTransactionReceipt",
          params: [txHash]
        });
        if (receipt) {
          if (receipt.status === "0x0") throw new Error("Transaction reverted.");
          return receipt;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    },

    // ---- History (reads past events straight off the chain — no backend/database needed) ----
    async getPastBlockRange() {
      const latestHex = await window.ethereum.request({ method: "eth_blockNumber" });
      const latest = parseInt(latestHex, 16);
      const from = Math.max(0, latest - LOG_LOOKBACK_BLOCKS);
      return { fromBlock: "0x" + from.toString(16), toBlock: latestHex };
    },

    async fetchLogs(eventName, filterValues = []) {
      const { fromBlock, toBlock } = await this.getPastBlockRange();
      const topics = iface.encodeFilterTopics(eventName, filterValues);
      const logs = await window.ethereum.request({
        method: "eth_getLogs",
        params: [{ address: CONTRACT_ADDRESS, fromBlock, toBlock, topics }]
      });
      return logs
        .map((log) => {
          try {
            const parsed = iface.parseLog({ topics: log.topics, data: log.data });
            return {
              args: parsed.args,
              blockNumber: parseInt(log.blockNumber, 16),
              txHash: log.transactionHash
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .reverse(); // most recent first
    },

    async loadMintHistory() {
      this.loadingMintHistory = true;
      try {
        const events = await this.fetchLogs("PointsGiven");
        this.mintHistory = events.map((e) => ({
          to: e.args.to,
          amount: e.args.amount.toString(),
          blockNumber: e.blockNumber,
          txHash: e.txHash
        }));
      } catch (err) {
        console.error("loadMintHistory failed:", err);
      } finally {
        this.loadingMintHistory = false;
      }
    },

    async loadRedeemHistory() {
      this.loadingRedeemHistory = true;
      try {
        const events = await this.fetchLogs("PointsRedeemed", [this.account]);
        this.redeemHistory = events.map((e) => {
          const amount = e.args.amount.toString();
          const item = REWARDS_MENU.find((m) => String(m.cost) === amount);
          return {
            amount,
            itemName: item ? item.name : "Custom redeem",
            itemIcon: item ? item.icon : "🔸",
            blockNumber: e.blockNumber,
            txHash: e.txHash
          };
        });
      } catch (err) {
        console.error("loadRedeemHistory failed:", err);
      } finally {
        this.loadingRedeemHistory = false;
      }
    },

    shortHash(h) {
      if (!h) return "";
      return h.slice(0, 8) + "..." + h.slice(-6);
    },

    async loadState() {
      const [ownerResult, pausedResult] = await Promise.all([
        this.ethCall("owner"),
        this.ethCall("paused")
      ]);
      this.isOwner = ownerResult[0].toLowerCase() === this.account.toLowerCase();
      this.paused = pausedResult[0];

      if (!this.isOwner) {
        const balResult = await this.ethCall("balanceOf", [this.account]);
        this.balance = balResult[0].toString();
        this.loadRedeemHistory();
      } else {
        this.loadMintHistory();
      }
    },

    async mintPoints() {
      this.mintStatus = { type: "pending", msg: "" };
      this.minting = true;
      try {
        this.mintStatus = { type: "pending", msg: "Transaction sent, waiting for confirmation..." };
        await this.sendTx("mint", [this.mintTo, this.mintAmount]);
        this.mintStatus = { type: "ok", msg: `Gave ${this.mintAmount} points to ${this.shortAddr(this.mintTo)}` };
        this.mintTo = "";
        this.mintAmount = "";
        this.loadMintHistory();
      } catch (err) {
        this.mintStatus = { type: "err", msg: this.parseError(err) };
      } finally {
        this.minting = false;
      }
    },

    async togglePause() {
      this.pauseStatus = { type: "pending", msg: "" };
      this.pausing = true;
      try {
        await this.sendTx(this.paused ? "unpause" : "pause");
        this.paused = !this.paused;
        this.pauseStatus = { type: "ok", msg: this.paused ? "Contract paused." : "Contract unpaused." };
      } catch (err) {
        this.pauseStatus = { type: "err", msg: this.parseError(err) };
      } finally {
        this.pausing = false;
      }
    },

    // Redeem points for a catalog item (e.g. a coffee or pastry). This is the
    // main customer flow — the item's cost is just passed to the same
    // on-chain redeem(amount) function used everywhere else.
    async redeemItem(item) {
      if (this.redeemingItemId) return;
      if (Number(this.balance) < item.cost) {
        this.itemStatus = { type: "err", msg: `You need ${item.cost} points for ${item.name}. You have ${this.balance}.` };
        return;
      }
      this.redeemingItemId = item.id;
      this.itemStatus = { type: "pending", msg: `Redeeming for ${item.name}, waiting for confirmation...` };
      this.lastReward = null;
      try {
        await this.sendTx("redeem", [item.cost]);
        const balResult = await this.ethCall("balanceOf", [this.account]);
        this.balance = balResult[0].toString();
        this.itemStatus = { type: "ok", msg: `Redeemed ${item.cost} points for ${item.name}.` };
        this.lastReward = item;
        this.fireConfetti();
        this.loadRedeemHistory();
      } catch (err) {
        this.itemStatus = { type: "err", msg: this.parseError(err) };
      } finally {
        this.redeemingItemId = null;
      }
    },

    // Custom amount redeem, kept for flexibility/testing outside the catalog.
    async redeemPoints() {
      this.redeemStatus = { type: "pending", msg: "" };
      this.redeeming = true;
      try {
        const amount = this.redeemAmount;
        this.redeemStatus = { type: "pending", msg: "Transaction sent, waiting for confirmation..." };
        await this.sendTx("redeem", [amount]);
        const balResult = await this.ethCall("balanceOf", [this.account]);
        this.balance = balResult[0].toString();
        this.redeemStatus = { type: "ok", msg: `Redeemed ${amount} points.` };
        this.redeemAmount = "";
        this.loadRedeemHistory();
      } catch (err) {
        this.redeemStatus = { type: "err", msg: this.parseError(err) };
      } finally {
        this.redeeming = false;
      }
    },

    shortAddr(a) {
      if (!a) return "";
      return a.slice(0, 6) + "..." + a.slice(-4);
    },

    // Small canvas-based confetti burst in the shop's brass/brick palette.
    // No external library — a self-removing overlay canvas animated with rAF.
    fireConfetti() {
      const canvas = document.createElement("canvas");
      canvas.style.position = "fixed";
      canvas.style.inset = "0";
      canvas.style.width = "100vw";
      canvas.style.height = "100vh";
      canvas.style.pointerEvents = "none";
      canvas.style.zIndex = "9999";
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext("2d");

      const colors = ["#c99a4b", "#e8c274", "#b1503a", "#e2a08c", "#f1e4cf"];
      const pieces = Array.from({ length: 80 }, () => ({
        x: canvas.width / 2 + (Math.random() - 0.5) * 120,
        y: canvas.height * 0.35 + (Math.random() - 0.5) * 40,
        vx: (Math.random() - 0.5) * 9,
        vy: Math.random() * -9 - 3,
        size: Math.random() * 7 + 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.3,
        gravity: 0.28 + Math.random() * 0.1
      }));

      const start = performance.now();
      const duration = 2200;

      function frame(now) {
        const elapsed = now - start;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const p of pieces) {
          p.vy += p.gravity;
          p.x += p.vx;
          p.y += p.vy;
          p.rot += p.vr;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
          ctx.restore();
        }
        if (elapsed < duration) {
          requestAnimationFrame(frame);
        } else {
          canvas.remove();
        }
      }
      requestAnimationFrame(frame);
    },

    parseError(err) {
      return err?.shortMessage || err?.reason || err?.message || "Transaction failed.";
    }
  };
}
